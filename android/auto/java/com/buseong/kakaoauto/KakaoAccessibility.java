package com.buseong.kakaoauto;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.content.Intent;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 카톡 공유 화면 자동 조작.
 *
 * 알림 RemoteInput 으로는 사진을 못 보낸다. 그래서 {@link ImageSender} 가
 * ACTION_SEND_MULTIPLE 로 카톡 공유창을 띄우고, 이 서비스가 그 창에서
 * "방 고르기 → (체크됐으면) 전송 버튼" 을 대신 눌러준다.
 *
 * 규칙 하나만 지킨다 — <b>armed 아닐 때는 아무것도 안 한다.</b>
 * 사용자가 평소에 카톡 쓰는 걸 방해하면 안 되니까, 이미지 전송을 예약한
 * 그 몇십 초 동안만 카톡 화면을 본다.
 *
 * <h3>왜 이렇게 생겼나</h3>
 * 카톡 공유창의 실제 뷰 트리(view id·버튼 라벨·탭 구조)는 공개 자료가 하나도 없다.
 * 그래서 셀렉터를 추측으로 박는 대신, <b>실패했을 때 화면에 뭐가 있었는지 통째로 남긴다</b>.
 * 사용자가 그걸 복사해서 보내주면 다음 버전에서 추측 없이 고칠 수 있다.
 * 진단이 1순위, 탐색 강화가 2순위다.
 *
 * <h3>덤프는 이렇게 오간다</h3>
 * 실패 경로({@link #dumpAndFail(String)} · onInterrupt · onUnbind)가 <b>알아서</b>
 * {@link #saveDump(Context, String, long)} 으로 저장한다. 읽는 쪽은
 * {@link #lastDumpFor(Context, long)} 에 <b>그 시도의 id</b>({@link #attemptId()} 를 arm 직후에
 * 받아둔 값)를 넘겨서 "이번 시도의 덤프인지" 를 확인하고 쓴다. id 를 모르면
 * {@link #lastDump(Context)} + {@link #lastDumpAt(Context)} 로 "언제 것인지" 를 같이 보여줘야 한다 —
 * 지난 덤프를 이번 실패 화면인 것처럼 보여주는 게 제일 나쁜 거짓말이다.
 * {@link #dumpScreen()} 은 <b>실패와 무관하게 지금 화면을 손으로 떠낼 때만</b> 쓰는 보조 API 다
 * (떠낸 걸 저장도 같이 한다).
 *
 * <h3>실패를 성공으로 속이지 않는다</h3>
 * ACTION_CLICK 이 true 를 돌려주는 건 "그 뷰에 클릭 리스너가 있었다" 는 뜻일 뿐이다.
 * 그래서 누른 다음에 <b>진짜로 바뀌었는지</b>(체크됨 / 채팅방 진입 / 공유창 닫힘) 확인하고,
 * 확인이 안 되면 성공이라고 보고하지 않는다. 사용자가 "보냈다"고 믿는 게 실패보다 나쁘다.
 */
public final class KakaoAccessibility extends AccessibilityService {

    /** 전송이 끝났을 때(성공/실패) 알려줄 콜백. ImageSender 가 꽂는다. */
    public interface Result {
        void done(boolean ok, String detail);
    }

    private static final String KAKAO = "com.kakao.talk";

    /** arm 할 때 타임아웃을 안 주면 쓰는 기본값 */
    public static final long DEFAULT_TIMEOUT_MS = 40000L;

    /**
     * 우리는 호출자(ImageSender)의 타임아웃보다 <b>반드시 먼저</b> 포기해야 한다.
     * 그래야 실패 원인과 화면 덤프를 우리가 남길 수 있다. 그 여유분.
     */
    private static final long SAFETY_MS = 3500L;

    // ── 진단 덤프 저장 위치 ─────────────────────────────────────────────────
    //  Log.add 로 트리를 쏟으면 200줄 링버퍼가 다 밀려나고 줄마다 commit() 이라 ANR 위험이 있다.
    //  그래서 Prefs 평문 키에 한 덩어리로 apply() 한 번에 저장한다.
    private static final String K_DUMP = "K_SHARE_DUMP";
    private static final String K_DUMP_AT = "K_SHARE_DUMP_AT";
    /** 이 덤프가 몇 번째 시도(arm) 의 것인지. 읽는 쪽이 "이번 것" 인지 판별하는 열쇠다. */
    private static final String K_DUMP_ID = "K_SHARE_DUMP_ID";

    // ── 라벨 후보 (하드코딩 금지 — 전부 여기 모아둔다) ──────────────────────────
    /** 공유창 하단의 전송/확인 버튼 후보 (정확히 일치 / 접두 일치용) */
    static final String[] SEND = {
            "전송", "보내기", "확인", "완료", "선택완료", "선택 완료",
            "공유", "다음", "Send", "Done", "OK", "Next"
    };
    /** 개수가 붙어 나오는 형태까지 잡는 느슨한 후보 ("1명 선택", "확인 · 1") */
    static final String[] SEND_LOOSE = {
            "명 선택", "개 선택", "선택 완료", "전송", "보내기", "확인"
    };
    /** 방을 못 찾았을 때 쓸 검색창 힌트 후보 */
    static final String[] SEARCH_HINT = {
            "이름, 채팅방", "이름 또는", "검색", "이름 검색", "채팅방 검색", "친구 검색", "Search"
    };
    /** 친구/채팅이 탭으로 갈려 있을 때 눌러볼 탭 라벨 후보 */
    static final String[] TAB_CHAT = { "채팅", "채팅방", "대화", "채팅 목록", "Chats" };

    /** 전송 버튼 viewId 후보. 없으면 텍스트로 폴백한다. */
    static final String[] SEND_IDS = {
            "com.kakao.talk:id/confirm",
            "com.kakao.talk:id/btn_send",
            "com.kakao.talk:id/send",
            "com.kakao.talk:id/send_layout",
            "com.kakao.talk:id/media_send_button",
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
    /** 방 이름이 들어있는 목록 행 viewId 후보 (텍스트 매칭이 먼저, 이건 가산점용) */
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

    // ── 위 라벨들을 미리 정규화해둔다 ────────────────────────────────────────────
    //  노드마다 squash(SEND[i]) 를 다시 도는 건 순수 낭비다 (노드 2500개 × 라벨 30개).
    //  클래스 로딩 때 한 번만 만든다. 순서는 원본 배열과 1:1 로 맞춰둔다.
    static final String[] SEND_S = squashAll(SEND);
    static final String[] SEND_LOOSE_S = squashAll(SEND_LOOSE);
    static final String[] SEARCH_HINT_S = squashAll(SEARCH_HINT);
    static final String[] TAB_CHAT_S = squashAll(TAB_CHAT);

    private static String[] squashAll(String[] in) {
        String[] out = new String[in.length];
        for (int i = 0; i < in.length; i++) out[i] = squash(in[i]);
        return out;
    }

    // ── 탐색 한도 ──────────────────────────────────────────────────────────
    /** 한 번 훑을 때 볼 최대 노드 수 */
    private static final int MAX_NODES = 2500;
    /** 재시도 간격 */
    private static final long RETRY_MS = 450L;
    /** 같은 창에서 이 시간 안에 또 온 이벤트는 무시 (이벤트 폭주 방지) */
    private static final long DEDUPE_MS = 120L;
    /** 검색창 입력 재시도 허용 횟수 */
    private static final int MAX_SEARCH_TRY = 2;
    /** 목록 스크롤 허용 횟수 */
    private static final int MAX_SCROLL = 15;
    /** 방 행 다시 누르기 허용 횟수 */
    private static final int MAX_CLICK_TRY = 2;
    /** 전송 버튼 누르기 허용 횟수 */
    private static final int MAX_SEND_TRY = 2;
    /** 화면이 이만큼 연속으로 똑같으면 "더 볼 것 없다" 로 본다 (약 3초) */
    private static final int STUCK_ROUNDS = 6;
    /** 목록을 맨 위로 되돌릴 때 한 번 쏘고 쉬는 간격 (연속으로 쏘면 리스트가 못 따라온다) */
    private static final long SCROLL_BACK_MS = 150L;
    /** 실패 뒤 공유창을 닫으려고 뒤로가기를 누를 최대 횟수 */
    private static final int MAX_BACK = 2;
    /** 뒤로가기 사이 간격 */
    private static final long BACK_MS = 550L;

    // ── 덤프 한도 (접근성 서비스 메인 스레드에서 도니까 반드시 지킨다) ───────────
    //  60줄이면 정작 필요한 목록 행과 하단 버튼이 잘려나간다. 예산(약 38KB)까지 늘렸다.
    private static final int DUMP_MAX_NODES = 700;
    private static final int DUMP_MAX_LINES = 260;
    private static final int DUMP_MAX_LINE_LEN = 200;
    private static final int DUMP_MAX_CHARS = 38000;
    /** 노드 목록 뒤에 붙일 꼬리(끝 표시 등) 자리 */
    private static final int DUMP_TAIL_ROOM = 1200;
    /** 대화 본문처럼 보이는 긴 글자는 이만큼만 남긴다 (남의 대화를 개발자한테 보내지 않게) */
    private static final int TEXT_KEEP = 20;
    /** 이 길이 이하면 방/사람 이름으로 보고 통째로 남긴다 (그게 있어야 셀렉터를 고친다) */
    private static final int NAME_MAX = 24;
    /** 실패 메시지에 넣을 "화면에 실제로 있던 방 이름" 최대 개수 */
    private static final int SHOW_NAMES = 8;

    // ── 단계 ───────────────────────────────────────────────────────────────
    /** 방 고르기 */
    private static final int P_PICK = 0;
    /** 방을 누른 직후 — 체크됐나 / 채팅방으로 갔나 판별 */
    private static final int P_AFTER = 1;
    /** 전송(확인) 버튼 누르기 */
    private static final int P_SEND = 2;
    /** 전송 버튼을 누른 뒤 진짜 나갔는지 확인 */
    private static final int P_VERIFY = 3;

    // ── 예약(armed) 상태 — 서비스 인스턴스와 별개로 살아있어야 해서 static ────────
    private static volatile KakaoAccessibility INSTANCE = null;
    private static volatile boolean armed = false;
    /** 카톡 화면을 마지막으로 본 시각 (0 = 한 번도 못 봄). 공유창이 떴는지 진단용. */
    private static volatile long lastKakaoWindowAt = 0L;
    private static volatile String targetRoom = null;
    private static volatile long armedUntil = 0L;
    /** 우리가 포기할 시각. 항상 armedUntil 보다 앞이다 (원인 보고는 우리가 한다). */
    private static volatile long deadlineAt = 0L;
    private static volatile Result callback = null;
    private static volatile int phase = P_PICK;
    private static volatile long phaseAt = 0L;
    private static volatile int searchTry = 0;
    private static volatile boolean searchImpossible = false;
    private static volatile int scrolls = 0;
    private static volatile boolean scrollDone = false;
    /** 마지막 스크롤 직전의 화면 서명 — 스크롤했는데 이게 그대로면 바닥이다 */
    private static volatile String scrollSig = "";
    private static volatile int clickTry = 0;
    private static volatile int sendTry = 0;
    private static volatile int tabTry = 0;
    /** 방 행을 실제로 눌렀나 (이 증거 없이는 "보내진 것 같다" 로 끝내지 않는다) */
    private static volatile boolean clickedRow = false;
    private static volatile long clickedAt = 0L;
    /** 공유창 목록(스크롤 되는 목록 + 여러 행)을 실제로 본 적 있나 */
    private static volatile boolean sawShareList = false;
    /** 방을 누른 순간의 화면 서명 — 이게 안 바뀌면 클릭이 아무 일도 안 한 거다 */
    private static volatile String clickSig = "";
    private static volatile String pickedRowKey = "";
    private static volatile String pickedName = "";
    private static volatile String lastSendLabel = "";
    /** 화면 서명 — 안 바뀌면 헛돌고 있다는 뜻 */
    private static volatile String lastSig = "";
    private static volatile int sameSig = 0;
    private static volatile int emptyRounds = 0;
    private static volatile String lastWinKey = "";
    private static volatile long lastWinAt = 0L;
    /** 마지막으로 남긴 실패 사유 (덤프 머리에 박는다) */
    private static volatile String lastWhere = "";

    /**
     * 시도 번호. arm 할 때마다 1 올린다.
     * 덤프에 같이 저장해서 "지난 덤프를 이번 실패 화면으로 착각" 하는 걸 막는다.
     */
    private static volatile long attempt = 0L;

    /**
     * 이번 시도의 진행 기록. Log.add 는 줄마다 SharedPreferences.commit()(동기 디스크 쓰기)라서
     * 접근성 메인 스레드에서 시도마다 10번 넘게 부르면 ANR 로 간다.
     * 그래서 여기 모아뒀다가 끝날 때 <b>한 번만</b> Log.add 로 넘기고, 덤프에도 같이 박는다.
     */
    private static final ArrayList<String> NOTES = new ArrayList<String>(24);
    private static final int NOTES_MAX = 40;

    // ── 마지막으로 훑은 화면의 요약 (창이 사라진 뒤에도 "그때까지 본 것" 을 말하려면 필요하다) ──
    private static volatile String seenNames = "";
    private static volatile String seenBtns = "";
    private static volatile String seenShape = "";
    private static volatile long seenAt = 0L;
    /** 마지막 WINDOW_STATE_CHANGED 의 클래스명 = 그때 떠 있던 액티비티/다이얼로그 */
    private static volatile String lastActivityCls = "";
    /** 실패하고 공유창을 닫으려고 뒤로가기를 몇 번 눌렀나 */
    private static volatile int backTries = 0;

    private final Handler h = new Handler(Looper.getMainLooper());
    /** 맨 위로 되돌리기에 남은 횟수 (지연 스크롤용) */
    private int backScrollLeft = 0;

    // ── 공개 API (기존 그대로 유지) ───────────────────────────────────────────

    /** since 이후로 카톡 화면을 본 적 있나 */
    public static boolean sawKakaoSince(long since) {
        return lastKakaoWindowAt >= since;
    }

    /** 기본 타임아웃으로 예약. 돌려주는 값은 시도 id. */
    public static long arm(String room) {
        return arm(room, DEFAULT_TIMEOUT_MS, null);
    }

    /** "다음에 뜨는 카톡 공유창에서 이 방을 골라라" 예약. 돌려주는 값은 시도 id. */
    public static long arm(String room, long timeoutMs) {
        return arm(room, timeoutMs, null);
    }

    /**
     * 예약 + 끝났을 때 받을 콜백 지정.
     * 이전 예약이 남아있으면 조용히 덮어쓴다(ImageSender 가 한 번에 한 건만 돌린다).
     *
     * @return 이번 시도의 id. 이걸 들고 {@link #lastDumpFor(Context, long)} 를 부르면
     *         "이번 실패의 화면" 만 골라 읽을 수 있다.
     */
    public static long arm(String room, long timeoutMs, Result cb) {
        return arm(room, timeoutMs, cb, null);
    }

    /**
     * 예약 + 콜백 + (선택) Context.
     * ctx 를 주면 <b>접근성 서비스가 아직 안 붙은 경우에도</b> 그 사실을 이번 시도의 덤프로 남긴다 —
     * 현장에서 가장 흔한 실패라 이게 비어 있으면 사용자는 아무 단서도 못 받는다.
     */
    public static long arm(String room, long timeoutMs, Result cb, Context ctx) {
        String r = (room == null) ? "" : room.trim();
        long t = (timeoutMs <= 0) ? DEFAULT_TIMEOUT_MS : timeoutMs;

        long now = System.currentTimeMillis();
        targetRoom = r;
        armedUntil = now + t;
        // 호출자보다 먼저 포기한다. 아주 짧은 타임아웃이면 절반 지점에서.
        deadlineAt = (t > SAFETY_MS * 2) ? (armedUntil - SAFETY_MS) : (now + t / 2);
        callback = cb;
        phase = P_PICK;
        phaseAt = now;
        searchTry = 0;
        searchImpossible = false;
        scrolls = 0;
        scrollDone = false;
        scrollSig = "";
        clickTry = 0;
        sendTry = 0;
        tabTry = 0;
        clickedRow = false;
        clickedAt = 0L;
        clickSig = "";
        sawShareList = false;
        pickedRowKey = "";
        pickedName = "";
        lastSendLabel = "";
        lastSig = "";
        sameSig = 0;
        emptyRounds = 0;
        lastWinKey = "";
        lastWinAt = 0L;
        lastWhere = "";
        seenNames = "";
        seenBtns = "";
        seenShape = "";
        seenAt = 0L;
        lastActivityCls = "";
        backTries = 0;
        synchronized (NOTES) { NOTES.clear(); }
        attempt++;
        armed = true;
        long id = attempt;

        // 지난 덤프는 여기서 지우지 않는다.
        //  지우고 나서 아무것도 못 채우는 경로(서비스 미바인드 · 공유창이 안 뜸 · 타임아웃)가
        //  있어서, 지우면 "쓸만한 지난 단서" 만 날리고 끝난다.
        //  대신 덤프마다 시도 id(K_DUMP_ID)와 시각을 같이 저장하니까,
        //  읽는 쪽이 lastDumpFor(ctx, id) 로 "이번 것" 만 골라 쓸 수 있다.

        KakaoAccessibility me = INSTANCE;
        if (me == null) {
            Log.add(ctx, "접근성 서비스가 연결되지 않았습니다. 공유창 자동 조작이 동작하지 않을 수 있습니다.");
            if (ctx != null) {
                // 조기 return 해도 이번 시도의 덤프는 남는다 (서비스가 없어서 트리는 못 읽는다)
                StringBuilder sb = new StringBuilder(512);
                sb.append("=== 카카오톡 화면 진단 ").append(stamp()).append(" ===\n");
                sb.append("시도 id: ").append(id).append('\n');
                sb.append("실패: 접근성 서비스가 연결되지 않아 화면을 읽지 못했습니다.\n");
                sb.append("대상 대화방: \"").append(r).append("\"\n");
                sb.append(env(ctx));
                sb.append("조치: 설정 › 접근성 › 설치된 앱 › 카톡 오토 를 재설정한 후 다시 시도하십시오.\n");
                sb.append("=== 끝 ===\n");
                saveDump(ctx, sb.toString(), id);
            }
            return id;
        }
        Log.add(me, "카카오톡 공유창 자동 조작을 예약했습니다. 대화방: " + r + " (시도 " + id + ")");
        me.kick(700L);   // 이벤트를 놓쳐도 스스로 한 번은 찾아본다
        return id;
    }

    /**
     * 예약 해제. 콜백은 부르지 않는다 (호출한 쪽이 이미 결과를 안다).
     *
     * 호출한 쪽(ImageSender)이 먼저 포기하는 경로(6초 검사·전체 타임아웃·startActivity 실패)는
     * dumpAndFail 을 안 타서 <b>덤프가 안 남는다</b>. 그래서 여기서
     *  (1) 이번 시도의 덤프가 아직 없으면 최소한의 덤프를 남기고,
     *  (2) 모아둔 진행 기록을 로그에 한 번 붙이고,
     *  (3) 사진이 붙은 공유창이 떠 있으면 닫는다.
     */
    public static void disarm() {
        KakaoAccessibility me = INSTANCE;
        boolean was = armed;
        if (me != null && was) {
            try {
                if (lastDumpAttempt(me) != attempt) {
                    me.saveMini("호출 측(이미지 전송)이 먼저 중단되었습니다. 공유창이 표시되지 않았거나 시간이 초과되었습니다."
                            + " 카카오톡 공유창이 열려 있으면 닫고, 「다른 앱 위에 표시」 권한과 카카오톡 버전을 확인하십시오.",
                            "disarm");
                }
            } catch (Throwable ignore) { }
        }
        if (me != null) {
            try { me.h.removeCallbacksAndMessages(null); } catch (Throwable ignore) { }
        }
        clear();
        if (me != null) {
            String trail = flushNotes();
            if (trail.length() > 0) Log.add(me, "공유창 진행 기록 — " + trail);
            if (was) me.closeShare();
        }
    }

    /** 지금 예약 상태인가. 시간이 지났으면 스스로 풀린다(그때도 원인은 남긴다). */
    public static boolean isArmed() {
        if (!armed) return false;
        if (System.currentTimeMillis() > armedUntil) {
            KakaoAccessibility me = INSTANCE;
            if (me != null) me.dumpAndFail("카카오톡이 응답하지 않았습니다. (" + whereNow() + ")");
            else clear();
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

    // ── 진단 덤프 공개 API ───────────────────────────────────────────────────

    /**
     * 지금 화면(카톡 창 + 위에 떠 있는 다이얼로그 창까지)을 사람이 읽을 수 있게 떠낸다.
     * 서비스가 안 붙어있거나 카톡 화면이 아니면 짧은 안내 문구를 돌려준다.
     * <b>armed 일 때만 실제 트리를 읽는다</b> — 평소 카톡 화면은 들여다보지 않는다.
     */
    public static String dumpScreen() {
        KakaoAccessibility me = INSTANCE;
        if (me == null) return "접근성 서비스가 연결되지 않아 화면을 읽지 못했습니다.";
        if (!armed) return "예약(armed) 상태가 아니므로 화면을 읽지 않았습니다. 진단은 전송 시도 중에만 수집됩니다.";
        try {
            String d = me.buildDump(lastWhere);
            // 손으로 떠낸 것도 저장해둔다 — 화면에서 바로 복사 못 하고 나중에 찾는 경우가 있다
            try { saveDump(me, d, attempt); } catch (Throwable ignore) { }
            return d;
        } catch (Throwable t) {
            return "화면 기록 생성에 실패했습니다. (" + t.getClass().getSimpleName() + ")";
        }
    }

    /** 지금 시도(arm) 의 id. arm 이 돌려준 값과 같다. 예약 전이면 0. */
    public static long attemptId() {
        return attempt;
    }

    /**
     * 마지막으로 저장한 화면 진단. 없으면 "".
     * <b>언제 것인지 모른다</b> — 이번 시도의 것만 원하면 {@link #lastDumpFor(Context, long)} 를 써라.
     */
    public static String lastDump(Context c) {
        String s = Prefs.getStr(c, K_DUMP, "");
        return (s == null) ? "" : s;
    }

    /**
     * <b>그 시도의</b> 덤프만 돌려준다. 다른 시도 것(또는 없음)이면 "".
     * arm 이 조기 return 해서 덤프가 안 남은 경우에도 옛 덤프를 이번 것처럼 주지 않는다.
     */
    public static String lastDumpFor(Context c, long attemptId) {
        if (c == null || attemptId <= 0) return "";
        if (lastDumpAttempt(c) != attemptId) return "";
        return lastDump(c);
    }

    /** 저장된 덤프가 몇 번째 시도의 것인지 (0 = 모름/없음) */
    public static long lastDumpAttempt(Context c) {
        return Prefs.getLong(c, K_DUMP_ID, 0L);
    }

    /** 마지막 화면 진단을 남긴 시각 (0 = 없음) */
    public static long lastDumpAt(Context c) {
        return Prefs.getLong(c, K_DUMP_AT, 0L);
    }

    /** 화면 진단 저장 (지금 시도 id 로 저장한다) */
    public static void saveDump(Context c, String dump) {
        saveDump(c, dump, attempt);
    }

    /**
     * 화면 진단 저장 (덮어쓴다 — 한 번에 한 덩어리만 보관한다).
     * 시도 id 를 같이 박는다. 이게 있어야 읽는 쪽이 "이번 실패의 화면인지" 를 판별한다.
     */
    public static void saveDump(Context c, String dump, long attemptId) {
        if (c == null) return;
        if (dump == null || dump.length() == 0) { clearDump(c); return; }
        String d = (dump.length() > DUMP_MAX_CHARS) ? dump.substring(0, DUMP_MAX_CHARS) + "\n…여기서 잘랐어" : dump;
        Prefs.putStr(c, K_DUMP, d);
        Prefs.putLong(c, K_DUMP_AT, System.currentTimeMillis());
        Prefs.putLong(c, K_DUMP_ID, attemptId);
    }

    /** 화면 진단 지우기 */
    public static void clearDump(Context c) {
        if (c == null) return;
        Prefs.remove(c, K_DUMP);
        Prefs.remove(c, K_DUMP_AT);
        Prefs.remove(c, K_DUMP_ID);
    }

    private static void clear() {
        armed = false;
        targetRoom = null;
        armedUntil = 0L;
        deadlineAt = 0L;
        callback = null;
        phase = P_PICK;
        phaseAt = 0L;
        searchTry = 0;
        searchImpossible = false;
        scrolls = 0;
        scrollDone = false;
        scrollSig = "";
        clickTry = 0;
        sendTry = 0;
        tabTry = 0;
        clickedRow = false;
        clickedAt = 0L;
        clickSig = "";
        sawShareList = false;
        pickedRowKey = "";
        pickedName = "";
        lastSendLabel = "";
        lastSig = "";
        sameSig = 0;
        emptyRounds = 0;
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
                    | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                    | AccessibilityEvent.TYPE_VIEW_SCROLLED;
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
            info.notificationTimeout = 100;
            info.packageNames = new String[] { KAKAO };
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                    | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            setServiceInfo(info);
        } catch (Throwable t) {
            Log.add(this, "접근성 서비스 설정 적용에 실패했습니다 (" + t.getClass().getSimpleName()
                    + "). 기본 설정으로 계속 동작합니다.");
        }
        Log.add(this, "접근성 서비스가 활성화되었습니다. 이미지 전송이 가능합니다."
                + (canGesture() ? "" : " (좌표 탭 대체 경로는 사용할 수 없습니다. 접근성 설정에 canPerformGestures 가 없습니다.)"));
        if (isArmed()) kick(500L);
    }

    @Override
    public void onInterrupt() {
        // 시스템이 서비스를 잠깐 멈출 때 온다. 진행 중이던 예약은 못 끝내니까 실패로 정리.
        // 이 경로도 덤프를 남긴다 — 여기서 비면 사용자는 "왜 실패했는지" 를 통째로 잃는다.
        if (isArmed()) {
            String w = "접근성 서비스가 중단되었습니다. (" + whereNow() + ")"
                    + " 타사 접근성 앱과 충돌했거나 시스템이 서비스를 종료했습니다."
                    + " 카카오톡 공유창이 열려 있으면 뒤로가기로 닫고 다시 시도하십시오.";
            saveMini(w, "onInterrupt");
            finish(false, w);
        } else {
            Log.add(this, "접근성 서비스가 일시 중단되었습니다.");
        }
    }

    @Override
    public boolean onUnbind(Intent intent) {
        if (isArmed()) {
            String w = "접근성 권한이 해제되었습니다. (" + whereNow() + ")"
                    + " 설정 › 접근성 › 카톡 오토 를 다시 활성화한 후 시도하십시오.";
            saveMini(w, "onUnbind");
            finish(false, w);
        }
        if (INSTANCE == this) INSTANCE = null;
        Log.add(this, "접근성 서비스가 비활성화되었습니다. 이미지 전송이 불가합니다.");
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
                && type != AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED
                && type != AccessibilityEvent.TYPE_VIEW_SCROLLED) return;

        // 같은 창에서 짧은 시간에 또 오면 스킵 (카톡은 content_changed 를 쏟아낸다)
        int winId = -1;
        try { winId = e.getWindowId(); } catch (Throwable ignore) { }
        String key = winId + "|" + type;
        long now = SystemClock.uptimeMillis();
        if (key.equals(lastWinKey) && (now - lastWinAt) < DEDUPE_MS) return;
        lastWinKey = key;
        lastWinAt = now;

        // 새 창이 떴으면 화면이 바뀐 것이니 "헛돌고 있다" 카운터만 리셋한다.
        // (포기 시점은 절대 데드라인으로 재니까 여기서 예산이 늘어나지는 않는다)
        if (type == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            sameSig = 0;
            lastSig = "";
            // 이때 오는 className 이 그 순간 떠 있는 액티비티/다이얼로그 이름이다.
            // 덤프에 이게 있으면 "공유창인지, 잠금화면인지, 업데이트 안내인지" 를 바로 안다.
            try {
                CharSequence cls = e.getClassName();
                if (cls != null && cls.length() > 0) lastActivityCls = cls.toString();
            } catch (Throwable ignore) { }
        }

        kick(0L);
    }

    /** 다음 탐색을 예약한다 (중복 예약 안 쌓이게 기존 건 지운다) */
    private void kick(long delayMs) {
        try {
            h.removeCallbacks(STEP);
            h.postDelayed(STEP, delayMs < 0 ? 0 : delayMs);
        } catch (Throwable t) {
            note("자동 조작 예약 실패 — " + t.getClass().getSimpleName());
        }
    }

    private final Runnable STEP = new Runnable() {
        @Override public void run() { step(); }
    };

    // ── 본체 ────────────────────────────────────────────────────────────────

    private void step() {
        if (!isArmed()) return;

        long now = System.currentTimeMillis();
        if (now >= deadlineAt) {
            dumpAndFail(timeoutWhere());
            return;
        }

        ArrayList<AccessibilityNodeInfo> rs = roots();
        if (rs.isEmpty()) {
            emptyRounds++;
            if (clickedRow && phase != P_PICK && emptyRounds >= 2 && (now - clickedAt) > 700L) {
                // 창이 사라진 것만으로는 성공이 아니다 — 사용자가 뒤로가기를 눌러도 똑같이 사라진다.
                // 전송(확인) 버튼을 실제로 누른 적이 있을 때만 "갔다" 로 본다.
                if (sendTry > 0) {
                    finish(true, targetRoom + " · 전송 버튼 입력 후 공유창이 닫혔습니다. 카카오톡에서 전송 결과를 확인하십시오.");
                    return;
                }
                // 여기가 단건 공유형(탭하면 바로 보냄)일 수도, 뒤로가기로 닫힌 것일 수도 있다.
                // 구분할 방법이 없으니 성공이라고 우기지 않는다.
                dumpAndFail("대화방 「" + cut(pickedName, 20) + "」 선택 후 공유창이 닫혔으나"
                        + " 전송 버튼이 입력되지 않았습니다. 전송 여부를 확인할 수 없습니다."
                        + " 카카오톡에서 전송 결과를 먼저 확인하십시오. 이미 전송된 경우 재전송하지 마십시오.");
                return;
            }
            retry();
            return;
        }
        emptyRounds = 0;

        try {
            Scan sc = scan(rs);
            // 화면이 계속 똑같으면 헛돌고 있다는 뜻 (스크롤/검색이 필요하다는 신호)
            if (sc.sig.equals(lastSig)) sameSig++;
            else { sameSig = 0; lastSig = sc.sig; }

            switch (phase) {
                case P_PICK:   doPick(sc);   break;
                case P_AFTER:  doAfter(sc);  break;
                case P_SEND:   doSend(sc);   break;
                default:       doVerify(sc); break;
            }
        } catch (Throwable t) {
            note("카톡 화면 자동 조작 중 오류 — " + t.getClass().getSimpleName()
                    + ": " + String.valueOf(t.getMessage()));
            retry();
        } finally {
            // 루트는 매 step 마다 새로 잡는다 — 다 쓴 건 여기서 반납한다.
            // (자식 노드는 별개 객체라 부모를 반납해도 안 깨진다. 잎 노드는 walk 가 반납했다)
            for (int i = 0; i < rs.size(); i++) {
                try { rs.get(i).recycle(); } catch (Throwable ignore) { }
            }
        }
    }

    private void retry() {
        kick(RETRY_MS);
    }

    // ── 1단계: 방 고르기 ─────────────────────────────────────────────────────

    private void doPick(Scan sc) {
        final String room = targetRoom;
        if (room == null || room.length() == 0) {
            finish(false, "대상 대화방 이름이 비어 있습니다.");
            return;
        }
        markShareList(sc);

        ArrayList<Hit> hits = sc.bestHits();

        // 비슷한 방이 여러 개면 아무것도 고르지 않는다 — 엉뚱한 방에 사진을 보내는 게 최악이다.
        if (hits.size() > 1) {
            StringBuilder names = new StringBuilder();
            for (int i = 0; i < hits.size() && i < 4; i++) {
                if (i > 0) names.append(", ");
                names.append(cut(hits.get(i).name, 24));
            }
            dumpAndFail("이름이 유사한 대화방이 다수 검색되어 전송을 중단했습니다(" + names + ")."
                    + " 오발송을 방지하기 위해 선택하지 않았습니다. 설정의 대화방 이름을 화면에 표시된 그대로 전체 입력하십시오." + nextStep());
            return;
        }

        if (hits.size() == 1) {
            Hit hit = hits.get(0);
            int r = clickRoom(hit);
            if (r == 2) return;                     // 이미 끝냈다
            if (r == 1) {
                phase = P_AFTER;
                phaseAt = System.currentTimeMillis();
                clickSig = sc.sig;      // 이게 안 바뀌면 클릭이 헛방이었다는 뜻
                sameSig = 0;
                lastSig = "";
                kick(900L);
                return;
            }
            // 클릭 자체가 안 먹었다 — 다음 번에 다시
            if (sameSig >= STUCK_ROUNDS) {
                dumpAndFail("대화방 「" + cut(hit.name, 24) + "」 을 찾았으나 선택 입력이 처리되지 않았습니다"
                        + " (선택 가능한 항목이 아니거나 다른 요소가 화면을 덮고 있습니다)" + nextStep());
                return;
            }
            retry();
            return;
        }

        // 못 찾았다. 스플래시/로딩이면 그냥 기다린다 (콜드스타트면 목록이 아직 없다)
        if (sc.splash && sameSig < STUCK_ROUNDS * 2) {
            retry();
            return;
        }

        // 1) 검색창에 넣어보는 게 스크롤보다 빠르고 정확하다
        if (searchTry < MAX_SEARCH_TRY && !searchImpossible && trySearch(sc)) {
            searchTry++;
            // 검색으로 목록이 바뀌면 스크롤 예산을 다시 준다
            scrolls = 0;
            scrollDone = false;
            scrollSig = "";
            sameSig = 0;
            lastSig = "";
            kick(1000L);
            return;
        }

        // 2) 목록을 내려본다 (RecyclerView 는 화면 밖 행을 트리에 아예 안 내보낸다)
        if (!scrollDone && scrollNext(sc)) {
            kick(420L);
            return;
        }

        // 3) 친구/채팅 탭이 갈려 있으면 채팅 탭을 눌러본다
        if (tabTry < TAB_CHAT.length && tryChatTab(sc)) {
            scrolls = 0;
            scrollDone = false;
            scrollSig = "";
            sameSig = 0;
            lastSig = "";
            kick(800L);
            return;
        }

        // 더 해볼 게 없고 화면도 안 바뀐다 → 여기서 끝내고 원인을 남긴다
        boolean noSearchLeft = searchImpossible || searchTry >= MAX_SEARCH_TRY;
        if (noSearchLeft && scrollDone && tabTry >= TAB_CHAT.length && sameSig >= STUCK_ROUNDS) {
            dumpAndFail(notFoundWhy(sc, room));
            return;
        }
        retry();
    }

    /**
     * "방을 못 찾았다" 를 사용자가 <b>스스로 고칠 수 있는 말</b>로 만든다.
     *
     * 스크롤 3회·글자 34개 같은 숫자는 사용자가 어쩔 수 없다. 대신
     *  (1) 공유 목록을 아예 못 봤으면 방 이름 탓으로 돌리지 않고 다른 화면 얘기를 하고,
     *  (2) 목록을 봤으면 <b>화면에 실제로 있던 방 이름</b>을 보여준다 —
     *      "아, 카톡엔 이모지가 붙어 있었네" 를 사용자가 직접 알아채는 게 제일 빠르다.
     */
    private String notFoundWhy(Scan sc, String room) {
        String tail = a11yTail();

        if (!sawShareList) {
            return "카카오톡이 공유창(대화방 선택 목록) 대신 다른 화면을 표시했습니다. 대화방 이름 문제가 아닙니다."
                    + " 카카오톡을 직접 실행하여 잠금(비밀번호)·재로그인·업데이트 안내가 표시되는지 확인하십시오."
                    + " 해당 화면을 해제하고 카카오톡 채팅 목록이 표시된 상태에서 다시 시도하십시오."
                    + (lastActivityCls.length() > 0 ? " (당시 표시된 화면: " + shortCls(lastActivityCls) + ")" : "")
                    + tail;
        }
        String names = roomLike(sc);
        return "대화방 목록에서 「" + cut(room, 24) + "」 을 찾지 못했습니다."
                + (names.length() > 0
                    ? " 당시 화면에 표시된 이름: " + names
                      + " . 카카오톡에 표시된 이름과 문자가 다른 경우(이모지·괄호·띄어쓰기) 설정의 대화방 이름을"
                      + " 화면에 표시된 그대로 수정하십시오."
                    : " 화면에서 대화방 이름으로 인식되는 문자를 읽지 못했습니다."
                      + " 카카오톡 공유창이 목록을 아직 표시하지 않은 상태일 수 있습니다. 카카오톡을 실행한 후 다시 시도하십시오.")
                + tail;
    }

    /**
     * 방 행을 누른다.
     * @return 0 = 못 눌렀다, 1 = 눌렀다(또는 이미 선택돼 있었다), 2 = 여기서 끝냈다
     */
    private int clickRoom(Hit hit) {
        AccessibilityNodeInfo row = rowOf(hit.node);
        if (row == null) row = hit.node;
        try {
            pickedName = hit.name;
            pickedRowKey = keyOf(row);

            // 이미 체크돼 있으면 절대 누르면 안 된다 — 누르면 선택이 풀린다.
            Boolean checked = rowChecked(row);
            if (checked != null && checked.booleanValue()) {
                note("「" + cut(hit.name, 20) + "」 은 이미 선택된 상태입니다. 재선택하지 않습니다.");
                clickedRow = true;
                clickedAt = System.currentTimeMillis();
                sawShareList = true;
                return 1;
            }

            boolean ok = clickNode(row, "방 행");
            if (!ok) return 0;

            clickedRow = true;
            clickedAt = System.currentTimeMillis();
            sawShareList = true;
            note("공유창에서 방을 눌렀어 — " + cut(hit.name, 20)
                    + " (매칭: " + hit.how() + ")");
            return 1;
        } finally {
            recycleRow(row, hit.node);
        }
    }

    // ── 2단계: 누른 다음에 뭐가 됐는지 판별 ─────────────────────────────────────

    private void doAfter(Scan sc) {
        long now = System.currentTimeMillis();

        // (a) 채팅방으로 들어갔다 = 단건 공유형. 우리가 방을 눌렀다는 증거가 있을 때만 성공으로 본다.
        if (sc.chatInput && clickedRow && sawShareList) {
            note("대화방 선택 후 채팅방으로 전환되었습니다. 전송된 것으로 처리합니다. 카카오톡에서 확인하십시오.");
            finish(true, targetRoom + " · 채팅방으로 전환되었습니다. 카카오톡에서 확인하십시오.");
            return;
        }

        // (b) 체크만 됐다 → 하단 확인/전송 버튼을 눌러야 한다
        boolean checkedNow = sc.checkedCount > 0 || rowCheckedByKey(sc);
        boolean changed = clickSig.length() > 0 && !sc.sig.equals(clickSig);
        Btn b = sc.bestBtn(true);
        // 화면이 하나도 안 바뀌었으면 전송 버튼처럼 보이는 걸 눌러선 안 된다 —
        // 권한 요청이나 다른 경고 다이얼로그의 "확인" 을 눌러버릴 수 있다.
        // 확실한 viewId(prio 0)만 예외로 허용한다.
        if (checkedNow || (b != null && (changed || b.prio == 0))) {
            if (checkedNow) note("대화방이 선택되었습니다. 전송 버튼을 탐색합니다.");
            phase = P_SEND;
            phaseAt = now;
            sameSig = 0;
            lastSig = "";
            kick(250L);
            return;
        }

        // (c) 눌렀는데 아무 일도 안 일어났다 = 엉뚱한 노드를 눌렀을 수 있다
        if ((now - clickedAt) > 2500L || sameSig >= STUCK_ROUNDS) {
            if (clickTry < MAX_CLICK_TRY) {
                clickTry++;
                note("방을 눌렀는데 화면이 안 바뀌었어 — 다시 눌러볼게 (" + clickTry + ")");
                phase = P_PICK;
                phaseAt = now;
                sameSig = 0;
                lastSig = "";
                clickedRow = false;
                kick(350L);
                return;
            }
            Btn dis = sc.bestBtn(false);
            String extra = (dis == null) ? ""
                    : " · 하단 버튼 「" + cut(dis.label, 20) + "」 이 비활성 상태입니다(선택이 처리되지 않았습니다)";
            dumpAndFail("대화방 「" + cut(pickedName, 20) + "」 을 선택했으나 선택 상태와 화면이 변경되지 않았습니다"
                    + extra + ". 이름은 일치하나 선택 위치가 올바르지 않습니다." + nextStep()
                    + " 증상이 반복되면 화면 진단을 복사하여 개발자에게 전달하십시오."
                    + a11yTail());
            return;
        }
        retry();
    }

    // ── 3단계: 전송 버튼 ─────────────────────────────────────────────────────

    private void doSend(Scan sc) {
        if (sc.chatInput && clickedRow && sawShareList) {
            finish(true, targetRoom + " · 채팅방으로 전환되었습니다. 카카오톡에서 확인하십시오.");
            return;
        }

        Btn b = sc.bestBtn(true);
        if (b != null) {
            if (sendTry >= MAX_SEND_TRY) {
                dumpAndFail("전송 버튼 「" + cut(b.label, 20) + "」 을 " + sendTry
                        + "회 입력했으나 화면이 변경되지 않았습니다. 전송 여부를 확인할 수 없습니다."
                        + " 카카오톡에서 「" + cut(pickedName, 20) + "」 의 전송 결과를 먼저 확인하십시오."
                        + " 이미 전송된 경우 재전송하지 마십시오." + nextStep());
                return;
            }
            if (clickNode(b.node, "전송 버튼")) {
                sendTry++;
                lastSendLabel = b.label;
                note("전송 버튼 눌렀어 — 「" + cut(b.label, 20) + "」"
                        + (b.id.length() > 0 ? " (" + b.id + ")" : ""));
                phase = P_VERIFY;
                phaseAt = System.currentTimeMillis();
                sameSig = 0;
                lastSig = "";
                kick(1200L);
                return;
            }
            if (sameSig >= STUCK_ROUNDS) {
                dumpAndFail("전송 버튼 「" + cut(b.label, 20) + "」 입력이 처리되지 않았습니다"
                        + " (버튼 형태이나 실제 입력 대상이 아닙니다)." + nextStep() + a11yTail());
                return;
            }
            retry();
            return;
        }

        // 버튼이 없다 — 비활성 버튼이 있으면 그게 곧 "선택이 안 됐다" 는 증거다
        if (sameSig >= STUCK_ROUNDS) {
            Btn dis = sc.bestBtn(false);
            if (dis != null) {
                dumpAndFail("전송 버튼 「" + cut(dis.label, 20) + "」 이 비활성 상태입니다. 대화방 선택이 처리되지 않았습니다."
                        + " 카카오톡 공유창에서 대화방을 직접 선택하고, 해당 대화방 이름이 화면에"
                        + " 어떻게 표기되는지 확인하십시오." + nextStep());
            } else {
                dumpAndFail("전송 버튼을 찾지 못했습니다 (화면에서 인식된 입력 가능 항목: "
                        + joinBtnLabels(sc) + ")"
                        + (sawShareList ? "" : " · 공유 목록이 확인되지 않았습니다. 카카오톡이 다른 화면을 표시한 것으로 판단됩니다")
                        + "." + nextStep()
                        + " 화면 진단을 전달하면 해당 버튼 이름을 다음 버전에 반영할 수 있습니다."
                        + a11yTail());
            }
            return;
        }
        retry();
    }

    // ── 4단계: 진짜 나갔는지 확인 ────────────────────────────────────────────

    private void doVerify(Scan sc) {
        if (sc.chatInput) {
            finish(true, targetRoom);
            return;
        }
        Btn b = sc.bestBtn(true);
        if (b == null) {
            // 우리가 전송 버튼을 실제로 누른 뒤에 그 버튼이 사라졌다 = 공유창이 진행됐다.
            // (전송을 누른 적이 없으면 여기로 오지 않는다 — doSend 에서만 넘어온다)
            note("전송 버튼이 사라졌어 — 보내진 걸로 볼게");
            finish(true, targetRoom);
            return;
        }
        if (sameSig >= STUCK_ROUNDS) {
            if (sendTry < MAX_SEND_TRY) {
                phase = P_SEND;
                sameSig = 0;
                lastSig = "";
                kick(400L);
                return;
            }
            dumpAndFail("전송 버튼 「" + cut(lastSendLabel, 20) + "」 입력 후 화면이 변경되지 않았습니다."
                    + " 전송 여부를 확인할 수 없습니다. 카카오톡에서 먼저 확인하십시오. 이미 전송된 경우 재전송하지 마십시오."
                    + nextStep());
            return;
        }
        retry();
    }

    // ── 검색창 ───────────────────────────────────────────────────────────────

    /** 검색창을 찾아 방 이름을 넣어본다. 넣었으면 true. */
    private boolean trySearch(Scan sc) {
        final String room = targetRoom;
        if (room == null || room.length() == 0) return false;

        AccessibilityNodeInfo box = sc.searchBox;
        if (box == null) {
            // 검색 아이콘/힌트 라벨일 수 있다. 눌러서 입력창을 띄워만 본다.
            if (sc.searchOpener != null) {
                if (clickNode(sc.searchOpener, "검색 열기")) {
                    note("대화방이 목록에 없어 검색을 실행했습니다.");
                    return true;
                }
            }
            searchImpossible = true;
            return false;
        }

        // 완전일치 검색은 이모지/말줄임표 때문에 0건이 되기 쉽다 → 앞 8자만 넣는다
        String q = norm(room);
        if (q.length() > 8) q = q.substring(0, 8);

        try {
            // 커스텀 검색뷰는 눌러야 편집 모드가 되는 경우가 있다 → CLICK → FOCUS → SET_TEXT
            try { box.performAction(AccessibilityNodeInfo.ACTION_CLICK); } catch (Throwable ignore) { }
            try { box.performAction(AccessibilityNodeInfo.ACTION_FOCUS); } catch (Throwable ignore) { }
            Bundle args = new Bundle();
            args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, q);
            boolean ok = box.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args);
            if (!ok) {
                note("검색창에 문자를 입력하지 못했습니다. 직접 입력이 필요할 수 있습니다.");
                searchImpossible = true;
                return false;
            }
            // 진짜 들어갔는지 확인한다 (performAction 이 true 인데 안 들어가는 기기가 있다)
            boolean went = true;
            try {
                if (box.refresh()) {
                    String got = norm(text(box));
                    went = got.length() > 0 && squash(got).contains(squash(q));
                }
            } catch (Throwable ignore) { }
            note("대화방이 목록에 없어 검색창에 「" + q + "」 를 입력했습니다."
                    + (went ? "" : " (문자가 입력되지 않은 것으로 판단됩니다)"));
            return true;
        } catch (Throwable t) {
            note("검색창 입력에 실패했습니다. (" + t.getClass().getSimpleName() + ")");
            searchImpossible = true;
            return false;
        }
    }

    /**
     * 친구/채팅이 탭으로 갈려 있으면 채팅 탭을 눌러본다.
     * 후보를 한 번에 다 훑고, 하나도 없으면 tabTry 를 끝까지 올려서 다시 안 시도한다
     * (안 그러면 여기서 데드라인까지 헛돈다).
     */
    private boolean tryChatTab(Scan sc) {
        if (tabTry >= TAB_CHAT.length) return false;
        for (int k = tabTry; k < TAB_CHAT_S.length; k++) {
            String want = TAB_CHAT_S[k];
            for (int i = 0; i < sc.tabs.size(); i++) {
                Btn t = sc.tabs.get(i);
                if (!squash(t.label).equals(want)) continue;
                tabTry = k + 1;
                if (clickNode(t.node, "탭")) {
                    note("「" + TAB_CHAT[k] + "」 탭을 눌러봤어");
                    return true;
                }
                return false;
            }
        }
        tabTry = TAB_CHAT.length;   // 화면에 탭이 아예 없다
        return false;
    }

    // ── 스크롤 ───────────────────────────────────────────────────────────────

    /**
     * 목록을 한 칸 내린다. 더 내릴 게 없으면 scrollDone 을 세우고 false.
     * 카톡처럼 바닥에서도 true 를 돌려주는 뷰가 있으니 내용 변화까지 같이 본다.
     */
    private boolean scrollNext(Scan sc) {
        if (scrolls >= MAX_SCROLL) {
            scrollDone = true;
            note("목록을 " + scrolls + "회 스크롤했으나 대화방을 찾지 못했습니다.");
            scrollBackToTop(sc);
            return false;
        }
        AccessibilityNodeInfo list = sc.biggestScrollable();
        if (list == null) {
            scrollDone = true;
            return false;
        }
        // 내용이 안 바뀌면 바닥이다 — 카톡처럼 바닥에서도 true 를 돌려주는 뷰가 있어서
        // performAction 반환값만 믿으면 안 된다.
        if (scrolls > 0 && sc.sig.equals(scrollSig)) {
            scrollDone = true;
            note("목록 끝까지 내려봤어 (" + scrolls + "회) — 방이 안 보여");
            scrollBackToTop(sc);
            return false;
        }
        boolean ok = false;
        try {
            ok = list.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
        } catch (Throwable ignore) { }
        if (!ok) {
            scrollDone = true;
            note("목록을 더 못 내려 (" + scrolls + "회) — 방이 안 보여");
            scrollBackToTop(sc);
            return false;
        }
        scrolls++;
        scrollSig = sc.sig;   // 다음 번에 이게 그대로면 더 내릴 게 없다는 뜻
        // 다음 step 에서 루트를 다시 잡고 처음부터 찾는다 (스크롤하면 기존 노드는 전부 무효)
        return true;
    }

    /**
     * 목록을 맨 위로 되돌린다 (중간에 남겨두면 다음 시도가 더 나빠진다).
     * 지연 없이 17번 연속 쏘면 리스트가 애니메이션을 못 따라와서 한 칸도 안 올라가거나
     * 이벤트 폭주로 화면이 얼어붙는다. 한 번 쏘고 쉬고, 안 먹히면 그만둔다.
     */
    private void scrollBackToTop(Scan sc) {
        final AccessibilityNodeInfo list = sc.biggestScrollable();
        if (list == null) return;
        backScrollLeft = MAX_SCROLL + 2;
        h.postDelayed(new Runnable() {
            @Override public void run() {
                boolean ok = false;
                try {
                    boolean alive = true;
                    try { alive = list.refresh(); } catch (Throwable ignore) { }
                    if (alive) ok = list.performAction(AccessibilityNodeInfo.ACTION_SCROLL_BACKWARD);
                } catch (Throwable ignore) { }
                backScrollLeft--;
                if (ok && backScrollLeft > 0) h.postDelayed(this, SCROLL_BACK_MS);
            }
        }, SCROLL_BACK_MS);
    }

    // ── 클릭 ─────────────────────────────────────────────────────────────────

    /**
     * 이 노드를 누른다.
     * 1) 자기/조상 중 clickable 을 골라 ACTION_CLICK — 행처럼 생긴 것(체크박스가 있거나 충분히 큰 것) 우선
     * 2) 다 실패하면 좌표 탭(dispatchGesture)
     *
     * <b>성공을 여기서 단정하지 않는다.</b> ACTION_CLICK 이 true 라도 실제로는 아무 일도
     * 안 일어날 수 있어서, 다음 단계에서 화면 변화를 확인한다.
     */
    private boolean clickNode(AccessibilityNodeInfo n, String what) {
        if (n == null) return false;
        try { n.refresh(); } catch (Throwable ignore) { }

        // getParent() 로 받은 노드는 <b>전부 우리 것</b>이라 다 쓰고 반납해야 한다.
        // (안 반납하면 스캔 한 번에 수천 개가 새서 접근성 프로세스가 죽는다)
        ArrayList<AccessibilityNodeInfo> got = new ArrayList<AccessibilityNodeInfo>(8);
        try {
            ArrayList<AccessibilityNodeInfo> ups = new ArrayList<AccessibilityNodeInfo>(8);
            AccessibilityNodeInfo cur = n;
            for (int up = 0; up < 8 && cur != null; up++) {
                boolean clickable = false, enabled = true;
                try { clickable = cur.isClickable(); } catch (Throwable ignore) { }
                try { enabled = cur.isEnabled(); } catch (Throwable ignore) { }
                if (clickable && enabled) ups.add(cur);
                AccessibilityNodeInfo p = null;
                try { p = cur.getParent(); } catch (Throwable ignore) { }
                if (p == null) break;
                got.add(p);
                cur = p;
            }

            // 행답게 큰 후보(또는 체크박스를 품은 후보)를 먼저 — 아바타/체크박스 컨테이너를
            // 먼저 누르면 프로필 팝업이 열린다.
            int rowH = Theme.dp(this, 40);
            AccessibilityNodeInfo first = null;
            for (int i = 0; i < ups.size(); i++) {
                Rect r = boundsOf(ups.get(i));
                if (r.height() >= rowH && r.width() >= rowH * 3) { first = ups.get(i); break; }
            }
            if (first != null) {
                try {
                    if (first.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
                } catch (Throwable ignore) { }
            }
            for (int i = 0; i < ups.size(); i++) {
                if (ups.get(i) == first) continue;
                try {
                    if (ups.get(i).performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
                } catch (Throwable ignore) { }
            }
            // clickable 조상이 아예 없으면 원본에도 한 번 쏴본다 (응답하는 커스텀 뷰가 더러 있다)
            try {
                if (ups.isEmpty() && n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
            } catch (Throwable ignore) { }

            // 마지막 수단: 좌표 탭
            return tapNode(n, what);
        } finally {
            recycleAll(got);
        }
    }

    /** getParent() 등으로 받아온 임시 노드들을 반납한다 */
    private static void recycleAll(ArrayList<AccessibilityNodeInfo> list) {
        if (list == null) return;
        for (int i = 0; i < list.size(); i++) {
            AccessibilityNodeInfo n = list.get(i);
            if (n == null) continue;
            try { n.recycle(); } catch (Throwable ignore) { }
        }
        list.clear();
    }

    /** 좌표 탭. canPerformGestures 가 없으면 조용히 실패하니 미리 확인한다. */
    private boolean tapNode(AccessibilityNodeInfo n, String what) {
        if (!canGesture()) {
            note(what + " 좌표 탭을 사용할 수 없습니다. 접근성 설정에 canPerformGestures 가 없습니다.");
            return false;
        }
        Rect r = boundsOf(n);
        if (r.width() <= 0 || r.height() <= 0) return false;
        int sw = 0, sh = 0;
        try {
            DisplayMetrics dm = getResources().getDisplayMetrics();
            sw = dm.widthPixels;
            sh = dm.heightPixels;
        } catch (Throwable ignore) { }
        float cx = r.exactCenterX(), cy = r.exactCenterY();
        if (cx < 0 || cy < 0 || (sw > 0 && cx > sw) || (sh > 0 && cy > sh)) return false;
        try {
            Path p = new Path();
            p.moveTo(cx, cy);
            GestureDescription.Builder b = new GestureDescription.Builder();
            b.addStroke(new GestureDescription.StrokeDescription(p, 0L, 60L));
            boolean ok = dispatchGesture(b.build(), null, null);
            note(what + " 를 좌표로 눌러봤어 (" + (int) cx + "," + (int) cy + ")"
                    + (ok ? "" : " — 실패"));
            return ok;
        } catch (Throwable t) {
            note(what + " 좌표 탭 실패 — " + t.getClass().getSimpleName());
            return false;
        }
    }

    private boolean canGesture() {
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info == null) return false;
            return (info.getCapabilities()
                    & AccessibilityServiceInfo.CAPABILITY_CAN_PERFORM_GESTURES) != 0;
        } catch (Throwable t) {
            return false;
        }
    }

    // ── 끝내기 ───────────────────────────────────────────────────────────────

    /** 실패 + 화면 덤프 저장. detail 에 단계 정보를 반드시 같이 넘긴다. */
    private void dumpAndFail(String where) {
        String w = (where == null || where.length() == 0) ? "카톡 화면을 못 찾았어" : where;
        lastWhere = w;
        long id = attempt;
        String dump;
        try {
            dump = buildDump(w);
        } catch (Throwable t) {
            dump = "화면 기록 생성에 실패했습니다. (" + t.getClass().getSimpleName() + ")"
                    + "\n" + miniBody(w, "buildDump 실패");
        }
        try { saveDump(this, dump, id); } catch (Throwable ignore) { }
        finish(false, w + " · 화면 진단을 저장했습니다 (매크로 › 이미지 첨부 › 화면 진단 보기).");
        // 실패했으면 사진이 붙은 공유창을 남겨두지 않는다 — 그대로 두면 다음 시도까지 망친다.
        // (finish 가 핸들러를 비우니까 반드시 finish 다음에 예약한다)
        closeShare();
    }

    /**
     * 트리를 안 읽고 만드는 최소 덤프. 서비스가 중단/언바인드된 경로에서 쓴다 —
     * 여기서 아무것도 안 남기면 사용자는 "왜 실패했는지" 를 통째로 잃는다.
     */
    private void saveMini(String where, String tag) {
        lastWhere = where;
        try { saveDump(this, miniBody(where, tag), attempt); } catch (Throwable ignore) { }
    }

    private String miniBody(String where, String tag) {
        StringBuilder sb = new StringBuilder(1024);
        sb.append("=== 카톡 화면 진단(간이) ").append(stamp()).append(" ===\n");
        sb.append("시도 id: ").append(attempt).append(" · 경로: ").append(tag).append('\n');
        sb.append("실패: ").append(where).append('\n');
        sb.append("노린 방: \"").append((targetRoom == null) ? "" : targetRoom).append("\"\n");
        sb.append("단계: ").append(whereNow())
                .append(" · 대화방 선택 ").append(clickedRow ? "시도" : "없음")
                .append(" · 전송 입력 ").append(sendTry).append("회")
                .append(" · 목록 확인 ").append(sawShareList ? "있음" : "없음").append('\n');
        sb.append(env(this));
        sb.append("마지막으로 본 화면: ")
                .append(seenAt == 0 ? "없음(화면을 한 번도 못 훑었어)" : seenShape).append('\n');
        if (seenNames.length() > 0) sb.append("그때 보였던 이름: ").append(seenNames).append('\n');
        if (seenBtns.length() > 0) sb.append("그때 보였던 버튼: ").append(seenBtns).append('\n');
        sb.append(notesBlock());
        sb.append("=== 끝 ===\n");
        return sb.toString();
    }

    /** 성공/실패 정리 + 콜백 1회 */
    private void finish(boolean ok, String detail) {
        Result cb = callback;
        String room = targetRoom;
        try { h.removeCallbacksAndMessages(null); } catch (Throwable ignore) { }
        clear();

        // 여기서 로그를 <b>한 번만</b> 쓴다. Log.add 는 줄마다 동기 디스크 쓰기라서
        // 접근성 메인 스레드에서 10번 넘게 부르면 ANR 로 간다.
        String trail = flushNotes();
        if (ok) {
            Log.add(this, "이미지 전송 완료 — " + room + (trail.length() == 0 ? "" : " | " + trail));
        } else {
            Log.add(this, "이미지 전송 실패 — " + detail
                    + (trail.length() == 0 ? "" : " | 진행: " + trail));
        }

        if (cb != null) {
            try {
                cb.done(ok, detail);
            } catch (Throwable t) {
                Log.add(this, "전송 결과 콜백에서 오류 — " + t.getClass().getSimpleName());
            }
        }
    }

    /**
     * 실패 뒤 카톡 공유창을 닫는다.
     * 사진이 붙은 공유창이 그대로 남으면 다음 시도가 그 화면 위에서 시작해서 또 실패한다.
     * 카톡 화면을 최근에 본 적이 있을 때만 누른다 (엉뚱한 앱에서 뒤로가기를 누르면 안 된다).
     */
    private void closeShare() {
        if (System.currentTimeMillis() - lastKakaoWindowAt > 10000L) return;
        backTries = 0;
        // 이 뒤에 새 시도가 시작되면(대기열에 다음 사진 건이 있으면) 뒤로가기를 쏘지 않는다 —
        // 새로 뜨는 공유창을 우리가 닫아버리면 그 건까지 망친다.
        final long mine = attempt;
        h.postDelayed(new Runnable() {
            @Override public void run() {
                if (backTries >= MAX_BACK) return;
                if (armed && attempt != mine) return;
                backTries++;
                // 키보드가 떠 있으면 첫 뒤로가기는 키보드만 닫는다 → 그때만 한 번 더 쏜다.
                // (아무 때나 두 번 쏘면 공유창 뒤에 있던 카톡 화면까지 닫아버린다)
                boolean ime = imeUp();
                boolean ok = false;
                try { ok = performGlobalAction(GLOBAL_ACTION_BACK); } catch (Throwable ignore) { }
                android.util.Log.i("KakaoAuto",
                        "공유창 닫기 뒤로가기 " + backTries + " ok=" + ok + " ime=" + ime);
                if (ime && backTries < MAX_BACK) h.postDelayed(this, BACK_MS);
            }
        }, 250L);
    }

    /** 키보드(IME) 창이 떠 있나 */
    private boolean imeUp() {
        try {
            List<AccessibilityWindowInfo> ws = getWindows();
            if (ws == null) return false;
            for (int i = 0; i < ws.size(); i++) {
                AccessibilityWindowInfo w = ws.get(i);
                if (w == null) continue;
                if (w.getType() == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return true;
            }
        } catch (Throwable ignore) { }
        return false;
    }

    // ── 진행 기록 (Log.add 를 시도마다 한 번으로 줄이기 위한 버퍼) ────────────────

    /** 진행 상황 한 줄. 디스크에 안 쓴다 — 끝날 때 한 번에 넘긴다. */
    private static void note(String msg) {
        String m = (msg == null) ? "" : msg.replace('\n', ' ').replace('\r', ' ');
        android.util.Log.i("KakaoAuto", "[공유창] " + m);
        synchronized (NOTES) {
            if (NOTES.size() < NOTES_MAX) NOTES.add(m);
            else if (NOTES.size() == NOTES_MAX) NOTES.add("…(기록이 너무 많아서 여기서 잘랐어)");
        }
    }

    /** 모아둔 기록을 한 줄로 뽑고 비운다 */
    private static String flushNotes() {
        String s = notesLine();
        synchronized (NOTES) { NOTES.clear(); }
        return s;
    }

    private static String notesLine() {
        StringBuilder sb = new StringBuilder(256);
        synchronized (NOTES) {
            for (int i = 0; i < NOTES.size(); i++) {
                if (i > 0) sb.append(" → ");
                sb.append(NOTES.get(i));
            }
        }
        String s = sb.toString();
        if (s.length() > 1200) s = s.substring(0, 1200) + "…";
        return s;
    }

    /** 덤프에 넣을 진행 기록 블록 (여기선 줄바꿈으로 보기 좋게) */
    private static String notesBlock() {
        StringBuilder sb = new StringBuilder(512);
        sb.append("진행 기록:\n");
        synchronized (NOTES) {
            if (NOTES.isEmpty()) sb.append("  (없음)\n");
            for (int i = 0; i < NOTES.size(); i++) {
                sb.append("  ").append(i + 1).append(". ").append(NOTES.get(i)).append('\n');
            }
        }
        return sb.toString();
    }

    /** 지금 어느 단계에서 뭘 하고 있었나 (한 줄) */
    private static String whereNow() {
        int p = phase;
        if (p == P_PICK) return "방 고르기 중 · 스크롤 " + scrolls + "회 · 검색 " + searchTry + "회";
        if (p == P_AFTER) return "방을 누른 직후 반응 확인 중";
        if (p == P_SEND) return "전송 버튼 찾는 중";
        return "전송 버튼 누른 뒤 확인 중";
    }

    private static String timeoutWhere() {
        int p = phase;
        String room = (targetRoom == null) ? "" : targetRoom;
        if (p == P_PICK) {
            if (!sawShareList) {
                return "시간이 초과되었으나 공유창(대화방 선택 목록)이 확인되지 않았습니다. 대화방 이름 문제가 아닙니다."
                        + " 카카오톡을 직접 실행하여 잠금·재로그인·업데이트 안내가 표시되는지 확인하고,"
                        + " 채팅 목록이 표시된 상태에서 다시 시도하십시오."
                        + (lastActivityCls.length() > 0
                            ? " (당시 표시된 화면: " + shortCls(lastActivityCls) + ")" : "");
            }
            return "대화방 목록에서 「" + cut(room, 24) + "」 을 찾지 못한 상태로 시간이 초과되었습니다."
                    + (seenNames.length() > 0
                        ? " 당시 화면에 표시된 이름: " + seenNames
                          + " . 설정의 대화방 이름을 화면에 표시된 그대로 수정하십시오."
                        : " 화면에서 대화방 이름으로 인식되는 문자를 읽지 못했습니다.")
                    + nextStep();
        }
        if (p == P_AFTER) {
            return "대화방을 선택했으나 선택 상태를 확인하지 못한 상태로 시간이 초과되었습니다." + nextStep();
        }
        if (p == P_SEND) {
            return "전송 버튼을 찾지 못한 상태로 시간이 초과되었습니다"
                    + (seenBtns.length() > 0 ? " (당시 확인된 버튼: " + seenBtns + ")" : "")
                    + "." + nextStep();
        }
        return "전송 버튼 입력 후 화면이 변경되지 않은 상태로 시간이 초과되었습니다. 전송 여부를 확인할 수 없습니다."
                + " 카카오톡에서 먼저 확인하십시오. 이미 전송된 경우 재전송하지 마십시오." + nextStep();
    }

    /**
     * 실패 메시지 끝에 붙이는 <b>다음 할 일</b>.
     * "눌렀는데 아무 일도 안 일어났어" 로 끝내면 사용자는 뭘 해야 할지 모른다.
     */
    private static String nextStep() {
        return " 카카오톡 공유창이 열린 상태일 수 있습니다. 뒤로가기로 자동 종료를 시도합니다."
                + " 종료되지 않으면 뒤로가기로 직접 닫고, 카카오톡을 채팅 목록 화면으로 둔 후 다시 시도하십시오.";
    }

    /**
     * 우리 말고 켜져 있는 접근성 앱 목록.
     * 접근성끼리 부딪히면 증상이 "카톡 레이아웃이 바뀐 것" 과 구분이 안 된다 —
     * 이게 메시지와 덤프에 없으면 엉뚱한 데를 고치게 된다.
     */
    private String otherA11y() {
        StringBuilder sb = new StringBuilder(96);
        int n = 0;
        try {
            String flat = android.provider.Settings.Secure.getString(getContentResolver(),
                    android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (flat == null || flat.trim().length() == 0) return "";
            String mine = getPackageName();
            String[] parts = flat.split(":");
            for (int i = 0; i < parts.length && n < 6; i++) {
                String p = (parts[i] == null) ? "" : parts[i].trim();
                if (p.length() == 0) continue;
                int slash = p.indexOf('/');
                String pkg = (slash > 0) ? p.substring(0, slash) : p;
                if (pkg.equals(mine)) continue;         // 우리 건 뺀다
                if (n > 0) sb.append(", ");
                sb.append(appLabel(pkg)).append('(').append(pkg).append(')');
                n++;
            }
        } catch (Throwable t) {
            return "";
        }
        return sb.toString();
    }

    /** 실패 메시지에 붙일 "다른 접근성 앱이 켜져 있다" 안내. 없으면 "". */
    private String a11yTail() {
        String o = otherA11y();
        if (o.length() == 0) return "";
        return " · 참고: 타사 접근성 앱이 활성 상태입니다(" + o + "). 해당 앱은 자동 조작과 충돌하여"
                + " 카카오톡 레이아웃이 변경된 것과 동일한 증상을 유발합니다. 일시 해제한 후 다시 시도하십시오.";
    }

    /** 패키지의 앱 이름 (못 찾으면 패키지명 그대로) */
    private String appLabel(String pkg) {
        try {
            android.content.pm.PackageManager pm = getPackageManager();
            CharSequence l = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0));
            if (l != null && l.length() > 0) return l.toString();
        } catch (Throwable ignore) { }
        return pkg;
    }

    /** 기기/OS/화면/앱 정보 — bounds 숫자를 해석하려면 해상도가 필요하다 */
    private static String env(Context c) {
        StringBuilder sb = new StringBuilder(256);
        sb.append("기기: ").append(Build.MANUFACTURER).append(' ').append(Build.MODEL)
                .append(" · 안드로이드 ").append(Build.VERSION.RELEASE)
                .append("(SDK ").append(Build.VERSION.SDK_INT).append(")\n");
        String res = "?";
        String appVer = "?";
        if (c != null) {
            try {
                DisplayMetrics dm = c.getResources().getDisplayMetrics();
                res = dm.widthPixels + "x" + dm.heightPixels + " (density " + dm.density + ")";
            } catch (Throwable ignore) { }
            try {
                appVer = String.valueOf(c.getPackageManager()
                        .getPackageInfo(c.getPackageName(), 0).versionName);
            } catch (Throwable ignore) { }
        }
        sb.append("화면: ").append(res).append(" · 앱 버전: ").append(appVer).append('\n');
        return sb.toString();
    }

    private static String stamp() {
        try {
            return new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA).format(new Date());
        } catch (Throwable t) {
            return "--/-- --:--:--";
        }
    }

    // ── 창/루트 모으기 ───────────────────────────────────────────────────────

    /**
     * 볼 만한 카톡 루트 노드들. 활성 창 먼저, 그다음 떠 있는 창을 레이어 높은 순으로.
     * getRootInActiveWindow() 하나만 보면 바텀시트·다이얼로그·최종 확인 팝업을 놓친다.
     */
    private ArrayList<AccessibilityNodeInfo> roots() {
        ArrayList<AccessibilityNodeInfo> out = new ArrayList<AccessibilityNodeInfo>(4);
        try {
            AccessibilityNodeInfo r = getRootInActiveWindow();
            if (r != null) {
                CharSequence p = null;
                try { p = r.getPackageName(); } catch (Throwable ignore) { }
                if (p == null || KAKAO.contentEquals(p)) out.add(r);
            }
        } catch (Throwable ignore) { }

        try {
            List<AccessibilityWindowInfo> ws = getWindows();
            if (ws != null && !ws.isEmpty()) {
                ArrayList<AccessibilityWindowInfo> sorted = new ArrayList<AccessibilityWindowInfo>(ws);
                // 레이어 높은 순 (위에 뜬 창을 먼저 본다). 목록이 짧으니 삽입 정렬로 충분하다.
                for (int i = 1; i < sorted.size(); i++) {
                    AccessibilityWindowInfo w = sorted.get(i);
                    int j = i - 1;
                    while (j >= 0 && layerOf(sorted.get(j)) < layerOf(w)) {
                        sorted.set(j + 1, sorted.get(j));
                        j--;
                    }
                    sorted.set(j + 1, w);
                }
                for (int i = 0; i < sorted.size(); i++) {
                    AccessibilityNodeInfo r = null;
                    try { r = sorted.get(i).getRoot(); } catch (Throwable ignore) { }
                    if (r == null) continue;
                    CharSequence p = null;
                    try { p = r.getPackageName(); } catch (Throwable ignore) { }
                    if (p == null || !KAKAO.contentEquals(p)) continue;
                    boolean dup = false;
                    for (int k = 0; k < out.size(); k++) {
                        if (r.equals(out.get(k))) { dup = true; break; }
                    }
                    if (!dup) out.add(r);
                }
            }
        } catch (Throwable ignore) { }
        return out;
    }

    private static int layerOf(AccessibilityWindowInfo w) {
        try { return (w == null) ? -1 : w.getLayer(); } catch (Throwable t) { return -1; }
    }

    // ── 한 번에 다 훑기 ──────────────────────────────────────────────────────

    /** 이름 후보 한 건 */
    private static final class Hit {
        AccessibilityNodeInfo node;
        String name = "";
        int level = 9;          // 0 정확 · 1 공백무시 · 2 말줄임 접두 · 3 부분일치
        String rowKey = "";

        String how() {
            switch (level) {
                case 0: return "정확히 일치";
                case 1: return "공백/특수문자 무시";
                case 2: return "말줄임 접두";
                default: return "부분 일치";
            }
        }
    }

    /** 버튼 후보 한 건 */
    private static final class Btn {
        AccessibilityNodeInfo node;
        String label = "";
        String id = "";
        boolean enabled = true;
        int prio = 9;
    }

    /** 한 step 에서 화면에서 알아낸 모든 것 */
    private final class Scan {
        final ArrayList<Hit> h0 = new ArrayList<Hit>(4);
        final ArrayList<Hit> h1 = new ArrayList<Hit>(4);
        final ArrayList<Hit> h2 = new ArrayList<Hit>(4);
        final ArrayList<Hit> h3 = new ArrayList<Hit>(4);
        final ArrayList<Btn> btns = new ArrayList<Btn>(8);
        final ArrayList<Btn> tabs = new ArrayList<Btn>(6);
        final ArrayList<AccessibilityNodeInfo> scrollables = new ArrayList<AccessibilityNodeInfo>(4);
        final ArrayList<String> leafTexts = new ArrayList<String>(32);
        /** 누를 수 있는 행 안에 있던 짧은 글자 = 방/사람 이름 후보 */
        final ArrayList<String> rowNames = new ArrayList<String>(32);
        AccessibilityNodeInfo searchBox = null;
        AccessibilityNodeInfo searchOpener = null;
        boolean chatInput = false;
        boolean splash = false;
        int checkables = 0;
        int checkedCount = 0;
        /** 행처럼 생긴 글자 개수 */
        int rows = 0;
        /** 제일 큰 스크롤 노드의 자식 수 (= 목록 행 수) */
        int listRows = 0;
        int nodes = 0;
        boolean truncated = false;
        String sig = "";

        /** 제일 확실한 후보 묶음만 돌려준다 (행 기준 중복 제거) */
        ArrayList<Hit> bestHits() {
            if (!h0.isEmpty()) return dedupe(h0);
            if (!h1.isEmpty()) return dedupe(h1);
            if (!h2.isEmpty()) return dedupe(h2);
            return dedupe(h3);
        }

        private ArrayList<Hit> dedupe(ArrayList<Hit> in) {
            ArrayList<Hit> out = new ArrayList<Hit>(in.size());
            for (int i = 0; i < in.size(); i++) {
                Hit a = in.get(i);
                boolean dup = false;
                for (int k = 0; k < out.size(); k++) {
                    Hit b = out.get(k);
                    if (a.rowKey.length() > 0 && a.rowKey.equals(b.rowKey)) { dup = true; break; }
                    if (squash(a.name).equals(squash(b.name))) { dup = true; break; }
                }
                if (!dup) out.add(a);
            }
            return out;
        }

        /** 가장 그럴듯한 전송 버튼. wantEnabled=false 면 비활성 버튼도 본다. */
        Btn bestBtn(boolean wantEnabled) {
            Btn best = null;
            for (int i = 0; i < btns.size(); i++) {
                Btn b = btns.get(i);
                if (wantEnabled && !b.enabled) continue;
                if (!wantEnabled && b.enabled) continue;
                if (best == null || b.prio < best.prio) best = b;
            }
            return best;
        }

        /** 면적이 가장 큰 스크롤 노드 (탭 스트립 같은 엉뚱한 걸 굴리지 않게) */
        AccessibilityNodeInfo biggestScrollable() {
            AccessibilityNodeInfo best = null;
            long area = 0;
            for (int i = 0; i < scrollables.size(); i++) {
                Rect r = boundsOf(scrollables.get(i));
                long a = (long) r.width() * (long) r.height();
                if (a > area) { area = a; best = scrollables.get(i); }
            }
            return best;
        }
    }

    /** 순회 상태 */
    private static final class Walk {
        int visited = 0;
        boolean truncated = false;
    }

    private interface Eye {
        /**
         * @param clickUp 나를 포함해 위로 몇 칸 안에 clickable 조상이 있나
         *                (0 = 자기 자신, 1 = 부모, … , {@link #NO_CLICK_UP} = 없음).
         *                순회하면서 내려주니까 getParent() 를 다시 부를 필요가 없다.
         * @return true 를 주면 그 노드는 보관한다(재활용하지 않는다)
         */
        boolean at(AccessibilityNodeInfo n, int depth, int clickUp);
    }

    /** clickable 조상이 (추적 범위 안에) 없다는 표시 */
    private static final int NO_CLICK_UP = 99;

    /**
     * 깊이 우선 순회 (화면에 보이는 순서대로).
     * 보관하지 않는 <b>잎 노드만</b> recycle() 한다 — 조상은 클릭 경로에 쓰이니 건드리지 않는다.
     * (API 33+ 는 recycle() 이 no-op 이고, 잘못 반납하면 IllegalStateException 이 나니 이 선만 지킨다)
     *
     * clickable 조상 거리(clickUp)를 내려주는 이유: 예전엔 노드마다 getParent() 를 4번 불러서
     * 확인했는데, 그 부모들을 하나도 반납하지 않아 보이는 노드 800개면 스캔 1회에 3200개가 샜다.
     * 트리를 내려가면서 이미 아는 값을 넘겨주면 부모를 아예 안 받아도 된다.
     */
    private static void walk(AccessibilityNodeInfo n, int depth, int limit, Walk w, Eye eye) {
        walk(n, depth, NO_CLICK_UP, limit, w, eye);
    }

    private static void walk(AccessibilityNodeInfo n, int depth, int clickUpIn,
                             int limit, Walk w, Eye eye) {
        if (n == null) return;
        if (w.visited >= limit) { w.truncated = true; return; }
        w.visited++;
        int clickUp = flag(n, 1) ? 0 : clickUpIn;
        boolean keep = false;
        try { keep = eye.at(n, depth, clickUp); } catch (Throwable ignore) { }
        int cc = 0;
        try { cc = n.getChildCount(); } catch (Throwable ignore) { }
        if (depth < 40) {
            int childUp = (clickUp >= NO_CLICK_UP) ? NO_CLICK_UP : clickUp + 1;
            for (int i = 0; i < cc; i++) {
                AccessibilityNodeInfo ch = null;
                try { ch = n.getChild(i); } catch (Throwable ignore) { }
                walk(ch, depth + 1, childUp, limit, w, eye);
            }
        }
        if (!keep && cc == 0 && depth > 0) {
            try { n.recycle(); } catch (Throwable ignore) { }
        }
    }

    /** 화면 한 번 훑어서 필요한 걸 다 모은다 (한 step 에 한 번만 돈다) */
    private Scan scan(List<AccessibilityNodeInfo> rs) {
        final Scan sc = new Scan();
        final String room = (targetRoom == null) ? "" : targetRoom;
        final String roomN = norm(room).toLowerCase(Locale.ROOT);
        final String roomS = squash(room);
        final StringBuilder sig = new StringBuilder(256);
        final int topThird = screenH() / 3;

        for (int ri = 0; ri < rs.size(); ri++) {
            final AccessibilityNodeInfo root = rs.get(ri);
            Walk w = new Walk();
            walk(root, 0, MAX_NODES, w, new Eye() {
                @Override public boolean at(AccessibilityNodeInfo n, int depth, int clickUp) {
                    boolean keep = false;
                    String id = viewId(n);
                    String shortId = shortId(id);
                    String tx = norm(text2(n));
                    String ds = norm(desc(n));
                    boolean vis = visible(n);
                    boolean clickable = flag(n, 1);
                    boolean editable = isEditable(n);
                    int cc = 0;
                    try { cc = n.getChildCount(); } catch (Throwable ignore) { }

                    // 체크 상태는 "보이는 노드" 만 센다 — 화면 밖 행이 체크돼 있다고
                    // 우리가 고른 방이 선택된 줄 오해하면 안 된다.
                    if (flag(n, 2) && vis) {
                        sc.checkables++;
                        if (flag(n, 3)) sc.checkedCount++;
                    }
                    if (flag(n, 4) && vis) {          // scrollable
                        sc.scrollables.add(n);
                        keep = true;
                    }
                    if (idIn(id, CHATROOM_IDS) && vis) sc.chatInput = true;

                    // 목록 행 세기.
                    //  예전 조건(clickable && 자식 있음 && 자기한테 글자 있음)은 거의 안 걸린다 —
                    //  카톡 행 컨테이너는 clickable 이지만 글자는 자식 TextView 에 있다.
                    //  그래서 "누를 수 있는 행 안에 있는 짧은 글자" 를 센다.
                    if (vis && cc == 0 && tx.length() > 0 && clickUp <= 4 && tx.length() <= NAME_MAX) {
                        sc.rows++;
                        if (sc.rowNames.size() < 40 && !sc.rowNames.contains(tx)) sc.rowNames.add(tx);
                    }

                    if (vis && cc == 0 && tx.length() > 0 && sig.length() < 900) {
                        sig.append(cut(tx, 12)).append('|');
                        if (sc.leafTexts.size() < 60 && !sc.leafTexts.contains(tx)) {
                            sc.leafTexts.add(tx);
                        }
                    }

                    // ── 검색 입력창 ──
                    if (editable && vis && !idIn(id, CHATROOM_IDS)) {
                        boolean hintOk = idIn(id, SEARCH_IDS) || hintLike(n);
                        boolean topOk = boundsOf(n).top <= topThird;
                        if (sc.searchBox == null && (hintOk || topOk)) {
                            sc.searchBox = n;
                            keep = true;
                        }
                    } else if (!editable && vis && clickable && sc.searchOpener == null) {
                        // 검색 아이콘 / 힌트 라벨 (라벨은 미리 정규화해둔 SEARCH_HINT_S 를 쓴다)
                        String txS = squash(tx);
                        String dsS = squash(ds);
                        for (int k = 0; k < SEARCH_HINT_S.length; k++) {
                            String hs = SEARCH_HINT_S[k];
                            if (hs.length() == 0) continue;
                            if (txS.contains(hs) || dsS.contains(hs)) {
                                sc.searchOpener = n;
                                keep = true;
                                break;
                            }
                        }
                    }

                    // ── 방 이름 후보 ──
                    if (vis && !editable && (tx.length() > 0 || ds.length() > 0) && roomN.length() > 0) {
                        String cand = (tx.length() > 0) ? tx : ds;
                        Hit hit = match(cand, roomN, roomS, room);
                        if (hit != null) {
                            hit.node = n;
                            AccessibilityNodeInfo row = rowOf(n);
                            hit.rowKey = keyOf(row);
                            recycleRow(row, n);
                            boolean idBonus = idIn(id, ROOM_IDS);
                            if (idBonus && hit.level > 0) hit.level--;
                            switch (hit.level) {
                                case 0: sc.h0.add(hit); break;
                                case 1: sc.h1.add(hit); break;
                                case 2: sc.h2.add(hit); break;
                                default: sc.h3.add(hit); break;
                            }
                            keep = true;
                        }
                    }

                    // ── 전송/확인 버튼 후보 ──
                    // (clickUp 은 순회가 내려준 값이다 — getParent() 를 다시 부르지 않는다)
                    if (vis && !editable && clickUp <= 3) {
                        String lbl = (tx.length() > 0) ? tx : ds;
                        int prio = btnPrio(id, lbl, room);
                        if (prio < 9) {
                            Btn b = new Btn();
                            b.node = n;
                            b.label = (lbl.length() > 0) ? lbl : shortId;
                            b.id = shortId;
                            b.enabled = flag(n, 5) && !zeroCount(lbl);
                            b.prio = prio;
                            sc.btns.add(b);
                            keep = true;
                        }
                        // 탭 후보
                        if (lbl.length() > 0 && lbl.length() <= 6 && boundsOf(n).top <= topThird) {
                            Btn t = new Btn();
                            t.node = n;
                            t.label = lbl;
                            t.id = shortId;
                            if (sc.tabs.size() < 12) sc.tabs.add(t);
                            keep = true;
                        }
                    }
                    return keep;
                }
            });
            sc.nodes += w.visited;
            if (w.truncated) sc.truncated = true;
        }
        // 제일 큰 스크롤 노드의 자식 수 = 목록 행 수에 가장 가까운 숫자.
        // (텍스트 매칭과 달리 여기엔 추측이 안 들어간다)
        AccessibilityNodeInfo list = sc.biggestScrollable();
        if (list != null) {
            try { sc.listRows = list.getChildCount(); } catch (Throwable ignore) { }
        }
        // 목록도 글자도 거의 없으면 아직 스플래시/로딩 구간이다 (콜드스타트면 방 목록이 없다)
        sc.splash = sc.scrollables.isEmpty() && sc.leafTexts.size() <= 2;
        sc.sig = String.valueOf(sig.toString().hashCode()) + "/" + sc.nodes
                + "/" + sc.checkedCount + "/" + sc.btns.size();
        remember(sc);
        return sc;
    }

    /**
     * 이번에 본 화면을 짧게 기억해둔다.
     * 창이 사라진 뒤(타임아웃·서비스 중단)에도 "그때까지 뭘 봤는지" 를 말할 수 있어야 한다.
     */
    private void remember(Scan sc) {
        seenNames = roomLike(sc);
        seenBtns = joinBtnLabels(sc);
        seenShape = "노드 " + sc.nodes + " · 목록행 " + sc.listRows + " · 행글자 " + sc.rows
                + " · 스크롤 " + sc.scrollables.size() + " · 체크 " + sc.checkables
                + "(켜짐 " + sc.checkedCount + ")" + " · 버튼후보 " + sc.btns.size();
        seenAt = System.currentTimeMillis();
    }

    /**
     * 공유 목록(방 고르기 목록)을 실제로 본 적이 있나 표시한다.
     *
     * 예전 조건은 rows>=2(clickable + 자식 + 자기 글자) 였는데 카톡 행 구조에선 거의 0 이라
     * "목록을 못 봤다" 로 잘못 새고, 성공 경로(sawShareList 를 요구하는 자리)까지 막힐 수 있었다.
     * 그래서 <b>행처럼 생긴 글자 · 스크롤 노드의 자식 수 · 체크박스 개수</b> 중 하나라도
     * 목록답게 나오면 봤다고 본다. (못 봤다고 잘못 말하는 쪽이 훨씬 해롭다)
     */
    private static void markShareList(Scan sc) {
        if (sawShareList) return;
        boolean listy = (sc.listRows >= 2) || (sc.rows >= 2) || (sc.checkables >= 2);
        if (listy && (sc.scrollables.size() > 0 || sc.checkables >= 2)) sawShareList = true;
        else if (!sc.h0.isEmpty() || !sc.h1.isEmpty()) sawShareList = true;   // 방 이름을 정확히 찾았다
    }

    /**
     * 화면에 있던 <b>방 이름처럼 보이는 글자</b>를 최대 {@link #SHOW_NAMES} 개 뽑는다.
     * 사용자가 "아, 카톡엔 이모지가 붙어 있었네" 를 스스로 알아채는 게 제일 빠른 수리다.
     */
    private static String roomLike(Scan sc) {
        ArrayList<String> pool = (sc.rowNames.size() > 0) ? sc.rowNames : sc.leafTexts;
        StringBuilder sb = new StringBuilder(128);
        int n = 0;
        for (int i = 0; i < pool.size() && n < SHOW_NAMES; i++) {
            String t = pool.get(i);
            if (!nameLike(t)) continue;
            if (n > 0) sb.append(" · ");
            sb.append('「').append(t).append('」');
            n++;
        }
        return sb.toString();
    }

    /** 방/사람 이름처럼 보이나 (UI 라벨·시각·대화 본문은 뺀다) */
    private static boolean nameLike(String t) {
        if (t == null) return false;
        String s = t.trim();
        if (s.length() == 0 || s.length() > NAME_MAX) return false;   // 길면 대화 본문
        String q = squash(s);
        if (q.length() == 0) return false;
        for (int i = 0; i < SEND_S.length; i++) if (q.equals(SEND_S[i])) return false;
        for (int i = 0; i < TAB_CHAT_S.length; i++) if (q.equals(TAB_CHAT_S[i])) return false;
        for (int i = 0; i < SEARCH_HINT_S.length; i++) {
            if (SEARCH_HINT_S[i].length() > 0 && q.contains(SEARCH_HINT_S[i])) return false;
        }
        boolean digit = false, other = false;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c >= '0' && c <= '9') digit = true;
            else if (c != ':' && c != '.' && c != ' ' && c != '-' && c != '/') other = true;
        }
        if (digit && !other) return false;                 // 숫자·시각("3:21")
        if (q.startsWith("오전") || q.startsWith("오후")) return false;   // "오후 3:21"
        if (q.endsWith("읽음") || q.endsWith("안읽음")) return false;
        return true;
    }

    /** 이름 매칭. 안 맞으면 null. */
    private static Hit match(String cand, String roomN, String roomS, String room) {
        String cn = cand.toLowerCase(Locale.ROOT);
        String cs = squash(cand);
        if (cn.equals(roomN)) { Hit h = new Hit(); h.name = cand; h.level = 0; return h; }
        if (cs.length() > 0 && cs.equals(roomS)) { Hit h = new Hit(); h.name = cand; h.level = 1; return h; }
        // 카톡이 긴 방 이름을 "…" 로 잘라서 보여주는 경우
        String base = cs;
        if (base.endsWith("…")) base = base.substring(0, base.length() - 1);
        else if (base.endsWith("...")) base = base.substring(0, base.length() - 3);
        if (base.length() >= 3 && !base.equals(cs) && roomS.startsWith(base)) {
            Hit h = new Hit(); h.name = cand; h.level = 2; return h;
        }
        // 부분 일치 — 남의 대화 미리보기 줄을 잡지 않게 길이를 제한한다
        if (roomS.length() >= 2 && cs.contains(roomS)
                && cs.length() <= roomS.length() + 14) {
            Hit h = new Hit(); h.name = cand; h.level = 3; return h;
        }
        return null;
    }

    /** 전송 버튼 우선순위. 9 = 후보 아님. */
    private static int btnPrio(String id, String label, String room) {
        if (idIn(id, SEND_IDS)) return 0;
        String l = squash(label);
        if (l.length() == 0) return 9;
        // 방 이름 자체를 전송 버튼으로 오인하지 않게
        if (room != null && room.length() > 0 && l.equals(squash(room))) return 9;
        // 라벨은 미리 정규화해둔 배열을 쓴다 (노드마다 squash 를 다시 돌리지 않는다)
        for (int i = 0; i < SEND_S.length; i++) {
            if (l.equals(SEND_S[i])) return 1;
        }
        for (int i = 0; i < SEND_S.length; i++) {
            String s = SEND_S[i];
            if (s.length() > 0 && l.startsWith(s) && l.length() <= s.length() + 6) return 2;
        }
        for (int i = 0; i < SEND_LOOSE_S.length; i++) {
            String s = SEND_LOOSE_S[i];
            if (s.length() > 0 && l.contains(s) && l.length() <= s.length() + 8) return 3;
        }
        return 9;
    }

    /** "전송 0", "확인 (0)" 처럼 개수가 0 인 버튼은 눌러도 아무 일이 없다 */
    private static boolean zeroCount(String label) {
        if (label == null) return false;
        boolean sawDigit = false;
        int val = 0;
        for (int i = 0; i < label.length(); i++) {
            char c = label.charAt(i);
            if (c >= '0' && c <= '9') { sawDigit = true; val = val * 10 + (c - '0'); }
            else if (sawDigit) break;
        }
        return sawDigit && val == 0;
    }

    /**
     * 방 이름 노드에서 눌러야 하는 "행" 을 찾는다.
     * <b>돌려준 노드 말고</b> 올라오면서 받은 부모 노드는 여기서 다 반납한다.
     * 돌려준 노드가 n 이 아니면 부른 쪽이 {@link #recycleRow(AccessibilityNodeInfo, AccessibilityNodeInfo)}
     * 로 반납해야 한다.
     */
    private AccessibilityNodeInfo rowOf(AccessibilityNodeInfo n) {
        if (n == null) return null;
        int rowH = Theme.dp(this, 40);
        ArrayList<AccessibilityNodeInfo> got = new ArrayList<AccessibilityNodeInfo>(6);
        AccessibilityNodeInfo cur = n;
        AccessibilityNodeInfo firstClickable = null;
        AccessibilityNodeInfo row = null;
        for (int up = 0; up < 6 && cur != null; up++) {
            boolean clickable = false;
            try { clickable = cur.isClickable(); } catch (Throwable ignore) { }
            if (clickable) {
                if (firstClickable == null) firstClickable = cur;
                Rect r = boundsOf(cur);
                if (r.height() >= rowH && r.width() >= rowH * 3) { row = cur; break; }
            }
            AccessibilityNodeInfo p = null;
            try { p = cur.getParent(); } catch (Throwable ignore) { }
            if (p == null) break;
            got.add(p);
            cur = p;
        }
        AccessibilityNodeInfo out = (row != null) ? row : ((firstClickable != null) ? firstClickable : n);
        // 고른 것만 남기고 나머지 부모는 반납 (부모를 반납해도 자식 노드는 안 깨진다)
        for (int i = 0; i < got.size(); i++) {
            AccessibilityNodeInfo p = got.get(i);
            if (p == out) continue;
            try { p.recycle(); } catch (Throwable ignore) { }
        }
        return out;
    }

    /** rowOf 가 돌려준 행 노드 반납 (원본 노드는 스캔이 들고 있으니 건드리지 않는다) */
    private static void recycleRow(AccessibilityNodeInfo row, AccessibilityNodeInfo origin) {
        if (row == null || row == origin) return;
        try { row.recycle(); } catch (Throwable ignore) { }
    }

    /** 행 안에 체크박스가 있나 / 켜져 있나. 없으면 null. */
    private Boolean rowChecked(AccessibilityNodeInfo row) {
        if (row == null) return null;
        final boolean[] found = new boolean[] { false, false };
        Walk w = new Walk();
        walk(row, 0, 80, w, new Eye() {
            @Override public boolean at(AccessibilityNodeInfo n, int depth, int clickUp) {
                if (flag(n, 2)) {
                    found[0] = true;
                    if (flag(n, 3)) found[1] = true;
                }
                return false;
            }
        });
        if (!found[0]) return null;
        return Boolean.valueOf(found[1]);
    }

    /** 우리가 눌렀던 행이 지금 체크돼 있나 */
    private boolean rowCheckedByKey(Scan sc) {
        if (pickedRowKey.length() == 0) return false;
        ArrayList<Hit> hits = sc.bestHits();
        for (int i = 0; i < hits.size(); i++) {
            Hit hit = hits.get(i);
            AccessibilityNodeInfo row = rowOf(hit.node);
            try {
                Boolean b = rowChecked(row);
                if (b != null && b.booleanValue()) return true;
            } finally {
                recycleRow(row, hit.node);
            }
        }
        return false;
    }

    private String joinBtnLabels(Scan sc) {
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (int i = 0; i < sc.btns.size() && n < 6; i++) {
            Btn b = sc.btns.get(i);
            if (b.label.length() == 0) continue;
            if (n > 0) sb.append(", ");
            sb.append(cut(b.label, 14));
            if (!b.enabled) sb.append("(비활성)");
            n++;
        }
        return (n == 0) ? "없음" : sb.toString();
    }

    // ── 화면 덤프 ────────────────────────────────────────────────────────────

    /**
     * 지금 화면을 사람이 읽을 수 있게 떠낸다.
     * 맨 위에 <b>요약</b>(창 목록 · 스크롤 노드 · 체크 노드 · 보이던 글자 · 버튼 후보)을 붙이고,
     * 그 아래에 노드 목록을 붙인다. 이 요약만 있어도 (a)단건/(b)다중선택 판정, 탭 유무,
     * 검색창 id, 확정 버튼 라벨이 한 번에 정해진다.
     */
    private String buildDump(String where) {
        final StringBuilder out = new StringBuilder(4096);
        final String room = (targetRoom == null) ? "" : targetRoom;
        String now = new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA).format(new Date());

        out.append("=== 카카오톡 화면 진단 ").append(now).append(" ===\n");
        out.append("※ 이 기록에는 당시 카카오톡 화면에 표시된 이름·문구가 포함됩니다.\n");
        out.append("   전달 전 내용을 확인하고, 노출을 원하지 않는 항목은 삭제하십시오.\n");
        out.append("   (대화 본문 등 장문은 앞 ").append(TEXT_KEEP).append("자만 기록됩니다)\n");
        out.append("시도 id: ").append(attempt).append('\n');
        out.append("실패: ").append((where == null || where.length() == 0) ? "(수동 수집)" : where).append('\n');
        out.append("대상 대화방: \"").append(room).append("\"  (정규화: \"").append(norm(room))
                .append("\" / 공백무시: \"").append(squash(room)).append("\")\n");
        out.append("단계: ").append(whereNow())
                .append(" · 대화방 선택 ").append(clickedRow ? "시도" : "없음")
                .append(" · 전송 입력 ").append(sendTry).append("회")
                .append(" · 목록 확인 ").append(sawShareList ? "있음" : "없음").append('\n');
        out.append(env(this));
        out.append("카카오톡 버전: ").append(kakaoVersion()).append('\n');
        out.append("좌표 탭 가능(canPerformGestures): ").append(canGesture() ? "Y" : "N").append('\n');
        out.append("마지막 액티비티/다이얼로그: ")
                .append(lastActivityCls.length() == 0 ? "확인 불가" : lastActivityCls).append('\n');
        String others = otherA11y();
        out.append("활성 상태인 타사 접근성 앱: ")
                .append(others.length() == 0 ? "없음" : others)
                .append(others.length() == 0 ? "" : "  ← 접근성 앱 충돌 시 레이아웃 변경과 동일한 증상이 발생합니다")
                .append('\n');

        ArrayList<AccessibilityNodeInfo> rs = roots();
        out.append("카카오톡 창 개수: ").append(rs.size()).append('\n');
        try {
            List<AccessibilityWindowInfo> ws = getWindows();
            if (ws != null) {
                for (int i = 0; i < ws.size() && i < 8; i++) {
                    AccessibilityWindowInfo w = ws.get(i);
                    if (w == null) continue;
                    AccessibilityNodeInfo r = null;
                    try { r = w.getRoot(); } catch (Throwable ignore) { }
                    out.append("  창#").append(i).append(" type=").append(winType(w))
                            .append(" active=").append(bool(w.isActive()))
                            .append(" focus=").append(bool(w.isFocused()))
                            .append(" layer=").append(layerOf(w))
                            .append(" pkg=").append((r == null) ? "?" : String.valueOf(pkgOf(r)))
                            .append(" 루트클래스=").append((r == null) ? "없음" : className(r))
                            .append(" 크기=").append((r == null) ? "?" : boundsStr(r))
                            .append('\n');
                    if (r != null) { try { r.recycle(); } catch (Throwable ignore) { } }
                }
            }
        } catch (Throwable t) {
            out.append("  (창 목록을 읽지 못했습니다 — ").append(t.getClass().getSimpleName()).append(")\n");
        }

        if (rs.isEmpty()) {
            out.append("\n현재 화면에 카카오톡 창이 없습니다. 공유창이 이미 닫혔거나 다른 앱이 전면에 있습니다.\n");
            out.append("마지막으로 본 화면: ")
                    .append(seenAt == 0 ? "없음(화면 수집 기록 없음)" : seenShape).append('\n');
            if (seenNames.length() > 0) out.append("당시 확인된 이름: ").append(seenNames).append('\n');
            if (seenBtns.length() > 0) out.append("당시 확인된 버튼: ").append(seenBtns).append('\n');
            out.append(notesBlock());
            out.append("=== 끝 ===\n");
            return out.toString();
        }

        Scan sc;
        try {
            sc = scan(rs);
        } catch (Throwable t) {
            out.append("\n화면 수집에 실패했습니다 — ").append(t.getClass().getSimpleName()).append('\n');
            out.append(notesBlock()).append("=== 끝 ===\n");
            recycleAll(rs);
            return out.toString();
        }

        out.append("노드 ").append(sc.nodes).append("개")
                .append(sc.truncated ? " (한도 초과로 일부 생략)" : "").append('\n');
        out.append("스크롤 가능 노드: ").append(sc.scrollables.size()).append("개\n");
        for (int i = 0; i < sc.scrollables.size() && i < 6; i++) {
            AccessibilityNodeInfo n = sc.scrollables.get(i);
            out.append("  - ").append(shortCls(className(n))).append(" id=")
                    .append(shortId(viewId(n))).append(' ').append(boundsStr(n)).append('\n');
        }
        out.append("목록 행(최대 스크롤 노드의 자식): ").append(sc.listRows)
                .append("개 · 행으로 인식된 문자: ").append(sc.rows).append("개\n");
        out.append("체크 가능 노드(보이는 것): ").append(sc.checkables).append("개 (켜진 것 ")
                .append(sc.checkedCount).append("개) → ")
                .append(sc.checkables > 0 ? "다중선택형(b)으로 판단" : "체크박스 미확인 = 단건형(a) 가능")
                .append('\n');
        out.append("검색 입력창: ").append(sc.searchBox == null ? "미확인"
                : (shortId(viewId(sc.searchBox)) + " " + boundsStr(sc.searchBox))).append('\n');
        out.append("검색 열기 후보: ").append(sc.searchOpener == null ? "미확인"
                : (cut(text2(sc.searchOpener), 20) + " / " + shortId(viewId(sc.searchOpener)))).append('\n');
        out.append("채팅방 입력창 보임: ").append(sc.chatInput ? "Y" : "N").append('\n');

        out.append("버튼으로 인식된 노드(입력 가능 + 문자 포함) ").append(sc.btns.size()).append("개:\n");
        for (int i = 0; i < sc.btns.size() && i < 12; i++) {
            Btn b = sc.btns.get(i);
            out.append("  - \"").append(cut(b.label, 24)).append("\" id=").append(b.id)
                    .append(" enabled=").append(b.enabled ? "Y" : "N")
                    .append(" prio=").append(b.prio)
                    .append(' ').append(boundsStr(b.node)).append('\n');
        }
        out.append("방 이름처럼 보이던 글자: ")
                .append(roomLike(sc).length() == 0 ? "없음" : roomLike(sc)).append('\n');
        out.append("화면에 있던 글자(중복 제거, 앞 ").append(Math.min(40, sc.leafTexts.size())).append("개):\n");
        for (int i = 0; i < sc.leafTexts.size() && i < 40; i++) {
            out.append("  ").append(i + 1).append(". ").append(privacyCut(sc.leafTexts.get(i))).append('\n');
        }
        ArrayList<Hit> hits = sc.bestHits();
        out.append("방 이름 후보: ").append(hits.size()).append("개");
        for (int i = 0; i < hits.size() && i < 5; i++) {
            out.append("\n  - \"").append(cut(hits.get(i).name, 24)).append("\" (")
                    .append(hits.get(i).how()).append(") 행=").append(hits.get(i).rowKey);
        }
        out.append('\n');

        // ── 전체 노드 ──
        out.append("\n--- 노드 목록 (최대 ").append(DUMP_MAX_LINES).append("줄) ---\n");
        final int[] lines = new int[] { 0 };
        final int[] skipped = new int[] { 0 };
        for (int ri = 0; ri < rs.size(); ri++) {
            out.append("[창 ").append(ri).append("] ").append(shortCls(className(rs.get(ri)))).append('\n');
            Walk w = new Walk();
            final StringBuilder sb = out;
            walk(rs.get(ri), 0, DUMP_MAX_NODES, w, new Eye() {
                @Override public boolean at(AccessibilityNodeInfo n, int depth, int clickUp) {
                    String tx = norm(textOnly(n));
                    String ds = norm(desc(n));
                    String id = shortId(viewId(n));
                    if (tx.length() == 0 && ds.length() == 0 && id.length() == 0) return false;
                    if (lines[0] >= DUMP_MAX_LINES
                            || sb.length() > DUMP_MAX_CHARS - DUMP_TAIL_ROOM) { skipped[0]++; return false; }
                    StringBuilder l = new StringBuilder(DUMP_MAX_LINE_LEN);
                    for (int d = 0; d < depth && d < 12; d++) l.append(' ');
                    l.append('[').append(shortCls(className(n))).append(']');
                    // 방/사람 이름은 통째로 남긴다(그게 있어야 셀렉터를 고친다).
                    // 대화 본문처럼 긴 글자만 앞부분으로 자른다.
                    if (tx.length() > 0) l.append(" text=\"").append(privacyCut(tx)).append('"');
                    if (ds.length() > 0) l.append(" desc=\"").append(privacyCut(ds)).append('"');
                    if (id.length() > 0) l.append(" id=").append(id);
                    l.append(" C=").append(bool(flag(n, 1)));
                    if (flag(n, 2)) l.append(" K=Y X=").append(bool(flag(n, 3)));
                    if (flag(n, 4)) l.append(" S=Y");
                    if (!flag(n, 5)) l.append(" D=Y");
                    if (!visible(n)) l.append(" 안보임");
                    l.append(' ').append(boundsStr(n));
                    String s = l.toString();
                    if (s.length() > DUMP_MAX_LINE_LEN) s = s.substring(0, DUMP_MAX_LINE_LEN) + "…";
                    sb.append(s).append('\n');
                    lines[0]++;
                    return false;
                }
            });
            if (w.truncated) out.append("  …트리가 ").append(DUMP_MAX_NODES).append("노드에서 생략되었습니다\n");
        }
        if (skipped[0] > 0) out.append("… 외 ").append(skipped[0]).append("개 생략\n");
        out.append('\n').append(notesBlock());
        out.append("=== 끝 ===\n");

        recycleAll(rs);
        String s = out.toString();
        if (s.length() > DUMP_MAX_CHARS) s = s.substring(0, DUMP_MAX_CHARS) + "\n…여기서 잘랐어";
        return s;
    }

    private String kakaoVersion() {
        try {
            return String.valueOf(getPackageManager().getPackageInfo(KAKAO, 0).versionName);
        } catch (Throwable t) {
            return "모름";
        }
    }

    private static String winType(AccessibilityWindowInfo w) {
        int t;
        try { t = w.getType(); } catch (Throwable ignore) { return "?"; }
        if (t == AccessibilityWindowInfo.TYPE_APPLICATION) return "APP";
        if (t == AccessibilityWindowInfo.TYPE_INPUT_METHOD) return "IME";
        if (t == AccessibilityWindowInfo.TYPE_SYSTEM) return "SYSTEM";
        if (t == AccessibilityWindowInfo.TYPE_ACCESSIBILITY_OVERLAY) return "A11Y_OVERLAY";
        if (t == AccessibilityWindowInfo.TYPE_SPLIT_SCREEN_DIVIDER) return "DIVIDER";
        return String.valueOf(t);
    }

    // ── 값 꺼내기 (전부 예외 안전) ─────────────────────────────────────────────

    /** text 가 없으면 contentDescription 으로 폴백 */
    static String text2(AccessibilityNodeInfo n) {
        if (n == null) return "";
        CharSequence t = null;
        try { t = n.getText(); } catch (Throwable ignore) { }
        if (t == null || t.length() == 0) {
            try { t = n.getContentDescription(); } catch (Throwable ignore) { }
        }
        return (t == null) ? "" : t.toString();
    }

    /** 옛 이름 유지 (다른 파일이 부를 수 있다) */
    static String text(AccessibilityNodeInfo n) {
        return text2(n);
    }

    /** text 만 (폴백 없음) */
    static String textOnly(AccessibilityNodeInfo n) {
        if (n == null) return "";
        CharSequence t = null;
        try { t = n.getText(); } catch (Throwable ignore) { }
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

    /** "com.kakao.talk:id/name" → "name" */
    static String shortId(String id) {
        if (id == null || id.length() == 0) return "";
        int i = id.lastIndexOf('/');
        return (i < 0) ? id : id.substring(i + 1);
    }

    static String className(AccessibilityNodeInfo n) {
        if (n == null) return "";
        try {
            CharSequence c = n.getClassName();
            return (c == null) ? "" : c.toString();
        } catch (Throwable t) {
            return "";
        }
    }

    /** "android.widget.TextView" → "TextView" */
    static String shortCls(String cls) {
        if (cls == null || cls.length() == 0) return "?";
        int i = cls.lastIndexOf('.');
        return (i < 0) ? cls : cls.substring(i + 1);
    }

    static String pkgOf(AccessibilityNodeInfo n) {
        if (n == null) return "";
        try {
            CharSequence c = n.getPackageName();
            return (c == null) ? "" : c.toString();
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

    /** 1=clickable 2=checkable 3=checked 4=scrollable 5=enabled */
    private static boolean flag(AccessibilityNodeInfo n, int which) {
        if (n == null) return false;
        try {
            switch (which) {
                case 1: return n.isClickable();
                case 2: return n.isCheckable();
                case 3: return n.isChecked();
                case 4: return n.isScrollable();
                default: return n.isEnabled();
            }
        } catch (Throwable t) {
            return false;
        }
    }

    private static boolean visible(AccessibilityNodeInfo n) {
        if (n == null) return false;
        try {
            if (!n.isVisibleToUser()) return false;
        } catch (Throwable ignore) { }
        Rect r = boundsOf(n);
        return r.width() > 0 && r.height() > 0;
    }

    // (hasClickableUp 은 없앴다 — 노드마다 getParent() 를 4번 부르고 하나도 반납하지 않아서
    //  보이는 노드 800개면 스캔 1회에 3200개가 샜다. 이제 walk 가 clickUp 을 내려준다)

    private static boolean hintLike(AccessibilityNodeInfo n) {
        String hint = "";
        try {
            CharSequence c = n.getHintText();
            if (c != null) hint = c.toString();
        } catch (Throwable ignore) { }
        String all = squash(hint) + squash(desc(n)) + squash(shortId(viewId(n)));
        if (all.length() == 0) return false;
        for (int i = 0; i < SEARCH_HINT_S.length; i++) {
            String s = SEARCH_HINT_S[i];
            if (s.length() > 0 && all.contains(s)) return true;
        }
        return all.contains("search");
    }

    private static boolean idIn(String id, String[] arr) {
        if (id == null || id.length() == 0) return false;
        for (int i = 0; i < arr.length; i++) {
            if (arr[i].equals(id)) return true;
        }
        return false;
    }

    static Rect boundsOf(AccessibilityNodeInfo n) {
        Rect r = new Rect();
        if (n == null) return r;
        try { n.getBoundsInScreen(r); } catch (Throwable ignore) { }
        return r;
    }

    private static String boundsStr(AccessibilityNodeInfo n) {
        Rect r = boundsOf(n);
        return "(" + r.left + "," + r.top + "-" + r.right + "," + r.bottom + ")";
    }

    private static String keyOf(AccessibilityNodeInfo n) {
        if (n == null) return "";
        return boundsStr(n);
    }

    private int screenH() {
        try {
            return getResources().getDisplayMetrics().heightPixels;
        } catch (Throwable t) {
            return 2000;
        }
    }

    private static String bool(boolean b) {
        return b ? "Y" : "N";
    }

    /**
     * 덤프용 자르기.
     * 방/사람 이름 길이({@link #NAME_MAX}자 이하)면 통째로 남긴다 — 이름이 잘리면 덤프가 쓸모없다.
     * 그보다 길면 대화 본문으로 보고 앞 {@link #TEXT_KEEP}자만 남긴다 (남의 대화를 개발자에게 넘기지 않게).
     */
    static String privacyCut(String s) {
        if (s == null) return "";
        String t = s.replace('\n', ' ').replace('\r', ' ');
        if (t.length() <= NAME_MAX) return t;
        return t.substring(0, TEXT_KEEP) + "…(" + t.length() + "자)";
    }

    /** 긴 글자는 앞부분만 (남의 대화를 개발자에게 넘기지 않게) */
    static String cut(String s, int n) {
        if (s == null) return "";
        String t = s.replace('\n', ' ').replace('\r', ' ');
        if (t.length() <= n + 4) return t;
        return t.substring(0, n) + "…";
    }

    /**
     * 공백/보이지 않는 문자 정리.
     * NBSP·전각공백·zero-width space·이모지 variation selector 를 걷어낸다 —
     * 카톡 방 이름에 이런 게 흔해서 완전일치가 조용히 실패한다.
     */
    static String norm(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == ' ' || c == '　' || c == '\t' || c == '\n' || c == '\r'
                    || c == ' ' || c == ' ') {
                b.append(' ');
                continue;
            }
            if (c == '​' || c == '‌' || c == '‍' || c == '﻿'
                    || c == '️' || c == '︎' || c == '­') {
                continue;
            }
            b.append(c);
        }
        String t = b.toString();
        while (t.contains("  ")) t = t.replace("  ", " ");
        return t.trim();
    }

    /** 공백 전부 제거 + 소문자 (너그러운 비교용) */
    static String squash(String s) {
        String t = norm(s).toLowerCase(Locale.ROOT);
        StringBuilder b = new StringBuilder(t.length());
        for (int i = 0; i < t.length(); i++) {
            char c = t.charAt(i);
            if (c == ' ') continue;
            b.append(c);
        }
        return b.toString();
    }
}
