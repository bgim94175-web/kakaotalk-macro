package com.buseong.kakaoauto;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 카톡 알림을 읽어서 (1) 방별 RemoteInput 세션을 기억하고 (2) 트리거·자동응답·봇으로 넘긴다.
 *
 * 이 앱이 카톡에 글을 쓸 수 있는 유일한 통로가 알림의 RemoteInput(답장창)이다.
 * 그래서 **그 방의 카톡 알림이 최근에 한 번은 와야** 발송이 가능하다. 세션은 메모리에만 두고,
 * 앱(프로세스)이 죽으면 사라진다 — 카톡 알림이 다시 오면 저절로 복구되니까 그게 정상 동작이다.
 *
 * 규칙 두 개만 지킨다.
 *   1) onNotificationPosted 안에서 절대 블로킹하지 않는다 → 파싱/세션갱신만 하고 나머지는 BG 스레드로 넘긴다.
 *   2) 기능 실행은 전부 License.allowed() 를 통과해야 한다 (macro / roombot / minigame 각각).
 *
 * 다른 클래스가 쓰는 공개 API
 *   boolean      sendTo(ctx, room, text)      — 그 방으로 발송 (Scheduler·Trigger·AutoReply·봇이 호출)
 *   int          othersSinceMine(room)        — 내 마지막 발송 뒤 남이 올린 메시지 수 (도배 방지 판정)
 *   List<String> knownRooms() / knownRooms(ctx) — 최근 감지된 방 이름 (설정 화면 방 선택용, 최대 50개)
 *   boolean      hasSession(room) / isKnownRoom(room) / connected(ctx)
 *   void         post(Runnable, delayMs)      — 공용 BG 핸들러 (지연 발송에 쓴다)
 *
 * 주의: 같은 패키지의 Log 클래스 때문에 android.util.Log 는 풀네임으로만 쓴다.
 */
public final class KakaoListener extends NotificationListenerService {

    public static final String KAKAO = "com.kakao.talk";

    /** 방 이름 캐시 최대 개수 (SPEC 8.2 — 방 목록은 평문 Prefs 에 이름만) */
    public static final int MAX_ROOMS = 50;

    /** 메모리에 들고 있을 방 세션 최대 개수 (넘치면 오래된 방부터 버린다) */
    public static final int MAX_SESSIONS = 120;

    /** 같은 알림이 여러 번 갱신돼도 한 번만 처리하는 무시 창 (ms) */
    private static final long DEDUP_MS = 1500L;

    /** 내가 방금 보낸 문장이 알림으로 되돌아왔을 때 내 메시지로 인정하는 창 (ms) */
    private static final long ECHO_MS = 30000L;

    private static final String K_ROOMS = "K_ROOM_CACHE";

    // ── 방별 세션 ─────────────────────────────────────────────────────────────

    /** 방 하나에 대한 최근 알림 상태. 발송에 필요한 재료가 여기 다 있다. */
    public static final class Session {
        public final String room;
        /** 답장 액션의 PendingIntent (카톡이 준 것) */
        public volatile PendingIntent pending;
        /** 그 액션에 달린 RemoteInput 들 (결과 키가 여기 있다) */
        public volatile RemoteInput[] inputs;
        /** 내가 이 방으로 마지막으로 보낸 시각 */
        public volatile long lastMine;
        /** 내 마지막 발송 뒤 남이 올린 메시지 수 */
        public volatile int othersSinceMine;
        /** 이 방 알림을 마지막으로 본 시각 */
        public volatile long lastAt;
        /** 마지막으로 본 발신자 */
        public volatile String lastSender = "";
        /** 그룹방인가 */
        public volatile boolean group;
        /** 내가 마지막으로 보낸 문장 (알림 메아리 걸러내기용) */
        public volatile String lastSentText = "";
        /** 중복 알림 판정용 지문 */
        volatile String lastKey = "";
        volatile long lastKeyAt;

        Session(String room) { this.room = room; }
    }

