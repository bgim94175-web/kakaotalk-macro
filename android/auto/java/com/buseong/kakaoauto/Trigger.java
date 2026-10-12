package com.buseong.kakaoauto;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * 메시지 추적 = 키워드 트리거 엔진 (SPEC 8.4 C).
 *
 * 규칙 모델은 {@link Settings.TriggerCfg} 다. 이 클래스는 **판정 + 실행**만 한다.
 *   판정 순서: 활성 → 방 필터 → 내 메시지 필터 → 패턴 매칭 → 1회발동/쿨다운 → 치환 → 랜덤 지연 → 발송
 *
 * 주기 발송 스케줄과 완전히 무관하다. 알림이 도착한 그 순간에 판정하고, 지연을 줬으면 그만큼만 기다렸다 보낸다.
 *
 * 쿨다운·1회발동 기록은 메모리 Map 이 정본이고, 앱이 죽어도 남게 평문 Prefs 에 JSON 으로 백업한다
 * (방 이름이 들어가긴 하지만 KakaoListener 의 방 캐시와 같은 수준의 정보라 평문으로 둔다).
 *
 * 정규식은 미리 컴파일해서 캐시한다. 깨진 정규식은 건너뛰고 Log 로 알린다 — 조용히 삼키지 않는다.
 */
public final class Trigger {
    private Trigger() {}

    /** 쿨다운/1회발동 백업 슬롯 (평문) */
    private static final String K_STATE = "K_TRIG_STATE";

    /** 지연 상한 (SPEC: 0~60000) */
    public static final int MAX_DELAY_MS = 60000;

    /** 트리거 하나가 기억하는 "이미 발동한 방" 최대 개수 */
    private static final int MAX_ONCE_ROOMS = 100;

    /** 같은 경고를 도배하지 않는 간격 */
    private static final long WARN_MS = 5 * 60 * 1000L;

    /** 내가 방금 보낸 문구가 알림으로 되돌아왔을 때 메아리로 인정하는 창 (ms) */
    private static final long ECHO_MS = 60000L;

    /** 방 하나에 대해 기억해두는 최근 발송 문구 개수 */
    private static final int MAX_SAID = 8;

    private static final Random RND = new Random();

    /** 트리거 id → 마지막 발동 시각 */
    private static final ConcurrentHashMap<String, Long> CD = new ConcurrentHashMap<String, Long>();
    /** 트리거 id → 이미 발동한 방 키들 (oncePerRoom. 값은 RoomRef.key()) */
    private static final ConcurrentHashMap<String, Set<String>> ONCE =
            new ConcurrentHashMap<String, Set<String>>();

    /** 정규식 캐시 (플래그+패턴 → Pattern) */
    private static final ConcurrentHashMap<String, Pattern> PAT =
            new ConcurrentHashMap<String, Pattern>();
    /** 컴파일이 깨진 정규식 (다시 시도해서 예외 비용을 또 내지 않게) */
    private static final ConcurrentHashMap<String, Boolean> BAD =
            new ConcurrentHashMap<String, Boolean>();
    /** 경고 로그 도배 방지 */
    private static final ConcurrentHashMap<String, Long> WARNED =
            new ConcurrentHashMap<String, Long>();

    /** 방 키 → 최근 내가 보낸 문구들 (메아리 차단용. RoomBot·MiniGame 과 동일한 구조) */
    private static final ConcurrentHashMap<String, ArrayList<Said>> SAID =
            new ConcurrentHashMap<String, ArrayList<Said>>();
    /** SAID 접근 잠금 (load() 의 Trigger.class 잠금과 섞이지 않게 별도로 둔다) */
    private static final Object SAID_LOCK = new Object();

    /** 내가 보낸 문구 하나 (정규화된 본문 + 보낸 시각) */
    private static final class Said {
        final String norm;
        final long at;
        Said(String norm, long at) { this.norm = norm; this.at = at; }
    }

    private static volatile boolean loaded = false;

