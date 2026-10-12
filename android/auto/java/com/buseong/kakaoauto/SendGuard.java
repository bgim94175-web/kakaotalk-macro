package com.buseong.kakaoauto;

import android.content.Context;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 발송 차단 장치 — <b>어디로 보내면 안 되는지</b>를 판정한다.
 *
 * 기존 발송 조건(방해금지 시간·쿨타임·새 메시지 최소 개수·계정 간 간격)은 전부
 * "언제 보낼지" 만 봤다. 그래서 대상 대화방 목록에 잘못 들어간 방 하나가
 * 개인 대화방이어도 그대로 발송됐다. 실제로 사고가 났다.
 *
 * 이 클래스는 발송 직전에 세 가지를 본다. 순서대로 하나라도 걸리면 보내지 않는다.
 *
 * <ol>
 *   <li><b>전체 정지</b> — 손님이 누른 비상 정지. 모든 기능의 모든 발송을 멈춘다.</li>
 *   <li><b>보호 대화방</b> — 손님이 지정한 절대 금지 목록. 어떤 설정·어떤 기능으로도
 *       발송되지 않고, 대화방이 다시 감지되어도 대상이 될 수 없다.</li>
 *   <li><b>1:1 개인 대화방</b> — 손님이 그 방에 대해 직접 동의하지 않았으면 보내지 않는다.
 *       오픈프로필 자동응답은 1:1 이 본래 목적이므로 예외다.</li>
 * </ol>
 *
 * <h3>왜 평문 Prefs 인가</h3>
 * 전체 정지와 보호 대화방은 <b>설정을 못 읽는 상태에서도 반드시 동작해야 한다.</b>
 * 설정은 기기 안의 설정키로 암호화돼 있어서 복호화가 실패하면 읽히지 않는다.
 * 그때 차단이 함께 풀려버리면 가장 필요한 순간에 장치가 없는 셈이다. 그래서 이 두 값만은
 * 암호화하지 않은 Prefs 에 따로 둔다. 둘 다 "막는" 값이라 평문으로 둬도 손해가 없다
 * (지우면 막지 않게 되지만, 그건 손님 기기에서 손님이 하는 일이다).
 */
public final class SendGuard {

    private SendGuard() {}

    // ── 기능 구분 (1:1 예외를 판정하는 데 쓴다) ──────────────────────────────

    /** 예약 자동발송 · 수동 즉시 발송 */
    public static final int MACRO = 1;
    /** 메시지 추적 */
    public static final int TRIGGER = 2;
    /** 오픈프로필 개인 대화 자동응답 — 1:1 이 본래 목적이라 1:1 검사에서 제외된다 */
    public static final int AUTOREPLY = 3;
    /** 대화방 관리봇 */
    public static final int ROOMBOT = 4;
    /** 미니게임봇 */
    public static final int MINIGAME = 5;

    private static String kindKr(int kind) {
        if (kind == TRIGGER) return "메시지 추적";
        if (kind == AUTOREPLY) return "자동응답";
        if (kind == ROOMBOT) return "대화방 관리봇";
        if (kind == MINIGAME) return "미니게임봇";
        return "자동발송";
    }

    // ── 저장 (평문 Prefs — 위 설명 참고) ────────────────────────────────────

    private static final String K_STOP = "guard_stop_all";
    private static final String K_PROTECTED = "guard_protected";
    /** 보호 목록 구분자 — 대화방 이름에 거의 쓰이지 않는 제어문자 */
    private static final String SEP = "\u0002";
    /** 보호 목록 최대 개수 (평문 Prefs 한 줄로 두니 상한을 건다) */
    public static final int MAX_PROTECTED = 200;

    // ── 전체 정지 ───────────────────────────────────────────────────────────

    public static boolean stopped(Context c) {
        if (c == null) return false;
        try {
            return Prefs.getBool(c, K_STOP, false);
        } catch (Throwable t) {
            return false;
        }
    }

    public static void setStopped(Context c, boolean on) {
        if (c == null) return;
        try {
            Prefs.putBool(c, K_STOP, on);
        } catch (Throwable t) {
            Log.add(c, "전체 정지 설정을 저장하지 못했습니다: " + t);
            return;
        }
        Log.add(c, on
                ? "전체 정지를 실행했습니다. 모든 자동 발송이 멈춥니다."
                : "전체 정지를 해제했습니다. 자동 발송이 다시 동작합니다.");
        if (on) {
            // 이미 예약된 알람·대기 중인 사진 전송까지 같이 끊는다
            try { Scheduler.cancel(c); } catch (Throwable ignore) { }
            try { ImageSender.dropAll(c); } catch (Throwable ignore) { }
        } else {
            try { Scheduler.ensureScheduled(c); } catch (Throwable ignore) { }
        }
    }

    // ── 보호 대화방 ─────────────────────────────────────────────────────────