    private static final ConcurrentHashMap<String, Session> SESSIONS =
            new ConcurrentHashMap<String, Session>();

    /** 최근 감지된 방 이름 (최신이 뒤). 접근은 전부 synchronized(ROOMS). */
    private static final LinkedHashSet<String> ROOMS = new LinkedHashSet<String>();
    private static volatile boolean roomsLoaded = false;

    /** 마지막으로 본 내 표시이름 (카톡이 알림에 넣어준다) */
    private static volatile String selfName = "";

    /** 리스너가 시스템에 붙어 있는지 (메모리 플래그 — 프로세스 죽으면 false 로 돌아간다) */
    private static volatile boolean bound = false;

    /** Context 를 안 넘겨주는 호출자(knownRooms())를 위한 보관용 */
    private static volatile Context APP;

    // ── BG 핸들러 ─────────────────────────────────────────────────────────────

    private static volatile Handler BG;

    /** 공용 백그라운드 핸들러. 서비스가 안 떠 있어도 쓸 수 있게 필요할 때 만든다. */
    private static Handler bg() {
        Handler h = BG;
        if (h != null) return h;
        synchronized (KakaoListener.class) {
            if (BG != null) return BG;
            HandlerThread t = new HandlerThread("kakao-bg");
            t.start();
            BG = new Handler(t.getLooper());
            return BG;
        }
    }