    // ── 판정 ──────────────────────────────────────────────────────────────────

    /**
     * 이 메시지가 규칙에 걸리나. 정규식은 컴파일 캐시를 쓰고, 깨져 있으면 false.
     * (Settings.TriggerCfg.matches 와 판정 결과는 같다. 여기 건 알림마다 불려도 되게 캐시가 붙어있는 버전이다)
     */
    public static boolean matches(Settings.TriggerCfg t, String text) {
        if (t == null || text == null) return false;
        String p = t.pattern;
        if (p == null || p.length() == 0) return false;

        if (Settings.MODE_REGEX.equals(t.mode)) {
            Pattern pat = compiled(p, t.ignoreCase);
            if (pat == null) return false;
            try {
                return pat.matcher(text).find();
            } catch (Throwable e) {
                return false;
            }
        }

        String m = text;
        String q = p;
        if (t.ignoreCase) {
            m = m.toLowerCase(Locale.getDefault());
            q = q.toLowerCase(Locale.getDefault());
        }
        if (Settings.MODE_EXACT.equals(t.mode)) return m.trim().equals(q.trim());
        if (Settings.MODE_STARTS.equals(t.mode)) return m.startsWith(q);
        return m.contains(q);
    }

    // ── 실행 ──────────────────────────────────────────────────────────────────

    /**
     * 알림 하나를 모든 활성 트리거에 물려본다. KakaoListener 의 BG 스레드에서 호출된다.
     *
     * 내 메시지인지는 발신자와 내 카톡 프로필 이름을 비교해서 판단한다
     * (리스너가 이미 알고 있으면 {@link #onMessage(Context, RoomRef, String, String, boolean, boolean)} 로 직접 넘겨라).
     *
     * @param room   메시지가 올라온 방 (계정 + 방 이름)
     * @param sender 발신자 (모르면 "")
     * @param text   본문
     * @param group  그룹방인가 (판정에는 안 쓰고 진입점 시그니처를 맞추기 위해 받는다)
     */
    public static void onMessage(Context c, RoomRef room, String sender, String text, boolean group) {
        boolean fromMe = false;
        try {
            String me = KakaoListener.selfName((room == null) ? null : room.acc);
            if (sender != null && me != null && me.length() > 0 && sender.trim().equals(me)) fromMe = true;
        } catch (Throwable t) {
            fromMe = false;
        }
        onMessage(c, room, sender, text, group, fromMe);
    }