    /**
     * 보호 목록의 키는 <b>대화방 이름</b>이다 (계정은 넣지 않는다).
     *
     * 계정까지 묶으면 듀얼 메신저의 다른 계정에 같은 이름의 방이 있을 때 한쪽만 막힌다.
     * 보호는 "이 사람에게는 보내지 마라" 는 뜻이므로 계정을 가로질러 막는 쪽이 맞다.
     * 이름 비교는 공백·보이지 않는 문자를 정리한 뒤 한다.
     */
    private static String norm(String name) {
        if (name == null) return "";
        String s = name.trim();
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch == ' ' || ch == ' ' || ch == '​' || ch == '\t') continue;
            sb.append(ch);
        }
        return sb.toString();
    }

    /** 보호 목록 (저장된 표기 그대로. 화면에 보여줄 때 쓴다) */
    public static List<String> protectedRooms(Context c) {
        ArrayList<String> out = new ArrayList<String>();
        if (c == null) return out;
        String raw;
        try {
            raw = Prefs.getStr(c, K_PROTECTED, "");
        } catch (Throwable t) {
            return out;
        }
        if (raw == null || raw.length() == 0) return out;
        String[] parts = raw.split(SEP, -1);
        for (int i = 0; i < parts.length; i++) {
            String p = (parts[i] == null) ? "" : parts[i].trim();
            if (p.length() > 0) out.add(p);
        }
        return out;
    }

    /** 비교용 집합 (정리된 이름). 알림마다 불릴 수 있어서 결과를 캐시한다. */
    private static volatile String cachedRaw = null;
    private static volatile Set<String> cachedSet = null;

    private static Set<String> normSet(Context c) {
        String raw;
        try {
            raw = Prefs.getStr(c, K_PROTECTED, "");
        } catch (Throwable t) {
            raw = "";
        }
        if (raw == null) raw = "";
        Set<String> hit = cachedSet;
        if (hit != null && raw.equals(cachedRaw)) return hit;
        HashSet<String> set = new HashSet<String>();
        if (raw.length() > 0) {
            String[] parts = raw.split(SEP, -1);
            for (int i = 0; i < parts.length; i++) {
                String n = norm(parts[i]);
                if (n.length() > 0) set.add(n);
            }
        }
        cachedRaw = raw;
        cachedSet = set;
        return set;
    }

    public static boolean isProtected(Context c, String roomName) {
        if (c == null) return false;
        String n = norm(roomName);
        if (n.length() == 0) return false;
        try {
            return normSet(c).contains(n);
        } catch (Throwable t) {
            return false;
        }
    }

    /** 보호 목록에 추가. 이미 있으면 그대로 true. */
    public static boolean protect(Context c, String roomName) {
        if (c == null) return false;
        String name = (roomName == null) ? "" : roomName.trim();
        if (name.length() == 0) return false;
        if (isProtected(c, name)) return true;
        List<String> cur = protectedRooms(c);
        if (cur.size() >= MAX_PROTECTED) {
            Log.add(c, "보호 대화방이 한도(" + MAX_PROTECTED + "개)에 도달해 추가하지 못했습니다.");
            return false;
        }
        cur.add(name);
        if (!writeList(c, cur)) return false;
        Log.add(c, "「" + name + "」 을(를) 보호 대화방으로 지정했습니다. 이 대화방에는 자동 발송되지 않습니다.");
        return true;
    }

    public static boolean unprotect(Context c, String roomName) {
        if (c == null) return false;
        String target = norm(roomName);
        List<String> cur = protectedRooms(c);
        boolean hit = false;
        for (int i = cur.size() - 1; i >= 0; i--) {
            if (norm(cur.get(i)).equals(target)) { cur.remove(i); hit = true; }
        }
        if (!hit) return false;
        if (!writeList(c, cur)) return false;
        Log.add(c, "「" + roomName + "」 의 보호를 해제했습니다.");
        return true;
    }

    private static boolean writeList(Context c, List<String> list) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) sb.append(SEP);
            sb.append(list.get(i));
        }
        try {
            Prefs.putStr(c, K_PROTECTED, sb.toString());
        } catch (Throwable t) {
            Log.add(c, "보호 대화방 목록을 저장하지 못했습니다: " + t);
            return false;
        }
        cachedRaw = null;
        cachedSet = null;
        return true;
    }

    // ── 1:1 동의 ────────────────────────────────────────────────────────────

    /**
     * 그 대화방이 1:1 인데도 발송 대상으로 쓰는 것에 손님이 동의했나.
     *
     * 동의는 <b>대화방을 발송 대상으로 켤 때</b> 확인창에서 받는다
     * ({@link ScreenRooms}). 동의가 없으면 1:1 로는 보내지 않는다.
     * 저장은 설정 쪽(RoomCfg)에 둔다 — 손님이 직접 켠 값이라 설정과 수명이 같아야 한다.
     */
    static boolean oneToOneAllowed(Context c, RoomRef ref) {
        if (ref == null) return false;
        try {
            Settings s = Settings.load(c);
            Settings.RoomCfg rc = s.roomCfg(ref);
            return (rc != null) && rc.allowOneToOne;
        } catch (Throwable t) {
            return false;       // 못 읽으면 막는 쪽
        }
    }

    // ── 판정 ────────────────────────────────────────────────────────────────

    /** 같은 사유를 반복해서 로그에 쌓지 않기 위한 기록 (방+사유 → 마지막 기록 시각) */
    private static final ConcurrentHashMap<String, Long> LOGGED =
            new ConcurrentHashMap<String, Long>();
    private static final long LOG_EVERY_MS = 10 * 60 * 1000L;

    /**
     * 보내도 되나. <b>막아야 하면 사유, 보내도 되면 null.</b>
     *
     * 발송 직전에 부른다. 여기서 null 이 아니면 어떤 경우에도 보내서는 안 된다.
     *
     * @param kind {@link #MACRO} 등 기능 구분. 1:1 예외 판정에만 쓴다.
     */
    public static String blockReason(Context c, RoomRef ref, int kind) {
        if (c == null || ref == null) return null;      // 판정 불가 — 기존 흐름을 바꾸지 않는다

        if (stopped(c)) {
            return "전체 정지 중입니다.";
        }
        if (isProtected(c, ref.name)) {
            return "보호 대화방으로 지정되어 있습니다.";
        }
        // 1:1 검사는 <b>앱이 먼저 말을 거는 기능</b>에만 건다 — 자동발송과 메시지 추적이다.
        // 사고가 난 경로가 이쪽이고, 개인에게 반복 발송되면 신고·차단 대상이 된다.
        //
        // 반대로 자동응답과 두 봇은 상대가 보낸 말에 답하는 기능이다. 자동응답은 1:1 이
        // 본래 목적이고, 봇은 손님이 직접 지정한 대화방에서 들어온 명령에만 답한다
        // (RoomBotCfg·MiniGameCfg 의 coversRoom 은 지정 목록이 비어 있으면 false 다).
        // 거기까지 막으면 쓰던 기능이 말 없이 멈춘다.
        if (kind == AUTOREPLY || kind == ROOMBOT || kind == MINIGAME) {
            return null;
        }

        // 1:1 판정. 단체방으로 확인된 방만 통과시킨다 — '미확인' 은 막는다.
        // 발송에는 살아있는 답장 통로가 필요하고, 그 통로는 알림에서 생기므로
        // 보낼 수 있는 방은 거의 항상 단체/1:1 이 확정돼 있다. 확정되지 않았다면
        // 그 방에 대해 아는 것이 없다는 뜻이므로 보내지 않는 쪽이 맞다.
        int g = KakaoListener.groupState(c, ref);
        if (g == KakaoListener.GROUP_YES) return null;
        if (oneToOneAllowed(c, ref)) return null;       // 손님이 그 방에 대해 직접 동의했다
        if (g == KakaoListener.GROUP_NO) {
            return "1:1 개인 대화방입니다. 대상 대화방 설정에서 직접 허용해야 발송됩니다.";
        }
        return "단체방인지 확인되지 않았습니다. 카카오톡 알림이 1회 수신되면 판정됩니다.";
    }

    /**
     * 막혔으면 활동 로그에 남긴다 (같은 사유는 10분에 한 번만).
     * 조용히 삼키면 손님은 "왜 안 보내지는지" 를 알 수 없다.
     */
    public static void note(Context c, RoomRef ref, int kind, String reason) {
        if (c == null || ref == null || reason == null) return;
        String key = ref.key() + '|' + reason;
        long now = System.currentTimeMillis();
        Long last = LOGGED.get(key);
        if (last != null && now - last.longValue() < LOG_EVERY_MS) return;
        LOGGED.put(key, Long.valueOf(now));
        if (LOGGED.size() > 400) LOGGED.clear();
        Log.add(c, kindKr(kind) + " — 「" + ref.label(c) + "」 발송을 보류했습니다. " + reason);
    }

    /**
     * <b>2차 방어선</b> — 기능 구분 없이 판정할 수 있는 두 가지(전체 정지 · 보호 대화방)만 본다.
     *
     * 1차 방어선은 {@link #blocked} 로, 기능별 호출부에서 기능 구분과 함께 부른다.
     * 그런데 호출부를 하나 빠뜨리면 그대로 새는 구조다(실제로 사진 발송의 문자열 판이
     * 차단을 지나지 않고 있었다). 그래서 모든 발송이 반드시 지나는 가장 낮은 지점에서
     * 기능 구분 없이도 판정되는 두 규칙을 한 번 더 본다. 1:1 검사는 기능을 알아야 하므로
     * 여기서는 하지 않는다.
     */
    public static boolean hardBlocked(Context c, RoomRef ref) {
        if (c == null || ref == null) return false;
        String why = null;
        if (stopped(c)) why = "전체 정지 중입니다.";
        else if (isProtected(c, ref.name)) why = "보호 대화방으로 지정되어 있습니다.";
        if (why == null) return false;
        note(c, ref, MACRO, why);
        return true;
    }

    /** 판정 + 로그를 한 번에. 막혔으면 true. */
    public static boolean blocked(Context c, RoomRef ref, int kind) {
        String why = blockReason(c, ref, kind);
        if (why == null) return false;
        note(c, ref, kind, why);
        return true;
    }
}
