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
 * 카톡 화면 자동 조작. <b>전송 흐름이 두 개</b>이고, 둘은 완전히 분리돼 있다.
 *
 * <h3>흐름 1 — 공유창 ({@link #arm})</h3>
 * {@link ImageSender} 가 ACTION_SEND_MULTIPLE 로 카톡 공유창을 띄우고, 이 서비스가 그 창에서
 * "방 고르기 → (체크됐으면) 전송 버튼" 을 눌러준다.
 * <b>실기기에서 이 화면은 한 번도 관측되지 않았다</b>(안드로이드 16 + 백그라운드 실행 제한으로 추정).
 * 구버전에서 유일하게 동작했던 경로라 남겨둔다.
 *
 * <h3>흐름 2 — 채팅방 내부 첨부 시트 ({@link #armAttach})</h3>
 * 이미 열려 있는 채팅방의 첨부(+) 시트를 조작한다:
 * {@code design_bottom_sheet} 확인 → {@code rv_media} 에서 desc(촬영 시각)로 사진 지목 →
 * {@code tv_select_order} 로 선택 검증 → {@code btn_send} 의 enabled 대기 → 전송.
 * 여기 쓰는 셀렉터는 전부 <b>실기기 뷰 트리 문서</b>
 * (docs/field/kakao-attach-sheet-26.8.2.md) 에 실측으로 적혀 있는 것뿐이다.
 * <b>문서에 없는 id 는 만들지 않는다</b> — 추측 셀렉터는 지금까지 전부 실패했다.
 * 아직 미확보인 것(채팅방 하단 + 버튼 id 등)은 지어내는 대신 대체 탐색을 시도하고,
 * 실패하면 화면을 덤프로 남긴다.
 *
 * 진단에는 <b>어느 흐름을 탔는지</b>를 항상 박는다 — 두 흐름의 원인과 조치가 전혀 다르다.
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

    // ── 채팅방 내부 첨부 시트 (근거: docs/field/kakao-attach-sheet-26.8.2.md) ──────
    //  ★ 아래 id 는 전부 카카오톡 26.8.2 실기기 뷰 트리에서 그대로 읽어온 값이다.
    //    문서에 없는 id 는 한 개도 넣지 않는다 — 추측으로 만든 셀렉터는 지금까지 전부 실패했다.
    //    id 는 shortId(= "com.kakao.talk:id/" 를 뗀 값)로 비교한다. 루트는 이미 카톡 창만 모은다.
    /** 바텀시트 루트 (문서 2장) — 이게 있으면 첨부 시트가 열려 있다 */
    static final String AID_SHEET = "design_bottom_sheet";
    /** 첨부 메뉴 목록 (문서 2·5장) */
    static final String AID_CHAT_TOOL = "rv_chat_tool";
    /** 최근 사진 가로 스트립 (문서 2·3장) */
    static final String AID_MEDIA = "rv_media";
    /** 사진 선택 순번 배지 (문서 3장) — 텍스트가 있으면 그 사진은 선택된 상태다 */
    static final String AID_SELECT_ORDER = "tv_select_order";
    /** 전송 버튼 (문서 4장) — enabled 가 선택 여부를 그대로 반영한다 */
    static final String AID_BTN_SEND = "btn_send";
    /** 첨부 메뉴 항목 라벨 (문서 5장) */
    static final String AID_TV_LABEL = "tv_label";

    /** 사진 썸네일 desc 접두 (문서 3장: {@code "사진, 9월 28일 오전 8:20"}) */
    static final String PHOTO_PREFIX = "사진,";
    /** 첨부 시트 사진 스트립의 첫 항목 — 사진이 아니라 카메라다 (문서 3장). 건너뛴다. */
    static final String PHOTO_SKIP = "카메라";

    /**
     * 첨부 메뉴에서 사진 목록을 여는 항목 라벨 후보.
     * 실기기 라벨은 <b>「사진」</b> 이다(문서 5장) — 「앨범」 만 두면 못 찾는다.
     */
    static final String[] ATTACH_MENU_PHOTO = { "사진", "앨범", "이미지", "사진/동영상" };
    /**
     * 채팅방 하단 첨부(+) 버튼의 desc 후보.
     *
     * <b>이 버튼의 view id 는 아직 미확보다</b>(문서 8장 — 시트가 이미 열린 상태를 덤프해서 안 잡혔다).
     * 그래서 없는 id 를 지어내지 않고 desc 로만 찾고, 그래도 못 찾으면 입력창 왼쪽 끝 clickable
     * 노드를 본다. 둘 다 실패하면 화면을 덤프한 뒤 실패로 끝낸다 — 덤프가 남으면 다음에 정확히 고친다.
     */
    static final String[] ATTACH_DESC = { "첨부", "추가", "더보기" };

    static final String[] ATTACH_MENU_PHOTO_S = squashAll(ATTACH_MENU_PHOTO);
    static final String[] ATTACH_DESC_S = squashAll(ATTACH_DESC);
    static final String PHOTO_PREFIX_S = squash(PHOTO_PREFIX);

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

    // ── 첨부 시트 흐름 한도 ────────────────────────────────────────────────────
    /** rv_media 가로 스크롤 허용 횟수 (문서 2장: 가로 RecyclerView) */
    private static final int MAX_MEDIA_SCROLL = 10;
    /** btn_send 의 enabled 가 Y 가 되기를 기다릴 횟수 (회당 {@link #RETRY_MS}) */
    private static final int MAX_SEND_WAIT = 12;
    /** 첨부(+) 버튼을 눌러 시트를 열어볼 횟수 */
    private static final int MAX_ATTACH_OPEN = 2;
    /** 사진을 탭한 뒤 tv_select_order 에 순번이 생겼는지 확인할 횟수 */
    private static final int MAX_SEL_VERIFY = 3;
    /** 진단에 나란히 적을 사진 desc 최대 개수 */
    private static final int SHOW_DESCS = 12;
    /** 첨부 시트에서 수집해둘 사진 desc 최대 개수 (스크롤 종료 판정에도 쓴다) */
    private static final int MEDIA_DESC_MAX = 60;
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
    /**
     * 이 길이 이하면 방/사람 이름으로 보고 통째로 남긴다 (그게 있어야 셀렉터를 고친다).
     *
     * 24자였는데 실사용 단체방 이름이 30자를 넘겼다(이모지로 시작 + 공백 다수).
     * 그래서 정작 찾던 이름이 「행 이름」 수집과 진단 목록에서 통째로 빠졌다 —
     * 사용자에게 "화면에 이런 이름이 있었습니다" 를 보여줘야 할 자리에 그 이름만 없었다.
     * 카톡 단체방 이름 길이까지 올린다.
     */
    private static final int NAME_MAX = 40;
    /** 말줄임 접두 매칭을 인정할 최소 길이 (공백 제거 기준). 이보다 짧으면 우연히 겹친다. */
    private static final int MIN_PREFIX = 6;
    /** 이모지·기호를 걷어낸 뒤의 접두 매칭 최소 길이 */
    private static final int MIN_PREFIX_CORE = 4;
    /** 검색창에 넣을 질의 최대 길이 (완전일치는 이모지·말줄임 때문에 0건이 되기 쉽다) */
    private static final int SEARCH_QUERY_MAX = 8;
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

    // ── 단계 (첨부 시트 흐름 전용 — 공유창 단계와 번호를 섞지 않는다) ─────────────
    /** 첨부 시트가 열려 있나 판정 (없으면 채팅방 하단 + 를 누른다) */
    private static final int A_SHEET = 10;
    /** rv_media 에서 대상 사진을 찾아 탭하고 선택을 검증한다 */
    private static final int A_PICK = 11;
    /** btn_send 의 enabled 를 기다려 누른다 */
    private static final int A_SEND = 12;
    /** 전송 뒤 시트가 실제로 닫혔는지 확인 */
    private static final int A_VERIFY = 13;

    // ── 이름 매칭 등급 (숫자가 작을수록 확실하다) ──────────────────────────────
    /** 정규화 후 완전히 같다 */
    private static final int L_EXACT = 0;
    /** 공백·보이지 않는 문자를 무시하면 같다 */
    private static final int L_SQUASH = 1;
    /** 이모지·기호·문장부호를 걷어내면 같다 */
    private static final int L_CORE = 2;
    /** 목록에서 잘려 표시된 앞부분이 일치한다 */
    private static final int L_PREFIX = 3;
    /** 부분 일치 (제일 약하다) */
    private static final int L_PART = 4;
    private static final int L_COUNT = 5;

    // ── 전송 흐름 ──────────────────────────────────────────────────────────────
    //  흐름이 둘이다. 진단에 <b>어느 흐름을 탔는지</b> 반드시 남긴다 —
    //  둘의 실패 원인과 조치가 완전히 달라서, 흐름 이름이 없으면 엉뚱한 데를 고치게 된다.
    /** {@link #arm} — 공유 인텐트로 띄운 대화방 선택 화면을 조작한다 */
    private static final int M_SHARE = 0;
    /** {@link #armAttach} — 이미 열려 있는 채팅방의 첨부 시트를 조작한다 */
    private static final int M_ATTACH = 1;

    /**
     * 공유창 흐름. 실기기에서 <b>이 화면은 한 번도 관측되지 않았다</b>
     * (안드로이드 16 + 백그라운드 실행 제한으로 추정 — 문서 1·7장).
     * 남겨두는 이유는 구버전 안드로이드에서 유일하게 동작했던 경로이기 때문이다.
     */
    private static final String FLOW_SHARE = "공유창(ACTION_SEND_MULTIPLE → 대화방 선택 → 전송)";
    /**
     * 채팅방 내부 첨부 시트 흐름. 실기기 뷰 트리가 전부 확보된 경로다
     * (docs/field/kakao-attach-sheet-26.8.2.md 2~6장).
     */
    private static final String FLOW_ATTACH =
            "채팅방 첨부 시트(+ → rv_media 사진 선택 → btn_send)";

    /** 지금 타고 있는 흐름 이름 (진단·로그에 그대로 박는다) */
    private static String flowName() {
        return (mode == M_ATTACH) ? FLOW_ATTACH : FLOW_SHARE;
    }

    // ── 예약(armed) 상태 — 서비스 인스턴스와 별개로 살아있어야 해서 static ────────
    private static volatile KakaoAccessibility INSTANCE = null;
    private static volatile boolean armed = false;
    /** 카톡 화면을 마지막으로 본 시각 (0 = 한 번도 못 봄). 공유창이 떴는지 진단용. */
    private static volatile long lastKakaoWindowAt = 0L;
    /**
     * 화면에서 찾을 <b>대화방 표시 이름</b>. 저장값({@code RoomRef.key()}) 이 아니다 —
     * 여기에 계정키와 구분자(U+0001)가 섞여 들어오면 카톡 화면의 어떤 글자와도 안 맞는다.
     */
    private static volatile String targetRoom = null;
    /** arm 에 넘어온 저장값 원본 ({@code RoomRef.key()} 일 수 있다). 세션 조회·진단에만 쓴다. */
    private static volatile String targetKey = "";
    /** 이번 시도에서 카톡 창 이벤트를 몇 건 받았나. 0 이면 공유창이 아예 안 떴다는 뜻이다. */
    private static volatile int kakaoEvents = 0;
    private static volatile long armedUntil = 0L;
    /** 우리가 포기할 시각. 항상 armedUntil 보다 앞이다 (원인 보고는 우리가 한다). */
    private static volatile long deadlineAt = 0L;
    private static volatile Result callback = null;
    /** 지금 타고 있는 흐름 ({@link #M_SHARE} / {@link #M_ATTACH}) */
    private static volatile int mode = M_SHARE;
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

    // ── 첨부 시트 흐름 상태 (M_ATTACH 에서만 쓴다) ───────────────────────────────
    /** 찾아야 하는 사진 desc 후보 — ImageSender 가 만들어 넘긴 원본 그대로 (진단 표시용) */
    private static volatile String[] wantDescs = new String[0];
    /** 위 후보를 공백 제거·소문자로 정규화한 값. 비교는 <b>이것과의 완전일치만</b> 인정한다. */
    private static volatile String[] wantDescsS = new String[0];
    /** 후보별 선택 완료 여부 (wantDescs 와 같은 순서) */
    private static volatile boolean[] gotDescs = new boolean[0];
    /**
     * 호출 측이 넘긴 후보 중 <b>서로 같은 desc</b> 였던 건수.
     * 같은 분에 찍은 사진 두 장은 desc 가 같아서 1:1 로 지목할 수 없다 —
     * 조용히 한 장만 보내고 "2장 전송" 이라고 보고하면 그게 거짓말이다.
     */
    private static volatile int dupWant = 0;
    /** 선택에 성공한 장수 */
    private static volatile int pickedCount = 0;
    /** 첨부 시트(design_bottom_sheet 또는 rv_media)를 한 번이라도 본 적 있나 */
    private static volatile boolean sawSheet = false;
    /** 첨부(+) 버튼을 눌러본 횟수 */
    private static volatile int attachOpens = 0;
    /** 첨부 메뉴의 「사진」 항목을 눌렀나 (문서 8장 — 그 뒤 화면 구조는 미확보다) */
    private static volatile boolean menuPhotoTapped = false;
    /** rv_media 가로 스크롤 횟수 */
    private static volatile int mediaScrolls = 0;
    /** 직전 스크롤 시점의 누적 사진 개수 — 늘지 않으면 끝까지 본 것이다 */
    private static volatile int mediaSeenBefore = 0;
    /** 더 스크롤해도 새 사진이 안 나온다 */
    private static volatile boolean mediaScrollDone = false;
    /** 지금 선택 검증을 기다리는 후보 index (-1 = 없음) */
    private static volatile int verifyIdx = -1;
    private static volatile int verifyTries = 0;
    /** btn_send 의 enabled 가 Y 가 되기를 기다린 횟수 */
    private static volatile int sendWaits = 0;
    /** 마지막으로 본 btn_send 상태 ("미확인" / "enabled=Y" / "enabled=N") */
    private static volatile String sendState = "미확인";
    /** 첨부 시트에서 본 사진 desc 목록 (중복 제거, 화면 밖으로 밀려난 것도 기억한다) */
    private static final ArrayList<String> MEDIA_SEEN = new ArrayList<String>(24);
    /** 첨부 메뉴에서 본 항목 라벨 (진단용) */
    private static volatile String menuSeen = "";
    /** 마지막으로 본 시트 구성 요약 (시트가 닫힌 뒤에도 말할 수 있어야 한다) */
    private static volatile String sheetShape = "";

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
        String raw = (room == null) ? "" : room.trim();
        // 저장값(RoomRef.key() = 계정키 + U+0001 + 방이름)이 그대로 넘어오는 호출부가 있다.
        // 그 값을 화면에서 찾으면 100% 실패한다 (카톡 화면에 계정키와 제어문자가 있을 수 없다).
        // 호출부가 이미 표시 이름을 넘겼으면 구분자가 없으니 이 줄은 아무 일도 하지 않는다.
        String r = (raw.indexOf(RoomRef.SEP) >= 0) ? RoomRef.parse(raw).name : raw;
        return armWith(raw, r, timeoutMs, cb, ctx);
    }

    /**
     * <b>권장 진입점</b> — 계정과 이름을 합친 문자열을 만들지 않는다.
     * 화면에서 찾는 것은 {@code ref.name} 뿐이고, 계정까지 필요한 조회(세션·대화방 열기 인텐트)는
     * {@code ref.key()} 로 한다. 둘을 한 문자열로 합쳐 넘기면 화면 매칭이 조용히 전부 실패한다.
     */
    public static long arm(RoomRef ref, long timeoutMs, Result cb, Context ctx) {
        String key = (ref == null) ? "" : ref.key();
        String name = (ref == null) ? "" : ref.name;
        return armWith(key, name, timeoutMs, cb, ctx);
    }

    // ── 공개 API: 채팅방 내부 첨부 시트 흐름 ────────────────────────────────────

    /**
     * <b>채팅방 내부 첨부 시트 흐름을 예약한다</b> — {@link #arm}(공유창 흐름)과 완전히 별개다.
     *
     * 전제: 대상 <b>채팅방이 이미 열려 있어야 한다</b>. 이 서비스는 채팅방을 열지 않는다
     * (방 열기는 {@code KakaoListener} 의 알림 contentIntent 담당이다).
     *
     * 동작 순서 (근거: docs/field/kakao-attach-sheet-26.8.2.md 2~6장)
     * <pre>
     *   design_bottom_sheet 있나? → 없으면 채팅방 하단 + 를 눌러 시트를 연다
     *   → rv_media 에서 desc 가 후보와 완전일치하는 사진을 탭
     *   → 그 사진의 tv_select_order 에 순번이 생겼는지로 선택을 검증
     *   → 필요한 장수만큼 반복 (rv_media 가로 스크롤)
     *   → btn_send 의 enabled 가 Y 가 될 때까지 대기 → 탭
     * </pre>
     *
     * @param room       대상 대화방 (진단·세션 조회용. 화면 매칭에는 {@code ref.name} 만 쓴다.
     *                   {@code key()} 를 이름으로 쓰면 "0␁이름" 이 화면에서 절대 안 맞는다 — 문서 7장)
     * @param photoDescs ImageSender 가 만들어 넘기는 <b>사진 desc 후보 목록</b>
     *                   (형식: {@code "사진, 9월 28일 오전 8:20"}). 공백만 무시하고
     *                   <b>완전일치하는 것만</b> 선택한다. 부분·근사 매칭은 하지 않는다.
     * @return 이번 시도의 id. {@link #lastDumpFor(Context, long)} 에 넘기면 이번 실패의 화면만 읽는다.
     */
    public static long armAttach(RoomRef room, String[] photoDescs, long timeoutMs, Result cb) {
        return armAttach(room, photoDescs, timeoutMs, cb, null);
    }

    /**
     * {@link #armAttach(RoomRef, String[], long, Result)} + Context.
     * ctx 를 주면 <b>접근성 서비스가 아직 안 붙은 경우에도</b> 그 사실을 이번 시도의 덤프로 남긴다.
     */
    public static long armAttach(RoomRef room, String[] photoDescs, long timeoutMs,
                                 Result cb, Context ctx) {
        String key = (room == null) ? "" : room.key();
        String name = (room == null) ? "" : room.name;
        long t = (timeoutMs <= 0) ? DEFAULT_TIMEOUT_MS : timeoutMs;

        long id = beginAttempt(M_ATTACH, key, name, t, cb);
        setWantDescs(photoDescs);

        KakaoAccessibility me = INSTANCE;
        if (me == null) {
            Log.add(ctx, "접근성 서비스가 연결되지 않았습니다. 첨부 시트 자동 조작이 동작하지 않습니다.");
            if (ctx != null) {
                StringBuilder sb = new StringBuilder(640);
                sb.append("=== 카카오톡 화면 진단 ").append(stamp()).append(" ===\n");
                sb.append("시도 id: ").append(id).append(" · 전송 흐름: ").append(flowName()).append('\n');
                sb.append(a11yBlock(ctx));
                sb.append("실패: 접근성 서비스가 연결되지 않아 화면을 읽지 못했습니다.\n");
                sb.append("대상 대화방: \"").append(name).append("\"\n");
                sb.append(attachBlock());
                sb.append(env(ctx));
                sb.append("조치: 설정 › 접근성 › 설치된 앱 › 카톡 오토 를 재설정한 후 다시 시도하십시오.\n");
                sb.append("=== 끝 ===\n");
                saveDump(ctx, sb.toString(), id);
            }
            return id;
        }
        Log.add(me, "카카오톡 첨부 시트 자동 조작을 예약했습니다. 대화방: " + name
                + " · 대상 사진 " + wantDescs.length + "장 · 흐름: " + FLOW_ATTACH
                + " (시도 " + id + ")");
        note("흐름: " + FLOW_ATTACH + " · 대상 사진 " + wantDescs.length + "장");
        me.kick(500L);
        return id;
    }

    /** 후보 desc 목록을 세팅한다 (원본 보관 + 비교용 정규화). null·빈 문자열은 버린다. */
    private static void setWantDescs(String[] in) {
        ArrayList<String> raw = new ArrayList<String>(8);
        ArrayList<String> sq = new ArrayList<String>(8);
        int dup = 0;
        if (in != null) {
            for (int i = 0; i < in.length; i++) {
                String d = norm(in[i]);
                if (d.length() == 0) continue;
                String s = squash(d);
                if (s.length() == 0) continue;
                if (sq.contains(s)) { dup++; continue; }   // 같은 desc 로는 1:1 지목이 불가능하다
                raw.add(d);
                sq.add(s);
            }
        }
        dupWant = dup;
        wantDescs = raw.toArray(new String[0]);
        wantDescsS = sq.toArray(new String[0]);
        gotDescs = new boolean[wantDescs.length];
    }

    /**
     * 시도 하나를 시작한다 (상태 초기화 + 시도 번호 증가). 두 흐름이 <b>같은 상태를 공유</b>하므로
     * 여기서 전부 한 번에 지운다 — 한쪽 흐름의 잔여 상태가 다음 흐름의 진단을 오염시키면
     * 사용자가 엉뚱한 곳을 고치게 된다.
     */
    private static long beginAttempt(int flowMode, String rawKey, String r, long t, Result cb) {
        long now = System.currentTimeMillis();
        mode = flowMode;
        targetKey = (rawKey == null) ? "" : rawKey;
        targetRoom = r;
        kakaoEvents = 0;
        armedUntil = now + t;
        // 호출자보다 먼저 포기한다. 아주 짧은 타임아웃이면 절반 지점에서.
        deadlineAt = (t > SAFETY_MS * 2) ? (armedUntil - SAFETY_MS) : (now + t / 2);
        callback = cb;
        phase = (flowMode == M_ATTACH) ? A_SHEET : P_PICK;
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
        clearAttachState();
        synchronized (NOTES) { NOTES.clear(); }
        attempt++;
        armed = true;
        return attempt;
    }

    /** 첨부 시트 흐름 상태만 초기화 */
    private static void clearAttachState() {
        wantDescs = new String[0];
        wantDescsS = new String[0];
        gotDescs = new boolean[0];
        pickedCount = 0;
        sawSheet = false;
        attachOpens = 0;
        menuPhotoTapped = false;
        mediaScrolls = 0;
        mediaSeenBefore = 0;
        mediaScrollDone = false;
        verifyIdx = -1;
        verifyTries = 0;
        dupWant = 0;
        sendWaits = 0;
        sendState = "미확인";
        menuSeen = "";
        sheetShape = "";
        synchronized (MEDIA_SEEN) { MEDIA_SEEN.clear(); }
    }

    /**
     * @param rawKey 저장·조회용 값 ({@code RoomRef.key()} 또는 구버전 이름)
     * @param r      <b>화면에서 찾을 표시 이름</b>
     */
    private static long armWith(String rawKey, String r, long timeoutMs, Result cb, Context ctx) {
        String raw = (rawKey == null) ? "" : rawKey;
        long t = (timeoutMs <= 0) ? DEFAULT_TIMEOUT_MS : timeoutMs;

        long id = beginAttempt(M_SHARE, raw, r, t, cb);

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
                sb.append("시도 id: ").append(id).append(" · 전송 흐름: ").append(flowName()).append('\n');
                sb.append(a11yBlock(ctx));
                sb.append("실패: 접근성 서비스가 연결되지 않아 화면을 읽지 못했습니다.\n");
                sb.append("찾으려던 이름: \"").append(r).append("\"\n");
                if (!r.equals(raw)) sb.append("설정 저장값: \"").append(vis(raw)).append("\"\n");
                sb.append("대화방 열기 인텐트(알림 contentIntent): ").append(openIntentState()).append('\n');
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
                    me.saveMini(mode == M_ATTACH
                            ? "호출 측(이미지 전송)이 먼저 중단되었습니다. 첨부 시트 조작을 끝내지 못했습니다."
                              + " 카카오톡 첨부 시트가 열려 있으면 닫고, 대상 채팅방이 화면에 열린 상태에서 다시 시도하십시오."
                            : "호출 측(이미지 전송)이 먼저 중단되었습니다. 공유창이 표시되지 않았거나 시간이 초과되었습니다."
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

    /** 지금 노리고 있는 방 이름(화면에서 찾는 표시 이름). 예약 없으면 "" */
    public static String armedRoom() {
        String r = targetRoom;
        return (r == null || !armed) ? "" : r;
    }

    /** arm 에 넘어온 저장값 원본({@code RoomRef.key()} 일 수 있다). 예약 없으면 "" */
    public static String armedRoomKey() {
        String k = targetKey;
        return (k == null || !armed) ? "" : k;
    }

    /**
     * 이번 시도에서 카카오톡 창 이벤트를 몇 건 받았나.
     * <b>0 이면 공유창이 아예 뜨지 않은 것</b>이고, 1건 이상이면 창은 떴으나
     * 방 선택·전송 단계에서 실패한 것이다. 이 둘은 조치가 완전히 다르므로 꼭 구분해서 보고한다.
     */
    public static int kakaoEventCount() {
        return kakaoEvents;
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
        String d = (dump.length() > DUMP_MAX_CHARS) ? dump.substring(0, DUMP_MAX_CHARS) + "\n…(이하 생략)" : dump;
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
        targetKey = "";
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
        // 첨부 흐름 상태도 같이 내린다. 남겨두면 다음 시도(다른 흐름)의 진단에 섞인다.
        clearAttachState();
        mode = M_SHARE;
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
        if (kakaoEvents < Integer.MAX_VALUE) kakaoEvents++;

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
            if (mode == M_ATTACH) {
                // 첨부 흐름에서 카톡 창이 사라졌다. 전송을 누른 뒤라면 화면이 전환된 것으로 본다.
                // 누른 적이 없으면 사용자가 카톡을 벗어난 것이니 기다린다(데드라인이 잡는다).
                if (sendTry > 0 && emptyRounds >= 2) {
                    finish(true, targetRoom + " · 전송 버튼 입력 후 카카오톡 화면이 전환되었습니다."
                            + " 카카오톡에서 전송 결과를 확인하십시오.");
                    return;
                }
                retry();
                return;
            }
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
            if (mode == M_ATTACH) {
                // 흐름이 완전히 갈린다 — 첨부 시트는 공유창과 화면·셀렉터·판정이 하나도 겹치지 않는다.
                AScan a = ascan(rs);
                if (a.sig.equals(lastSig)) sameSig++;
                else { sameSig = 0; lastSig = a.sig; }

                switch (phase) {
                    case A_SHEET: doSheet(a);       break;
                    case A_PICK:  doPickPhoto(a);   break;
                    case A_SEND:  doSendAttach(a);  break;
                    default:      doVerifyAttach(a); break;
                }
                return;
            }

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
            note("카카오톡 화면 자동 조작 중 오류 — " + t.getClass().getSimpleName()
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
                    + " 오발송을 방지하기 위해 선택하지 않았습니다."
                    + wantVsSeen(roomLike(sc))
                    + " 설정의 대화방 이름을 화면에 표시된 그대로 전체 입력하십시오." + nextStep());
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
        return "대화방 목록에서 「" + cut(room, NAME_MAX) + "」 을 찾지 못했습니다."
                + wantVsSeen(names)
                + (names.length() > 0
                    ? " 두 이름의 문자가 다른 경우(이모지·괄호·띄어쓰기) 설정의 대화방 이름을"
                      + " 화면에 표시된 그대로 수정하십시오."
                    : " 카카오톡 공유창이 목록을 아직 표시하지 않은 상태일 수 있습니다."
                      + " 카카오톡을 실행한 후 다시 시도하십시오.")
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

            boolean ok = clickNode(row, "대화방 행");
            if (!ok) return 0;

            clickedRow = true;
            clickedAt = System.currentTimeMillis();
            sawShareList = true;
            note("공유창에서 대화방을 선택했습니다 — " + cut(hit.name, 20)
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
            note("대화방 선택 후 대화방 화면으로 전환되었습니다. 발송된 것으로 처리합니다. 카카오톡에서 확인하십시오.");
            finish(true, targetRoom + " · 대화방 화면으로 전환되었습니다. 카카오톡에서 확인하십시오.");
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
                note("대화방 선택 후 화면이 전환되지 않았습니다. 재시도합니다 (" + clickTry + "회).");
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
            finish(true, targetRoom + " · 대화방 화면으로 전환되었습니다. 카카오톡에서 확인하십시오.");
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
                note("전송 버튼을 입력했습니다 — 「" + cut(b.label, 20) + "」"
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
            note("전송 버튼이 화면에서 사라졌습니다. 발송된 것으로 처리합니다.");
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

    // ═══════════════════════════════════════════════════════════════════════
    //  채팅방 내부 첨부 시트 흐름 (M_ATTACH)
    //  근거: docs/field/kakao-attach-sheet-26.8.2.md — 실기기 뷰 트리
    //  여기서 쓰는 id 는 전부 그 문서에 실측으로 적혀 있는 것뿐이다. 추측 셀렉터 금지.
    // ═══════════════════════════════════════════════════════════════════════

    /** 첨부 시트의 사진 썸네일 한 개 (문서 3장) */
    private static final class Photo {
        AccessibilityNodeInfo node;
        /** 정규화한 desc 원본 (진단 표시용) */
        String desc = "";
        /** 공백 제거·소문자 — 비교는 이것만 쓴다 */
        String descS = "";
        String cls = "";
        /** tv_select_order 의 텍스트. 비어 있지 않으면 <b>선택된 상태</b>다 (문서 3장) */
        String order = "";
        boolean inMedia = false;

        boolean selected() {
            return order.length() > 0;
        }
    }

    /** 첨부 시트 한 번 훑어서 알아낸 것 전부 */
    private final class AScan {
        /** design_bottom_sheet — 있으면 시트가 열려 있다 */
        AccessibilityNodeInfo sheet = null;
        /** rv_media (가로 RecyclerView) */
        AccessibilityNodeInfo media = null;
        /** rv_chat_tool (첨부 메뉴 목록) */
        AccessibilityNodeInfo chatTool = null;
        /** btn_send */
        AccessibilityNodeInfo btnSend = null;
        /** 첨부 메뉴의 「사진」 항목 (문서 5장) */
        AccessibilityNodeInfo menuPhoto = null;
        /** desc 가 첨부/추가/더보기 인 clickable 노드 (문서 8장 — id 는 미확보) */
        AccessibilityNodeInfo plusByDesc = null;
        final ArrayList<Photo> photos = new ArrayList<Photo>(16);
        /** 첨부 메뉴에서 본 라벨 (진단용) */
        final ArrayList<String> menuLabels = new ArrayList<String>(8);
        /** 입력창 근처에서 + 를 찾을 때 볼 clickable 후보 */
        final ArrayList<AccessibilityNodeInfo> nearCands = new ArrayList<AccessibilityNodeInfo>(16);
        /** 메시지 입력창 위치 (CHATROOM_IDS 로 찾은 것) */
        Rect inputRect = null;
        /** id 는 못 맞췄지만 편집 가능한 노드 — 입력창 대체 후보 */
        Rect editRect = null;
        boolean chatInput = false;
        boolean sendEnabled = false;
        boolean sendClickable = false;
        /** 화면에서 선택 상태인 사진 개수 (대상 여부 무관) */
        int selectedTotal = 0;
        /** rv_media 밖에 있어 대상에서 제외한 「사진, …」 노드 수 (대화 내용의 사진 말풍선 등) */
        int outsideMedia = 0;
        /** 대상 대화방 이름을 화면 글자에서 봤나 (검증이 아니라 <b>확인용</b> 표시다) */
        boolean roomNameSeen = false;
        int nodes = 0;
        boolean truncated = false;
        String sig = "";

        boolean sheetOpen() {
            return sheet != null || media != null;
        }

        /** descS 가 완전히 같은 사진. 없으면 null. (부분 일치는 절대 하지 않는다) */
        Photo exact(String descS) {
            if (descS == null || descS.length() == 0) return null;
            for (int i = 0; i < photos.size(); i++) {
                Photo p = photos.get(i);
                if (p.descS.equals(descS)) return p;
            }
            return null;
        }

        /**
         * descS 가 완전히 같은 사진이 <b>몇 개</b> 있나.
         * desc 의 시각은 분 단위라서 같은 분에 찍은 사진 두 장이 같은 desc 를 가질 수 있다.
         * 그때 아무거나 고르면 엉뚱한 사진이 나간다 — 호출부가 이 값으로 중단을 판단한다.
         */
        int count(String descS) {
            if (descS == null || descS.length() == 0) return 0;
            int n = 0;
            for (int i = 0; i < photos.size(); i++) {
                if (photos.get(i).descS.equals(descS)) n++;
            }
            return n;
        }
    }

    /**
     * 첨부 시트 화면을 한 번 훑는다.
     *
     * rv_media 안인지, 어느 사진 썸네일 안인지는 <b>DFS 깊이</b>로 판정한다 —
     * 사진 desc 와 tv_select_order 를 한 번의 순회로 짝지으려면 이게 제일 싸다
     * (getParent() 를 다시 부르면 반납할 노드가 수천 개로 늘어난다).
     */
    private AScan ascan(List<AccessibilityNodeInfo> rs) {
        final AScan a = new AScan();
        final String roomS = squash((targetRoom == null) ? "" : targetRoom);
        final StringBuilder sig = new StringBuilder(256);
        final int halfH = screenH() / 2;
        final int smallPx = Theme.dp(this, 160);

        for (int ri = 0; ri < rs.size(); ri++) {
            final int[] mediaDepth = new int[] { -1 };
            final int[] toolDepth = new int[] { -1 };
            final int[] photoDepth = new int[] { -1 };
            final Photo[] curPhoto = new Photo[] { null };
            Walk w = new Walk();
            walk(rs.get(ri), 0, MAX_NODES, w, new Eye() {
                @Override public boolean at(AccessibilityNodeInfo n, int depth, int clickUp) {
                    // 컨테이너를 벗어났으면 표시를 내린다 (DFS 라 depth 가 되돌아온다)
                    if (mediaDepth[0] >= 0 && depth <= mediaDepth[0]) mediaDepth[0] = -1;
                    if (toolDepth[0] >= 0 && depth <= toolDepth[0]) toolDepth[0] = -1;
                    if (photoDepth[0] >= 0 && depth <= photoDepth[0]) {
                        photoDepth[0] = -1;
                        curPhoto[0] = null;
                    }

                    boolean keep = false;
                    String id = viewId(n);
                    String sid = shortId(id);
                    String tx = norm(textOnly(n));
                    String ds = norm(desc(n));
                    String cls = className(n);
                    boolean vis = visible(n);
                    boolean clickable = flag(n, 1);
                    boolean editable = isEditable(n);

                    // ── 실측 id (문서 2장) ──
                    if (sid.equals(AID_SHEET)) {
                        if (a.sheet == null) { a.sheet = n; keep = true; }
                    } else if (sid.equals(AID_MEDIA)) {
                        if (a.media == null) { a.media = n; keep = true; }
                        mediaDepth[0] = depth;
                    } else if (sid.equals(AID_CHAT_TOOL)) {
                        if (a.chatTool == null) { a.chatTool = n; keep = true; }
                        toolDepth[0] = depth;
                    } else if (sid.equals(AID_BTN_SEND)) {
                        if (a.btnSend == null) {
                            a.btnSend = n;
                            a.sendEnabled = flag(n, 5);
                            a.sendClickable = clickable;
                            keep = true;
                        }
                    } else if (sid.equals(AID_SELECT_ORDER)) {
                        // 순번 배지. 지금 들어와 있는 사진 썸네일의 것이다 (문서 3장 구조).
                        if (curPhoto[0] != null && tx.length() > 0) curPhoto[0].order = tx;
                    }

                    // ── 사진 썸네일 (문서 3장) ──
                    //  desc 가 "사진," 으로 시작하는 것만 대상. "카메라" 는 사진이 아니라 건너뛴다.
                    //  클래스는 Button 이 정답이지만, 커스텀 뷰가 다른 클래스로 보고되는 경우까지
                    //  놓치지 않게 clickable 도 인정한다 (무엇을 잡았는지는 덤프에 클래스로 남긴다).
                    //  desc 완전일치만 선택하니 이 완화로 엉뚱한 사진이 선택될 수는 없다.
                    //  화면 밖(재활용 대기) 항목은 대상에서 뺀다 — 좌표 탭이 엉뚱한 곳을 누를 수 있다.
                    //  화면 밖 사진은 rv_media 를 가로 스크롤해서 보이게 만든 뒤 고른다.
                    String dsS = squash(ds);
                    if (vis && dsS.startsWith(PHOTO_PREFIX_S) && !descHead(ds).equals(PHOTO_SKIP)
                            && (cls.contains("Button") || clickable)) {
                        Photo p = new Photo();
                        p.node = n;
                        p.desc = ds;
                        p.descS = dsS;
                        p.cls = shortCls(cls);
                        p.inMedia = mediaDepth[0] >= 0;
                        a.photos.add(p);
                        photoDepth[0] = depth;
                        curPhoto[0] = p;
                        seeMedia(ds);
                        keep = true;
                    }

                    // ── 첨부 메뉴 항목 (문서 5장: 라벨은 「사진」 이다) ──
                    if ((toolDepth[0] >= 0 || sid.equals(AID_TV_LABEL))
                            && !dsS.startsWith(PHOTO_PREFIX_S)) {
                        String lbl = (tx.length() > 0) ? tx : descHead(ds);
                        if (lbl.length() > 0 && lbl.length() <= 12) {
                            if (a.menuLabels.size() < 10 && !a.menuLabels.contains(lbl)) {
                                a.menuLabels.add(lbl);
                            }
                            String lblS = squash(lbl);
                            for (int k = 0; k < ATTACH_MENU_PHOTO_S.length; k++) {
                                if (!lblS.equals(ATTACH_MENU_PHOTO_S[k])) continue;
                                if (a.menuPhoto == null) { a.menuPhoto = n; keep = true; }
                                break;
                            }
                        }
                    }

                    // ── 채팅방 입력창 / 첨부(+) 버튼 후보 (문서 8장 — id 미확보) ──
                    if (idIn(id, CHATROOM_IDS)) {
                        a.chatInput = true;
                        if (a.inputRect == null) a.inputRect = boundsOf(n);
                    } else if (editable && vis && a.editRect == null) {
                        a.editRect = boundsOf(n);
                    }
                    if (vis && clickable && !editable && a.nearCands.size() < 60) {
                        Rect r = boundsOf(n);
                        if (r.bottom > halfH && r.width() <= smallPx && r.height() <= smallPx) {
                            a.nearCands.add(n);
                            keep = true;
                        }
                    }
                    if (vis && clickable && a.plusByDesc == null) {
                        String head = squash(descHead(ds));
                        for (int k = 0; k < ATTACH_DESC_S.length; k++) {
                            if (head.length() > 0 && head.equals(ATTACH_DESC_S[k])) {
                                a.plusByDesc = n;
                                keep = true;
                                break;
                            }
                        }
                    }

                    // 대상 대화방 이름이 화면에 보이나 — 이 흐름은 방을 검증하지 않으므로
                    // 진단에 "확인됨/확인되지 않음" 만 남긴다 (대화방 제목 id 는 미확보 — 문서 8장).
                    if (vis && !a.roomNameSeen && roomS.length() >= 2 && tx.length() > 0) {
                        String txS = squash(tx);
                        if (txS.equals(roomS) || (txS.length() >= 4 && roomS.startsWith(txS))) {
                            a.roomNameSeen = true;
                        }
                    }

                    if (vis && sig.length() < 700 && (tx.length() > 0 || sid.length() > 0)) {
                        sig.append(cut(tx, 10)).append(':').append(sid).append('|');
                    }
                    return keep;
                }
            });
            a.nodes += w.visited;
            if (w.truncated) a.truncated = true;
        }

        // 대상은 <b>rv_media 안의 사진</b>이다(문서 3장). rv_media 안에서 하나라도 찾았으면
        // 밖에서 본 것(대화 내용의 사진 말풍선 등)은 전부 버린다 — 그걸 누르면 사진 뷰어가 열린다.
        // rv_media 가 아예 없을 때만(「사진」 메뉴로 전체 갤러리에 들어간 경우) 밖의 것을 쓴다.
        boolean anyInMedia = false;
        for (int i = 0; i < a.photos.size(); i++) {
            if (a.photos.get(i).inMedia) { anyInMedia = true; break; }
        }
        // rv_media 밖의 사진은 「사진」 메뉴로 전체 갤러리에 들어간 경우에만 인정한다.
        // 그 외에는 대화 내용의 사진 말풍선일 수 있고, 그걸 누르면 사진 뷰어가 열린다.
        if (anyInMedia || !menuPhotoTapped) {
            for (int i = a.photos.size() - 1; i >= 0; i--) {
                if (!a.photos.get(i).inMedia) {
                    a.outsideMedia++;
                    a.photos.remove(i);
                }
            }
        }
        for (int i = 0; i < a.photos.size(); i++) {
            if (a.photos.get(i).selected()) a.selectedTotal++;
        }
        a.sig = String.valueOf(sig.toString().hashCode()) + "/" + a.nodes
                + "/" + a.photos.size() + "/" + a.selectedTotal
                + "/" + (a.sheetOpen() ? 1 : 0) + "/" + (a.btnSend == null ? 0 : (a.sendEnabled ? 2 : 1));
        rememberAttach(a);
        return a;
    }

    /** 시트가 닫힌 뒤에도 "그때 뭐가 있었는지" 를 말할 수 있게 요약을 남긴다 */
    private void rememberAttach(AScan a) {
        if (a.btnSend != null) sendState = a.sendEnabled ? "enabled=Y" : "enabled=N";
        else if (sendState.equals("미확인")) sendState = "미확인(btn_send 를 화면에서 찾지 못했습니다)";
        sheetShape = (a.sheet != null ? "design_bottom_sheet 있음" : "design_bottom_sheet 없음")
                + " · rv_media " + (a.media != null ? "있음" : "없음")
                + " · rv_chat_tool " + (a.chatTool != null ? "있음" : "없음")
                + " · btn_send " + (a.btnSend == null ? "없음" : sendState)
                + " · 사진항목 " + a.photos.size() + "개(선택 " + a.selectedTotal + ")"
                + " · 입력창 " + (a.chatInput ? "있음" : "없음")
                + " · 대화방 이름 화면 확인 " + (a.roomNameSeen ? "있음" : "없음")
                + (a.outsideMedia > 0 ? (" · rv_media 밖 사진 " + a.outsideMedia + "개 제외") : "")
                + " · 노드 " + a.nodes;
        if (a.menuLabels.size() > 0) {
            StringBuilder sb = new StringBuilder(64);
            for (int i = 0; i < a.menuLabels.size(); i++) {
                if (i > 0) sb.append(" · ");
                sb.append('「').append(a.menuLabels.get(i)).append('」');
            }
            menuSeen = sb.toString();
        }
        seenAt = System.currentTimeMillis();
    }

    // ── A단계 1: 첨부 시트 열기 ────────────────────────────────────────────────

    private void doSheet(AScan a) {
        // 재료 검사는 아무것도 누르기 전에 끝낸다 — 시트를 열어놓고 실패하면 사용자만 번거로워진다.
        if (wantDescs.length == 0) {
            dumpAndFail("전송할 사진 정보가 비어 있습니다. 이미지를 다시 선택한 후 시도하십시오.");
            return;
        }
        if (dupWant > 0) {
            dumpAndFail("전송할 사진의 촬영 시각 표기가 동일하여 사진을 개별로 지목할 수 없습니다"
                    + " (중복 " + dupWant + "건 · 지목 가능 " + wantDescs.length + "장)."
                    + " 오발송을 방지하기 위해 중단했습니다. 해당 이미지는 카카오톡에서 직접 첨부하십시오.");
            return;
        }
        if (a.sheetOpen()) {
            if (!sawSheet) {
                note("첨부 시트를 확인했습니다 ("
                        + (a.sheet != null ? AID_SHEET : AID_MEDIA) + " 확인 · 사진항목 "
                        + a.photos.size() + "개).");
            }
            sawSheet = true;
            phase = A_PICK;
            phaseAt = System.currentTimeMillis();
            sameSig = 0;
            lastSig = "";
            kick(200L);
            return;
        }

        if (attachOpens >= MAX_ATTACH_OPEN) {
            dumpAndFail("첨부 버튼을 " + attachOpens + "회 입력했으나 첨부 시트가 열리지 않았습니다."
                    + attachOpenTail(a));
            return;
        }
        if (openAttach(a)) {
            attachOpens++;
            sameSig = 0;
            lastSig = "";
            kick(900L);
            return;
        }
        // + 를 못 찾았다. 화면을 덤프로 남기고 끝낸다 — 덤프가 있으면 다음 버전에서 정확히 고친다.
        if (sameSig >= STUCK_ROUNDS) {
            dumpAndFail("첨부 버튼을 찾지 못했습니다." + attachOpenTail(a));
            return;
        }
        retry();
    }

    /** 첨부 버튼 실패 메시지 꼬리 — 사용자가 확인할 것과 다음 조치를 같이 준다 */
    private String attachOpenTail(AScan a) {
        return (a.chatInput
                    ? " 채팅방 입력창은 확인되었으나 첨부(+) 버튼을 특정하지 못했습니다."
                    : " 채팅방 화면(메시지 입력창)이 확인되지 않았습니다. 대상 채팅방이 열려 있는지 확인하십시오.")
                + " 카카오톡에서 채팅방 하단 + 를 직접 눌러 첨부 시트를 열어 둔 상태로 다시 시도하십시오."
                + " 화면 진단을 전달하면 해당 버튼을 다음 버전에 반영할 수 있습니다."
                + a11yTail();
    }

    /**
     * 첨부(+) 버튼을 눌러 시트를 연다. 순서는 문서 8장의 지시대로다.
     *  1) desc 가 첨부/추가/더보기 인 clickable 노드
     *  2) 메시지 입력창 근처의 <b>왼쪽 끝</b> clickable 노드
     * <b>없는 id 는 지어내지 않는다.</b> 둘 다 실패하면 false 를 돌려주고 호출부가 덤프를 남긴다.
     */
    private boolean openAttach(AScan a) {
        if (a.plusByDesc != null && clickExact(a.plusByDesc, "첨부 버튼(desc)")) {
            note("첨부 버튼을 입력했습니다 (desc 후보 " + cut(norm(desc(a.plusByDesc)), 12) + ").");
            return true;
        }
        AccessibilityNodeInfo left = leftOfInput(a);
        if (left != null && clickExact(left, "첨부 버튼(입력창 왼쪽)")) {
            note("입력창 왼쪽 끝 항목을 첨부 버튼으로 보고 입력했습니다 " + boundsStr(left)
                    + " — 이 버튼의 id 는 아직 미확보 상태입니다.");
            return true;
        }
        return false;
    }

    /**
     * 메시지 입력창과 같은 줄에 있는 clickable 노드 중 <b>가장 왼쪽</b> 것.
     * 입력창 id 를 못 찾았으면 편집 가능한 노드 위치로 대체한다. 둘 다 없으면 null.
     */
    private AccessibilityNodeInfo leftOfInput(AScan a) {
        Rect ref = (a.inputRect != null) ? a.inputRect : a.editRect;
        if (ref == null) return null;
        int pad = Theme.dp(this, 28);
        AccessibilityNodeInfo best = null;
        int bestLeft = Integer.MAX_VALUE;
        for (int i = 0; i < a.nearCands.size(); i++) {
            AccessibilityNodeInfo n = a.nearCands.get(i);
            Rect r = boundsOf(n);
            if (r.width() <= 0 || r.height() <= 0) continue;
            int cy = r.centerY();
            if (cy < ref.top - pad || cy > ref.bottom + pad) continue;   // 입력창과 같은 줄만
            if (r.right > ref.left + pad) continue;                      // 입력창 왼쪽에 있는 것만
            if (r.left < bestLeft) { bestLeft = r.left; best = n; }
        }
        return best;
    }

    // ── A단계 2: 사진 고르기 ──────────────────────────────────────────────────

    private void doPickPhoto(AScan a) {
        long now = System.currentTimeMillis();

        if (wantDescs.length == 0) {
            dumpAndFail("전송할 사진 정보가 비어 있습니다. 이미지를 다시 선택한 후 시도하십시오.");
            return;
        }

        // 시트가 닫혔다 (사용자가 뒤로가기를 눌렀거나 우리가 엉뚱한 곳을 눌렀다)
        if (!a.sheetOpen() && a.photos.isEmpty()) {
            if (attachOpens < MAX_ATTACH_OPEN) {
                note("첨부 시트가 닫혔습니다. 다시 엽니다.");
                phase = A_SHEET;
                phaseAt = now;
                sameSig = 0;
                lastSig = "";
                kick(400L);
                return;
            }
            dumpAndFail("첨부 시트가 닫혀 사진을 선택할 수 없습니다. 선택 " + pickedCount + "장 완료 상태입니다."
                    + " 카카오톡에서 채팅방 하단 + 를 눌러 첨부 시트를 열어 둔 상태로 다시 시도하십시오.");
            return;
        }

        // desc 가 겹치는 사진이 둘 이상 보이면 아무것도 고르지 않는다 (같은 분에 찍은 두 장).
        // 엉뚱한 사진을 보내는 것이 안 보내는 것보다 나쁘다 — 공유창 흐름의 동명 대화방 규칙과 같다.
        String dup = dupDesc(a);
        if (dup.length() > 0) {
            dumpAndFail("촬영 시각이 같은 사진이 여러 장 있어 대상을 특정하지 못했습니다(" + dup + ")."
                    + " 오발송을 방지하기 위해 선택하지 않았습니다."
                    + " 해당 사진은 카카오톡에서 직접 첨부하십시오.");
            return;
        }

        applySelection(a);

        // 대상 목록에 없는 사진이 선택돼 있으면 여기서 멈춘다.
        // 그대로 전송하면 사용자가 의도하지 않은 사진이 함께 나간다 — 안 보내는 것보다 나쁘다.
        String extra = extraSelected(a);
        if (extra.length() > 0) {
            dumpAndFail("전송 대상이 아닌 사진이 선택된 상태입니다(" + extra + ")."
                    + " 의도하지 않은 사진이 함께 전송되는 것을 방지하기 위해 중단했습니다."
                    + " 카카오톡 첨부 시트에서 선택을 모두 해제한 후 다시 시도하십시오.");
            return;
        }

        // 방금 탭한 사진의 선택 검증 (tv_select_order 에 순번이 생겼나 — 문서 3장)
        if (verifyIdx >= 0) {
            if (verifyIdx < gotDescs.length && gotDescs[verifyIdx]) {
                verifyIdx = -1;
                verifyTries = 0;
            } else {
                verifyTries++;
                if (verifyTries >= MAX_SEL_VERIFY) {
                    String want = (verifyIdx < wantDescs.length) ? wantDescs[verifyIdx] : "";
                    int idx = verifyIdx;
                    verifyIdx = -1;
                    dumpAndFail("사진 「" + cut(want, 24) + "」 을 탭했으나 선택 순번(" + AID_SELECT_ORDER
                            + ")이 표시되지 않았습니다. 선택이 처리되지 않았습니다."
                            + " (대상 " + (idx + 1) + "/" + wantDescs.length + "장 · 선택 완료 "
                            + pickedCount + "장)" + a11yTail());
                    return;
                }
                kick(400L);
                return;
            }
        }

        if (allSelected()) {
            note("사진 " + pickedCount + "장의 선택 순번을 확인했습니다. 전송 버튼을 확인합니다.");
            phase = A_SEND;
            phaseAt = now;
            sendWaits = 0;
            sameSig = 0;
            lastSig = "";
            kick(250L);
            return;
        }

        // 화면에 보이는 대상 사진 중 아직 선택되지 않은 것 하나를 탭한다.
        // (이미 선택된 항목은 건너뛴다 — 다시 누르면 선택이 풀린다)
        int idx = nextTapIndex(a);
        if (idx >= 0) {
            Photo p = a.exact(wantDescsS[idx]);
            if (p != null && clickExact(p.node, "사진 선택")) {
                verifyIdx = idx;
                verifyTries = 0;
                note("사진을 탭했습니다 — 「" + cut(wantDescs[idx], 24) + "」 (" + p.cls + ")");
                kick(450L);
                return;
            }
            if (sameSig >= STUCK_ROUNDS) {
                dumpAndFail("사진 「" + cut(wantDescs[idx], 24) + "」 을 찾았으나 선택 입력이 처리되지 않았습니다"
                        + (p == null ? "" : " (" + p.cls + " " + boundsStr(p.node) + ")") + "."
                        + a11yTail());
                return;
            }
            retry();
            return;
        }

        // 화면 밖에 있다 → rv_media 를 가로로 스크롤하며 다시 찾는다 (문서 2장)
        if (!mediaScrollDone && scrollMedia(a)) {
            kick(450L);
            return;
        }

        if (mediaScrollDone || sameSig >= STUCK_ROUNDS) {
            dumpAndFail(photoNotFound());
            return;
        }
        retry();
    }

    /**
     * 화면의 선택 상태를 후보 목록에 반영한다.
     * 한 번 선택된 것은 다시 내리지 않는다 — 스크롤로 화면 밖에 나가면 노드가 사라지기 때문이다.
     */
    private void applySelection(AScan a) {
        boolean[] got = gotDescs;
        int n = 0;
        for (int i = 0; i < wantDescsS.length && i < got.length; i++) {
            if (!got[i]) {
                Photo p = a.exact(wantDescsS[i]);
                if (p != null && p.selected()) {
                    got[i] = true;
                    note("사진 선택을 확인했습니다 — 「" + cut(wantDescs[i], 24) + "」 (순번 " + p.order + ")");
                }
            }
            if (got[i]) n++;
        }
        pickedCount = n;
    }

    /** 후보 중 화면에 <b>둘 이상</b> 같은 desc 로 보이는 것. 없으면 "". */
    private String dupDesc(AScan a) {
        for (int i = 0; i < wantDescsS.length && i < gotDescs.length; i++) {
            if (gotDescs[i]) continue;
            if (a.count(wantDescsS[i]) > 1) {
                return "「" + cut(wantDescs[i], 24) + "」 " + a.count(wantDescsS[i]) + "장";
            }
        }
        return "";
    }

    /** 아직 선택 안 됐고 지금 화면에 보이는 후보의 index. 없으면 -1. */
    private int nextTapIndex(AScan a) {
        for (int i = 0; i < wantDescsS.length && i < gotDescs.length; i++) {
            if (gotDescs[i]) continue;
            Photo p = a.exact(wantDescsS[i]);
            if (p != null && !p.selected()) return i;
        }
        return -1;
    }

    private boolean allSelected() {
        if (gotDescs.length == 0) return false;
        for (int i = 0; i < gotDescs.length; i++) {
            if (!gotDescs[i]) return false;
        }
        return true;
    }

    /** 선택돼 있는데 우리 대상 목록에는 없는 사진들 (최대 3개까지 이름을 낸다) */
    private String extraSelected(AScan a) {
        StringBuilder sb = new StringBuilder(64);
        int n = 0;
        for (int i = 0; i < a.photos.size(); i++) {
            Photo p = a.photos.get(i);
            if (!p.selected()) continue;
            boolean ours = false;
            for (int k = 0; k < wantDescsS.length; k++) {
                if (p.descS.equals(wantDescsS[k])) { ours = true; break; }
            }
            if (ours) continue;
            if (n < 3) {
                if (n > 0) sb.append(", ");
                sb.append('「').append(cut(p.desc, 24)).append('」');
            }
            n++;
        }
        if (n > 3) sb.append(" 외 ").append(n - 3).append("장");
        return sb.toString();
    }

    /**
     * rv_media 를 한 칸 가로 스크롤한다. 더 나올 게 없으면 {@link #mediaScrollDone} 을 세우고 false.
     * performAction 의 반환값만 믿지 않는다 — 끝에서도 true 를 주는 뷰가 있어서
     * <b>새 사진이 실제로 늘었는지</b>까지 본다.
     */
    private boolean scrollMedia(AScan a) {
        if (a.media == null) {
            // rv_media 가 아예 없다. 첨부 메뉴의 「사진」 을 한 번 눌러 목록을 띄워본다 (문서 5장).
            if (!menuPhotoTapped && a.menuPhoto != null && clickExact(a.menuPhoto, "첨부 메뉴 사진")) {
                menuPhotoTapped = true;
                note("첨부 메뉴 「사진」 을 입력했습니다. 이후 전체 갤러리 화면 구조는 미확보 상태입니다(문서 8장).");
                return true;
            }
            mediaScrollDone = true;
            return false;
        }
        if (mediaScrolls >= MAX_MEDIA_SCROLL) {
            mediaScrollDone = true;
            note("rv_media 를 " + mediaScrolls + "회 스크롤했으나 대상 사진이 표시되지 않았습니다.");
            return false;
        }
        int seen = mediaSeenCount();
        if (mediaScrolls > 0 && seen == mediaSeenBefore) {
            mediaScrollDone = true;
            note("rv_media 스크롤에서 새 사진이 표시되지 않았습니다 (" + mediaScrolls
                    + "회 · 누적 " + seen + "장).");
            return false;
        }
        mediaSeenBefore = seen;
        boolean ok = false;
        try {
            ok = a.media.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
        } catch (Throwable ignore) { }
        if (!ok) {
            mediaScrollDone = true;
            note("rv_media 를 더 스크롤할 수 없습니다 (" + mediaScrolls + "회 · 누적 "
                    + mediaSeenCount() + "장).");
            return false;
        }
        mediaScrolls++;
        return true;
    }

    /** 사진을 못 찾았다 — 찾으려던 desc 와 화면에 있던 desc 를 나란히 보여준다 */
    private String photoNotFound() {
        StringBuilder sb = new StringBuilder(256);
        sb.append("첨부 시트의 최근 사진 목록에서 대상 사진을 찾지 못했습니다 (선택 완료 ")
                .append(pickedCount).append('/').append(wantDescs.length).append("장).");
        sb.append(" 찾으려던 항목: ").append(wantList(3));
        sb.append(" · 화면에서 확인된 항목: ").append(seenList(3)).append('.');
        sb.append(" 대상 이미지가 카카오톡의 최근 사진 목록에 없거나(다운로드 폴더 등),");
        sb.append(" 촬영 시각 표기가 달라 대조에 실패했습니다.");
        sb.append(" 화면 진단의 두 목록을 대조하십시오.");
        return sb.toString();
    }

    /** 찾으려던 desc 목록 (한 줄) */
    private static String wantList(int max) {
        String[] w = wantDescs;
        if (w.length == 0) return "없음";
        StringBuilder sb = new StringBuilder(96);
        for (int i = 0; i < w.length && i < max; i++) {
            if (i > 0) sb.append(" · ");
            sb.append('「').append(cut(w[i], 24)).append('」');
        }
        if (w.length > max) sb.append(" 외 ").append(w.length - max).append("건");
        return sb.toString();
    }

    /** 화면(rv_media)에서 본 사진 desc 목록 (한 줄) */
    private static String seenList(int max) {
        ArrayList<String> seen = mediaSeenList();
        if (seen.isEmpty()) return "없음";
        StringBuilder sb = new StringBuilder(96);
        for (int i = 0; i < seen.size() && i < max; i++) {
            if (i > 0) sb.append(" · ");
            sb.append('「').append(cut(seen.get(i), 24)).append('」');
        }
        if (seen.size() > max) sb.append(" 외 ").append(seen.size() - max).append("건");
        return sb.toString();
    }

    // ── A단계 3: 전송 ────────────────────────────────────────────────────────

    private void doSendAttach(AScan a) {
        if (a.btnSend == null) {
            if (sendTry > 0) {
                finish(true, targetRoom + " · 사진 " + pickedCount + "장을 전송했습니다."
                        + " 카카오톡에서 확인하십시오.");
                return;
            }
            if (sameSig >= STUCK_ROUNDS) {
                dumpAndFail("전송 버튼(" + AID_BTN_SEND + ")을 찾지 못했습니다. 첨부 시트 구성이 변경되었습니다."
                        + " (선택 완료 " + pickedCount + "장 · " + sheetShape + ")" + a11yTail());
                return;
            }
            retry();
            return;
        }

        // 문서 4장 — enabled 가 선택 여부를 그대로 반영한다. Y 가 된 뒤에만 누른다.
        if (!a.sendEnabled) {
            sendWaits++;
            if (sendWaits >= MAX_SEND_WAIT) {
                dumpAndFail("선택된 이미지가 없어 전송 버튼이 활성화되지 않았습니다."
                        + " (선택 완료 " + pickedCount + "/" + wantDescs.length + "장 · "
                        + AID_BTN_SEND + " enabled=N · " + sendWaits + "회 대기)"
                        + " 카카오톡 첨부 시트에서 사진이 선택되는지 직접 확인하십시오." + a11yTail());
                return;
            }
            kick(RETRY_MS);
            return;
        }

        if (sendTry >= MAX_SEND_TRY) {
            dumpAndFail("전송 버튼을 " + sendTry + "회 입력했으나 첨부 시트가 닫히지 않았습니다."
                    + " 전송 여부를 확인할 수 없습니다. 카카오톡에서 전송 결과를 먼저 확인하십시오."
                    + " 이미 전송된 경우 재전송하지 마십시오.");
            return;
        }
        if (clickExact(a.btnSend, "전송 버튼")) {
            sendTry++;
            lastSendLabel = AID_BTN_SEND;
            note("전송 버튼을 입력했습니다 (" + AID_BTN_SEND + " · enabled=Y · 선택 "
                    + pickedCount + "장 · " + sendTry + "회).");
            phase = A_VERIFY;
            phaseAt = System.currentTimeMillis();
            sameSig = 0;
            lastSig = "";
            kick(1200L);
            return;
        }
        if (sameSig >= STUCK_ROUNDS) {
            dumpAndFail("전송 버튼(" + AID_BTN_SEND + ") 입력이 처리되지 않았습니다"
                    + " (clickable=" + bool(a.sendClickable) + " · 좌표 탭 가능="
                    + (canGesture() ? "Y" : "N") + ")." + a11yTail());
            return;
        }
        retry();
    }

    // ── A단계 4: 전송 확인 ───────────────────────────────────────────────────

    private void doVerifyAttach(AScan a) {
        // 시트가 닫혔다 = 전송이 진행됐다 (전송을 누른 적이 있을 때만 이 단계로 들어온다)
        if (!a.sheetOpen() && a.btnSend == null) {
            note("전송 후 첨부 시트가 닫혔습니다.");
            finish(true, targetRoom + " · 사진 " + pickedCount + "장을 전송했습니다. 카카오톡에서 확인하십시오.");
            return;
        }
        // 시트는 남았지만 선택이 전부 풀리고 전송 버튼이 비활성으로 돌아갔다 = 선택분이 전송됐다
        if (a.btnSend != null && !a.sendEnabled && a.selectedTotal == 0 && pickedCount > 0) {
            note("전송 후 선택이 해제되고 전송 버튼이 비활성으로 돌아갔습니다.");
            finish(true, targetRoom + " · 사진 " + pickedCount + "장을 전송했습니다. 카카오톡에서 확인하십시오.");
            return;
        }
        if (sameSig >= STUCK_ROUNDS) {
            if (sendTry < MAX_SEND_TRY) {
                phase = A_SEND;
                sameSig = 0;
                lastSig = "";
                kick(400L);
                return;
            }
            dumpAndFail("전송 버튼 입력 후 첨부 시트가 닫히지 않았습니다. 전송 여부를 확인할 수 없습니다."
                    + " 카카오톡에서 전송 결과를 먼저 확인하십시오. 이미 전송된 경우 재전송하지 마십시오.");
            return;
        }
        retry();
    }

    // ── 첨부 흐름 공용 도구 ───────────────────────────────────────────────────

    /**
     * 이 노드를 누른다 — <b>자기 자신 → 가장 가까운 clickable 조상 → 좌표 탭</b> 순서.
     *
     * {@link #clickNode} 와 달리 "행처럼 큰 조상" 을 먼저 고르지 않는다. 첨부 시트에서 큰 조상을
     * 누르면 시트 배경을 눌러 시트가 그대로 닫힌다. 여기서는 <b>가장 가까운</b> clickable 만 쓴다.
     * 성공을 여기서 단정하지 않는다 — tv_select_order / btn_send 상태로 다음 단계에서 확인한다.
     */
    private boolean clickExact(AccessibilityNodeInfo n, String what) {
        if (n == null) return false;
        try { n.refresh(); } catch (Throwable ignore) { }

        boolean clickable = false, enabled = true;
        try { clickable = n.isClickable(); } catch (Throwable ignore) { }
        try { enabled = n.isEnabled(); } catch (Throwable ignore) { }
        if (clickable && enabled) {
            try {
                if (n.performAction(AccessibilityNodeInfo.ACTION_CLICK)) return true;
            } catch (Throwable ignore) { }
        }

        // getParent() 로 받은 노드는 전부 우리 것이라 다 쓰고 반납한다.
        ArrayList<AccessibilityNodeInfo> got = new ArrayList<AccessibilityNodeInfo>(6);
        try {
            AccessibilityNodeInfo cur = n;
            for (int up = 0; up < 5; up++) {
                AccessibilityNodeInfo p = null;
                try { p = cur.getParent(); } catch (Throwable ignore) { }
                if (p == null) break;
                got.add(p);
                cur = p;
                boolean c = false, e = true;
                try { c = p.isClickable(); } catch (Throwable ignore) { }
                try { e = p.isEnabled(); } catch (Throwable ignore) { }
                if (!c || !e) continue;
                try {
                    if (p.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                        note(what + " — 조상 노드로 입력했습니다 (" + up + "칸 위).");
                        return true;
                    }
                } catch (Throwable ignore) { }
            }
        } finally {
            recycleAll(got);
        }
        // 마지막 수단: 좌표 탭 (문서 기준 canPerformGestures=Y 로 확인됐다)
        return tapNode(n, what);
    }

    /** "카메라, 버튼" → "카메라". 카톡 desc 에는 역할 설명이 쉼표로 붙는다 (문서 2장 handle_container) */
    private static String descHead(String s) {
        String t = (s == null) ? "" : s;
        int i = t.indexOf(',');
        return ((i < 0) ? t : t.substring(0, i)).trim();
    }

    private static void seeMedia(String descText) {
        if (descText == null || descText.length() == 0) return;
        synchronized (MEDIA_SEEN) {
            if (MEDIA_SEEN.contains(descText)) return;
            if (MEDIA_SEEN.size() < MEDIA_DESC_MAX) MEDIA_SEEN.add(descText);
        }
    }

    private static int mediaSeenCount() {
        synchronized (MEDIA_SEEN) { return MEDIA_SEEN.size(); }
    }

    private static ArrayList<String> mediaSeenList() {
        synchronized (MEDIA_SEEN) { return new ArrayList<String>(MEDIA_SEEN); }
    }

    /**
     * 첨부 흐름 전용 진단 블록.
     * <b>찾으려던 것과 화면에 있던 것을 나란히</b> 놓는다 — 사용자가 둘을 대조할 수 있어야
     * "촬영 시각 표기가 다르다" 를 스스로 알아챈다. 떨어뜨려 놓으면 아무도 비교하지 않는다.
     */
    private static String attachBlock() {
        StringBuilder sb = new StringBuilder(1024);
        String[] w = wantDescs;
        boolean[] g = gotDescs;
        sb.append("첨부 시트: ").append(sawSheet ? "확인됨" : "확인되지 않음")
                .append(sheetShape.length() == 0 ? "" : (" · " + sheetShape)).append('\n');
        sb.append("※ 이 흐름은 열려 있는 채팅방이 대상 대화방인지 검증하지 않습니다")
                .append(" (대화방 제목 view id 미확보 — 문서 8장). 대상 채팅방을 여는 것은 호출 측 책임입니다.\n");
        sb.append("첨부 메뉴 항목: ").append(menuSeen.length() == 0 ? "확인되지 않음" : menuSeen)
                .append(menuPhotoTapped ? " · 「사진」 입력함" : "").append('\n');
        sb.append("찾으려던 사진 desc ").append(w.length).append("개")
                .append(dupWant > 0 ? (" · 중복으로 제외된 지목 " + dupWant + "건") : "").append(":\n");
        if (w.length == 0) {
            sb.append("  (없음 — 호출 측이 사진 desc 후보를 넘기지 않았습니다)\n");
        }
        for (int i = 0; i < w.length && i < SHOW_DESCS; i++) {
            sb.append("  ").append(i + 1).append(". \"").append(w[i]).append('"')
                    .append(" → ").append((i < g.length && g[i]) ? "선택 성공" : "선택되지 않음")
                    .append('\n');
        }
        if (w.length > SHOW_DESCS) {
            sb.append("  … 외 ").append(w.length - SHOW_DESCS).append("개\n");
        }
        ArrayList<String> seen = mediaSeenList();
        sb.append("화면(").append(AID_MEDIA).append(")에서 확인된 사진 desc ").append(seen.size())
                .append("개").append(seen.size() > SHOW_DESCS ? (" · 앞 " + SHOW_DESCS + "개만 표시") : "")
                .append(":\n");
        if (seen.isEmpty()) {
            sb.append("  (없음 — 사진 항목을 한 개도 보지 못했습니다)\n");
        }
        for (int i = 0; i < seen.size() && i < SHOW_DESCS; i++) {
            sb.append("  ").append(i + 1).append(". \"").append(seen.get(i)).append("\"\n");
        }
        sb.append("  ↑ 위 두 목록을 대조하십시오. 공백을 제외한 문자가 완전히 일치해야 선택됩니다.\n");
        sb.append("선택 성공: ").append(pickedCount).append('/').append(w.length).append("장")
                .append(" · rv_media 스크롤 ").append(mediaScrolls).append("회")
                .append(" · 첨부 버튼 입력 ").append(attachOpens).append("회\n");
        sb.append("전송 버튼(").append(AID_BTN_SEND).append("): ").append(sendState)
                .append(" · 입력 ").append(sendTry).append("회")
                .append(" · 활성 대기 ").append(sendWaits).append("회\n");
        return sb.toString();
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
                    note("목록에서 대화방을 찾지 못해 검색을 실행했습니다.");
                    return true;
                }
            }
            searchImpossible = true;
            return false;
        }

        // 완전일치 검색은 이모지·말줄임표 때문에 0건이 되기 쉽다 → 앞 이모지를 떼고 앞부분만 넣는다
        String q = searchQuery(room);
        if (q.length() == 0) { searchImpossible = true; return false; }

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
            note("목록에서 대화방을 찾지 못해 검색창에 「" + q + "」 를 입력했습니다."
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
                    note("「" + TAB_CHAT[k] + "」 탭을 선택했습니다.");
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
            note("목록 끝까지 스크롤했습니다 (" + scrolls + "회). 대화방이 표시되지 않았습니다.");
            scrollBackToTop(sc);
            return false;
        }
        boolean ok = false;
        try {
            ok = list.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD);
        } catch (Throwable ignore) { }
        if (!ok) {
            scrollDone = true;
            note("목록을 더 스크롤할 수 없습니다 (" + scrolls + "회). 대화방이 표시되지 않았습니다.");
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
            note(what + " 좌표 탭을 실행했습니다 (" + (int) cx + "," + (int) cy + ")"
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
        String w = (where == null || where.length() == 0) ? "카카오톡 화면을 인식하지 못했습니다." : where;
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
        sb.append("=== 카카오톡 화면 진단(간이) ").append(stamp()).append(" ===\n");
        sb.append("시도 id: ").append(attempt).append(" · 경로: ").append(tag)
                .append(" · 전송 흐름: ").append(flowName()).append('\n');
        sb.append(a11yBlock(this));
        sb.append("실패: ").append(where).append('\n');
        sb.append("대상 대화방: \"").append((targetRoom == null) ? "" : targetRoom).append("\"\n");
        if (mode == M_ATTACH) {
            // 첨부 흐름은 대화방 이름이 아니라 사진 desc 대조가 핵심이다
            sb.append(attachBlock());
            sb.append("단계: ").append(whereNow()).append('\n');
        } else {
            sb.append("화면에서 확인된 이름: ").append(seenNames.length() == 0 ? "없음" : seenNames).append('\n');
            sb.append("단계: ").append(whereNow())
                    .append(" · 대화방 선택 ").append(clickedRow ? "시도" : "없음")
                    .append(" · 전송 입력 ").append(sendTry).append("회")
                    .append(" · 목록 확인 ").append(sawShareList ? "있음" : "없음").append('\n');
        }
        sb.append("카카오톡 화면 이벤트: ").append(eventState()).append('\n');
        sb.append("대화방 열기 인텐트(알림 contentIntent): ").append(openIntentState()).append('\n');
        sb.append(env(this));
        sb.append("마지막으로 본 화면: ")
                .append(seenAt == 0 ? "없음(화면 수집 기록 없음)" : seenShape).append('\n');
        if (seenBtns.length() > 0) sb.append("당시 확인된 버튼: ").append(seenBtns).append('\n');
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
                        "카카오톡 화면 닫기 뒤로가기 " + backTries + " ok=" + ok + " ime=" + ime);
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
            else if (NOTES.size() == NOTES_MAX) NOTES.add("…(기록 한도 초과로 이하 생략)");
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
        if (mode == M_ATTACH) {
            if (p == A_SHEET) {
                return "첨부 시트 열기 중 · 첨부 버튼 입력 " + attachOpens + "회"
                        + " · 시트 " + (sawSheet ? "확인" : "미확인");
            }
            if (p == A_PICK) {
                return "사진 선택 중 · 선택 " + pickedCount + "/" + wantDescs.length + "장"
                        + " · rv_media 스크롤 " + mediaScrolls + "회";
            }
            if (p == A_SEND) {
                return "전송 버튼 확인 중 · 선택 " + pickedCount + "장 · btn_send " + sendState
                        + " · 활성 대기 " + sendWaits + "회";
            }
            return "전송 버튼 입력 후 확인 중 · 선택 " + pickedCount + "장";
        }
        if (p == P_PICK) return "대화방 선택 중 · 스크롤 " + scrolls + "회 · 검색 " + searchTry + "회";
        if (p == P_AFTER) return "대화방 선택 직후 반응 확인 중";
        if (p == P_SEND) return "전송 버튼 찾는 중";
        return "전송 버튼 누른 뒤 확인 중";
    }

    private static String timeoutWhere() {
        int p = phase;
        String room = (targetRoom == null) ? "" : targetRoom;
        if (mode == M_ATTACH) return attachTimeoutWhere();
        if (p == P_PICK) {
            if (!sawShareList) {
                return "시간이 초과되었으나 공유창(대화방 선택 목록)이 확인되지 않았습니다. 대화방 이름 문제가 아닙니다."
                        + " 카카오톡을 직접 실행하여 잠금·재로그인·업데이트 안내가 표시되는지 확인하고,"
                        + " 채팅 목록이 표시된 상태에서 다시 시도하십시오."
                        + (lastActivityCls.length() > 0
                            ? " (당시 표시된 화면: " + shortCls(lastActivityCls) + ")" : "");
            }
            return "대화방 목록에서 「" + cut(room, NAME_MAX) + "」 을 찾지 못한 상태로 시간이 초과되었습니다."
                    + wantVsSeen(seenNames)
                    + (seenNames.length() > 0
                        ? " 설정의 대화방 이름을 화면에 표시된 그대로 수정하십시오." : "")
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
        if (mode == M_ATTACH) {
            return " 카카오톡 첨부 시트가 열린 상태일 수 있습니다. 뒤로가기로 자동 종료를 시도합니다."
                    + " 종료되지 않으면 뒤로가기로 직접 닫은 후 다시 시도하십시오.";
        }
        return " 카카오톡 공유창이 열린 상태일 수 있습니다. 뒤로가기로 자동 종료를 시도합니다."
                + " 종료되지 않으면 뒤로가기로 직접 닫고, 카카오톡을 채팅 목록 화면으로 둔 후 다시 시도하십시오.";
    }

    /** 첨부 시트 흐름에서 시간이 초과됐을 때의 단계별 원인 */
    private static String attachTimeoutWhere() {
        int p = phase;
        if (p == A_SHEET) {
            return "첨부 시트를 열지 못한 상태로 시간이 초과되었습니다"
                    + (sawSheet ? "" : " (design_bottom_sheet 를 한 번도 확인하지 못했습니다)")
                    + ". 대상 채팅방이 화면에 열려 있는지 확인하고, 채팅방 하단 + 를 눌러"
                    + " 첨부 시트를 열어 둔 상태로 다시 시도하십시오." + nextStep();
        }
        if (p == A_PICK) {
            return "대상 사진을 선택하지 못한 상태로 시간이 초과되었습니다 (선택 "
                    + pickedCount + "/" + wantDescs.length + "장)."
                    + " 찾으려던 항목: " + wantList(3)
                    + " · 화면에서 확인된 항목: " + seenList(3) + "." + nextStep();
        }
        if (p == A_SEND) {
            return "전송 버튼이 활성화되지 않은 상태로 시간이 초과되었습니다 (선택 "
                    + pickedCount + "장 · " + AID_BTN_SEND + " " + sendState + ")." + nextStep();
        }
        return "전송 버튼 입력 후 첨부 시트가 닫히지 않은 상태로 시간이 초과되었습니다."
                + " 전송 여부를 확인할 수 없습니다. 카카오톡에서 먼저 확인하십시오."
                + " 이미 전송된 경우 재전송하지 마십시오.";
    }

    /**
     * 우리 말고 켜져 있는 접근성 앱 목록.
     * 접근성끼리 부딪히면 증상이 "카톡 레이아웃이 바뀐 것" 과 구분이 안 된다 —
     * 이게 메시지와 덤프에 없으면 엉뚱한 데를 고치게 된다.
     */
    private static String otherA11y(Context c) {
        if (c == null) return "";
        StringBuilder sb = new StringBuilder(96);
        int n = 0;
        try {
            String flat = android.provider.Settings.Secure.getString(c.getContentResolver(),
                    android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (flat == null || flat.trim().length() == 0) return "";
            String mine = c.getPackageName();
            String[] parts = flat.split(":");
            for (int i = 0; i < parts.length && n < 6; i++) {
                String p = (parts[i] == null) ? "" : parts[i].trim();
                if (p.length() == 0) continue;
                int slash = p.indexOf('/');
                String pkg = (slash > 0) ? p.substring(0, slash) : p;
                if (pkg.equals(mine)) continue;         // 우리 건 뺀다
                if (n > 0) sb.append(", ");
                sb.append(appLabel(c, pkg)).append('(').append(pkg).append(')');
                n++;
            }
        } catch (Throwable t) {
            return "";
        }
        return sb.toString();
    }

    /**
     * 실패 메시지에 붙일 "다른 접근성 앱이 켜져 있다" 안내. 없으면 "".
     * 화면 조작 실패에서 제일 먼저 확인할 항목이라 덤프 상단에도 같은 값을 박는다({@link #a11yBlock}).
     */
    private String a11yTail() {
        String o = otherA11y(this);
        if (o.length() == 0) return "";
        return " · 참고: 타사 접근성 앱이 활성 상태입니다(" + o + "). 해당 앱은 자동 조작과 충돌하여"
                + " 카카오톡 레이아웃이 변경된 것과 동일한 증상을 유발합니다."
                + " 이미지 전송 중에는 해당 앱의 자동 클릭 동작을 중지하거나 접근성 권한을 일시 해제하십시오.";
    }

    /**
     * 진단 <b>맨 위</b>에 들어가는 타사 접근성 앱 목록.
     * 화면 조작이 실패했을 때 가장 먼저 확인해야 하는 항목이므로 아래로 내려보내지 않는다.
     */
    private static String a11yBlock(Context c) {
        String o = otherA11y(c);
        if (o.length() == 0) return "활성 상태인 타사 접근성 앱: 없음\n";
        return "활성 상태인 타사 접근성 앱: " + o + "\n"
                + "  ← 화면 조작 실패 시 가장 먼저 확인할 항목입니다."
                + " 해당 앱의 자동 클릭 동작을 중지한 후 다시 시도하십시오.\n";
    }

    /** 패키지의 앱 이름 (못 찾으면 패키지명 그대로) */
    private static String appLabel(Context c, String pkg) {
        try {
            android.content.pm.PackageManager pm = c.getPackageManager();
            CharSequence l = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0));
            if (l != null && l.length() > 0) return l.toString();
        } catch (Throwable ignore) { }
        return pkg;
    }

    /**
     * 실패 문구의 핵심 한 줄 — <b>찾으려던 이름</b>과 <b>화면에서 본 이름들</b>을 나란히 남긴다.
     * 둘을 떨어뜨려 놓으면 사용자가 비교를 못 하고, 비교만 되면 대부분 스스로 고친다
     * (이모지·괄호·띄어쓰기 차이가 눈에 바로 보인다).
     */
    private static String wantVsSeen(String seen) {
        String want = (targetRoom == null) ? "" : targetRoom;
        return " 찾으려던 이름: 「" + cut(want, NAME_MAX) + "」"
                + " · 화면에서 확인된 이름: "
                + (seen == null || seen.length() == 0 ? "없음" : seen) + ".";
    }

    /**
     * 그 대화방을 여는 인텐트(알림 contentIntent)를 갖고 있나.
     * 공유창이 안 뜨는 원인을 좁힐 때 "대체 경로 재료가 있는지" 를 같이 봐야 한다.
     */
    private static String openIntentState() {
        String k = targetKey;
        if (k == null || k.length() == 0) return "확인 불가(대상 대화방 없음)";
        try {
            // 저장값을 그대로 넘긴다 — 구분자가 있으면 그 계정에서, 없으면 구버전 경로로 찾는다
            return KakaoListener.hasOpenIntent(k)
                    ? "보유"
                    : "없음(해당 대화방 알림을 아직 수신하지 않았거나 카카오톡이 제공하지 않음)";
        } catch (Throwable t) {
            return "확인 실패(" + t.getClass().getSimpleName() + ")";
        }
    }

    /** 이번 시도에서 카톡 창 이벤트를 받았나 — "화면 미표시" 와 "표시됐으나 실패" 를 가른다 */
    private static String eventState() {
        if (kakaoEvents != 0) return kakaoEvents + "건 (카카오톡 화면은 표시되었습니다)";
        return mode == M_ATTACH
                ? "0건 (카카오톡 화면 이벤트를 한 건도 수신하지 못했습니다 = 카카오톡이 전면에 없는 것으로 판단)"
                : "0건 (카카오톡 화면 이벤트를 한 건도 수신하지 못했습니다 = 공유창 미표시로 판단)";
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
        /** {@code L_EXACT} ~ {@code L_PART} */
        int level = L_PART;
        String rowKey = "";

        String how() {
            switch (level) {
                case L_EXACT: return "정확히 일치";
                case L_SQUASH: return "공백·보이지 않는 문자 무시";
                case L_CORE: return "이모지·기호 제거 후 일치";
                case L_PREFIX: return "말줄임 접두 일치";
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
        /** 매칭 등급별 후보 (index = L_* 상수). 등급이 늘면 {@link #newTiers()} 만 고친다. */
        final ArrayList<ArrayList<Hit>> tiers = newTiers();
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
            for (int i = 0; i < tiers.size(); i++) {
                ArrayList<Hit> t = tiers.get(i);
                if (!t.isEmpty()) return dedupe(t);
            }
            return new ArrayList<Hit>(0);
        }

        /** 이름을 확실하게 맞춘 후보가 있나 (= 지금 보고 있는 화면이 방 목록이라는 강한 증거) */
        boolean strongHit() {
            for (int i = 0; i <= L_CORE; i++) {
                if (!tiers.get(i).isEmpty()) return true;
            }
            return false;
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

    private static ArrayList<ArrayList<Hit>> newTiers() {
        ArrayList<ArrayList<Hit>> out = new ArrayList<ArrayList<Hit>>(L_COUNT);
        for (int i = 0; i < L_COUNT; i++) out.add(new ArrayList<Hit>(4));
        return out;
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
        final String roomC = core(room);
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
                        Hit hit = match(cand, roomN, roomS, roomC);
                        if (hit != null) {
                            hit.node = n;
                            AccessibilityNodeInfo row = rowOf(n);
                            hit.rowKey = keyOf(row);
                            recycleRow(row, n);
                            boolean idBonus = idIn(id, ROOM_IDS);
                            if (idBonus && hit.level > L_EXACT) hit.level--;
                            int lv = hit.level;
                            if (lv < 0) lv = 0;
                            if (lv >= L_COUNT) lv = L_COUNT - 1;
                            sc.tiers.get(lv).add(hit);
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
        else if (sc.strongHit()) sawShareList = true;   // 방 이름을 확실하게 찾았다
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

    /**
     * 이름 매칭. 안 맞으면 null.
     *
     * 실사용 이름(🎆로 시작 · 30자 · 공백 다수)을 기준으로 다시 짰다. 예전 판의 구멍은 셋이었다.
     *  1) 이모지·기호를 걷어낸 비교가 없었다 → 앞의 이모지 한 글자 때문에 전부 빗나간다.
     *  2) 말줄임 대응이 "…" 가 <b>글자에 들어온 경우</b>만 봤다. 뷰가 그림으로만 자르면
     *     글자에는 말줄임표가 없어서 접두 일치가 성립하지 않는다 → 마커 없는 접두도 본다.
     *  3) 연속 공백은 {@link #norm} 이 한 칸으로 줄이고 {@link #squash} 가 전부 지운다 (그대로 유지).
     *
     * 너그러워진 만큼 오발송 위험이 커지는 것은 <b>후보가 둘 이상이면 전송을 중단하는</b>
     * {@link #doPick} 규칙이 막는다. 짧은 접두는 우연히 겹치니 최소 길이를 요구한다.
     */
    private static Hit match(String cand, String roomN, String roomS, String roomC) {
        String cn = cand.toLowerCase(Locale.ROOT);
        if (cn.equals(roomN)) return hitOf(cand, L_EXACT);

        String cs = squash(cand);
        if (cs.length() > 0 && cs.equals(roomS)) return hitOf(cand, L_SQUASH);

        String cc = core(cand);
        if (cc.length() >= 2 && roomC.length() >= 2 && cc.equals(roomC)) return hitOf(cand, L_CORE);

        // 목록에서 잘려 표시된 경우 — 말줄임표가 글자에 있든 없든 둘 다 본다
        String base = stripEllipsis(cs);
        boolean marked = !base.equals(cs);
        if (base.length() >= (marked ? 3 : MIN_PREFIX)
                && roomS.length() > base.length() && roomS.startsWith(base)) {
            return hitOf(cand, L_PREFIX);
        }
        String baseC = core(base);
        if (baseC.length() >= (marked ? 2 : MIN_PREFIX_CORE)
                && roomC.length() > baseC.length() && roomC.startsWith(baseC)) {
            return hitOf(cand, L_PREFIX);
        }

        // 부분 일치 — 남의 대화 미리보기 줄을 잡지 않게 길이를 제한한다
        if (roomS.length() >= 2 && cs.contains(roomS)
                && cs.length() <= roomS.length() + 14) {
            return hitOf(cand, L_PART);
        }
        if (roomC.length() >= 4 && cc.contains(roomC)
                && cc.length() <= roomC.length() + 14) {
            return hitOf(cand, L_PART);
        }
        return null;
    }

    private static Hit hitOf(String name, int level) {
        Hit h = new Hit();
        h.name = name;
        h.level = level;
        return h;
    }

    /** 끝에 붙은 말줄임표(… · ...)를 뗀다 */
    private static String stripEllipsis(String s) {
        String t = (s == null) ? "" : s;
        while (true) {
            if (t.endsWith("…")) { t = t.substring(0, t.length() - 1); continue; }
            if (t.endsWith("...")) { t = t.substring(0, t.length() - 3); continue; }
            return t;
        }
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
        if (mode == M_ATTACH) return buildAttachDump(where);
        final StringBuilder out = new StringBuilder(4096);
        final String room = (targetRoom == null) ? "" : targetRoom;

        dumpHead(out, where);
        out.append("찾으려던 이름: \"").append(room).append("\"\n");
        out.append("  (정규화: \"").append(norm(room))
                .append("\" / 공백무시: \"").append(squash(room))
                .append("\" / 이모지·기호 제거: \"").append(core(room))
                .append("\" / 검색 질의: \"").append(searchQuery(room)).append("\")\n");
        String key = (targetKey == null) ? "" : targetKey;
        if (!key.equals(room)) {
            out.append("  설정 저장값: \"").append(vis(key))
                    .append("\"  (계정키·구분자는 화면 매칭에서 제외했습니다)\n");
        }
        out.append("카카오톡 화면 이벤트: ").append(eventState()).append('\n');
        out.append("대화방 열기 인텐트(알림 contentIntent): ").append(openIntentState()).append('\n');
        out.append("단계: ").append(whereNow())
                .append(" · 대화방 선택 ").append(clickedRow ? "시도" : "없음")
                .append(" · 전송 입력 ").append(sendTry).append("회")
                .append(" · 목록 확인 ").append(sawShareList ? "있음" : "없음").append('\n');
        out.append(env(this));
        out.append("카카오톡 버전: ").append(kakaoVersion()).append('\n');
        out.append("좌표 탭 가능(canPerformGestures): ").append(canGesture() ? "Y" : "N").append('\n');
        out.append("마지막 액티비티/다이얼로그: ")
                .append(lastActivityCls.length() == 0 ? "확인 불가" : lastActivityCls).append('\n');

        ArrayList<AccessibilityNodeInfo> rs = roots();
        appendWindows(out, rs.size());

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
        out.append("대화방 입력창 보임: ").append(sc.chatInput ? "Y" : "N").append('\n');

        out.append("버튼으로 인식된 노드(입력 가능 + 문자 포함) ").append(sc.btns.size()).append("개:\n");
        for (int i = 0; i < sc.btns.size() && i < 12; i++) {
            Btn b = sc.btns.get(i);
            out.append("  - \"").append(cut(b.label, 24)).append("\" id=").append(b.id)
                    .append(" enabled=").append(b.enabled ? "Y" : "N")
                    .append(" prio=").append(b.prio)
                    .append(' ').append(boundsStr(b.node)).append('\n');
        }
        String seenNow = roomLike(sc);
        out.append("화면에서 확인된 이름(위의 「찾으려던 이름」 과 비교하십시오): ")
                .append(seenNow.length() == 0 ? "없음" : seenNow).append('\n');
        out.append("화면에서 수집된 문자(중복 제거, 앞 ").append(Math.min(40, sc.leafTexts.size())).append("개):\n");
        for (int i = 0; i < sc.leafTexts.size() && i < 40; i++) {
            out.append("  ").append(i + 1).append(". ").append(privacyCut(sc.leafTexts.get(i))).append('\n');
        }
        ArrayList<Hit> hits = sc.bestHits();
        out.append("대화방 이름 후보: ").append(hits.size()).append("개");
        for (int i = 0; i < hits.size() && i < 5; i++) {
            out.append("\n  - \"").append(cut(hits.get(i).name, 24)).append("\" (")
                    .append(hits.get(i).how()).append(") 행=").append(hits.get(i).rowKey);
        }
        out.append('\n');

        appendNodeList(out, rs);
        out.append('\n').append(notesBlock());
        out.append("=== 끝 ===\n");

        recycleAll(rs);
        String s = out.toString();
        if (s.length() > DUMP_MAX_CHARS) s = s.substring(0, DUMP_MAX_CHARS) + "\n…(이하 생략)";
        return s;
    }

    // ── 덤프 공용 조각 (공유창 · 첨부 시트 둘 다 쓴다) ──────────────────────────

    /** 덤프 머리 — 시각 · 시도 id · 흐름 이름 · 타사 접근성 앱 · 실패 사유 */
    private void dumpHead(StringBuilder out, String where) {
        String now = new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA).format(new Date());
        out.append("=== 카카오톡 화면 진단 ").append(now).append(" ===\n");
        out.append("※ 이 기록에는 당시 카카오톡 화면에 표시된 이름·문구가 포함됩니다.\n");
        out.append("   전달 전 내용을 확인하고, 노출을 원하지 않는 항목은 삭제하십시오.\n");
        out.append("   (대화 본문 등 장문은 앞 ").append(TEXT_KEEP).append("자만 기록됩니다)\n");
        out.append("시도 id: ").append(attempt).append(" · 전송 흐름: ").append(flowName()).append('\n');
        // 타사 접근성 앱은 화면 조작 실패에서 가장 먼저 봐야 하는 항목이다 → 맨 위에 둔다
        out.append(a11yBlock(this));
        out.append("실패: ").append((where == null || where.length() == 0) ? "(수동 수집)" : where).append('\n');
    }

    /** 창 목록 (바텀시트가 별도 창인지 같은 창인지 여기서 갈린다 — 문서 6장) */
    private void appendWindows(StringBuilder out, int rootCount) {
        out.append("카카오톡 창 개수: ").append(rootCount).append('\n');
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
    }

    /** 노드 목록 (셀렉터를 고칠 근거는 결국 이것이다) */
    private void appendNodeList(StringBuilder out, ArrayList<AccessibilityNodeInfo> rs) {
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
    }

    /**
     * 첨부 시트 흐름 전용 진단.
     * 공유창 덤프와 섞지 않는다 — 봐야 하는 값이 (방 이름 vs 사진 desc) 완전히 다르다.
     */
    private String buildAttachDump(String where) {
        final StringBuilder out = new StringBuilder(4096);
        dumpHead(out, where);
        out.append("대상 대화방: \"").append((targetRoom == null) ? "" : targetRoom).append("\"\n");
        String key = (targetKey == null) ? "" : targetKey;
        if (!key.equals((targetRoom == null) ? "" : targetRoom)) {
            out.append("  설정 저장값: \"").append(vis(key))
                    .append("\"  (계정키·구분자는 화면 매칭에서 쓰지 않습니다)\n");
        }
        out.append("단계: ").append(whereNow()).append('\n');
        out.append(attachBlock());
        out.append("카카오톡 화면 이벤트: ").append(eventState()).append('\n');
        out.append(env(this));
        out.append("카카오톡 버전: ").append(kakaoVersion()).append('\n');
        out.append("좌표 탭 가능(canPerformGestures): ").append(canGesture() ? "Y" : "N").append('\n');
        out.append("마지막 액티비티/다이얼로그: ")
                .append(lastActivityCls.length() == 0 ? "확인 불가" : lastActivityCls).append('\n');

        ArrayList<AccessibilityNodeInfo> rs = roots();
        appendWindows(out, rs.size());

        if (rs.isEmpty()) {
            out.append("\n현재 화면에 카카오톡 창이 없습니다. 카카오톡이 전면에 없거나 화면이 꺼졌습니다.\n");
            out.append("마지막으로 본 첨부 시트: ")
                    .append(seenAt == 0 ? "없음(화면 수집 기록 없음)" : sheetShape).append('\n');
            out.append(notesBlock());
            out.append("=== 끝 ===\n");
            return out.toString();
        }

        AScan a;
        try {
            a = ascan(rs);
        } catch (Throwable t) {
            out.append("\n화면 수집에 실패했습니다 — ").append(t.getClass().getSimpleName()).append('\n');
            out.append(notesBlock()).append("=== 끝 ===\n");
            recycleAll(rs);
            return out.toString();
        }

        out.append("\n--- 지금 화면의 첨부 시트 ---\n");
        out.append("노드 ").append(a.nodes).append("개")
                .append(a.truncated ? " (한도 초과로 일부 생략)" : "").append('\n');
        out.append(AID_SHEET).append(": ").append(a.sheet == null ? "없음" : boundsStr(a.sheet)).append('\n');
        out.append(AID_MEDIA).append(": ").append(a.media == null ? "없음"
                : (boundsStr(a.media) + " 자식 " + childCount(a.media) + "개")).append('\n');
        out.append(AID_CHAT_TOOL).append(": ").append(a.chatTool == null ? "없음"
                : (boundsStr(a.chatTool) + " 자식 " + childCount(a.chatTool) + "개")).append('\n');
        out.append(AID_BTN_SEND).append(": ").append(a.btnSend == null ? "없음"
                : ("enabled=" + bool(a.sendEnabled) + " clickable=" + bool(a.sendClickable)
                   + " " + boundsStr(a.btnSend))).append('\n');
        out.append("첨부 메뉴 「사진」 항목: ").append(a.menuPhoto == null ? "없음"
                : boundsStr(a.menuPhoto)).append('\n');
        out.append("메시지 입력창(").append(joinIds(CHATROOM_IDS)).append("): ")
                .append(a.inputRect == null
                        ? (a.editRect == null ? "없음" : ("id 불일치 · 편집 가능 노드 " + rectStr(a.editRect)))
                        : rectStr(a.inputRect)).append('\n');
        out.append("첨부(+) 버튼 후보: desc(").append(joinLabels(ATTACH_DESC)).append(") ")
                .append(a.plusByDesc == null ? "없음" : boundsStr(a.plusByDesc));
        AccessibilityNodeInfo left = leftOfInput(a);
        out.append(" · 입력창 왼쪽 끝 ").append(left == null ? "없음"
                : (shortId(viewId(left)).length() == 0 ? "id 없음" : shortId(viewId(left)))
                  + " " + boundsStr(left)).append('\n');
        out.append("사진 항목 ").append(a.photos.size()).append("개 (선택 ")
                .append(a.selectedTotal).append("개):\n");
        for (int i = 0; i < a.photos.size() && i < SHOW_DESCS; i++) {
            Photo ph = a.photos.get(i);
            out.append("  ").append(i + 1).append(". desc=\"").append(privacyCut(ph.desc))
                    .append("\" [").append(ph.cls).append(']')
                    .append(" 순번=").append(ph.order.length() == 0 ? "-" : ph.order)
                    .append(ph.inMedia ? "" : " (rv_media 밖)")
                    .append(' ').append(boundsStr(ph.node)).append('\n');
        }
        if (a.photos.size() > SHOW_DESCS) {
            out.append("  … 외 ").append(a.photos.size() - SHOW_DESCS).append("개\n");
        }

        appendNodeList(out, rs);
        out.append('\n').append(notesBlock());
        out.append("=== 끝 ===\n");

        recycleAll(rs);
        String s = out.toString();
        if (s.length() > DUMP_MAX_CHARS) s = s.substring(0, DUMP_MAX_CHARS) + "\n…(이하 생략)";
        return s;
    }

    private static int childCount(AccessibilityNodeInfo n) {
        if (n == null) return 0;
        try { return n.getChildCount(); } catch (Throwable t) { return 0; }
    }

    private static String rectStr(Rect r) {
        return (r == null) ? "?" : ("(" + r.left + "," + r.top + "-" + r.right + "," + r.bottom + ")");
    }

    /** id 후보 배열을 shortId 로 한 줄에 (덤프에서 "무엇을 찾았는지" 를 밝힌다) */
    private static String joinIds(String[] ids) {
        StringBuilder sb = new StringBuilder(64);
        for (int i = 0; i < ids.length; i++) {
            if (i > 0) sb.append('/');
            sb.append(shortId(ids[i]));
        }
        return sb.toString();
    }

    private static String joinLabels(String[] labels) {
        StringBuilder sb = new StringBuilder(48);
        for (int i = 0; i < labels.length; i++) {
            if (i > 0) sb.append('/');
            sb.append(labels[i]);
        }
        return sb.toString();
    }

    private String kakaoVersion() {
        try {
            return String.valueOf(getPackageManager().getPackageInfo(KAKAO, 0).versionName);
        } catch (Throwable t) {
            return "확인 불가";
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
            // 제어문자는 화면 글자에 있을 수 없다. 특히 RoomRef.SEP(U+0001) 가 섞인 값이
            // 넘어오면 여기서 털어내야 완전일치·검색이 조용히 실패하지 않는다.
            if (c < ' ' || c == '\u007f') continue;
            b.append(c);
        }
        String t = b.toString();
        while (t.contains("  ")) t = t.replace("  ", " ");
        return t.trim();
    }

    /**
     * <b>이모지·기호·문장부호를 걷어내고 글자와 숫자만 남긴다</b> (비교 전용).
     * 카톡 방 이름은 이모지로 시작하거나 중간에 기호가 끼는 경우가 흔하고,
     * 접근성이 읽어오는 글자에서 그 이모지가 빠지거나 다른 변형으로 오는 경우가 있다.
     * 그때 이름 전체가 어긋나는 것을 막는다. 한글·영문·숫자는 그대로 남는다.
     */
    static String core(String s) {
        String t = squash(s);
        StringBuilder b = new StringBuilder(t.length());
        int i = 0;
        while (i < t.length()) {
            int cp = t.codePointAt(i);
            int n = Character.charCount(cp);
            if (Character.isLetterOrDigit(cp)) b.appendCodePoint(cp);
            i += n;
        }
        return b.toString();
    }

    /**
     * 검색창에 넣을 질의.
     * 완전일치를 넣으면 이모지·말줄임 때문에 0건이 되기 쉽다. 그래서
     *  (1) 앞에 붙은 이모지·기호를 떼고 (검색창에 이모지를 넣으면 카톡이 0건을 준다)
     *  (2) 글자 {@link #SEARCH_QUERY_MAX} 자까지만 넣는다 (서러게이트 쌍은 쪼개지 않는다).
     */
    static String searchQuery(String room) {
        String t = norm(room);
        int i = 0;
        while (i < t.length()) {
            int cp = t.codePointAt(i);
            if (Character.isLetterOrDigit(cp)) break;
            i += Character.charCount(cp);
        }
        if (i >= t.length()) i = 0;      // 글자가 하나도 없으면 원본 그대로 넣어본다
        String body = t.substring(i).trim();
        if (body.length() == 0) body = t;
        int end = 0, kept = 0;
        while (end < body.length() && kept < SEARCH_QUERY_MAX) {
            end += Character.charCount(body.codePointAt(end));
            kept++;
        }
        return body.substring(0, end).trim();
    }

    /** 보이지 않는 문자를 눈에 보이게 바꿔 적는다 (진단에서 "왜 안 맞았나" 를 보여주는 용도) */
    static String vis(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length() + 8);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c < ' ' || c == '\u007f') {
                b.append("<U+").append(String.format(Locale.ROOT, "%04X", (int) c)).append('>');
            } else {
                b.append(c);
            }
        }
        return b.toString();
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
