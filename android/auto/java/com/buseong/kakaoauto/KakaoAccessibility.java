package com.buseong.kakaoauto;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Intent;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;

/**
 * 카톡 공유 화면 자동 조작.
 *
 * 알림 RemoteInput 으로는 사진을 못 보낸다. 그래서 {@link ImageSender} 가
 * ACTION_SEND_MULTIPLE 로 카톡 공유창을 띄우고, 이 서비스가 그 창에서
 * "방 이름 탭 → 전송 버튼 탭" 을 대신 눌러준다.
 *
 * 규칙 하나만 지킨다 — <b>armed 아닐 때는 아무것도 안 한다.</b>
 * 사용자가 평소에 카톡 쓰는 걸 방해하면 안 되니까, 이미지 전송을 예약한
 * 그 몇십 초 동안만 카톡 화면을 본다.
 *
 * 카톡은 버전마다 UI 가 바뀐다. 그래서 텍스트/설명/viewId 후보를 아래 상수 배열에
 * 모아두고 순서대로 시도하고, 다 실패하면 사용자가 원인을 알 수 있게 로그를 남긴다.
 */
public final class KakaoAccessibility extends AccessibilityService {

    /** 전송이 끝났을 때(성공/실패) 알려줄 콜백. ImageSender 가 꽂는다. */
    public interface Result {
        void done(boolean ok, String detail);
    }

    private static final String KAKAO = "com.kakao.talk";

    /** arm 할 때 타임아웃을 안 주면 쓰는 기본값 */
    public static final long DEFAULT_TIMEOUT_MS = 40000L;

    // ── 라벨 후보 (하드코딩 금지 — 전부 여기 모아둔다) ──────────────────────────
    /** 공유창의 전송/보내기 버튼 후보 */
    static final String[] SEND = { "전송", "보내기", "확인", "Send", "완료" };
    /** 방을 못 찾았을 때 쓸 검색창 힌트 후보 */
    static final String[] SEARCH_HINT = { "이름, 채팅방", "검색", "이름 검색", "채팅방 검색", "Search" };
    /** 한 번 더 확인을 물어볼 때의 버튼 후보 */
    static final String[] CONFIRM = { "확인", "완료", "OK", "보내기" };

    /** 전송 버튼 viewId 후보. 없으면 텍스트로 폴백한다. */
    static final String[] SEND_IDS = {
            "com.kakao.talk:id/confirm",
            "com.kakao.talk:id/btn_send",
            "com.kakao.talk:id/send",
            "com.kakao.talk:id/ok",
            "com.kakao.talk:id/toolbar_right_button",
            "com.kakao.talk:id/menu_send",
            "com.kakao.talk:id/bottom_confirm"
    };
    /** 검색 입력창 viewId 후보 */
    static final String[] SEARCH_IDS = {
            "com.kakao.talk:id/search_text",
            "com.kakao.talk:id/search_bar",
            "com.kakao.talk:id/edit_search",
            "com.kakao.talk:id/search_edit",
            "com.kakao.talk:id/et_search"
    };
    /** 방 이름이 들어있는 목록 행 viewId 후보 (참고용 — 텍스트 매칭이 먼저다) */
    static final String[] ROOM_IDS = {
            "com.kakao.talk:id/name",
            "com.kakao.talk:id/title",
            "com.kakao.talk:id/tv_name",
            "com.kakao.talk:id/chat_room_name"
    };
    /** 채팅방 안으로 넘어갔는지 판단할 입력창 viewId 후보 */
    static final String[] CHATROOM_IDS = {
            "com.kakao.talk:id/message_edit_text",
            "com.kakao.talk:id/chat_edit_text",
            "com.kakao.talk:id/edit_text"
    };