    /** 내 메시지 여부를 호출한 쪽이 알고 있을 때 쓰는 진입점 */
    public static void onMessage(final Context c, final RoomRef room, String sender, String text,
                                 boolean group, boolean fromMe) {
        if (c == null || room == null || text == null || text.length() == 0) return;
        Settings s;
        try {
            s = Settings.load(c);
        } catch (Throwable t) {
            return;
        }
        // 대상 계정이 아니면 아무것도 안 한다 (Settings.accounts 가 비어 있으면 모든 계정이 대상)
        if (!s.accountOn(room.acc)) return;

        List<Settings.TriggerCfg> list = s.triggers;
        if (list == null || list.isEmpty()) return;

        final String roomKey = room.key();
        final String roomName = room.name;
        final String roomLabel = room.label(c);
        final String who = (sender == null) ? "" : sender.trim();
        final long now = System.currentTimeMillis();

        load(c);

        // 메아리 차단: 내가 방금 이 방에 보낸 문구가 알림으로 되돌아온 것이면 트리거 판정을 하지 않는다.
        // (fromMe 트리거가 자기 발송을 재감지해 무한 발송 루프를 도는 사고를 막는다. RoomBot·MiniGame 과 동일한 방어선)
        if (saidRecently(room, text, now)) return;

        boolean dirty = false;

        for (int i = 0; i < list.size(); i++) {
            Settings.TriggerCfg t = list.get(i);
            if (t == null || !t.enabled) continue;
            if (t.id == null || t.id.length() == 0) continue;
            if (!t.coversRoom(room)) continue;
            if (fromMe && !t.fromMe) continue;

            // 정규식이 깨진 트리거는 건너뛰되 사용자에게 알린다
            if (Settings.MODE_REGEX.equals(t.mode) && compiled(t.pattern, t.ignoreCase) == null) {
                warn(c, "regex:" + t.id,
                        "메시지 추적 「" + t.title() + "」 패턴 형식이 올바르지 않아 건너뛰었습니다. 설정에서 수정하십시오.");
                continue;
            }

            if (!matches(t, text)) continue;

            // 방마다 한 번만 (계정별로 따로 센다 — 키가 계정을 포함한다)
            if (t.oncePerRoom && firedIn(t.id, roomKey)) continue;

            // 트리거별 쿨다운
            long cool = (t.cooldownMs < 0) ? 0L : t.cooldownMs;
            Long last = CD.get(t.id);
            if (last != null && now - last.longValue() < cool) continue;

            // 보낼 곳 결정.
            // target 에 방 이름만 적혀 있으면 감지된 방과 같은 계정으로 보낸다
            // (계정 구분자가 들어있으면 그 계정을 그대로 쓴다).
            String tgt = (t.target == null) ? "" : t.target.trim();
            final RoomRef dest;
            if (tgt.length() == 0) {
                dest = room;
            } else if (tgt.indexOf('\u0001') >= 0) {
                dest = RoomRef.parse(tgt);
            } else {
                dest = RoomRef.of(room.acc, tgt);
            }
            if (dest == null || !dest.valid()) {
                warn(c, "dest:" + t.id,
                        "메시지 추적 「" + t.title() + "」 대상 대화방이 지정되지 않아 건너뛰었습니다.");
                continue;
            }
            final String destLabel = dest.label(c);
            // 다른 방으로 보내는 트리거는 그 방 세션이 살아있어야 한다 (SPEC 8.4 C).
            // 쿨다운을 소모하지 않고 넘겨서, 그 방 알림이 오면 다음에 정상 발동하게 한다.
            if (tgt.length() > 0 && !KakaoListener.hasSession(dest)) {
                warn(c, "sess:" + t.id + ":" + dest.key(),
                        "메시지 추적 「" + t.title() + "」 대상 대화방의 연결이 없습니다. 「" + destLabel
                                + "」의 카카오톡 알림이 1회 수신되어야 발송이 가능합니다.");
                continue;
            }

            final String msg = t.render(roomName, who, text, now);
            if (msg == null || msg.trim().length() == 0) {
                warn(c, "empty:" + t.id,
                        "메시지 추적 「" + t.title() + "」 발송할 메시지가 비어 있어 건너뛰었습니다.");
                continue;
            }

            // 상태를 먼저 찍는다 — 지연 중에 같은 트리거가 또 걸리는 걸 막는다.
            // 다만 발송이 실패하면 아래 Runnable 에서 선점한 쿨다운·1회발동을 되돌린다
            // (AutoReply.refund 와 동일한 원칙 — 소모분을 실패 시 복구한다).
            CD.put(t.id, Long.valueOf(now));
            if (t.oncePerRoom) markFired(t.id, roomKey);
            dirty = true;

            final long wait = delayOf(t.delayMs);
            final String name = t.title();
            final String tid = t.id;
            final boolean once = t.oncePerRoom;
            final long stamp = now;
            KakaoListener.post(new Runnable() {
                @Override public void run() {
                    // 메아리 차단: 보낼 문구를 발송 직전에 방별로 기억한다 (되돌아온 알림을 걸러낸다)
                    remember(dest.key(), msg, System.currentTimeMillis());
                    int r = KakaoListener.send(c, dest, msg, SendGuard.TRIGGER);
                    if (r == KakaoListener.SEND_HELD) {
                        // 다른 계정이 방금 같은 대화방에 보냈다. 메시지 추적은 '즉시 발송' 이
                        // 약속이라 미루면 의미가 없고, 두 계정이 같은 키워드에 두 번 반응하는
                        // 것이 문제다 → 이번 건은 그 계정에 맡기고 보내지 않는다.
                        KakaoListener.noteHeld(c, dest, SendGuard.TRIGGER, 0L, true);
                        return;
                    }
                    boolean ok = (r == KakaoListener.SEND_OK);
                    if (!ok) {
                        Log.add(c, "메시지 추적 「" + name + "」 발송에 실패했습니다. (대상 "
                                + destLabel + ")");
                        // 그 사이 같은 트리거가 다시 발동하지 않았다면 선점한 쿨다운·1회발동을 되돌린다.
                        // 특히 oncePerRoom 트리거가 발송 실패로 영구히 '발동 완료'로 묶이는 것을 막는다.
                        rollback(c, tid, roomKey, once, stamp);
                    }
                }
            }, wait);

            Log.add(c, "메시지 추적 「" + name + "」 감지 · 「" + roomLabel + "」 → 「" + destLabel + "」 "
                    + (wait <= 0 ? "즉시" : (wait / 1000) + "초 후") + " 발송 예약");
        }

        if (dirty) {
            prune(list);
            save(c);
        }
    }