    /**
     * 지연 실행. 트리거·자동응답·봇의 "N초 뒤 발송"은 전부 이걸 쓴다.
     * 핸들러를 못 만들면 그 자리에서 실행한다 (조용히 버리지 않는다).
     */
    public static void post(Runnable r, long delayMs) {
        if (r == null) return;
        long d = (delayMs < 0) ? 0 : delayMs;
        try {
            bg().postDelayed(r, d);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "지연 실행 실패 — 바로 실행할게", t);
            try { r.run(); } catch (Throwable ignore) { /* 아래 로그는 호출자가 남긴다 */ }
        }
    }

    // ── 서비스 수명주기 ───────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        APP = getApplicationContext();
        loadRooms(APP);
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        bound = true;
        APP = getApplicationContext();
        loadRooms(APP);
        Log.add(APP, "알림 읽기 권한이 연결됐어 — 이제 카톡 알림을 감지할 수 있어");
    }

    @Override
    public void onListenerDisconnected() {
        bound = false;
        Log.add(APP, "알림 읽기 권한이 끊겼어 — 설정에서 다시 켜줘 (발송 불가)");
        super.onListenerDisconnected();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            handle(sbn);
        } catch (Throwable t) {
            Log.add(getApplicationContext(), "알림 처리 중 오류가 났어: " + t);
        }
    }

    // ── 알림 처리 ─────────────────────────────────────────────────────────────

    private void handle(StatusBarNotification sbn) {
        if (sbn == null) return;
        if (!KAKAO.equals(sbn.getPackageName())) return;

        final Notification n = sbn.getNotification();
        if (n == null) return;

        // 카톡 상주 알림 / 묶음 요약 알림은 대화가 아니다
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) return;

        final Bundle ex = n.extras;
        if (ex == null) return;

        final Msg m = parse(ex, sbn.getPostTime());
        if (m == null) return;
        if (m.room.length() == 0 || m.text.length() == 0) return;

        // 세션 갱신 (여기까지는 아주 싸다 — 메인 스레드에서 해도 된다)
        Session s = SESSIONS.get(m.room);
        if (s == null) {
            Session fresh = new Session(m.room);
            Session prev = SESSIONS.putIfAbsent(m.room, fresh);
            s = (prev != null) ? prev : fresh;
            if (SESSIONS.size() > MAX_SESSIONS) trimSessions(m.room);
        }

        Reply r = findReply(n);
        if (r != null) {
            s.pending = r.pending;
            s.inputs = r.inputs;
        }
        s.lastAt = m.at;
        s.group = m.group;
        s.lastSender = m.sender;

        // 내가 방금 보낸 문장이 알림으로 되돌아온 경우도 내 메시지로 본다
        if (!m.fromMe && s.lastSentText.length() > 0
                && m.at - s.lastMine < ECHO_MS
                && s.lastSentText.equals(m.text)) {
            m.fromMe = true;
        }

        // 같은 알림 갱신(읽음 처리·요약 재게시 등)은 한 번만 처리한다
        boolean dup = m.key.equals(s.lastKey) && (m.at - s.lastKeyAt) < DEDUP_MS;
        s.lastKey = m.key;
        s.lastKeyAt = m.at;
        if (dup) return;

        if (!m.fromMe) s.othersSinceMine = s.othersSinceMine + 1;

        final Context ctx = getApplicationContext();
        // 무거운 건 전부 BG 로. 설정 복호화·정규식·Prefs 쓰기가 여기 들어있다.
        post(new Runnable() {
            @Override public void run() { dispatch(ctx, m); }
        }, 0);
    }

    /** 트리거 / 자동응답 / 봇으로 넘긴다. BG 스레드에서만 호출된다. */
    private static void dispatch(Context ctx, Msg m) {
        // 매크로(트리거·자동응답)
        try {
            if (License.allowed(ctx, Features.MACRO)) {
                try {
                    Trigger.onMessage(ctx, m.room, m.sender, m.text, m.fromMe);
                } catch (Throwable t) {
                    Log.add(ctx, "메시지추적 처리 중 오류: " + t);
                }
                if (!m.group && !m.fromMe) {
                    try {
                        AutoReply.onDirectMessage(ctx, m.room, m.sender, m.text);
                    } catch (Throwable t) {
                        Log.add(ctx, "자동응답 처리 중 오류: " + t);
                    }
                }
            }
        } catch (Throwable t) {
            Log.add(ctx, "매크로 게이트 확인 실패: " + t);
        }

        // 봇은 내 메시지에 반응하면 자기 말에 자기가 답하는 루프가 생긴다 → 내 메시지는 안 넘긴다
        if (!m.fromMe) {
            try {
                if (License.allowed(ctx, Features.ROOMBOT)) {
                    RoomBot.onMessage(ctx, m.room, m.sender, m.text, m.group);
                }
            } catch (Throwable t) {
                Log.add(ctx, "방 관리봇 처리 중 오류: " + t);
            }
            try {
                if (License.allowed(ctx, Features.MINIGAME)) {
                    MiniGame.onMessage(ctx, m.room, m.sender, m.text, m.group);
                }
            } catch (Throwable t) {
                Log.add(ctx, "미니게임봇 처리 중 오류: " + t);
            }
        }

        // 방 이름 캐시는 **디스패치 뒤에** 넣는다.
        // 자동응답의 "모르는 사람만" 판정이 isKnownRoom() 을 쓰기 때문에,
        // 먼저 캐시하면 처음 온 사람도 이미 아는 방으로 잡혀서 판정이 항상 거짓이 된다.
        remember(ctx, m.room);
    }

    // ── 파싱 ──────────────────────────────────────────────────────────────────

    /** 알림 하나에서 뽑아낸 한 건의 메시지 */
    private static final class Msg {
        String room = "";
        String sender = "";
        String text = "";
        boolean group = false;
        boolean fromMe = false;
        long at = 0L;
        String key = "";
    }

    private static Msg parse(Bundle ex, long postTime) {
        Msg m = new Msg();
        m.at = (postTime > 0) ? postTime : System.currentTimeMillis();

        String title = cs(ex.getCharSequence(Notification.EXTRA_TITLE));
        String convo = cs(ex.getCharSequence(Notification.EXTRA_CONVERSATION_TITLE));

        // 방 이름: conversationTitle 이 있으면 그게 방 이름, 없으면 title
        m.room = (convo.length() > 0) ? convo : title;
        m.group = ex.getBoolean(Notification.EXTRA_IS_GROUP_CONVERSATION, false);

        // 내 표시이름 (내 메시지 판정에 쓴다)
        String me = cs(ex.getCharSequence(Notification.EXTRA_SELF_DISPLAY_NAME));
        if (me.length() == 0 && Build.VERSION.SDK_INT >= 28) {
            me = personName(ex.getParcelable(Notification.EXTRA_MESSAGING_PERSON));
        }
        if (me.length() > 0) selfName = me;

        // android.messages 에서 마지막 한 건을 꺼낸다 (여기에 발신자가 들어있다)
        Bundle last = lastMessage(ex);
        if (last != null) {
            m.text = cs(last.getCharSequence("text"));
            String sender = personName(last.getParcelable("sender_person"));
            if (sender.length() == 0) sender = cs(last.getCharSequence("sender"));
            m.sender = sender;
            long t = last.getLong("time", 0L);
            if (t > 0) m.at = t;
        }

        if (m.text.length() == 0) m.text = cs(ex.getCharSequence(Notification.EXTRA_TEXT));
        if (m.sender.length() == 0) {
            // 1:1 은 방 이름 = 상대 이름. 그룹방은 title 이 방 이름이라 발신자를 모를 수 있다.
            m.sender = m.group ? "" : m.room;
        }

        // 그룹여부 플래그가 없는(구버전) 알림 보정: 방 이름과 발신자가 다르면 그룹으로 본다
        if (!ex.containsKey(Notification.EXTRA_IS_GROUP_CONVERSATION)
                && convo.length() > 0 && m.sender.length() > 0
                && !convo.equals(m.sender)) {
            m.group = true;
        }

        // 내 메시지인가: 발신자 == 내 표시이름, 또는 내 답장 이력에 같은 문장이 있음
        if (m.sender.length() > 0 && me.length() > 0 && m.sender.equals(me)) m.fromMe = true;
        if (!m.fromMe && inReplyHistory(ex, m.text)) m.fromMe = true;

        m.room = m.room.trim();
        m.sender = m.sender.trim();
        m.key = m.at + "|" + m.sender + "|" + m.text;
        return m;
    }

    /** android.messages 배열의 마지막 항목 */
    private static Bundle lastMessage(Bundle ex) {
        try {
            Parcelable[] arr = ex.getParcelableArray(Notification.EXTRA_MESSAGES);
            if (arr == null || arr.length == 0) return null;
            for (int i = arr.length - 1; i >= 0; i--) {
                if (arr[i] instanceof Bundle) {
                    Bundle b = (Bundle) arr[i];
                    if (cs(b.getCharSequence("text")).length() > 0) return b;
                }
            }
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "android.messages 파싱 실패", t);
        }
        return null;
    }

    /** 내가 알림 답장창으로 보낸 이력에 이 문장이 있나 */
    private static boolean inReplyHistory(Bundle ex, String text) {
        if (text == null || text.length() == 0) return false;
        try {
            // 상수(EXTRA_REMOTE_INPUT_HISTORY)는 버전에 따라 공개/비공개가 갈려서 문자열로 직접 쓴다
            CharSequence[] hist = ex.getCharSequenceArray("android.remoteInputHistory");
            if (hist == null) return false;
            for (int i = 0; i < hist.length; i++) {
                if (hist[i] != null && text.equals(hist[i].toString())) return true;
            }
        } catch (Throwable t) { /* 없으면 없는 거다 */ }
        return false;
    }

    /**
     * android.app.Person 의 이름. Person 은 API 28 부터라 타입을 직접 안 쓰고 리플렉션으로 읽는다
     * (minSdk 26 에서 클래스 검증 경고를 안 만들려고).
     */
    private static String personName(Object p) {
        if (p == null) return "";
        try {
            Object v = p.getClass().getMethod("getName").invoke(p);
            return (v == null) ? "" : v.toString().trim();
        } catch (Throwable t) {
            return "";
        }
    }

    private static String cs(CharSequence v) {
        return (v == null) ? "" : v.toString().trim();
    }

    // ── 답장 액션 찾기 ────────────────────────────────────────────────────────

    private static final class Reply {
        PendingIntent pending;
        RemoteInput[] inputs;
    }

    /** 알림의 액션들 중 자유 입력이 가능한 RemoteInput 액션을 찾는다 */
    private static Reply findReply(Notification n) {
        Notification.Action[] acts = n.actions;
        if (acts == null) return null;
        Reply any = null;
        for (int i = 0; i < acts.length; i++) {
            Notification.Action a = acts[i];
            if (a == null || a.actionIntent == null) continue;
            RemoteInput[] ris = a.getRemoteInputs();
            if (ris == null || ris.length == 0) continue;
            Reply r = new Reply();
            r.pending = a.actionIntent;
            r.inputs = ris;
            for (int j = 0; j < ris.length; j++) {
                if (ris[j] != null && ris[j].getAllowFreeFormInput()) return r;  // 이게 답장창이다
            }
            if (any == null) any = r;
        }
        return any;
    }

    // ── 발송 ──────────────────────────────────────────────────────────────────

    /**
     * 그 방의 알림 답장창으로 메시지를 보낸다.
     * 세션이 없으면(= 그 방 카톡 알림을 아직 못 봤으면) 보낼 방법이 없다 → false.
     */
    public static boolean sendTo(Context ctx, String room, String text) {
        String r = (room == null) ? "" : room.trim();
        if (r.length() == 0) {
            Log.add(ctx, "발송 실패: 방 이름이 비어있어");
            return false;
        }
        if (text == null || text.trim().length() == 0) {
            Log.add(ctx, "발송 실패: 「" + r + "」 보낼 내용이 비어있어");
            return false;
        }
        Session s = SESSIONS.get(r);
        if (s == null || s.pending == null || s.inputs == null || s.inputs.length == 0) {
            Log.add(ctx, "발송 실패: 「" + r + "」 방 세션이 없어(그 방 카톡 알림이 와야 발송 가능)");
            return false;
        }
        if (!bound) {
            Log.add(ctx, "발송 실패: 「" + r + "」 알림 읽기 권한이 꺼져 있어 — 설정에서 켜줘");
            return false;
        }

        PendingIntent pi = s.pending;
        RemoteInput[] inputs = s.inputs;
        try {
            Intent filled = new Intent();
            Bundle results = new Bundle();
            for (int i = 0; i < inputs.length; i++) {
                if (inputs[i] == null) continue;
                String key = inputs[i].getResultKey();
                if (key == null || key.length() == 0) continue;
                results.putCharSequence(key, text);
            }
            if (results.isEmpty()) {
                Log.add(ctx, "발송 실패: 「" + r + "」 답장 입력칸을 못 찾았어");
                return false;
            }
            RemoteInput.addResultsToIntent(inputs, filled, results);
            if (Build.VERSION.SDK_INT >= 28) {
                // 카톡이 "사람이 직접 입력한 답장"으로 인식하게 출처를 붙인다
                RemoteInput.setResultsSource(filled, RemoteInput.SOURCE_FREE_FORM_INPUT);
            }
            pi.send(ctx, 0, filled);

            long now = System.currentTimeMillis();
            s.lastMine = now;
            s.othersSinceMine = 0;
            s.lastSentText = text;
            Log.add(ctx, "「" + r + "」 발송 완료: " + preview(text));
            return true;
        } catch (PendingIntent.CanceledException e) {
            // 카톡이 그 알림을 치웠다 → 세션은 죽은 거다. 다음 알림에서 되살아난다.
            s.pending = null;
            s.inputs = null;
            Log.add(ctx, "발송 실패: 「" + r + "」 답장창이 만료됐어(카톡 알림이 다시 와야 해)");
            return false;
        } catch (Throwable t) {
            Log.add(ctx, "발송 실패: 「" + r + "」 " + t);
            return false;
        }
    }

    private static String preview(String text) {
        String one = text.replace('\n', ' ').replace('\r', ' ').trim();
        if (one.length() <= 24) return one;
        return one.substring(0, 24) + "…";
    }

    // ── 조회용 API ────────────────────────────────────────────────────────────

    /** 내 마지막 발송 뒤 그 방에 남이 올린 메시지 수. 세션이 없으면 0. */
    public static int othersSinceMine(String room) {
        Session s = session(room);
        return (s == null) ? 0 : s.othersSinceMine;
    }

    /** 내가 그 방으로 마지막으로 보낸 시각 (epoch ms). 없으면 0. */
    public static long lastMineAt(String room) {
        Session s = session(room);
        return (s == null) ? 0L : s.lastMine;
    }

    /** 그 방 알림을 마지막으로 본 시각 (epoch ms). 없으면 0. */
    public static long lastSeenAt(String room) {
        Session s = session(room);
        return (s == null) ? 0L : s.lastAt;
    }

    /** 지금 그 방으로 발송할 수 있나 (= 살아있는 답장창이 있나) */
    public static boolean hasSession(String room) {
        Session s = session(room);
        return s != null && s.pending != null && s.inputs != null && s.inputs.length > 0;
    }

    public static Session session(String room) {
        if (room == null) return null;
        return SESSIONS.get(room.trim());
    }

    /** 세션이 너무 쌓이면 오래 본 적 없는 방부터 버린다 (방금 만든 방은 남긴다) */
    private static void trimSessions(String keep) {
        while (SESSIONS.size() > MAX_SESSIONS) {
            String oldest = null;
            long oldestAt = Long.MAX_VALUE;
            Iterator<Map.Entry<String, Session>> it = SESSIONS.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Session> e = it.next();
                Session s = e.getValue();
                if (s == null) { it.remove(); continue; }
                if (e.getKey().equals(keep)) continue;
                if (s.lastAt < oldestAt) { oldestAt = s.lastAt; oldest = e.getKey(); }
            }
            if (oldest == null) return;
            SESSIONS.remove(oldest);
        }
    }

    /** 발송 가능한 방 이름들 (지금 세션이 살아있는 방만) */
    public static List<String> liveRooms() {
        ArrayList<String> out = new ArrayList<String>();
        Iterator<Map.Entry<String, Session>> it = SESSIONS.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, Session> e = it.next();
            Session s = e.getValue();
            if (s != null && s.pending != null && s.inputs != null && s.inputs.length > 0) {
                out.add(e.getKey());
            }
        }
        return out;
    }

    /** 마지막으로 본 내 표시이름. 모르면 "". */
    public static String selfName() {
        return (selfName == null) ? "" : selfName;
    }

    /** 알림 읽기 권한이 실제로 붙어 있나 (설정에 체크돼 있는지는 connected(ctx) 로 확인) */
    public static boolean listenerBound() {
        return bound;
    }

    /** 시스템 설정에서 이 앱에 알림 읽기 권한이 허용돼 있나 */
    public static boolean connected(Context c) {
        if (c == null) return false;
        try {
            String enabled = android.provider.Settings.Secure.getString(
                    c.getContentResolver(), "enabled_notification_listeners");
            if (enabled == null || enabled.length() == 0) return false;
            return enabled.contains(c.getPackageName());
        } catch (Throwable t) {
            return bound;
        }
    }

    // ── 방 이름 캐시 (평문 Prefs · 이름만 · 최대 50개) ────────────────────────

    /** 최근 감지된 방 이름 (최신이 앞). 설정 화면의 방 선택 목록에 쓴다. */
    public static List<String> knownRooms(Context c) {
        loadRooms(c);
        ArrayList<String> out = new ArrayList<String>();
        synchronized (ROOMS) {
            out.addAll(ROOMS);
        }
        java.util.Collections.reverse(out);   // 최근에 본 방이 위로
        return out;
    }

    /**
     * Context 없이 호출하는 버전. 가능하면 knownRooms(ctx) 를 써라 —
     * 이건 리스너가 한 번도 안 돌았고 앱 컨텍스트도 못 구한 상황에서 빈 목록이 나온다.
     */
    public static List<String> knownRooms() {
        return knownRooms(appContext());
    }

    /** 그 방을 전에 본 적 있나. 자동응답의 "모르는 사람만" 판정에 쓴다. */
    public static boolean isKnownRoom(String room) {
        if (room == null) return false;
        String r = room.trim();
        if (r.length() == 0) return false;
        loadRooms(appContext());
        synchronized (ROOMS) {
            return ROOMS.contains(r);
        }
    }

    /** 방 이름 캐시를 비운다 (내정보 탭의 초기화용) */
    public static void clearRooms(Context c) {
        synchronized (ROOMS) {
            ROOMS.clear();
            roomsLoaded = true;
        }
        Prefs.remove(c, K_ROOMS);
    }

    private static void remember(Context c, String room) {
        if (room == null) return;
        String r = room.trim();
        if (r.length() == 0) return;
        loadRooms(c);
        boolean changed;
        synchronized (ROOMS) {
            // 이미 맨 뒤(=가장 최근)면 건드릴 게 없다 → 알림마다 Prefs 를 쓰지 않는다
            String newest = null;
            Iterator<String> tail = ROOMS.iterator();
            while (tail.hasNext()) newest = tail.next();
            if (r.equals(newest)) return;

            // LinkedHashSet 은 재삽입해도 순서가 안 바뀐다 → 최근 순서를 유지하려면 지우고 다시 넣는다
            ROOMS.remove(r);
            ROOMS.add(r);
            while (ROOMS.size() > MAX_ROOMS) {
                Iterator<String> it = ROOMS.iterator();
                if (!it.hasNext()) break;
                it.next();
                it.remove();
            }
            changed = true;
        }
        if (changed) saveRooms(c);
    }

    private static void loadRooms(Context c) {
        if (roomsLoaded) return;
        synchronized (ROOMS) {
            if (roomsLoaded) return;
            roomsLoaded = true;
            if (c == null) { roomsLoaded = false; return; }   // 컨텍스트가 생기면 다시 시도한다
            try {
                String raw = Prefs.getStr(c, K_ROOMS, null);
                if (raw == null || raw.length() == 0) return;
                String[] parts = raw.split("\n");
                for (int i = 0; i < parts.length; i++) {
                    String s = parts[i].trim();
                    if (s.length() > 0) ROOMS.add(s);
                }
                while (ROOMS.size() > MAX_ROOMS) {
                    Iterator<String> it = ROOMS.iterator();
                    if (!it.hasNext()) break;
                    it.next();
                    it.remove();
                }
            } catch (Throwable t) {
                Log.add(c, "방 목록을 불러오지 못했어: " + t);
            }
        }
    }

    private static void saveRooms(Context c) {
        if (c == null) return;
        StringBuilder sb = new StringBuilder(256);
        synchronized (ROOMS) {
            Iterator<String> it = ROOMS.iterator();
            while (it.hasNext()) {
                sb.append(it.next());
                if (it.hasNext()) sb.append('\n');
            }
        }
        Prefs.putStr(c, K_ROOMS, sb.toString());
    }

    /**
     * 앱 컨텍스트. 서비스가 한 번이라도 떴으면 그걸 쓰고, 아니면 프레임워크에서 꺼내본다.
     * (라이브러리 없이 Context 없는 static 호출을 받아주려면 이 방법밖에 없다)
     */
    private static Context appContext() {
        Context c = APP;
        if (c != null) return c;
        try {
            Object app = Class.forName("android.app.ActivityThread")
                    .getMethod("currentApplication").invoke(null);
            if (app instanceof Context) {
                APP = ((Context) app).getApplicationContext();
                return APP;
            }
        } catch (Throwable t) { /* 못 구하면 못 구하는 거다 */ }
        return null;
    }
}