    // ── 탐색 한도 (이상한 트리에서 멈추지 않게) ─────────────────────────────────
    private static final int MAX_NODES = 2000;
    /** 한 단계(phase)에서 연속 실패 허용 횟수 */
    private static final int MAX_MISS = 12;
    /** 재시도 간격 */
    private static final long RETRY_MS = 400L;
    /** 같은 창에서 이 시간 안에 또 온 이벤트는 무시 (이벤트 폭주 방지) */
    private static final long DEDUPE_MS = 100L;
    /** 검색창 입력 재시도 허용 횟수 */
    private static final int MAX_SEARCH_TRY = 2;

    // ── 예약(armed) 상태 — 서비스 인스턴스와 별개로 살아있어야 해서 static ────────
    private static volatile KakaoAccessibility INSTANCE = null;
    private static volatile boolean armed = false;
    /** 카톡 화면을 마지막으로 본 시각 (0 = 한 번도 못 봄). 공유창이 떴는지 진단용. */
    private static volatile long lastKakaoWindowAt = 0L;

    /** since 이후로 카톡 화면을 본 적 있나 */
    public static boolean sawKakaoSince(long since) {
        return lastKakaoWindowAt >= since;
    }
    private static volatile String targetRoom = null;
    private static volatile long armedUntil = 0L;
    private static volatile Result callback = null;
    /** 0 = 방 고르기, 1 = 전송 버튼 누르기 */
    private static volatile int phase = 0;
    private static volatile int miss = 0;
    /** 지금 단계를 시작한 시각. 이벤트가 쏟아져도 너무 빨리 포기하지 않게 쓴다. */
    private static volatile long phaseAt = 0L;
    private static volatile int searchTry = 0;
    private static volatile String lastWinKey = "";
    private static volatile long lastWinAt = 0L;

    private final Handler h = new Handler(Looper.getMainLooper());

    // ── 공개 API ────────────────────────────────────────────────────────────

    /** 기본 타임아웃으로 예약 */
    public static void arm(String room) {
        arm(room, DEFAULT_TIMEOUT_MS, null);
    }

    /** "다음에 뜨는 카톡 공유창에서 이 방을 골라라" 예약 */
    public static void arm(String room, long timeoutMs) {
        arm(room, timeoutMs, null);
    }

    /**
     * 예약 + 끝났을 때 받을 콜백 지정.
     * 이전 예약이 남아있으면 조용히 덮어쓴다(ImageSender 가 한 번에 한 건만 돌린다).
     */
    public static void arm(String room, long timeoutMs, Result cb) {
        String r = (room == null) ? "" : room.trim();
        long t = (timeoutMs <= 0) ? DEFAULT_TIMEOUT_MS : timeoutMs;

        targetRoom = r;
        armedUntil = System.currentTimeMillis() + t;
        callback = cb;
        phase = 0;
        miss = 0;
        phaseAt = System.currentTimeMillis();
        searchTry = 0;
        lastWinKey = "";
        lastWinAt = 0L;
        armed = true;

        KakaoAccessibility me = INSTANCE;
        if (me == null) {
            Log.add(null, "접근성 서비스가 아직 안 붙었어 — 공유창을 자동으로 못 누를 수 있어");
            return;
        }
        Log.add(me, "카톡 공유창 자동 조작 예약했어 — 방: " + r);
        me.kick(700L);   // 이벤트를 놓쳐도 스스로 한 번은 찾아본다
    }

    /** 예약 해제. 콜백은 부르지 않는다 (호출한 쪽이 이미 결과를 안다). */
    public static void disarm() {
        KakaoAccessibility me = INSTANCE;
        if (me != null) {
            try { me.h.removeCallbacksAndMessages(null); } catch (Throwable ignore) { }
        }
        clear();
    }

    /** 지금 예약 상태인가. 시간이 지났으면 스스로 풀린다. */
    public static boolean isArmed() {
        if (!armed) return false;
        if (System.currentTimeMillis() > armedUntil) {
            clear();
            return false;
        }
        return true;
    }

    /** 서비스가 실제로 붙어있나 (설정 목록보다 이게 확실하다) */
    public static boolean connected() {
        return INSTANCE != null;
    }