    /** 0 ~ delayMs 사이 랜덤. 상한은 60초. */
    private static long delayOf(int delayMs) {
        int d = delayMs;
        if (d <= 0) return 0L;
        if (d > MAX_DELAY_MS) d = MAX_DELAY_MS;
        return RND.nextInt(d + 1);
    }

    // ── 저장 전 검증 (설정 화면이 쓴다) ───────────────────────────────────────

    /** 문제가 없으면 null, 있으면 사용자에게 그대로 보여줄 한국어 설명. */
    public static String validate(Settings.TriggerCfg t) {
        if (t == null) return "규칙 내용이 비어 있습니다.";
        if (t.pattern == null || t.pattern.trim().length() == 0) return "감지할 글자을 입력하십시오.";
        if (t.reply == null || t.reply.trim().length() == 0) return "발송할 메시지를 입력하십시오.";
        if (!validMode(t.mode)) return "찾는 방식을 선택하십시오. (포함 · 정확히 · 시작)";

        if (Settings.MODE_REGEX.equals(t.mode)) {
            try {
                Pattern.compile(t.pattern);
            } catch (Throwable e) {
                String why = e.getMessage();
                return "패턴 형식이 올바르지 않습니다."
                        + ((why == null) ? "" : (" (" + why.replace('\n', ' ') + ")"));
            }
            // 고쳐서 저장하는 경우가 많으니 "깨진 패턴" 표시를 풀어준다
            forget(t.pattern);
        }

        if (t.delayMs < 0 || t.delayMs > MAX_DELAY_MS) return "지연 시간은 0~60초 범위로 입력하십시오.";
        if (t.cooldownMs < 0) return "다시 감지까지 대기은 0 이상으로 입력하십시오.";
        if (t.rooms != null && t.rooms.size() > 50) return "대화방은 최대 50개까지 지정됩니다.";
        if (t.reply.length() > 2000) return "발송 메시지가 너무 깁니다. 2000자 이하로 입력하십시오.";
        return null;
    }

    private static boolean validMode(String mode) {
        if (mode == null) return false;
        for (int i = 0; i < Settings.MODES.length; i++) {
            if (Settings.MODES[i].equals(mode)) return true;
        }
        return false;
    }

    // ── 상태 조회 / 초기화 (설정 화면용) ──────────────────────────────────────

    /** 이 트리거가 마지막으로 발동한 시각 (없으면 0) */
    public static long lastFiredAt(Context c, String triggerId) {
        if (triggerId == null) return 0L;
        load(c);
        Long v = CD.get(triggerId);
        return (v == null) ? 0L : v.longValue();
    }

    /** oncePerRoom 로 이미 발동한 방 목록 (표시용 이름. 계정이 여러 개면 계정 이름이 함께 붙는다) */
    public static List<String> firedRooms(Context c, String triggerId) {
        load(c);
        ArrayList<String> out = new ArrayList<String>();
        if (triggerId == null) return out;
        Set<String> set = ONCE.get(triggerId);
        if (set == null) return out;
        ArrayList<String> keys = new ArrayList<String>();
        synchronized (set) { keys.addAll(set); }
        for (int i = 0; i < keys.size(); i++) {
            String k = keys.get(i);
            RoomRef r = RoomRef.parse(k);
            out.add((r == null) ? k : r.label());
        }
        Collections.sort(out);
        return out;
    }

    /** oncePerRoom 로 이미 발동한 방 (RoomRef 목록) */
    public static List<RoomRef> firedRoomRefs(Context c, String triggerId) {
        load(c);
        ArrayList<RoomRef> out = new ArrayList<RoomRef>();
        if (triggerId == null) return out;
        Set<String> set = ONCE.get(triggerId);
        if (set == null) return out;
        ArrayList<String> keys = new ArrayList<String>();
        synchronized (set) { keys.addAll(set); }
        Collections.sort(keys);
        for (int i = 0; i < keys.size(); i++) {
            RoomRef r = RoomRef.parse(keys.get(i));
            if (r != null) out.add(r);
        }
        return out;
    }

    /** 트리거 하나의 쿨다운·1회발동 기록을 지운다 (다시 발동하게) */
    public static void resetState(Context c, String triggerId) {
        if (triggerId == null) return;
        load(c);
        CD.remove(triggerId);
        ONCE.remove(triggerId);
        save(c);
    }

    /** 모든 발동 기록 초기화 */
    public static void clearState(Context c) {
        CD.clear();
        ONCE.clear();
        loaded = true;
        Prefs.remove(c, K_STATE);
    }

    // ── 정규식 캐시 ───────────────────────────────────────────────────────────

    private static Pattern compiled(String pattern, boolean ignoreCase) {
        if (pattern == null || pattern.length() == 0) return null;
        int flags = ignoreCase ? (Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE) : 0;
        String key = flags + "\u0000" + pattern;
        Pattern p = PAT.get(key);
        if (p != null) return p;
        if (BAD.containsKey(key)) return null;
        try {
            p = Pattern.compile(pattern, flags);
        } catch (Throwable e) {
            BAD.put(key, Boolean.TRUE);
            return null;
        }
        if (PAT.size() > 128) PAT.clear();   // 트리거 30개 한도면 절대 안 닿지만 안전장치
        PAT.put(key, p);
        return p;
    }

    /** 이 패턴에 대한 캐시(정상/깨짐)를 버린다. 사용자가 고쳐서 저장할 때 호출. */
    private static void forget(String pattern) {
        if (pattern == null) return;
        String suffix = "\u0000" + pattern;
        Iterator<String> a = BAD.keySet().iterator();
        while (a.hasNext()) { if (a.next().endsWith(suffix)) a.remove(); }
        Iterator<String> b = PAT.keySet().iterator();
        while (b.hasNext()) { if (b.next().endsWith(suffix)) b.remove(); }
    }

    // ── 1회발동 기록 ──────────────────────────────────────────────────────────

    private static boolean firedIn(String id, String room) {
        Set<String> set = ONCE.get(id);
        if (set == null) return false;
        synchronized (set) { return set.contains(room); }
    }

    private static void markFired(String id, String room) {
        Set<String> set = ONCE.get(id);
        if (set == null) {
            Set<String> fresh = new HashSet<String>();
            Set<String> prev = ONCE.putIfAbsent(id, fresh);
            set = (prev != null) ? prev : fresh;
        }
        synchronized (set) {
            if (set.size() >= MAX_ONCE_ROOMS) {
                // 넘치면 통째로 비운다 — 어느 걸 버릴지 고를 근거가 없다
                set.clear();
            }
            set.add(room);
        }
    }