    /** 지금 노리고 있는 방 이름. 예약 없으면 "" */
    public static String armedRoom() {
        String r = targetRoom;
        return (r == null || !armed) ? "" : r;
    }

    private static void clear() {
        armed = false;
        targetRoom = null;
        armedUntil = 0L;
        callback = null;
        phase = 0;
        miss = 0;
        phaseAt = 0L;
        searchTry = 0;
        lastWinKey = "";
        lastWinAt = 0L;
    }

    // ── 서비스 수명주기 ──────────────────────────────────────────────────────

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        INSTANCE = this;
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info == null) info = new AccessibilityServiceInfo();
            info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                    | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED;
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
            info.notificationTimeout = 100;
            info.packageNames = new String[] { KAKAO };
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                    | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            setServiceInfo(info);
        } catch (Throwable t) {
            Log.add(this, "접근성 서비스 설정 적용 실패 — " + t.getClass().getSimpleName()
                    + " (기본 설정으로 계속 갈게)");
        }
        Log.add(this, "접근성 서비스 켜졌어 — 이미지 전송 쓸 수 있어");
        if (isArmed()) kick(500L);
    }

    @Override
    public void onInterrupt() {
        // 시스템이 서비스를 잠깐 멈출 때 온다. 진행 중이던 예약은 못 끝내니까 실패로 정리.
        if (isArmed()) {
            finish(false, "접근성 서비스가 중단됐어");
        } else {
            Log.add(this, "접근성 서비스가 잠깐 중단됐어");
        }
    }

    @Override
    public boolean onUnbind(Intent intent) {
        if (isArmed()) finish(false, "접근성 권한이 꺼졌어");
        if (INSTANCE == this) INSTANCE = null;
        Log.add(this, "접근성 서비스 꺼졌어 — 이미지 전송은 안 돼");
        try {
            h.removeCallbacksAndMessages(null);
        } catch (Throwable ignore) { }
        return super.onUnbind(intent);
    }

    @Override
    public void onDestroy() {
        if (INSTANCE == this) INSTANCE = null;
        try {
            h.removeCallbacksAndMessages(null);
        } catch (Throwable ignore) { }
        super.onDestroy();
    }

    // ── 이벤트 ──────────────────────────────────────────────────────────────

    @Override
    public void onAccessibilityEvent(AccessibilityEvent e) {
        if (e == null) return;
        if (!isArmed()) return;             // ★ 예약 없으면 손대지 않는다

        CharSequence pkg = null;
        try { pkg = e.getPackageName(); } catch (Throwable ignore) { }
        if (pkg == null || !KAKAO.contentEquals(pkg)) return;

        // 카톡 화면을 실제로 봤다는 표시. 공유창이 아예 안 뜬 경우와
        // 떴는데 방을 못 고른 경우를 구분하는 데 쓴다 (ImageSender 진단).
        lastKakaoWindowAt = System.currentTimeMillis();

        int type;
        try { type = e.getEventType(); } catch (Throwable ignore) { return; }
        if (type != AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                && type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED) return;

        // 같은 창에서 100ms 안에 또 오면 스킵 (카톡은 content_changed 를 쏟아낸다)
        int winId = -1;
        try { winId = e.getWindowId(); } catch (Throwable ignore) { }
        String key = winId + "|" + type;
        long now = SystemClock.uptimeMillis();
        if (key.equals(lastWinKey) && (now - lastWinAt) < DEDUPE_MS) return;
        lastWinKey = key;
        lastWinAt = now;

        // 새 창이 떴으면 그 화면에서 다시 12번 볼 기회를 준다
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            miss = 0;
            phaseAt = System.currentTimeMillis();
        }

        kick(0L);
    }

    /** 다음 탐색을 예약한다 (중복 예약 안 쌓이게 기존 건 지운다) */
    private void kick(long delayMs) {
        try {
            h.removeCallbacks(STEP);
            h.postDelayed(STEP, delayMs < 0 ? 0 : delayMs);
        } catch (Throwable t) {
            Log.add(this, "자동 조작 예약 실패 — " + t.getClass().getSimpleName());
        }
    }

    private final Runnable STEP = new Runnable() {
        @Override public void run() { step(); }
    };

    // ── 본체 ────────────────────────────────────────────────────────────────

    private void step() {
        if (!isArmed()) return;

        AccessibilityNodeInfo root = null;
        try {
            root = getRootInActiveWindow();
        } catch (Throwable t) {
            Log.add(this, "카톡 화면을 읽다 실패했어 — " + t.getClass().getSimpleName());
        }
        if (root == null) { retry(); return; }

        CharSequence rp = null;
        try { rp = root.getPackageName(); } catch (Throwable ignore) { }
        if (rp != null && !KAKAO.contentEquals(rp)) {
            // 카톡이 아직 앞에 안 왔다. 기다린다.
            retry();
            return;
        }

        try {
            if (phase == 0) {
                if (pickRoom(root)) {
                    phase = 1;
                    miss = 0;
                    phaseAt = System.currentTimeMillis();
                    kick(600L);
                    return;
                }
                if (searchTry < MAX_SEARCH_TRY && typeSearch(root)) {
                    searchTry++;
                    miss = 0;
                    phaseAt = System.currentTimeMillis();
                    kick(800L);
                    return;
                }
                retry();
            } else {
                if (pressSend(root)) {
                    finish(true, targetRoom);
                    return;
                }
                // 전송 버튼이 안 보이는데 이미 채팅방으로 넘어갔으면 보내진 걸로 본다.
                // (카톡 일부 버전은 방을 누르는 순간 바로 보낸다)
                if (miss >= 6 && inChatRoom(root)) {
                    Log.add(this, "전송 버튼은 못 찾았는데 채팅방으로 넘어갔어 — 보내진 걸로 볼게. 카톡에서 확인해줘");
                    finish(true, targetRoom);
                    return;
                }
                retry();
            }
        } catch (Throwable t) {
            Log.add(this, "카톡 화면 자동 조작 중 오류 — " + t.getClass().getSimpleName()
                    + ": " + String.valueOf(t.getMessage()));
            retry();
        }
    }

    private void retry() {
        miss++;
        // 카톡은 typeWindowContentChanged 를 초당 몇 번씩 쏘기 때문에 횟수만 보면
        // 화면이 다 그려지기도 전에 포기해버린다. 그래서 최소 경과시간도 같이 본다.
        long spent = System.currentTimeMillis() - phaseAt;
        if (miss > MAX_MISS && spent >= MAX_MISS * RETRY_MS) {
            String where = (phase == 0) ? "방 목록에서 \"" + targetRoom + "\" 을 못 찾았어"
                                        : "전송 버튼을 못 찾았어";
            Log.add(this, "카톡 화면을 못 찾았어 — 카톡 버전이 바뀌었을 수 있어 (" + where + ")");
            finish(false, "카톡 화면을 못 찾았어 — 카톡 버전이 바뀌었을 수 있어");
            return;
        }
        kick(RETRY_MS);
    }

    /** 성공/실패 정리 + 콜백 1회 */
    private void finish(boolean ok, String detail) {
        Result cb = callback;
        String room = targetRoom;
        try { h.removeCallbacksAndMessages(null); } catch (Throwable ignore) { }
        clear();

        if (ok) Log.add(this, "이미지 전송 완료 — " + room);
        else Log.add(this, "이미지 전송 실패 — " + detail);

        if (cb != null) {
            try {
                cb.done(ok, detail);
            } catch (Throwable t) {
                Log.add(this, "전송 결과 콜백에서 오류 — " + t.getClass().getSimpleName());
            }
        }
    }

    // ── 단계별 동작 ──────────────────────────────────────────────────────────

    /** 공유창 목록에서 방 이름을 찾아 누른다 */
    private boolean pickRoom(AccessibilityNodeInfo root) {
        final String room = targetRoom;
        if (room == null || room.length() == 0) return false;

        // 1) 텍스트 정확히 일치
        AccessibilityNodeInfo n = findByTextExact(root, room);
        // 2) contentDescription 정확히 일치
        if (n == null) n = findByDesc(root, room, true);
        // 3) 잎 노드 부분 일치 (방 이름 뒤에 인원수가 붙는 경우가 있다)
        if (n == null) n = findByTextContains(root, room);
        if (n == null) return false;

        // 검색 입력창에 방 이름을 넣어둔 상태면 그 입력창이 잡힌다 — 그건 누르면 안 된다
        if (isEditable(n)) return false;

        if (!clickUp(n)) return false;
        Log.add(this, "공유창에서 방 찾았어 — " + room);
        return true;
    }

    /** 방을 못 찾았을 때: 검색창에 방 이름을 넣어본다 */
    private boolean typeSearch(AccessibilityNodeInfo root) {
        final String room = targetRoom;
        if (room == null || room.length() == 0) return false;

        AccessibilityNodeInfo box = null;
        for (int i = 0; i < SEARCH_IDS.length && box == null; i++) {
            box = findByViewId(root, SEARCH_IDS[i]);
        }
        if (box == null) box = findEditable(root);
        if (box == null) {
            for (int i = 0; i < SEARCH_HINT.length && box == null; i++) {
                box = findByTextContains(root, SEARCH_HINT[i]);
                if (box == null) box = findByDesc(root, SEARCH_HINT[i], false);
            }
        }
        if (box == null) return false;

        if (!isEditable(box)) {
            // 검색 아이콘/힌트 라벨일 수 있다. 눌러서 입력창을 띄워만 본다.
            boolean opened = clickUp(box);
            if (opened) Log.add(this, "방이 안 보여서 검색을 열었어");
            return opened;
        }

        try {
            box.performAction(AccessibilityNodeInfo.ACTION_FOCUS);
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, room);
            boolean ok = box.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
            if (ok) Log.add(this, "방이 안 보여서 검색창에 \"" + room + "\" 넣어봤어");
            else Log.add(this, "검색창에 글자를 못 넣었어 — 직접 눌러봐야 할 수도 있어");
            return ok;
        } catch (Throwable t) {
            Log.add(this, "검색창 입력 실패 — " + t.getClass().getSimpleName());
            return false;
        }
    }

    /** 전송/확인 버튼을 찾아 누른다 */
    private boolean pressSend(AccessibilityNodeInfo root) {
        // 1) viewId 후보
        for (int i = 0; i < SEND_IDS.length; i++) {
            AccessibilityNodeInfo n = findByViewId(root, SEND_IDS[i]);
            if (n != null && clickUp(n)) {
                Log.add(this, "전송 버튼 눌렀어 (" + SEND_IDS[i] + ")");
                return true;
            }
        }
        // 2) 텍스트/설명 정확히 일치
        for (int i = 0; i < SEND.length; i++) {
            AccessibilityNodeInfo n = findByTextExact(root, SEND[i]);
            if (n == null) n = findByDesc(root, SEND[i], true);
            if (n != null && !isEditable(n) && clickUp(n)) {
                Log.add(this, "전송 버튼 눌렀어 (" + SEND[i] + ")");
                return true;
            }
        }
        // 3) 접두 매칭 — "전송 (1)", "확인 3" 같은 표기
        for (int i = 0; i < SEND.length; i++) {
            AccessibilityNodeInfo n = findByTextPrefix(root, SEND[i]);
            if (n != null && !isEditable(n) && clickUp(n)) {
                Log.add(this, "전송 버튼 눌렀어 (" + SEND[i] + "…)");
                return true;
            }
        }
        // 4) 마지막으로 확인 버튼 후보
        for (int i = 0; i < CONFIRM.length; i++) {
            AccessibilityNodeInfo n = findByTextExact(root, CONFIRM[i]);
            if (n == null) n = findByDesc(root, CONFIRM[i], true);
            if (n != null && !isEditable(n) && clickUp(n)) {
                Log.add(this, "확인 버튼 눌렀어 (" + CONFIRM[i] + ")");
                return true;
            }
        }
        return false;
    }

    /** 지금 화면이 채팅방(입력창이 있는 화면) 인가 */
    private boolean inChatRoom(AccessibilityNodeInfo root) {
        for (int i = 0; i < CHATROOM_IDS.length; i++) {
            if (findByViewId(root, CHATROOM_IDS[i]) != null) return true;
        }
        return false;
    }

    // ── 노드 탐색 유틸 ────────────────────────────────────────────────────────

    private interface Test {
        boolean ok(AccessibilityNodeInfo n);
    }

    /** 너비 우선 탐색. 얕은 노드가 먼저 걸린다. 노드 수 상한이 있다. */
    private static AccessibilityNodeInfo find(AccessibilityNodeInfo root, Test t) {
        if (root == null || t == null) return null;
        ArrayList<AccessibilityNodeInfo> q = new ArrayList<AccessibilityNodeInfo>(64);
        q.add(root);
        int seen = 0;
        for (int i = 0; i < q.size(); i++) {
            if (seen++ > MAX_NODES) break;
            AccessibilityNodeInfo n = q.get(i);
            if (n == null) continue;
            try {
                if (t.ok(n)) return n;
            } catch (Throwable ignore) { }
            int cc = 0;
            try { cc = n.getChildCount(); } catch (Throwable ignore) { }
            for (int k = 0; k < cc; k++) {
                AccessibilityNodeInfo ch = null;
                try { ch = n.getChild(k); } catch (Throwable ignore) { }
                if (ch != null) q.add(ch);
            }
        }
        return null;
    }

    /** text 가 정확히 일치하는 노드 */
    static AccessibilityNodeInfo findByTextExact(AccessibilityNodeInfo root, String s) {
        final String want = norm(s);
        if (want.length() == 0) return null;
        return find(root, new Test() {
            @Override public boolean ok(AccessibilityNodeInfo n) {
                return want.equalsIgnoreCase(norm(text(n)));
            }
        });
    }

    /** text 에 s 가 들어있는 노드. 잎 노드를 먼저 본다(부모가 자식 텍스트를 합쳐 갖는 경우 회피). */
    static AccessibilityNodeInfo findByTextContains(AccessibilityNodeInfo root, String s) {
        final String want = norm(s).toLowerCase();
        if (want.length() == 0) return null;
        AccessibilityNodeInfo leaf = find(root, new Test() {
            @Override public boolean ok(AccessibilityNodeInfo n) {
                int cc;
                try { cc = n.getChildCount(); } catch (Throwable t) { cc = 0; }
                if (cc != 0) return false;
                String got = norm(text(n)).toLowerCase();
                return got.length() > 0 && got.contains(want);
            }
        });
        if (leaf != null) return leaf;
        return find(root, new Test() {
            @Override public boolean ok(AccessibilityNodeInfo n) {
                String got = norm(text(n)).toLowerCase();
                return got.length() > 0 && got.contains(want);
            }
        });
    }

    /** text 가 s 로 시작하는 노드 ("전송 (1)" 같은 표기 대응) */
    static AccessibilityNodeInfo findByTextPrefix(AccessibilityNodeInfo root, String s) {
        final String want = norm(s).toLowerCase();
        if (want.length() == 0) return null;
        return find(root, new Test() {
            @Override public boolean ok(AccessibilityNodeInfo n) {
                String got = norm(text(n)).toLowerCase();
                return got.length() > 0 && got.startsWith(want);
            }
        });
    }

    /** contentDescription 으로 찾기. exact=false 면 부분 일치. */
    static AccessibilityNodeInfo findByDesc(AccessibilityNodeInfo root, String s, final boolean exact) {
        final String want = norm(s).toLowerCase();
        if (want.length() == 0) return null;
        return find(root, new Test() {
            @Override public boolean ok(AccessibilityNodeInfo n) {
                String got = norm(desc(n)).toLowerCase();
                if (got.length() == 0) return false;
                return exact ? got.equals(want) : got.contains(want);
            }
        });
    }

    /** viewIdResourceName 으로 찾기 (보이고 눌릴 만한 노드만) */
    static AccessibilityNodeInfo findByViewId(AccessibilityNodeInfo root, String id) {
        final String want = (id == null) ? "" : id.trim();
        if (want.length() == 0) return null;
        return find(root, new Test() {
            @Override public boolean ok(AccessibilityNodeInfo n) {
                if (!want.equals(viewId(n))) return false;
                try {
                    if (!n.isVisibleToUser()) return false;
                } catch (Throwable ignore) { }
                return true;
            }
        });
    }

    /** 글자를 넣을 수 있는 노드 (검색창) */
    static AccessibilityNodeInfo findEditable(AccessibilityNodeInfo root) {
        return find(root, new Test() {
            @Override public boolean ok(AccessibilityNodeInfo n) {
                if (!isEditable(n)) return false;
                try {
                    if (!n.isVisibleToUser()) return false;
                } catch (Throwable ignore) { }
                return true;
            }
        });
    }

    /**
     * 이 노드부터 위로 올라가며 ACTION_CLICK 가능한 조상을 찾아 누른다.
     * 텍스트 노드 자체는 보통 clickable 이 아니고 그 부모 행이 clickable 이다.
     */
    static boolean clickUp(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo cur = n;
        for (int up = 0; up < 8 && cur != null; up++) {
            boolean clickable = false;
            boolean enabled = true;
            try { clickable = cur.isClickable(); } catch (Throwable ignore) { }
            try { enabled = cur.isEnabled(); } catch (Throwable ignore) { }
            if (clickable && enabled) {
                try {
                    if (cur.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
                } catch (Throwable ignore) { }
            }
            AccessibilityNodeInfo p = null;
            try { p = cur.getParent(); } catch (Throwable ignore) { }
            cur = p;
        }
        // clickable 조상이 없어도 그냥 눌러본다 (응답하는 뷰가 더러 있다)
        try {
            return n != null && n.performAction(AccessibilityNodeInfo.ACTION_CLICK);
        } catch (Throwable t) {
            return false;
        }
    }

    // ── 값 꺼내기 (전부 예외 안전) ─────────────────────────────────────────────

    static String text(AccessibilityNodeInfo n) {
        if (n == null) return "";
        CharSequence t = null;
        try { t = n.getText(); } catch (Throwable ignore) { }
        if (t == null || t.length() == 0) {
            try { t = n.getContentDescription(); } catch (Throwable ignore) { }
        }
        return (t == null) ? "" : t.toString();
    }

    static String desc(AccessibilityNodeInfo n) {
        if (n == null) return "";
        CharSequence t = null;
        try { t = n.getContentDescription(); } catch (Throwable ignore) { }
        return (t == null) ? "" : t.toString();
    }

    static String viewId(AccessibilityNodeInfo n) {
        if (n == null) return "";
        try {
            String s = n.getViewIdResourceName();
            return (s == null) ? "" : s;
        } catch (Throwable t) {
            return "";
        }
    }

    static boolean isEditable(AccessibilityNodeInfo n) {
        if (n == null) return false;
        try {
            if (n.isEditable()) return true;
        } catch (Throwable ignore) { }
        try {
            CharSequence cn = n.getClassName();
            return cn != null && cn.toString().contains("EditText");
        } catch (Throwable t) {
            return false;
        }
    }

    /** 공백 정리. 방 이름에 줄바꿈/이중 공백이 섞여 오는 걸 맞춰준다. */
    static String norm(String s) {
        if (s == null) return "";
        String t = s.replace(' ', ' ').replace('\n', ' ').replace('\r', ' ').replace('\t', ' ');
        while (t.contains("  ")) t = t.replace("  ", " ");
        return t.trim();
    }
}