    /** 1회발동 기록에서 방 하나를 뺀다 (발송 실패 복구용) */
    private static void unmarkFired(String id, String room) {
        Set<String> set = ONCE.get(id);
        if (set == null) return;
        synchronized (set) { set.remove(room); }
    }

    /**
     * 발송이 실패했을 때 선점했던 쿨다운·1회발동을 되돌린다.
     * 그 사이 같은 트리거가 다시 발동했다면(CD 스탬프가 바뀌었다면) 손대지 않는다 —
     * 뒤에 성공한 발송의 기록까지 지워버리면 안 되기 때문이다.
     */
    private static void rollback(Context c, String id, String roomKey, boolean once, long stamp) {
        if (id == null) return;
        Long cur = CD.get(id);
        if (cur == null || cur.longValue() != stamp) return;   // 그 사이 재발동함 → 유지
        CD.remove(id);
        if (once) unmarkFired(id, roomKey);
        save(c);
    }

    // ── 메아리 차단 (RoomBot·MiniGame 과 동일한 구조) ──────────────────────────

    /** 보낸 문구를 방별로 기억한다 (정규화해서). 최근 {@link #MAX_SAID} 건만 들고 있는다. */
    private static void remember(String key, String msg, long now) {
        if (key == null || msg == null) return;
        String norm = flat(msg);
        if (norm.length() == 0) return;
        synchronized (SAID_LOCK) {
            ArrayList<Said> list = SAID.get(key);
            if (list == null) { list = new ArrayList<Said>(); SAID.put(key, list); }
            list.add(new Said(norm, now));
            while (list.size() > MAX_SAID) list.remove(0);
            if (SAID.size() > 120) {
                Iterator<String> it = SAID.keySet().iterator();
                while (it.hasNext() && SAID.size() > 120) {
                    String k = it.next();
                    if (k.equals(key)) continue;
                    it.remove();
                }
            }
        }
    }

    /**
     * 내가 최근 {@link #ECHO_MS} 안에 이 방으로 보낸 문구의 메아리인가.
     * 단체방 알림은 "내이름 : 보낸문장" 으로 되돌아오므로 접두 이름을 뗀 본문으로도 비교한다.
     * 여러 줄 메시지는 알림에서 잘려 오니 앞부분 일치도 본다 (RoomBot 과 동일 규칙).
     */
    private static boolean saidRecently(RoomRef room, String text, long now) {
        if (room == null || text == null) return false;
        String key = room.key();
        if (matchSaid(key, flat(text), now)) return true;
        String body = stripName(text);
        return body.length() > 0 && matchSaid(key, flat(body), now);
    }

    private static boolean matchSaid(String key, String b, long now) {
        if (b.length() == 0) return false;
        synchronized (SAID_LOCK) {
            ArrayList<Said> list = SAID.get(key);
            if (list == null) return false;
            for (int i = list.size() - 1; i >= 0; i--) {
                Said s = list.get(i);
                if (now - s.at > ECHO_MS) continue;
                if (s.norm.equals(b)) return true;
                if (s.norm.length() > b.length() && b.length() >= 6 && s.norm.startsWith(b)) return true;
            }
        }
        return false;
    }

    /** "홍길동 : 안녕하세요" 처럼 앞에 짧은 이름 접두사가 있으면 본문만 떼어 돌려준다 (없으면 ""). */
    private static String stripName(String text) {
        if (text == null) return "";
        int nl = text.indexOf('\n');
        String head = (nl >= 0) ? text.substring(0, nl) : text;
        int i = head.indexOf(" : ");
        if (i <= 0 || i > 20) return "";
        if (text.length() <= i + 3) return "";
        return text.substring(i + 3);
    }

    /** 줄바꿈·연속 공백을 한 칸으로 (비교용) */
    private static String flat(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length());
        boolean sp = false;
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (Character.isWhitespace(ch)) { sp = true; continue; }
            if (sp && sb.length() > 0) sb.append(' ');
            sp = false;
            sb.append(ch);
        }
        return sb.toString().trim();
    }

    /** 지금 없는 트리거의 기록은 버린다 */
    private static void prune(List<Settings.TriggerCfg> list) {
        HashSet<String> alive = new HashSet<String>();
        for (int i = 0; i < list.size(); i++) {
            Settings.TriggerCfg t = list.get(i);
            if (t != null && t.id != null) alive.add(t.id);
        }
        Iterator<String> a = CD.keySet().iterator();
        while (a.hasNext()) { if (!alive.contains(a.next())) a.remove(); }
        Iterator<String> b = ONCE.keySet().iterator();
        while (b.hasNext()) { if (!alive.contains(b.next())) b.remove(); }
    }

    // ── 경고 로그 (도배 방지) ─────────────────────────────────────────────────

    private static void warn(Context c, String key, String msg) {
        long now = System.currentTimeMillis();
        Long last = WARNED.get(key);
        if (last != null && now - last.longValue() < WARN_MS) return;
        WARNED.put(key, Long.valueOf(now));
        if (WARNED.size() > 200) WARNED.clear();
        Log.add(c, msg);
    }

    // ── 백업 저장/복구 ────────────────────────────────────────────────────────

    private static void load(Context c) {
        if (loaded) return;
        synchronized (Trigger.class) {
            if (loaded) return;
            loaded = true;
            if (c == null) { loaded = false; return; }
            String raw = Prefs.getStr(c, K_STATE, null);
            if (raw == null || raw.length() == 0) return;
            try {
                JSONObject o = new JSONObject(raw);
                JSONObject cd = o.optJSONObject("cd");
                if (cd != null) {
                    Iterator<String> it = cd.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        long v = cd.optLong(k, 0L);
                        if (v > 0) CD.put(k, Long.valueOf(v));
                    }
                }
                JSONObject once = o.optJSONObject("once");
                if (once != null) {
                    Iterator<String> it = once.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        JSONArray arr = once.optJSONArray(k);
                        if (arr == null) continue;
                        HashSet<String> set = new HashSet<String>();
                        for (int i = 0; i < arr.length() && set.size() < MAX_ONCE_ROOMS; i++) {
                            String room = arr.optString(i, "");
                            if (room.length() == 0) continue;
                            // 옛 기록은 계정 구분자가 없는 방 이름이다 → 기본 계정 키로 올려준다
                            RoomRef ref = RoomRef.parse(room);
                            set.add((ref == null) ? room : ref.key());
                        }
                        if (!set.isEmpty()) ONCE.put(k, set);
                    }
                }
            } catch (Throwable t) {
                Log.add(c, "메시지 추적 감지 기록이 손상되어 초기화했습니다. (" + t + ")");
                CD.clear();
                ONCE.clear();
            }
        }
    }

    private static void save(Context c) {
        if (c == null) return;
        try {
            JSONObject o = new JSONObject();
            JSONObject cd = new JSONObject();
            Iterator<Map.Entry<String, Long>> it = CD.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Long> e = it.next();
                cd.put(e.getKey(), e.getValue().longValue());
            }
            o.put("cd", cd);

            JSONObject once = new JSONObject();
            Iterator<Map.Entry<String, Set<String>>> it2 = ONCE.entrySet().iterator();
            while (it2.hasNext()) {
                Map.Entry<String, Set<String>> e = it2.next();
                Set<String> set = e.getValue();
                if (set == null) continue;
                JSONArray arr = new JSONArray();
                synchronized (set) {
                    Iterator<String> r = set.iterator();
                    while (r.hasNext()) arr.put(r.next());
                }
                if (arr.length() > 0) once.put(e.getKey(), arr);
            }
            o.put("once", once);

            Prefs.putStr(c, K_STATE, o.toString());
        } catch (Throwable t) {
            Log.add(c, "메시지 추적 감지 기록을 저장하지 못했습니다. (" + t + ")");
        }
    }
}
