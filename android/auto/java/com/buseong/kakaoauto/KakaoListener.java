package com.buseong.kakaoauto;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Parcelable;
import android.service.notification.NotificationListenerService;
import android.service.notification.StatusBarNotification;

import com.buseong.kakaoauto.engine.RoomKind;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * 카톡 알림을 읽어서 (1) 방별 RemoteInput 세션을 기억하고 (2) 트리거·자동응답·봇으로 넘긴다.
 *
 * 글 매크로는 설정이 켜져 있을 때만 알림 답장으로 넣는다. 그 외 발송은 등록한 카카오 계정이다.
 * 답장 세션은 그 방 알림이 한 번은 와야 생긴다. 세션은 메모리에만 두고,
 * 앱(프로세스)이 죽으면 사라진다 — 카톡 알림이 다시 오면 저절로 복구된다.
 *
 * 규칙 두 개만 지킨다.
 *   1) onNotificationPosted 안에서 절대 블로킹하지 않는다 → 파싱/세션갱신만 하고 나머지는 BG 스레드로 넘긴다.
 *   2) 기능 실행은 전부 License.allowed() 를 통과해야 한다 (macro / roombot / minigame 각각).
 *
 * 방은 이름 하나가 아니라 {@link RoomRef}(계정키 + 방 이름)로 잡는다. 듀얼 메신저로 카톡이
 * 두 개 깔리면 같은 이름의 방이 계정별로 따로 있고 답장창(세션)도 계정별로 따로다 (UI_V3 6장).
 * 세션 맵·방 캐시의 키는 전부 {@code RoomRef.key()} 다. 방 이름만 받는 예전 오버로드는
 * {@code RoomRef.parse()} 로 위임하고, 기본 계정에서 못 찾으면 이름이 유일할 때만 다른 계정도 뒤진다.
 *
 * 다른 클래스가 쓰는 공개 API
 *   boolean        queueReply(ctx, ref, text)    — 매크로 글을 알림 답장에 넣기 (접수만, 성공 아님)
 *   boolean        sendTo(ctx, ref|room, text)   — 쓰지 않음. 항상 false
 *   Set&lt;String&gt; imageTypesFor(ref|room)     — 그 방 답장창이 받아주는 사진 MIME (비었으면 사진 첨부 불가)
 *   boolean        sendImageTo(ctx, ref|room, uri) — 답장창에 사진 한 장 실어 보내기 (ImageSender 가 호출)
 *   PendingIntent  openIntentFor(ref|room)        — 그 대화방을 여는 인텐트 (카톡 알림의 contentIntent)
 *   boolean        hasOpenIntent(ref|room)        — 위 인텐트를 갖고 있나 (진단 표시용)
 *   int            othersSinceMine(ref|room)     — 내 마지막 발송 뒤 남이 올린 메시지 수 (도배 방지 판정)
 *   List<RoomInfo> knownRooms(ctx)               — 최근 감지된 방 (계정·단체여부·감지시각, 최대 50개)
 *   void           forgetRoom(ctx, ref)          — 감지된 방 1건 삭제 (멤버 오인식 정리)
 *   void           clearRooms(ctx)               — 감지 캐시 전체 초기화
 *   Set<String>    accountsSeen(ctx)             — 지금까지 확인된 계정키
 *   boolean        hasSession(room) / isKnownRoom(room) / connected(ctx)
 *   void           post(Runnable, delayMs)       — 공용 BG 핸들러 (지연 발송에 쓴다)
 *
 * 주의: 같은 패키지의 Log 클래스 때문에 android.util.Log 는 풀네임으로만 쓴다.
 */
public final class KakaoListener extends NotificationListenerService {

    public static final String KAKAO = "com.kakao.talk";

    /** 감지 방 캐시 최대 개수 (SPEC 8.2 — 방 목록은 평문 Prefs 에 계정·이름만) */
    public static final int MAX_ROOMS = 50;

    /** 메모리에 들고 있을 방 세션 최대 개수 (넘치면 오래된 방부터 버린다) */
    public static final int MAX_SESSIONS = 120;

    /** 같은 알림이 여러 번 갱신돼도 한 번만 처리하는 무시 창 (ms) */
    private static final long DEDUP_MS = 1500L;

    /** 내가 방금 보낸 문장이 알림으로 되돌아왔을 때 내 메시지로 인정하는 창 (ms) */
    private static final long ECHO_MS = 30000L;

    private static final String K_ROOMS = "K_ROOM_CACHE";

    // ── 그룹 판정 근거의 세기 (= 신호 우선순위) ───────────────────────────────
    // 숫자가 클수록 확실한 근거다. 약한 근거로 강한 근거를 덮어쓰지 않는다.
    // 우선순위: isGroupConversation > android.messages 발신자 > conversationTitle > 본문 접두 이름
    //
    // 본문 접두 이름(namePrefix)이 제일 약한 이유 —
    // 1:1 상대가 "시간 : 3시" 라고만 보내도 모양만 보면 "발신자 : 내용" 과 똑같다.
    // 그래서 이 신호는 마지막에 보고, namePrefix 자체도 이름처럼 생긴 것만 인정한다.

    /** 아무 근거도 없다 (그냥 1:1 로 추정한 상태) */
    private static final int RANK_NONE = 0;
    /** 본문 앞 "이름 : " 접두사로 추측했다 (제일 약한 근거) */
    private static final int RANK_HEURISTIC = 1;
    /** conversationTitle(방) 과 title(발신자) 이 달랐다 */
    private static final int RANK_TITLE = 2;
    /** android.messages 의 발신자 정보로 판정했다 */
    private static final int RANK_MESSAGES = 3;
    /** 카톡이 android.isGroupConversation 으로 직접 알려줬다 (제일 확실) */
    private static final int RANK_EXTRA = 4;

    /** "홍길동 : 안녕" 처럼 본문 앞에 붙는 발신자 이름의 최대 길이 (이보다 길면 문장이다) */
    private static final int NAME_MAX = 12;

    /** 이름에 들어갈 수 없는 문자들. 하나라도 섞이면 발신자 이름으로 안 본다. */
    private static final String NAME_BAD_CHARS = ":@/\\#$%^&*=+<>[]{}|~";

    /**
     * "시간 : 3시" 처럼 사람들이 본문에 자주 쓰는 라벨 단어.
     * 이런 말은 절대 발신자 이름으로 보지 않는다 — 이것 때문에 1:1 이 단체방으로 오판됐다.
     */
    private static final String[] LABEL_WORDS = {
        "시간", "주소", "이름", "날짜", "가격", "금액", "번호",
        "전화", "링크", "위치", "메모", "내용", "제목"
    };

    /** 방마다 기억해두는 "최근에 실제로 본 발신자" 개수 (namePrefix 인정 기준으로 쓴다) */
    private static final int MAX_SENDERS = 12;

    // ── 방별 세션 ─────────────────────────────────────────────────────────────

    /** 방 하나에 대한 최근 알림 상태. 발송에 필요한 재료가 여기 다 있다. */
    public static final class Session {
        /** 이 세션이 붙은 방 (계정 + 이름) */
        public final RoomRef ref;
        /** 방 이름 (= ref.name). 예전 코드가 그대로 읽을 수 있게 남겨둔다 */
        public final String room;
        /** 답장 액션의 PendingIntent (카톡이 준 것) */
        public volatile PendingIntent pending;
        /**
         * 알림 본문을 탭했을 때 실행되는 인텐트 = <b>그 대화방 열기</b> (카톡이 만든 것).
         *
         * 이게 있으면 대화방을 열 때 이름 매칭·검색·스크롤이 전부 필요 없다 —
         * 카톡이 지목한 "그 방" 이라서 이름 표기 차이(이모지·말줄임)와 무관하다.
         * 다만 <b>이미지 첨부 수단은 아니다</b>: 방만 열리고, 우리 SAF URI 를 카톡 앨범
         * 그리드에서 지목할 방법이 없다. 그래서 지금은 진단(보유 여부)과
         * 향후 대체 경로 재료로만 보관한다.
         *
         * 답장 액션(pending)과 별개 객체다. contentIntent 를 send() 해도 답장 세션은 죽지 않는다
         * (FLAG_AUTO_CANCEL 은 사용자가 알림을 탭했을 때만 적용된다).
         * 없으면 null (카톡이 안 넣어준 알림).
         */
        public volatile PendingIntent open;
        /** 그 액션에 달린 RemoteInput 들 (결과 키가 여기 있다) */
        public volatile RemoteInput[] inputs;
        /**
         * 그 답장창이 받아주는 데이터 타입들 (RemoteInput.getAllowedDataTypes() 의 합집합).
         * 카톡이 여기에 이미지 MIME 을 걸어놨으면 <b>알림 답장만으로 사진을 보낼 수 있다</b> —
         * 공유창을 안 열어도 되니까 화면이 아예 안 움직인다. 비어 있으면 못 보낸다.
         * 항상 수정 불가 Set 으로만 넣는다 (밖에 그대로 내주니까).
         */
        public volatile java.util.Set<String> dataTypes = java.util.Collections.emptySet();
        /** 내가 이 방으로 마지막으로 보낸 시각 */
        public volatile long lastMine;
        /** 알림 답장을 넣었지만 카카오 메시지 번호는 아직 없는 시각 */
        public volatile long lastQueuedAt;
        /** 내 마지막 발송 뒤 남이 올린 메시지 수 */
        public volatile int othersSinceMine;
        /** 이 방 알림을 마지막으로 본 시각 */
        public volatile long lastAt;
        /** 마지막으로 본 발신자 */
        public volatile String lastSender = "";
        /**
         * 이 방에서 카톡이 실제로 알려준 발신자 이름들 (최근 {@link #MAX_SENDERS} 명).
         * 본문 접두 "이름 : " 을 발신자로 인정할지 판단하는 데 쓴다 —
         * 아는 이름이 아니면 그냥 본문의 일부로 본다.
         * 접근은 전부 synchronized(recentSenders).
         */
        public final LinkedHashSet<String> recentSenders = new LinkedHashSet<String>();
        /** 그룹방인가 */
        public volatile boolean group;
        /**
         * 위 group 값을 만든 근거의 세기 (RANK_* 상수).
         * 근거가 약한 알림 한 건 때문에 "단체방"이 "1:1" 로 뒤집히지 않게 막는 데 쓴다 —
         * 단체방에 자동응답이 나가면 도배로 강퇴당하니까, 애매하면 그룹 쪽으로 기운다.
         */
        public volatile int groupRank;
        /** 내가 마지막으로 보낸 문장 (알림 메아리 걸러내기용) */
        public volatile String lastSentText = "";
        /** 중복 알림 판정용 지문 */
        volatile String lastKey = "";
        volatile long lastKeyAt;
        /** 판정 근거 로그를 이 방에서 이미 남겼나 (방마다 처음 1회만 — 도배 금지) */
        volatile boolean whyLogged = false;
        /** 자동응답 보류 로그를 이 방에서 이미 남겼나 */
        volatile boolean blockLogged = false;

        Session(RoomRef ref) { this.ref = ref; this.room = ref.name; }
    }

    /** 키는 {@code RoomRef.key()} — 동명 대화방이 계정별로 공존한다 */
    private static final ConcurrentHashMap<String, Session> SESSIONS =
            new ConcurrentHashMap<String, Session>();

    /** 감지된 방 한 건 (화면에 뿌리는 값, 불변) */
    public static final class RoomInfo {
        /** 계정 + 방 이름 */
        public final RoomRef ref;
        /** 단체방인가 (false = 1:1) */
        public final boolean group;
        /** 마지막 감지 시각 (epoch ms). 0 이면 구버전 저장값이라 모름 */
        public final long lastAt;

        RoomInfo(RoomRef ref, boolean group, long lastAt) {
            this.ref = ref;
            this.group = group;
            this.lastAt = lastAt;
        }
    }

    /** 방 캐시 내부 레코드 (가변) */
    private static final class Room {
        RoomRef ref;
        boolean group;
        long lastAt;
        /** 디스크에 마지막으로 쓴 감지 시각 (Prefs 쓰기 빈도 제한용) */
        long savedAt;
    }

    /** 같은 방 알림이 쏟아질 때 방 캐시를 다시 쓰는 최소 간격 (ms) */
    private static final long ROOM_SAVE_MS = 60000L;

    /** 최근 감지된 방 (키 = RoomRef.key(), 최신이 뒤). 접근은 전부 synchronized(ROOMS). */
    private static final LinkedHashMap<String, Room> ROOMS = new LinkedHashMap<String, Room>();
    private static volatile boolean roomsLoaded = false;

    /** 마지막으로 본 내 표시이름 (카톡이 알림에 넣어준다) */
    private static volatile String selfName = "";

    /** 계정별 내 표시이름 (계정키 → 카톡 프로필 이름) */
    private static final ConcurrentHashMap<String, String> SELF =
            new ConcurrentHashMap<String, String>();

    /**
     * 알림이 알려준 이 폰 카카오톡의 표시 이름. 계정키 → 이름.
     * 등록 계정·상시 발송과는 따로 둔다. 이름이 없으면 넣지 않는다.
     */
    private static final String K_PHONE = "K_PHONE_KAKAO";
    private static final String K_PHONE_REPLY = "K_PHONE_REPLY";
    private static final LinkedHashMap<String, String> PHONE = new LinkedHashMap<String, String>();
    private static boolean phoneLoaded = false;
    /** 알림이 가장 최근에 알려준 계정. 알림 답장은 이 계정으로 나간다. */
    private static String replyAcc = "";
    private static volatile KakaoListener LIVE;

    /**
     * 감지된 방. 답장 액션이 없어도 올린다. LOCO 방 목록과 따로 둔다.
     * 채팅 목록에서만 보고 계정을 못 가르면 계정키는 {@link #LIST_ACC} 다.
     */
    public static final String LIST_ACC = "list";
    private static final String K_NOTIFY_ROOMS = "K_NOTIFY_ROOMS";
    private static final LinkedHashMap<String, NRoom> NOTIFY = new LinkedHashMap<String, NRoom>();
    private static boolean notifyLoaded = false;

    private static final class NRoom {
        RoomRef ref;
        boolean group;
        String listKind = RoomKind.NORMAL;
        /** 알림이나 목록이 종류를 알려줬다. 아니면 일반 채팅방으로 두되 화면에는 미확인이라고 적는다. */
        boolean kindKnown;
        /** 채팅 목록에서 읽은 방. 알림으로 다시 보면 거짓이 된다. */
        boolean fromList;
        long lastAt;
    }

    /** 보낼 방에 뿌리는 감지 방. 답장 가능 여부는 지금 세션으로 계산한다. */
    public static final class NotifyRoom {
        public final RoomRef ref;
        public final boolean group;
        public final String listKind;
        public final long lastAt;
        public final boolean replyable;
        public final boolean kindKnown;
        public final boolean fromList;

        NotifyRoom(RoomRef ref, boolean group, String listKind, long lastAt, boolean replyable,
                   boolean kindKnown, boolean fromList) {
            this.ref = ref;
            this.group = group;
            this.listKind = listKind == null ? RoomKind.NORMAL : listKind;
            this.lastAt = lastAt;
            this.replyable = replyable;
            this.kindKnown = kindKnown;
            this.fromList = fromList;
        }
    }

    /** 리스너가 시스템에 붙어 있는지 (메모리 플래그 — 프로세스 죽으면 false 로 돌아간다) */
    private static volatile boolean bound = false;

    /** Context 를 안 넘겨주는 호출자(knownRooms() 등)를 위한 보관용 */
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
            android.util.Log.w("KakaoAuto", "지연 실행에 실패하여 즉시 실행합니다", t);
            try { r.run(); } catch (Throwable ignore) { /* 아래 로그는 호출자가 남긴다 */ }
        }
    }

    // ── 서비스 수명주기 ───────────────────────────────────────────────────────

    @Override
    public void onCreate() {
        super.onCreate();
        LIVE = this;
        APP = getApplicationContext();
        loadRooms(APP);
    }

    @Override
    public void onDestroy() {
        if (LIVE == this) LIVE = null;
        super.onDestroy();
    }

    @Override
    public void onListenerConnected() {
        super.onListenerConnected();
        bound = true;
        APP = getApplicationContext();
        loadRooms(APP);
        noteActivePhones();
        Log.add(APP, "알림 접근 권한이 연결되었습니다. 카카오톡 알림 감지를 시작합니다.");
    }

    @Override
    public void onListenerDisconnected() {
        bound = false;
        Log.add(APP, "알림 접근 권한이 해제되었습니다. 발송이 불가하며, 설정에서 재허용이 필요합니다.");
        super.onListenerDisconnected();
    }

    @Override
    public void onNotificationPosted(StatusBarNotification sbn) {
        try {
            handle(sbn, shortcutLabel(sbn));
        } catch (Throwable t) {
            Log.add(ctxOrApp(), "알림 처리 중 오류가 발생했습니다: " + t);
        }
    }

    /**
     * 대화 바로가기(conversation shortcut)에 붙은 라벨 = 카톡이 등록한 **방 이름**.
     * 단체방 알림에서 conversationTitle 이 비어 있을 때 이게 제일 정확하다
     * (title 은 방 이름이 아니라 "마지막으로 말한 사람" 인 경우가 많다 → 방 목록에 멤버 이름이 뜬다).
     * API 30 미만이거나 못 읽으면 빈 문자열.
     */
    private String shortcutLabel(StatusBarNotification sbn) {
        if (sbn == null || Build.VERSION.SDK_INT < 30) return "";
        try {
            NotificationListenerService.RankingMap rm = getCurrentRanking();
            if (rm == null) return "";
            NotificationListenerService.Ranking r = new NotificationListenerService.Ranking();
            if (!rm.getRanking(sbn.getKey(), r)) return "";
            android.content.pm.ShortcutInfo si = r.getConversationShortcutInfo();
            if (si == null) return "";
            CharSequence cs = si.getLongLabel();
            if (cs == null || cs.length() == 0) cs = si.getShortLabel();
            return (cs == null) ? "" : cs.toString().trim();
        } catch (Throwable ignore) {
            return "";   // 기종/버전에 따라 없을 수 있다. 없으면 다음 폴백으로 간다.
        }
    }

    /** 앱 컨텍스트. getApplicationContext() 가 아직 null 이어도 죽지 않게 감싼다. */
    private Context ctxOrApp() {
        try {
            Context c = getApplicationContext();
            if (c != null) return c;
        } catch (Throwable ignore) { /* 아래 폴백으로 간다 */ }
        return appContext();
    }

    // ── 알림 처리 ─────────────────────────────────────────────────────────────

    private void handle(StatusBarNotification sbn, String shortcutLabel) {
        if (sbn == null) return;
        if (!KAKAO.equals(sbn.getPackageName())) return;

        final Notification n = sbn.getNotification();
        if (n == null) return;

        // 카톡 상주 알림 / 묶음 요약 알림은 대화가 아니다
        if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) return;
        if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) return;

        final Bundle ex = n.extras;
        if (ex == null) return;

        // 어느 카톡 계정에서 온 알림인가 (듀얼 메신저면 프로필마다 UserHandle 이 다르다)
        final String acc = Accounts.keyOf(sbn);

        final Msg m = parse(ex, sbn.getPostTime(), shortcutLabel, acc);
        if (m == null) return;
        final Context seen = ctxOrApp();
        notePhone(seen, m.acc, m.selfName);
        if (m.room.length() == 0) return;

        // 세션 갱신 (여기까지는 아주 싸다 — 메인 스레드에서 해도 된다)
        final String skey = m.ref.key();
        Session s = SESSIONS.get(skey);
        if (s == null) {
            Session fresh = new Session(m.ref);
            Session prev = SESSIONS.putIfAbsent(skey, fresh);
            s = (prev != null) ? prev : fresh;
            if (SESSIONS.size() > MAX_SESSIONS) trimSessions(skey);
        }

        Reply r = findReply(n);
        if (r != null) {
            s.pending = r.pending;
            s.inputs = r.inputs;
            s.dataTypes = r.dataTypes;
            // 사진을 알림 답장으로 보낼 수 있나 — 이 앱이 살아있는 동안 딱 한 번만 알려준다
            probeImageOnce(ctxOrApp(), r.dataTypes);
        }
        if (m.text.length() == 0) {
            if (m.roomTrusted) {
                post(new Runnable() {
                    @Override public void run() {
                        noteNotifyRoom(seen, m, n);
                        remember(seen, m.ref, m.group, m.at);
                    }
                }, 0);
            }
            return;
        }
        // 대화방 열기 인텐트. 새 알림에 없으면 이전에 받아둔 것을 그대로 둔다 —
        // 쓸 수 있는 인텐트를 null 로 덮는 건 손실뿐이다.
        try {
            PendingIntent ci = n.contentIntent;
            if (ci != null) s.open = ci;
        } catch (Throwable ignore) { }
        s.lastAt = m.at;

        // ── 그룹 판정을 세션에 반영한다 (약한 근거로 강한 근거를 덮지 않는다) ──
        // 이번 알림의 근거가 세션에 남은 근거보다 세거나 같으면 그대로 갱신한다.
        // 더 약하면: 세션이 "단체방" 을 기억하고 있을 때 그 기억을 이긴다(애매하면 그룹).
        if (m.groupRank >= s.groupRank) {
            s.group = m.group;
            s.groupRank = m.groupRank;
        } else if (s.group) {
            m.group = true;
            m.why = m.why + "→세션기억(단체방)";
        }
        // (세션이 확실한 1:1 인데 이번 근거가 약하게 '그룹' 이라고 하면 m.group 은 그대로 둔다.
        //  이 한 건만 조심하고, 세션 판정을 오염시키지는 않는다.)

        s.lastSender = m.sender;

        // 이 방에서 본 발신자를 기억해둔다 — 다음 알림의 "이름 : 내용" 접두사 판정 근거다
        Iterator<String> seenIt = m.seenSenders.iterator();
        while (seenIt.hasNext()) rememberSender(s, seenIt.next());

        // 내가 방금 보낸 문장이 알림으로 되돌아온 경우도 내 메시지로 본다.
        // 단체방은 "내이름 : 보낸문장" 으로 되돌아오니까 접두사를 뗀 본문으로도 비교한다.
        // (시각은 절대값으로 본다 — 알림의 time 이 내 발송 시각보다 앞서는 기기가 있다)
        if (!m.fromMe && s.lastSentText.length() > 0 && s.lastMine > 0
                && Math.abs(m.at - s.lastMine) < ECHO_MS
                && (s.lastSentText.equals(m.text) || s.lastSentText.equals(m.body))) {
            m.fromMe = true;
        }

        // 같은 알림 갱신(읽음 처리·요약 재게시 등)은 한 번만 처리한다
        boolean dup = m.key.equals(s.lastKey) && (m.at - s.lastKeyAt) < DEDUP_MS;
        s.lastKey = m.key;
        s.lastKeyAt = m.at;
        if (dup) return;

        if (!m.fromMe) s.othersSinceMine = s.othersSinceMine + 1;

        final Context ctx = ctxOrApp();
        // 무거운 건 전부 BG 로. 방 등록은 답장 액션이 없어도 한다.
        post(new Runnable() {
            @Override public void run() {
                if (m.roomTrusted) {
                    noteNotifyRoom(ctx, m, n);
                    remember(ctx, m.ref, m.group, m.at);
                } else if (m.room.length() > 0) {
                    roomSrcWarn(ctx, m);
                }
                dispatch(ctx, m);
            }
        }, 0);
    }

    /** 트리거 / 자동응답 / 봇으로 넘긴다. BG 스레드에서만 호출된다. */
    private static void dispatch(Context ctx, Msg m) {
        // 수신·발송·계정 자동 연결은 등록된 카카오 계정의 LOCO 세션만 쓴다.
        // 알림으로 계정을 만들거나 기능을 돌리지 않는다.
    }

    // ── 파싱 ──────────────────────────────────────────────────────────────────

    /** 알림 하나에서 뽑아낸 한 건의 메시지 */
    private static final class Msg {
        /** 이 알림이 온 카톡 계정키 */
        String acc = RoomRef.DEFAULT_ACC;
        /** 계정 + 방 이름. 세션 맵·방 캐시의 키가 여기서 나온다 (parse 끝에서 확정) */
        RoomRef ref = RoomRef.of(RoomRef.DEFAULT_ACC, "");
        /** 이 계정의 내 카톡 프로필 이름 (못 읽으면 "") */
        String selfName = "";
        String room = "";
        String sender = "";
        String text = "";
        /** 본문에서 "발신자 : " 접두사를 뗀 알맹이 (메아리 판정용). 접두사가 없으면 text 와 같다. */
        String body = "";
        /**
         * 이 알림에서 카톡이 실제로 알려준 발신자 이름들 (나 제외, 폴백 전).
         * 방별 "아는 발신자" 목록에 쌓아서 다음 알림의 namePrefix 판정에 쓴다.
         */
        final LinkedHashSet<String> seenSenders = new LinkedHashSet<String>();
        boolean group = false;
        /** group 을 정한 근거의 세기 (RANK_*) */
        int groupRank = RANK_NONE;
        /** 방 이름을 어디서 읽었나 (로그용): conversationTitle / 대화 바로가기 / subText / title … */
        String roomSrc = "";
        /**
         * 방 이름을 믿을 수 있나. 단체방인데 title 밖에 없으면 그건 방 이름이 아니라
         * "마지막으로 말한 사람" 일 가능성이 높다 → 방 목록에 넣지 않는다.
         */
        boolean roomTrusted = false;
        /** 판정 근거 한 줄 설명 (로그용) */
        String why = "";
        /**
         * 본문 앞이 이름처럼 생겼는데 "아는 이름" 은 아니었다 (그래서 그룹 판정엔 안 썼다).
         * 구버전 카톡 단체방 알림이 이 모양이라, 근거가 약할 때는 이 한 건만 자동응답을 보류한다.
         * 세션 판정은 건드리지 않는다 — 그래야 1:1 이 영구히 죽지 않는다.
         */
        String oddPrefix = "";
        boolean fromMe = false;
        long at = 0L;
        String key = "";
    }

    /**
     * 알림 extras 한 덩어리를 메시지 한 건으로 만든다.
     *
     * 신호 우선순위는 하나뿐이고 아래 if 사슬 순서가 곧 그 우선순위다:
     *   (1) extras 의 android.isGroupConversation — <b>containsKey 로 있는지 확인</b>해야
     *       '없음' 과 'false' 가 구분된다. 있으면 이 값이 최우선이다.
     *   (2) android.messages 의 서로 다른 발신자 수 (나 제외 2명 이상 → 단체방)
     *   (3) android.messages 에 나 말고 한 명뿐 → 방 이름 == 그 사람이면 1:1
     *   (4) conversationTitle(방) ≠ title(발신자) → 단체방
     *   (5) 조여진 본문 접두 이름 (제일 약한 신호, {@link #knownName} 을 통과해야 쓴다)
     * 신호가 모두 1:1 을 가리키면 자동응답이 실제로 나가야 한다 —
     * 그래서 {@link #safeForAutoReply} 의 모양 검사는 근거가 약할 때만 적용한다.
     *
     * 순서가 중요하다 (결함 10): **그룹 판정을 먼저 확정하고 그 다음에 sender 폴백을 적용한다.**
     * 예전에는 sender 가 비었을 때 방 이름을 먼저 집어넣어서, 뒤따르는 구버전 보정이
     * `방이름 != 발신자` 를 검사할 때 이미 둘이 같아져 있었다 → 단체방이 영원히 1:1 로 잡혔고
     * 오픈프로필 자동응답이 단체방에 나갔다.
     */
    private static Msg parse(Bundle ex, long postTime, String shortcutLabel, String acc) {
        Msg m = new Msg();
        m.acc = (acc == null || acc.trim().length() == 0) ? RoomRef.DEFAULT_ACC : acc.trim();
        m.at = (postTime > 0) ? postTime : System.currentTimeMillis();

        String title = getCs(ex, Notification.EXTRA_TITLE);
        String convo = getCs(ex, Notification.EXTRA_CONVERSATION_TITLE);

        // ── 방 이름 해석 ────────────────────────────────────────────────
        // 카톡 단체방 알림은 title 에 **방 이름이 아니라 마지막으로 말한 사람**을 넣는 경우가 많다.
        // 그래서 title 을 바로 방 이름으로 쓰면 방 목록에 멤버 이름이 뜬다.
        // 방 이름이라고 믿을 수 있는 출처를 순서대로 뒤진다.
        String roomSrc = "";
        if (convo.length() > 0) { m.room = convo; roomSrc = "conversationTitle"; }
        if (m.room.length() == 0) {
            String hidden = getCs(ex, "android.hiddenConversationTitle");
            if (hidden.length() > 0) { m.room = hidden; roomSrc = "hiddenConversationTitle"; }
        }
        if (m.room.length() == 0 && shortcutLabel != null && shortcutLabel.trim().length() > 0) {
            m.room = shortcutLabel.trim(); roomSrc = "대화 바로가기";
        }
        if (m.room.length() == 0) {
            // subText/summaryText 에 방 이름을 넣는 카톡 버전이 있다. 발신자와 같으면 방 이름이 아니다.
            String sub = getCs(ex, Notification.EXTRA_SUB_TEXT);
            if (sub.length() == 0) sub = getCs(ex, Notification.EXTRA_SUMMARY_TEXT);
            if (sub.length() > 0 && !sub.equals(title)) { m.room = sub; roomSrc = "subText"; }
        }
        if (m.room.length() == 0) { m.room = title; roomSrc = "title"; }
        // 믿을 수 있는 출처에서 나왔나. title 폴백은 1:1 일 때만 믿는다
        // (1:1 은 방 == 상대방이라 title 이 곧 방 이름이 맞다). 단체방에서 title 만 있으면
        // 그건 십중팔구 멤버 이름이라 **방 목록에 넣지 않는다** — 아래 handle() 에서 거른다.
        m.roomSrc = roomSrc;
        m.roomTrusted = !"title".equals(roomSrc);

        // 내 표시이름 (내 메시지 판정에 쓴다). 같은 안드로이드 사용자 안의 카카오 프로필은
        // 이름이 다르면 계정키를 나눈다. 한 바구니에 합치지 않기 위해서다.
        String me = selfFrom(ex);
        m.acc = accountKey(m.acc, me);
        if (me.length() > 0) {
            selfName = me;
            SELF.put(m.acc, me);
        }
        m.selfName = me;

        // android.messages: 마지막 본문 + 서로 다른 발신자 수 (둘 다 그룹 판정 재료다).
        // 발신자 수는 "나를 뺀" 사람 수다 — 내 이름까지 세면 1:1 도 2명으로 잡힌다.
        String myName = (me.length() > 0) ? me : selfName(m.acc);
        Bundle[] msgs = messages(ex);
        LinkedHashSet<String> others = senderNames(msgs, myName);
        int senders = others.size();
        // 나 말고 딱 한 명만 말했을 때 그 사람 이름 (1:1 판정에 쓴다)
        String soleOther = only(others);
        Bundle last = lastMessage(msgs);
        String rawSender = "";
        if (last != null) {
            m.text = getCs(last, "text");
            rawSender = personName(getParcel(last, "sender_person"));
            if (rawSender.length() == 0) rawSender = getCs(last, "sender");
            long t = 0L;
            try { t = last.getLong("time", 0L); } catch (Throwable ignore) { t = 0L; }
            if (t > 0) m.at = t;
        }
        if (m.text.length() == 0) m.text = getCs(ex, Notification.EXTRA_TEXT);

        // 카톡이 이름을 알려준 발신자만 모은다 (폴백으로 만든 이름은 넣지 않는다 — 오염된다)
        m.seenSenders.addAll(others);
        if (rawSender.trim().length() > 0) m.seenSenders.add(rawSender.trim());

        // 카톡 단체방 알림(MessagingStyle 이 아닌 구버전)은 본문을 "발신자 : 내용" 으로 준다.
        // 알맹이(body)는 메아리 판정에만 쓰니까 "이름처럼 생겼으면" 떼고,
        // 그룹 판정에 쓰는 prefixName 은 한 단계 더 조여서 "아는 이름" 일 때만 인정한다.
        String headName = nameLike(m.text);
        int cut = m.text.indexOf(" : ");
        m.body = (headName.length() > 0 && cut > 0) ? m.text.substring(cut + 3).trim() : m.text;
        // "아는 발신자" 조회는 계정까지 맞춰야 한다 — 같은 이름 방이 두 계정에 있을 수 있다
        String skey = RoomRef.of(m.acc, m.room).key();
        String prefixName = knownName(headName, title, convo, skey);
        if (headName.length() > 0 && prefixName.length() == 0) m.oddPrefix = headName;

        // ── 그룹 판정 (sender 폴백보다 먼저!) ─────────────────────────────────
        if (has(ex, Notification.EXTRA_IS_GROUP_CONVERSATION)) {
            // (1) 카톡이 직접 알려준 값이 제일 정확하다.
            //     containsKey 로 확인해야 '없음' 과 'false' 가 구분된다 — 이게 핵심이다.
            m.group = getBool(ex, Notification.EXTRA_IS_GROUP_CONVERSATION);
            m.groupRank = RANK_EXTRA;
            m.why = "isGroupConversation=" + m.group;
            // 카톡이 false 라고 했는데 같은 알림에 발신자가 2명 이상이면 그건 단체방이다.
            // 서로 어긋날 때는 그룹 쪽으로 기운다 (단체방 오발송이 훨씬 큰 사고다).
            if (!m.group && senders >= 2) {
                m.group = true;
                m.why = m.why + "지만 발신자 " + senders + "명 → 단체방";
            }
        } else if (senders >= 2) {
            // (2) 한 알림에 서로 다른 발신자가 2명 이상 = 단체방
            m.group = true;
            m.groupRank = RANK_MESSAGES;
            m.why = "messages 발신자 " + senders + "명";
        } else if (soleOther.length() > 0) {
            // (3) SPEC 8.4 휴리스틱: 나 말고 발신자 1명이고 방 이름 == 그 사람 이름이면 1:1,
            //     다르면 단체방. (내가 마지막으로 말한 경우에도 상대 이름으로 판정해야 맞다)
            m.group = !m.room.equals(soleOther);
            m.groupRank = RANK_MESSAGES;
            m.why = m.group ? "대화방 이름≠발신자(messages)" : "대화방 이름=발신자(messages)";
        } else if (convo.length() > 0 && title.length() > 0 && !convo.equals(title)) {
            // (4) conversationTitle(방)과 title(발신자)이 다르면 단체방
            m.group = true;
            m.groupRank = RANK_TITLE;
            m.why = "conversationTitle≠title";
        } else if (prefixName.length() > 0 && !prefixName.equals(m.room)) {
            // (5) 마지막 신호 — 본문이 "아는 다른 이름 : …" 이면 단체방.
            //     namePrefix 를 조여놨으니 "시간 : 3시" 같은 1:1 본문은 여기 안 걸린다.
            m.group = true;
            m.groupRank = RANK_HEURISTIC;
            m.why = "본문 접두 발신자(" + prefixName + ")≠대화방 이름";
        } else {
            // (6) 근거가 하나도 없다 → 1:1 로 추정하되 근거 세기는 0 이다.
            //     같은 방에서 전에 단체방 근거를 본 적이 있으면 handle() 이 그룹으로 되돌린다.
            m.group = false;
            m.groupRank = RANK_NONE;
            m.why = "근거없음→1:1추정";
        }

        // ── 그룹 판정이 끝난 뒤에 sender 폴백 ────────────────────────────────
        m.sender = rawSender;
        if (m.sender.length() == 0) m.sender = prefixName;
        // 1:1 은 방 이름 = 상대 이름. 단체방은 발신자를 모르면 빈 값으로 둔다
        // (방 이름을 발신자로 쓰면 {이름} 치환에 방 이름이 들어가고 판정도 또 망가진다).
        if (m.sender.length() == 0 && !m.group) m.sender = m.room;

        // 내 메시지인가: 발신자 == 내 표시이름, 또는 내 답장 이력에 같은 문장이 있음
        if (m.sender.length() > 0 && me.length() > 0 && m.sender.equals(me)) m.fromMe = true;
        if (!m.fromMe && (inReplyHistory(ex, m.text) || inReplyHistory(ex, m.body))) m.fromMe = true;

        // 1:1 이면 방 == 상대방이라 title 이 곧 방 이름이다 → 믿어도 된다.
        // 단체방인데 출처가 title 뿐이면 못 믿는다 (멤버 이름일 가능성이 높다).
        if (!m.group) m.roomTrusted = true;

        m.room = m.room.trim();
        m.sender = m.sender.trim();
        m.ref = RoomRef.of(m.acc, m.room);
        m.key = m.at + "|" + m.sender + "|" + m.text;
        return m;
    }

    /**
     * "홍길동 : 안녕하세요" 의 앞부분이 <b>이름처럼 생겼으면</b> 그 이름, 아니면 "".
     * 구분자는 " : " 만 인정한다(카톡 단체방 알림이 쓰는 형태고, 이름에는 콜론을 못 쓴다).
     *
     * 여기까지는 "모양 검사" 뿐이다 — 메아리 판정용으로 본문 접두사를 뗄 때 쓴다.
     * 그룹/1:1 판정에 쓰려면 {@link #knownName} 을 한 번 더 통과해야 한다.
     */
    private static String nameLike(String text) {
        if (text == null || text.length() == 0) return "";
        int nl = text.indexOf('\n');
        String head = (nl >= 0) ? text.substring(0, nl) : text;
        int i = head.indexOf(" : ");
        if (i <= 0) return "";
        if (text.length() <= i + 3) return "";          // 알맹이가 남아야 접두사로 인정한다
        String name = head.substring(0, i).trim();
        return looksLikeName(name) ? name : "";
    }

    /**
     * 이름처럼 생겼나. 여기가 조여지기 전에는 " : " 만 있으면 앞부분을 전부 발신자로 인정했고,
     * 그래서 1:1 상대가 "시간 : 3시" / "주소 : 서울" 이라고 보내면 단체방으로 오판돼서
     * 오픈프로필 자동응답이 그 방에서 영구히 죽었다.
     *
     * 규칙:
     *   - 길이 1~{@link #NAME_MAX}자
     *   - 숫자나 {@link #NAME_BAD_CHARS} 의 특수문자가 섞이면 이름이 아니다
     *   - 내부 공백은 최대 1개 (이름에 문장이 들어오는 걸 막는다)
     *   - {@link #LABEL_WORDS} 의 흔한 라벨 단어는 이름으로 보지 않는다
     */
    private static boolean looksLikeName(String name) {
        if (name == null) return false;
        int n = name.length();
        if (n == 0 || n > NAME_MAX) return false;

        int spaces = 0;
        for (int i = 0; i < n; i++) {
            char ch = name.charAt(i);
            if (ch == ' ') { spaces++; continue; }
            if (Character.isWhitespace(ch)) return false;       // 줄바꿈·탭은 이름이 아니다
            if (ch >= '0' && ch <= '9') return false;           // 숫자가 섞이면 이름이 아니다
            if (Character.isDigit(ch)) return false;            // 전각 숫자 등
            if (NAME_BAD_CHARS.indexOf(ch) >= 0) return false;  // 특수문자가 섞이면 이름이 아니다
        }
        if (spaces > 1) return false;

        for (int i = 0; i < LABEL_WORDS.length; i++) {
            if (name.equals(LABEL_WORDS[i])) return false;
        }
        return true;
    }

    /**
     * 모양이 이름 같아도 <b>아는 이름</b>일 때만 발신자로 인정한다.
     * 아는 이름 = 알림 title 또는 conversationTitle 과 같거나, 그 방에서 최근에 본 발신자.
     * (그래야 "사과 : 맛있어" 같은 평범한 1:1 문장이 단체방 근거로 쓰이지 않는다)
     */
    private static String knownName(String name, String title, String convo, String sessionKey) {
        if (name == null || name.length() == 0) return "";
        if (title != null && name.equals(title.trim())) return name;
        if (convo != null && name.equals(convo.trim())) return name;
        return seenSender(sessionKey, name) ? name : "";
    }

    /** 그 방에서 최근에 카톡이 알려준 발신자인가 (sessionKey = RoomRef.key()) */
    private static boolean seenSender(String sessionKey, String name) {
        if (sessionKey == null || sessionKey.length() == 0
                || name == null || name.length() == 0) return false;
        Session s = SESSIONS.get(sessionKey);
        if (s == null) return false;
        synchronized (s.recentSenders) {
            return s.recentSenders.contains(name);
        }
    }

    /** 방별 "아는 발신자" 목록에 넣는다 (최근 MAX_SENDERS 명만 들고 있는다) */
    private static void rememberSender(Session s, String name) {
        if (s == null || name == null || name.length() == 0) return;
        synchronized (s.recentSenders) {
            s.recentSenders.remove(name);       // 다시 넣어서 최신으로 올린다
            s.recentSenders.add(name);
            while (s.recentSenders.size() > MAX_SENDERS) {
                Iterator<String> it = s.recentSenders.iterator();
                if (!it.hasNext()) break;
                it.next();
                it.remove();
            }
        }
    }

    /** android.messages 배열을 Bundle 목록으로 (없으면 null) */
    private static Bundle[] messages(Bundle ex) {
        try {
            Parcelable[] arr = ex.getParcelableArray(Notification.EXTRA_MESSAGES);
            if (arr == null || arr.length == 0) return null;
            ArrayList<Bundle> out = new ArrayList<Bundle>(arr.length);
            for (int i = 0; i < arr.length; i++) {
                if (arr[i] instanceof Bundle) out.add((Bundle) arr[i]);
            }
            if (out.isEmpty()) return null;
            return out.toArray(new Bundle[out.size()]);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "android.messages 파싱 실패", t);
            return null;
        }
    }

    /**
     * 그 알림에 담긴 서로 다른 발신자 수. 2명 이상이면 단체방이다.
     * 빈 이름(MessagingStyle 에서 sender 가 null 이면 '나')과 내 이름은 세지 않는다.
     */
    private static LinkedHashSet<String> senderNames(Bundle[] msgs, String myName) {
        LinkedHashSet<String> names = new LinkedHashSet<String>();
        if (msgs == null) return names;
        String mine = (myName == null) ? "" : myName.trim();
        for (int i = 0; i < msgs.length; i++) {
            if (msgs[i] == null) continue;
            String s = personName(getParcel(msgs[i], "sender_person"));
            if (s.length() == 0) s = getCs(msgs[i], "sender");
            if (s.length() == 0) continue;
            if (mine.length() > 0 && s.equals(mine)) continue;
            names.add(s);
        }
        return names;
    }

    /** 집합에 딱 한 명만 있으면 그 이름, 아니면 "" */
    private static String only(LinkedHashSet<String> names) {
        if (names == null || names.size() != 1) return "";
        Iterator<String> it = names.iterator();
        return it.hasNext() ? it.next() : "";
    }

    /** 본문이 들어있는 마지막 항목 */
    private static Bundle lastMessage(Bundle[] msgs) {
        if (msgs == null) return null;
        for (int i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i] == null) continue;
            if (getCs(msgs[i], "text").length() > 0) return msgs[i];
        }
        return null;
    }

    // Bundle 은 다른 앱이 만든 물건이라 언제든 읽다가 터질 수 있다 (BadParcelableException 등).
    // 알림 한 건 때문에 리스너가 죽으면 그 뒤 모든 발송이 멈추니까 전부 감싸서 읽는다.

    private static boolean has(Bundle b, String key) {
        if (b == null) return false;
        try { return b.containsKey(key); } catch (Throwable t) { return false; }
    }

    private static boolean getBool(Bundle b, String key) {
        if (b == null) return false;
        try { return b.getBoolean(key, false); } catch (Throwable t) { return false; }
    }

    private static String getCs(Bundle b, String key) {
        if (b == null) return "";
        try { return cs(b.getCharSequence(key)); } catch (Throwable t) { return ""; }
    }

    private static Parcelable getParcel(Bundle b, String key) {
        if (b == null) return null;
        try { return b.getParcelable(key); } catch (Throwable t) { return null; }
    }

    // ── 판정 근거 로그 (처음 몇 번만) ─────────────────────────────────────────

    /**
     * 그룹/1:1 판정 근거를 남긴다. 알림마다 찍으면 로그 링버퍼(200줄)가 쓸려나가니까
     * <b>방마다 처음 1회만</b> 남긴다 — 사용자가 오작동을 신고할 때 그 방의 근거만 있으면 충분하다.
     */
    private static void whyLog(Context ctx, Msg m) {
        Session s = SESSIONS.get(m.ref.key());
        if (s != null) {
            if (s.whyLogged) return;
            s.whyLogged = true;
        }
        Log.add(ctx, "대화방 판정: 「" + m.ref.label(ctx) + "」 " + (m.group ? "단체방" : "1:1")
                + " (근거: " + m.why + " / 발신자: "
                + (m.sender.length() == 0 ? "확인 불가" : m.sender) + ")");
    }

    /** 자동응답 방어선이 막았을 때 (드물고 중요한 일이라 남기되, 방마다 처음 1회만) */
    private static void blockLog(Context ctx, RoomRef ref, String why) {
        Session s = SESSIONS.get(ref.key());
        if (s != null) {
            if (s.blockLogged) return;
            s.blockLogged = true;
        }
        Log.add(ctx, "자동응답 보류: 「" + ref.label(ctx) + "」 " + why
                + " 단체방 오발송을 차단했습니다.");
    }

    /**
     * 자동응답 직전 마지막 방어선. dispatch() 에서 group==false 를 한 번 더 확인하는 자리다.
     * 단체방에 자동응답이 나가면 도배로 강퇴당한다 — 1:1 에 안 나가는 것보다 훨씬 큰 사고라서
     * 조금이라도 수상하면 보내지 않는다.
     */
    private static boolean safeForAutoReply(Context ctx, Msg m) {
        if (m.group) return false;
        Session s = SESSIONS.get(m.ref.key());
        if (s != null && s.group) {
            blockLog(ctx, m.ref, "해당 대화방이 단체방으로 기록되어 있습니다.");
            return false;
        }
        // 카톡이 직접 알려줬거나(isGroupConversation=false) android.messages 로 1:1 이 확정된 방은
        // 여기서 더 막지 않는다. 예전엔 방 이름 == 발신자 검사를 무조건 걸어서,
        // 상대 닉네임과 방 이름이 다른 평범한 1:1 에도 자동응답이 안 나갔다.
        if (m.groupRank >= RANK_MESSAGES) return true;

        // ── 여기부터는 근거가 약한 알림이다. 자동응답은 "확실한 1:1" 에만 보낸다. ──
        //
        // 왜 이렇게 빡세게 막나:
        //   구버전 카톡 단체방 알림은 android.messages 도 isGroupConversation 도 없이
        //   본문만 "발신자 : 내용" 으로 온다. 그 발신자 닉네임에 숫자가 섞여 있거나
        //   길면(예: "민수123", "행복한하루보내세요") 이름으로 인정되지 않아서
        //   prefixName·oddPrefix 가 둘 다 비고, sender 는 방 이름으로 폴백된다.
        //   그러면 아래 모양 검사(sender==room)를 통과해 **단체방에 자동응답이 나간다.**
        //   단체방 도배는 강퇴 사유라서, 1:1 에 안 나가는 것보다 훨씬 큰 사고다.
        //
        // 그래서 근거가 RANK_MESSAGES 미만이면 무조건 보류한다.
        // 요즘 카톡은 MessagingStyle(android.messages)과 isGroupConversation 을 둘 다 넣어주므로
        // 실제 사용자는 위 return true 로 빠지고, 여기까지 오는 건 아주 오래된 카톡뿐이다.
        blockLog(ctx, m.ref,
                "1:1 여부를 확정할 수 없습니다. 카카오톡 알림에 대화 정보가 포함되지 않았습니다. "
                        + "카카오톡을 최신 버전으로 업데이트하십시오.");
        return false;
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
        /** 이 액션의 RemoteInput 들이 받아주는 데이터 타입 합집합 (수정 불가 Set) */
        java.util.Set<String> dataTypes = java.util.Collections.emptySet();
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
            r.dataTypes = collectDataTypes(ris);
            for (int j = 0; j < ris.length; j++) {
                if (ris[j] != null && ris[j].getAllowFreeFormInput()) return r;  // 이게 답장창이다
            }
            if (any == null) any = r;
        }
        return any;
    }

    /** RemoteInput 들이 허용한 데이터 타입을 다 모은다 (없으면 빈 Set) */
    private static java.util.Set<String> collectDataTypes(RemoteInput[] ris) {
        if (ris == null || ris.length == 0) return java.util.Collections.emptySet();
        LinkedHashSet<String> out = new LinkedHashSet<String>();
        for (int i = 0; i < ris.length; i++) {
            if (ris[i] == null) continue;
            java.util.Set<String> t;
            try {
                t = ris[i].getAllowedDataTypes();
            } catch (Throwable ignore) {
                continue;   // 기종에 따라 없을 수 있다. 없으면 없는 거다.
            }
            if (t == null || t.isEmpty()) continue;
            Iterator<String> it = t.iterator();
            while (it.hasNext()) {
                String s = it.next();
                if (s == null) continue;
                s = s.trim();
                if (s.length() > 0) out.add(s);
            }
        }
        if (out.isEmpty()) return java.util.Collections.emptySet();
        return java.util.Collections.unmodifiableSet(out);
    }

    // ── 알림 답장에 사진 붙이기 (공유창·접근성 없이 보내는 경로) ────────────────
    //
    //  안드로이드는 알림 답장에 이미지를 실어 보내는 공식 경로를 API 26 부터 갖고 있다.
    //  단 **보내는 앱(카톡)이 RemoteInput.Builder.setAllowDataType("image/*", true) 로
    //  허용해둬야만** 된다. 허용 여부는 런타임에 getAllowedDataTypes() 로만 알 수 있다.
    //  되면 화면이 아예 안 움직인다 → 공유창 경로(접근성 조작)를 전부 안 써도 된다.

    /** 이 프로세스에서 사진 첨부 가능 여부를 이미 로그에 남겼나 (0=아직 · 1=가능 · 2=불가) */
    private static volatile int imageProbed = 0;

    /**
     * 카톡 알림에서 답장창을 처음 봤을 때 "사진을 알림 답장으로 보낼 수 있나" 를 딱 한 번 로그에 남긴다.
     * <b>이 한 줄이 다음 방향을 정한다</b> — 사용자가 이걸 보고 알려줘야 우리가 경로를 확정할 수 있다.
     * 판정이 바뀌면(카톡 업데이트 등) 그때 한 번 더 남긴다. 그 외에는 도배하지 않는다.
     */
    private static void probeImageOnce(final Context ctx, final java.util.Set<String> types) {
        final java.util.Set<String> img = imageOnly(types);
        final int want = img.isEmpty() ? 2 : 1;
        if (imageProbed == want) return;
        synchronized (KakaoListener.class) {
            if (imageProbed == want) return;
            imageProbed = want;
        }
        final String raw = (types == null || types.isEmpty())
                ? "(카카오톡이 선언한 데이터 타입 없음)" : types.toString();
        // Log.add 는 Prefs 를 동기로 쓴다 → 알림 콜백(메인 스레드)에서 직접 부르면 안 된다
        post(new Runnable() {
            @Override public void run() {
                if (want == 1) {
                    Log.add(ctx, "카카오톡이 알림 답장 이미지 첨부를 허용합니다. 화면 조작 없이 전송됩니다."
                            + " 허용 타입: " + img);
                } else {
                    Log.add(ctx, "카카오톡이 알림 답장 이미지 첨부를 허용하지 않습니다. "
                            + "공유창을 경유하여 전송되며 전송 중 화면이 전환됩니다."
                            + " 선언된 타입: " + raw);
                }
            }
        }, 0);
    }

    /** 데이터 타입 중 사진에 쓸 수 있는 것만 골라낸다 (image/ 로 시작하는 것과 와일드카드) */
    private static java.util.Set<String> imageOnly(java.util.Set<String> types) {
        if (types == null || types.isEmpty()) return java.util.Collections.emptySet();
        LinkedHashSet<String> out = new LinkedHashSet<String>();
        Iterator<String> it = types.iterator();
        while (it.hasNext()) {
            String s = it.next();
            if (s == null) continue;
            String t = s.trim();
            if (t.length() == 0) continue;
            String low = t.toLowerCase(java.util.Locale.US);
            if (low.equals("*/*") || low.startsWith("image/")) out.add(t);
        }
        if (out.isEmpty()) return java.util.Collections.emptySet();
        return java.util.Collections.unmodifiableSet(out);
    }

    /**
     * 그 방의 알림 답장창이 받아주는 <b>사진</b> MIME 들. 비어 있으면 이 경로로는 못 보낸다.
     * 세션이 죽어 있으면(그 방 알림을 아직 못 봤거나 알림이 치워졌으면) 빈 Set 이다.
     */
    public static java.util.Set<String> imageTypesFor(String room) {
        return imageTypesFor(lookup(room));
    }

    /** 계정까지 지정해서 조회하는 버전 */
    public static java.util.Set<String> imageTypesFor(RoomRef ref) {
        return imageTypesFor(findSession(ref, false));
    }

    private static java.util.Set<String> imageTypesFor(Session s) {
        if (s == null || s.pending == null || s.inputs == null || s.inputs.length == 0) {
            return java.util.Collections.emptySet();
        }
        return imageOnly(s.dataTypes);
    }

    /**
     * 그 대화방을 여는 인텐트(= 카톡 알림의 contentIntent). 없으면 null.
     *
     * 그 방 알림을 한 번이라도 본 뒤에만 생긴다(세션과 수명이 같다 — 프로세스가 죽으면 사라진다).
     * 이름 매칭 없이 대화방으로 직행하는 유일한 수단이지만, <b>이미지 첨부까지는 못 한다</b>:
     * 방이 열린 뒤 사진을 고르는 단계는 카톡 자기 앨범(MediaStore)이라서 우리 URI 를 지목할 수 없다.
     *
     * 쓰는 쪽 주의 —
     *  (1) {@code send()} 는 액티비티를 띄우므로 백그라운드 실행 제한을 받는다. 우리 특권을
     *      전달하려면 API 34 이상에서 {@code ActivityOptions.makeBasic()
     *      .setPendingIntentBackgroundActivityStartMode(MODE_BACKGROUND_ACTIVITY_START_ALLOWED)}
     *      를 같이 넘겨야 한다.
     *  (2) 카톡이 그 알림을 치우면 이 인텐트도 만료된다. 돌려받은 값이 null 이 아니어도
     *      {@code send()} 는 {@link PendingIntent.CanceledException} 을 던질 수 있다.
     *      그때는 만료된 것이니 {@code session(ref).open = null} 로 비우고 다음 알림을 기다린다.
     */
    public static PendingIntent openIntentFor(RoomRef ref) {
        Session s = findSession(ref, false);
        return (s == null) ? null : s.open;
    }

    /** 저장값(방 이름 또는 {@code RoomRef.key()})으로 조회하는 버전 */
    public static PendingIntent openIntentFor(String room) {
        Session s = lookup(room);
        return (s == null) ? null : s.open;
    }

    /** 그 대화방을 여는 인텐트를 갖고 있나 (진단 표시용 — 인텐트를 밖으로 내주지 않는다) */
    public static boolean hasOpenIntent(RoomRef ref) {
        return openIntentFor(ref) != null;
    }

    /** 저장값으로 확인하는 버전 */
    public static boolean hasOpenIntent(String room) {
        return openIntentFor(room) != null;
    }

    /**
     * 그 방의 알림 답장창에 <b>사진 한 장</b>을 실어 보낸다.
     * 공유창도 접근성도 안 쓴다 — 화면이 아예 안 움직인다.
     *
     * {@code Map<String,Uri>} 는 MIME 하나당 URI 하나라서 <b>한 번에 한 장</b>이다.
     * 여러 장은 호출자가 이걸 장수만큼 순서대로 부른다.
     *
     * true 는 "카톡에 넘기는 것까지 성공" 이라는 뜻이다 — 카톡이 실제로 올렸는지는
     * 우리가 확인할 방법이 없다. 그래서 호출자가 어느 경로로 보냈는지 로그에 꼭 남겨야 한다.
     */
    public static boolean sendImageTo(Context ctx, String room, Uri uri) {
        if (ctx != null) {
            Log.add(ctx, "알림 답장으로는 이미지를 보내지 않습니다. 등록한 카카오 계정으로만 발송합니다.");
        }
        return false;
    }

    /** 계정까지 지정해서 보내는 버전 */
    public static boolean sendImageTo(Context ctx, RoomRef ref, Uri uri) {
        if (ctx != null) {
            Log.add(ctx, "알림 답장으로는 이미지를 보내지 않습니다. 등록한 카카오 계정으로만 발송합니다.");
        }
        return false;
    }

    private static boolean sendImageTo(Context ctx, RoomRef ref, Uri uri, Session s) {
        if (ctx == null || ref == null || !ref.valid() || uri == null) return false;
        final String r = ref.label(ctx);

        if (s == null) {
            Log.add(ctx, "이미지 전송 실패: 「" + r + "」 대화방 세션이 없습니다. "
                    + "해당 대화방의 카카오톡 알림이 1회 이상 수신되어야 전송이 가능합니다.");
            return false;
        }
        PendingIntent pi = s.pending;
        RemoteInput[] inputs = s.inputs;
        if (pi == null || inputs == null || inputs.length == 0) {
            Log.add(ctx, "이미지 전송 실패: 「" + r + "」 답장창이 없습니다. "
                    + "카카오톡 알림이 다시 수신되면 복구됩니다.");
            return false;
        }
        if (!bound) {
            Log.add(ctx, "이미지 전송 실패: 「" + r + "」 알림 접근 권한이 비활성 상태입니다. "
                    + "설정에서 권한을 허용하십시오.");
            return false;
        }

        String mime = null;
        try { mime = ctx.getContentResolver().getType(uri); } catch (Throwable ignore) { }
        if (mime == null || mime.trim().length() == 0) mime = "image/jpeg";
        mime = mime.trim();

        // 카톡이 선언한 문자열을 **그대로** 키로 써야 카톡이 찾아낼 수 있다 ("image/*" 선언에
        // "image/jpeg" 키로 넣으면 카톡 쪽 조회가 빗나간다).
        String key = matchType(s.dataTypes, mime);
        RemoteInput target = inputFor(inputs, key);
        if (key == null || target == null) {
            Log.add(ctx, "이미지 전송 실패: 「" + r + "」 카카오톡이 알림 답장에서 해당 이미지 타입("
                    + mime + ")을 허용하지 않습니다.");
            return false;
        }

        try {
            Intent filled = new Intent();
            java.util.HashMap<String, Uri> data = new java.util.HashMap<String, Uri>(2);
            data.put(key, uri);
            RemoteInput.addDataResultToIntent(target, filled, data);

            // addDataResultToIntent 가 ClipData 를 자기 용도로 덮어쓴다 →
            // 글 발송처럼 ClipData 에 URI 를 실어서 권한을 넘기는 방법은 여기서는 못 쓴다.
            // 그래서 카톡에 읽기 권한을 직접 준다. **보낸 뒤 바로 회수하면 안 된다** —
            // 카톡은 업로드할 때(한참 뒤에) 이 URI 를 읽는다.
            try {
                ctx.grantUriPermission(KAKAO, uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (Throwable t) {
                Log.add(ctx, "이미지 읽기 권한을 카카오톡에 부여하지 못했습니다 ("
                        + t.getClass().getSimpleName() + "). 전송은 계속 진행합니다.");
            }
            filled.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            if (Build.VERSION.SDK_INT >= 28) {
                // 카톡이 "사람이 직접 보낸 답장" 으로 인식하게 출처를 붙인다.
                // (addDataResultToIntent 뒤에 불러야 데이터 결과가 안 지워진다)
                RemoteInput.setResultsSource(filled, RemoteInput.SOURCE_FREE_FORM_INPUT);
            }

            pi.send(ctx, 0, filled);

            s.lastMine = System.currentTimeMillis();
            s.othersSinceMine = 0;
            return true;
        } catch (PendingIntent.CanceledException e) {
            // 카톡이 그 알림을 치웠다 → 세션은 죽은 거다. 다음 알림에서 되살아난다.
            s.pending = null;
            s.inputs = null;
            Log.add(ctx, "이미지 전송 실패: 「" + r + "」 답장창이 만료되었습니다. "
                    + "카카오톡 알림이 다시 수신되면 복구됩니다.");
            return false;
        } catch (Throwable t) {
            Log.add(ctx, "이미지 전송 실패: 「" + r + "」 " + t);
            return false;
        }
    }

    /** 카톡이 선언한 타입 중에서 이 사진에 쓸 키를 고른다. 쓸 게 없으면 null. */
    private static String matchType(java.util.Set<String> allowed, String mime) {
        if (allowed == null || allowed.isEmpty() || mime == null) return null;
        String want = mime.trim().toLowerCase(java.util.Locale.US);
        String star = null, anyImage = null, anyAll = null;
        Iterator<String> it = allowed.iterator();
        while (it.hasNext()) {
            String s = it.next();
            if (s == null) continue;
            String t = s.trim();
            if (t.length() == 0) continue;
            String low = t.toLowerCase(java.util.Locale.US);
            if (low.equals(want)) return t;                      // 정확히 일치 — 제일 안전
            if (low.equals("image/*")) star = t;
            else if (low.equals("*/*")) anyAll = t;
            else if (low.startsWith("image/") && anyImage == null) anyImage = t;
        }
        if (star != null) return star;
        if (anyImage != null) return anyImage;   // 타입이 좀 달라도 카톡은 URI 를 읽는다
        return anyAll;
    }

    /** 그 타입을 허용하는 RemoteInput 을 찾는다 (결과 키가 그 안에 있다) */
    private static RemoteInput inputFor(RemoteInput[] inputs, String type) {
        if (inputs == null || type == null) return null;
        for (int i = 0; i < inputs.length; i++) {
            RemoteInput ri = inputs[i];
            if (ri == null) continue;
            String key = ri.getResultKey();
            if (key == null || key.length() == 0) continue;
            java.util.Set<String> t;
            try { t = ri.getAllowedDataTypes(); } catch (Throwable ignore) { continue; }
            if (t == null) continue;
            Iterator<String> it = t.iterator();
            while (it.hasNext()) {
                String s = it.next();
                if (s != null && type.equals(s.trim())) return ri;
            }
        }
        return null;
    }

    // ── 발송 ──────────────────────────────────────────────────────────────────

    /**
     * 그 방의 알림 답장창으로 메시지를 보낸다.
     * 세션이 없으면(= 그 방 카톡 알림을 아직 못 봤으면) 보낼 방법이 없다 → false.
     */
    /**
     * 저장값(방 이름 또는 {@code RoomRef.key()}) 하나로 세션을 찾는다.
     * 계정 구분자가 없는 값은 <b>구버전 저장값</b>이라 계정을 알 수 없다 → 기본 계정에서 못 찾으면
     * 이름이 유일할 때만 다른 계정도 뒤진다. 구분자가 있는 값은 그 계정 안에서만 찾는다.
     */
    private static Session lookup(String stored) {
        if (stored == null) return null;
        boolean legacy = (stored.indexOf(RoomRef.SEP) < 0);
        return findSession(RoomRef.parse(stored), legacy);
    }

    /**
     * 방 세션 찾기. 정확히 일치하는 게 없으면 조금 너그럽게 찾는다 —
     * 사용자가 방 이름을 손으로 입력할 때 공백/대소문자/이모지 정도는 어긋나기 쉽고,
     * 카톡이 방 이름을 안 알려줘서 사용자가 직접 적어 넣은 경우도 있다.
     * 애매하게 여러 개 걸리면 **아무것도 고르지 않는다** (엉뚱한 방에 보내는 게 더 큰 사고다).
     *
     * 너그러운 탐색도 <b>같은 계정 안에서만</b> 한다. 계정이 다르면 아예 다른 카톡이다.
     * crossAcc 는 계정 정보가 없는 구버전 저장값만 쓰는 예외 경로다 (이름이 유일할 때만 인정).
     */
    private static Session findSession(RoomRef ref, boolean crossAcc) {
        if (ref == null || !ref.valid()) return null;

        Session exact = SESSIONS.get(ref.key());
        if (exact != null) return exact;

        String want = normRoom(ref.name);
        if (want.length() == 0) return null;

        Session hit = null;
        // 1차: 같은 계정 + 정규화해서 완전히 같은 이름
        for (Map.Entry<String, Session> e : SESSIONS.entrySet()) {
            Session v = e.getValue();
            if (v == null || !v.ref.acc.equals(ref.acc)) continue;
            if (want.equals(normRoom(v.ref.name))) {
                if (hit != null) return null;      // 둘 이상 → 애매하니 포기
                hit = v;
            }
        }
        if (hit != null) return hit;

        // 2차: 같은 계정 + 한쪽이 다른 쪽을 포함 (방 이름 뒤에 인원수 "(12)" 가 붙는 경우 등)
        for (Map.Entry<String, Session> e : SESSIONS.entrySet()) {
            Session v = e.getValue();
            if (v == null || !v.ref.acc.equals(ref.acc)) continue;
            String have = normRoom(v.ref.name);
            if (have.length() == 0) continue;
            if (have.contains(want) || want.contains(have)) {
                if (hit != null) return null;      // 둘 이상 → 애매하니 포기
                hit = v;
            }
        }
        if (hit != null || !crossAcc) return hit;

        // 3차: 계정 정보가 없는 구버전 저장값 — 이름이 딱 하나 걸릴 때만 그 계정으로 보낸다
        for (Map.Entry<String, Session> e : SESSIONS.entrySet()) {
            Session v = e.getValue();
            if (v == null) continue;
            if (want.equals(normRoom(v.ref.name))) {
                if (hit != null) return null;
                hit = v;
            }
        }
        return hit;
    }

    /**
     * 그 계정이 사용 대상인가. 설정을 못 읽으면(라이선스 미인증 등) 막지 않는다 —
     * 설정을 못 읽는 것과 사용자가 제외한 것은 다르다.
     */
    private static boolean accountAllowed(Context ctx, String acc) {
        if (ctx == null || acc == null) return true;
        try {
            Settings st = Settings.load(ctx);
            return st == null || st.accountOn(acc);
        } catch (Throwable t) {
            return true;
        }
    }

    /** 방 이름 비교용 정규화: 공백 제거 + 소문자 */
    private static String normRoom(String v) {
        if (v == null) return "";
        return v.replaceAll("\\s+", "").toLowerCase(java.util.Locale.KOREA);
    }

    /**
     * 매크로 글만 그 방의 카카오톡 알림 답장에 넣는다.
     * true 는 카카오톡이 답장을 접수했다는 뜻이다. 카카오 메시지 번호가 없으므로 발송 성공이 아니다.
     */
    public static boolean queueReply(Context ctx, RoomRef ref, String text) {
        if (ctx == null) return false;
        if (ref == null || !ref.valid()) {
            Log.add(ctx, "발송 실패: 방이 지정되지 않았습니다. 발송으로 세지 않았습니다.");
            return false;
        }
        if (!isPhoneAccount(ctx, ref.acc) && !accountAllowed(ctx, ref.acc)) {
            Log.add(ctx, "발송 취소: " + ref.label(ctx)
                    + " — 해당 카카오톡 계정이 사용 대상에서 제외되어 있습니다. 발송으로 세지 않았습니다.");
            return false;
        }
        final String r = ref.label(ctx);
        if (text == null || text.trim().length() == 0) {
            Log.add(ctx, "발송 실패: 「" + r + "」 발송할 내용이 비어 있습니다. 발송으로 세지 않았습니다.");
            return false;
        }
        Session s = session(ref);
        if (!live(s) || !bound) {
            Log.add(ctx, "「" + r + "」에 답장할 카카오톡 알림이 없습니다. 발송으로 세지 않았습니다.");
            return false;
        }
        return enqueue(ctx, r, text, s);
    }

    /** 저장값(방 이름 또는 RoomRef.key())으로 보내는 버전. 알림 답장 발송은 매크로 스위치만 쓴다. */
    public static boolean sendTo(Context ctx, String room, String text) {
        if (ctx != null) {
            Log.add(ctx, "알림 답장으로는 보내지 않습니다. 등록한 카카오 계정으로만 발송합니다.");
        }
        return false;
    }

    /**
     * 계정까지 지정해서 그 계정의 세션으로만 보내는 버전.
     *
     * 계정키가 기본값("0")인 참조는 <b>구버전 저장값이거나 아직 계정이 확정되지 않은 값</b>이다.
     * 업데이트 전에는 계정 개념이 없어서 모든 대화방이 이름만으로 저장됐는데, 그 방이 실제로는
     * 부계정(듀얼 메신저) 것일 수 있다. 그런 값을 기본 계정에 못 박으면 발송이 조용히 끊긴다.
     * 그래서 기본 계정 참조는 계정을 가로질러 찾되, 이름이 딱 하나 걸릴 때만 보낸다
     * (여러 계정에 같은 이름이 있으면 findSession 이 null 을 돌려주므로 오발송은 없다).
     */
    public static boolean sendTo(Context ctx, RoomRef ref, String text) {
        if (ctx != null) {
            Log.add(ctx, "알림 답장으로는 보내지 않습니다. 등록한 카카오 계정으로만 발송합니다.");
        }
        return false;
    }

    /** 답장 인텐트만 넣는다. 발송 완료로 적지 않고, 마지막 발송 시각도 올리지 않는다. */
    private static boolean enqueue(Context ctx, String label, String text, Session s) {
        if (s == null || s.pending == null || s.inputs == null || s.inputs.length == 0) {
            Log.add(ctx, "「" + label + "」에 답장할 카카오톡 알림이 없습니다. 발송으로 세지 않았습니다.");
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
                Log.add(ctx, "「" + label + "」 답장 입력란을 찾지 못했습니다. 발송으로 세지 않았습니다.");
                return false;
            }
            RemoteInput.addResultsToIntent(inputs, filled, results);
            if (Build.VERSION.SDK_INT >= 28) {
                RemoteInput.setResultsSource(filled, RemoteInput.SOURCE_FREE_FORM_INPUT);
            }
            pi.send(ctx, 0, filled);
            return true;
        } catch (PendingIntent.CanceledException e) {
            s.pending = null;
            s.inputs = null;
            Log.add(ctx, "「" + label + "」에 답장할 카카오톡 알림이 없습니다. 발송으로 세지 않았습니다.");
            return false;
        } catch (Throwable t) {
            Log.add(ctx, "「" + label + "」 알림 답장을 넣지 못했습니다. 발송으로 세지 않았습니다.");
            return false;
        }
    }

    // ── 조회용 API ────────────────────────────────────────────────────────────

    /** 내 마지막 발송 뒤 그 방에 남이 올린 메시지 수. 세션이 없으면 0. */
    public static int othersSinceMine(String room) {
        Session s = session(room);
        return (s == null) ? 0 : s.othersSinceMine;
    }

    /** 계정까지 지정해서 조회하는 버전 */
    public static int othersSinceMine(RoomRef ref) {
        Session s = session(ref);
        return (s == null) ? 0 : s.othersSinceMine;
    }

    /** 내가 그 방으로 마지막으로 보낸 시각 (epoch ms). 없으면 0. */
    public static long lastMineAt(String room) {
        Session s = session(room);
        return (s == null) ? 0L : s.lastMine;
    }

    /** 계정까지 지정해서 조회하는 버전 */
    public static long lastMineAt(RoomRef ref) {
        Session s = session(ref);
        return (s == null) ? 0L : s.lastMine;
    }

    /** 그 방 알림을 마지막으로 본 시각 (epoch ms). 없으면 0. */
    public static long lastSeenAt(String room) {
        Session s = session(room);
        return (s == null) ? 0L : s.lastAt;
    }

    /** 계정까지 지정해서 조회하는 버전 */
    public static long lastSeenAt(RoomRef ref) {
        Session s = session(ref);
        return (s == null) ? 0L : s.lastAt;
    }

    /** 지금 그 방으로 발송할 수 있나 (= 살아있는 답장창이 있나) */
    public static boolean hasSession(String room) {
        return live(session(room));
    }

    /** 계정까지 지정해서 확인하는 버전 */
    public static boolean hasSession(RoomRef ref) {
        return live(session(ref));
    }

    private static boolean live(Session s) {
        return s != null && s.pending != null && s.inputs != null && s.inputs.length > 0;
    }

    /** 저장값(방 이름 또는 RoomRef.key())으로 세션 조회. 구버전 저장값 호환용이다. */
    public static Session session(String room) {
        return lookup(room);
    }

    /** 계정까지 지정해서 세션 조회 */
    public static Session session(RoomRef ref) {
        return findSession(ref, false);
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

    /** 발송 가능한 방들 (지금 세션이 살아있는 방만) */
    public static List<RoomRef> liveRooms() {
        ArrayList<RoomRef> out = new ArrayList<RoomRef>();
        Iterator<Map.Entry<String, Session>> it = SESSIONS.entrySet().iterator();
        while (it.hasNext()) {
            Session s = it.next().getValue();
            if (live(s)) out.add(s.ref);
        }
        return out;
    }

    /**
     * 지금 떠 있는 카카오톡 알림에서 이 폰의 표시 이름만 읽는다.
     * 계정 등록이나 발송에는 쓰지 않는다.
     */
    public static void capturePhoneAccounts() {
        KakaoListener svc = LIVE;
        if (svc == null || !bound) return;
        svc.noteActivePhones();
    }

    /**
     * 알림이 알려준 이름 중, 알림 답장으로 나가는 계정.
     * 알림이 이름을 준 적이 없으면 "". 순번이나 기본 계정으로 채우지 않는다.
     */
    public static String phoneAccountLine(Context c) {
        capturePhoneAccounts();
        synchronized (PHONE) {
            loadPhone(c);
            String k = replyKeyLocked();
            if (k == null) return "";
            String name = PHONE.get(k);
            return (name == null) ? "" : name;
        }
    }

    /** 알림 답장에 쓸 방. 그 방 알림의 계정이면 그대로, 아니면 감지된 폰 계정으로 돌린다. */
    public static RoomRef replyTarget(Context c, RoomRef ref) {
        if (c == null || ref == null || !ref.valid()) return null;
        synchronized (PHONE) {
            loadPhone(c);
            if (named(ref.acc)) return ref;
            String k = replyKeyLocked();
            if (k == null) return null;
            return RoomRef.of(k, ref.name);
        }
    }

    /** 알림이 이름을 알려준 폰 계정인가. 등록 계정 목록과는 별개다. */
    public static boolean isPhoneAccount(Context c, String acc) {
        if (c == null || acc == null) return false;
        synchronized (PHONE) {
            loadPhone(c);
            return named(acc.trim());
        }
    }

    private static boolean named(String acc) {
        if (acc == null || acc.length() == 0) return false;
        String n = PHONE.get(acc);
        return n != null && n.length() > 0;
    }

    /** PHONE 잠금 안에서. 이름이 있는 감지 계정만. */
    private static String replyKeyLocked() {
        if (named(replyAcc)) return replyAcc;
        String last = null;
        Iterator<Map.Entry<String, String>> it = PHONE.entrySet().iterator();
        while (it.hasNext()) {
            Map.Entry<String, String> e = it.next();
            if (e.getValue() != null && e.getValue().length() > 0) last = e.getKey();
        }
        return last;
    }

    private void noteActivePhones() {
        StatusBarNotification[] all;
        try { all = getActiveNotifications(); } catch (Throwable t) { return; }
        if (all == null) return;
        Context ctx = ctxOrApp();
        for (int i = 0; i < all.length; i++) {
            StatusBarNotification sbn = all[i];
            if (sbn == null || !KAKAO.equals(sbn.getPackageName())) continue;
            Notification n = sbn.getNotification();
            if (n == null || n.extras == null) continue;
            if ((n.flags & Notification.FLAG_GROUP_SUMMARY) != 0) continue;
            if ((n.flags & Notification.FLAG_ONGOING_EVENT) != 0) continue;
            String acc = Accounts.keyOf(sbn);
            notePhone(ctx, acc, selfFrom(n.extras));
            String shortcut = "";
            try { shortcut = shortcutLabel(sbn); } catch (Throwable ignore) { }
            Msg m = parse(n.extras, sbn.getPostTime(), shortcut, acc);
            if (m == null || m.room.length() == 0) continue;
            if (m.selfName.length() > 0) notePhone(ctx, m.acc, m.selfName);
            if (!m.roomTrusted) continue;
            Reply reply = findReply(n);
            if (reply != null) {
                Session s = SESSIONS.get(m.ref.key());
                if (s == null) {
                    Session fresh = new Session(m.ref);
                    Session prev = SESSIONS.putIfAbsent(m.ref.key(), fresh);
                    s = (prev != null) ? prev : fresh;
                }
                s.pending = reply.pending;
                s.inputs = reply.inputs;
                s.dataTypes = reply.dataTypes;
                s.lastAt = m.at;
            }
            noteNotifyRoom(ctx, m, n);
            remember(ctx, m.ref, m.group, m.at);
        }
    }

    /**
     * 안드로이드 사용자 키와 카카오 프로필 이름을 계정키로 만든다.
     * 그 사용자에서 처음 본 이름은 사용자 키를 그대로 쓴다.
     * 다른 이름이 오면 {@code 사용자키~해시} 로 나누고, 먼저 본 이름은 그대로 둔다.
     */
    private static String accountKey(String userKey, String selfName) {
        String u = (userKey == null || userKey.trim().length() == 0) ? RoomRef.DEFAULT_ACC : userKey.trim();
        String n = selfName == null ? "" : selfName.trim();
        if (n.length() == 0 || u.indexOf('~') >= 0) return u;
        synchronized (PHONE) {
            loadPhone(appContext());
            return keyLocked(u, n);
        }
    }

    /** PHONE 잠금 안에서. */
    private static String keyLocked(String userKey, String selfName) {
        String have = PHONE.get(userKey);
        if (have == null || have.length() == 0 || have.equals(selfName)) return userKey;
        return userKey + "~" + Integer.toHexString(selfName.hashCode());
    }

    /**
     * 알림이 준 이름만 기억한다. 비어 있으면 무시한다.
     * 같은 안드로이드 사용자 안에 카카오 프로필이 둘이면 나중 이름이 앞 이름을 지우지 않는다.
     */
    private static void notePhone(Context ctx, String acc, String name) {
        if (ctx == null || name == null) return;
        String n = name.trim();
        if (n.length() == 0) return;
        String given = (acc == null || acc.trim().length() == 0) ? RoomRef.DEFAULT_ACC : acc.trim();
        boolean changed;
        String k;
        synchronized (PHONE) {
            loadPhone(ctx);
            k = given.indexOf('~') >= 0 ? given : keyLocked(given, n);
            boolean nameChanged = !n.equals(PHONE.get(k));
            changed = nameChanged || !k.equals(replyAcc);
            PHONE.remove(k);
            PHONE.put(k, n);
            replyAcc = k;
            if (!changed) return;
            savePhone(ctx);
            Prefs.putStr(ctx, K_PHONE_REPLY, k);
            if (!nameChanged) return;
        }
        SELF.put(k, n);
        selfName = n;
        try { Accounts.seen(ctx, k, n); } catch (Throwable ignore) { }
        Log.add(ctx, "폰 카카오톡 계정을 알림에서 감지했습니다: " + n + ". 이 계정의 대화방은 그 이름으로 구분합니다.");
        new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() {
            @Override public void run() {
                try { ScreenMacro.refresh(); } catch (Throwable ignore) { }
            }
        });
    }

    private static String selfFrom(Bundle ex) {
        String me = getCs(ex, Notification.EXTRA_SELF_DISPLAY_NAME);
        if (me.length() == 0 && Build.VERSION.SDK_INT >= 28) {
            me = personName(getParcel(ex, Notification.EXTRA_MESSAGING_PERSON));
        }
        return me;
    }

    private static void loadPhone(Context c) {
        if (phoneLoaded || c == null) return;
        phoneLoaded = true;
        String raw = Prefs.getStr(c, K_PHONE, "");
        if (raw == null || raw.length() == 0) return;
        try {
            JSONObject o = new JSONObject(raw);
            Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                String n = o.optString(k, "").trim();
                if (k == null || k.length() == 0 || n.length() == 0) continue;
                PHONE.put(k, n);
                SELF.put(k, n);
                selfName = n;
            }
            if (!named(replyAcc)) {
                String saved = Prefs.getStr(c, K_PHONE_REPLY, "");
                if (named(saved)) replyAcc = saved;
            }
        } catch (Throwable ignore) { }
    }

    private static void savePhone(Context c) {
        JSONObject o = new JSONObject();
        try {
            Iterator<Map.Entry<String, String>> it = PHONE.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, String> e = it.next();
                if (e.getKey() == null || e.getValue() == null || e.getValue().length() == 0) continue;
                o.put(e.getKey(), e.getValue());
            }
        } catch (Throwable ignore) { }
        Prefs.putStr(c, K_PHONE, o.toString());
    }

    /** 믿을 수 있는 방 이름을 보낼 방 목록에 올린다. 답장 액션은 요구하지 않는다. */
    private static void noteNotifyRoom(Context ctx, Msg m, Notification n) {
        if (ctx == null || m == null || !m.ref.valid() || n == null) return;
        KindRead read = readKind(n, m.group);
        if (!LIST_ACC.equals(m.ref.acc)) dropListTwin(ctx, m.ref);
        boolean fresh = putDetected(ctx, m.ref, m.group, read.kind, read.known, m.at, false);
        if (!fresh) return;
        String where = read.known ? kindLabel(read.kind) : "일반 채팅방";
        String tail = read.known ? "" : " 종류는 확인되지 않았습니다.";
        Log.add(ctx, "「" + m.ref.name + "」을 알림에서 감지했습니다. " + where + "에 표시합니다." + tail);
        refreshRooms();
    }

    /**
     * 채팅 목록에서 읽은 방. 계정을 특정하지 못하면 {@link #LIST_ACC} 로 둔다.
     * 답장 알림이 없어도 목록에 남긴다.
     */
    public static void noteListRoom(Context ctx, String acc, String name, String kind, boolean kindKnown) {
        if (ctx == null || name == null) return;
        String a = (acc == null || acc.trim().length() == 0) ? LIST_ACC : acc.trim();
        RoomRef ref = RoomRef.of(a, name);
        if (!ref.valid()) return;
        String k = kind;
        boolean known = kindKnown;
        if (!RoomKind.OPEN_ROOM.equals(k) && !RoomKind.OPEN_DM.equals(k)) {
            k = RoomKind.NORMAL;
            if (!RoomKind.NORMAL.equals(kind)) known = false;
        }
        if (!LIST_ACC.equals(ref.acc)) dropListTwin(ctx, ref);
        boolean fresh = putDetected(ctx, ref, false, k, known, System.currentTimeMillis(), true);
        remember(ctx, ref, false, System.currentTimeMillis());
        if (!fresh) return;
        String where = known ? kindLabel(k) : "일반 채팅방";
        String tail = known ? "" : " 종류는 확인되지 않았습니다.";
        Log.add(ctx, "「" + ref.name + "」을 채팅 목록에서 감지했습니다. " + where + "에 표시합니다." + tail);
        refreshRooms();
    }

    /** 폰에서 프로필이 하나뿐이면 그 계정키. 없거나 둘 이상이면 "". */
    public static String onlyPhoneAccount(Context c) {
        synchronized (PHONE) {
            loadPhone(c);
            if (PHONE.size() != 1) return "";
            Iterator<String> it = PHONE.keySet().iterator();
            return it.hasNext() ? it.next() : "";
        }
    }

    /** 그 방 이름이 폰 계정 하나에만 있으면 그 키. 없거나 여러 계정이면 "". */
    public static String accountForListedName(Context c, String name) {
        if (c == null || name == null) return "";
        String want = name.trim();
        if (want.length() == 0) return "";
        String hit = null;
        synchronized (NOTIFY) {
            loadNotify(c);
            Iterator<NRoom> it = NOTIFY.values().iterator();
            while (it.hasNext()) {
                NRoom r = it.next();
                if (r == null || r.ref == null || LIST_ACC.equals(r.ref.acc)) continue;
                if (!want.equals(r.ref.name)) continue;
                if (hit != null && !hit.equals(r.ref.acc)) return "";
                hit = r.ref.acc;
            }
        }
        return hit == null ? "" : hit;
    }

    /** 그 계정키의 폰 카카오톡 표시 이름. 없으면 "". */
    public static String phoneName(Context c, String acc) {
        if (c == null || acc == null) return "";
        synchronized (PHONE) {
            loadPhone(c);
            String n = PHONE.get(acc);
            return n == null ? "" : n;
        }
    }

    /** 감지된 폰 카카오톡 이름을 모두 잇는다. 없으면 "". */
    public static String phoneNamesLine(Context c) {
        synchronized (PHONE) {
            loadPhone(c);
            StringBuilder sb = new StringBuilder();
            Iterator<String> it = PHONE.values().iterator();
            while (it.hasNext()) {
                String n = it.next();
                if (n == null || n.length() == 0) continue;
                if (sb.length() > 0) sb.append(" · ");
                sb.append(n);
            }
            return sb.toString();
        }
    }

    private static void dropListTwin(Context ctx, RoomRef ref) {
        if (ctx == null || ref == null || LIST_ACC.equals(ref.acc)) return;
        RoomRef twin = RoomRef.of(LIST_ACC, ref.name);
        boolean removed;
        synchronized (NOTIFY) {
            loadNotify(ctx);
            removed = NOTIFY.remove(twin.key()) != null;
            if (removed) saveNotify(ctx);
        }
        if (!removed) return;
        synchronized (ROOMS) {
            loadRooms(ctx);
            if (ROOMS.remove(twin.key()) != null) saveRooms(ctx);
        }
    }

    /** @return 이번에 처음 넣은 방이면 true */
    private static boolean putDetected(Context ctx, RoomRef ref, boolean group, String kind,
                                       boolean kindKnown, long at, boolean fromList) {
        if (ctx == null || ref == null || !ref.valid()) return false;
        String k = (kind == null) ? RoomKind.NORMAL : kind;
        if (!RoomKind.OPEN_ROOM.equals(k) && !RoomKind.OPEN_DM.equals(k)) k = RoomKind.NORMAL;
        long now = at > 0 ? at : System.currentTimeMillis();
        synchronized (NOTIFY) {
            loadNotify(ctx);
            NRoom have = NOTIFY.get(ref.key());
            if (have != null) {
                boolean save = false;
                if (now > have.lastAt) have.lastAt = now;
                if (kindKnown && !have.kindKnown) {
                    have.listKind = k;
                    have.kindKnown = true;
                    have.group = group;
                    save = true;
                }
                if (!fromList && have.fromList) {
                    have.fromList = false;
                    have.group = group;
                    save = true;
                }
                if (save) saveNotify(ctx);
                return false;
            }
            NRoom r = new NRoom();
            r.ref = ref;
            r.group = group;
            r.listKind = k;
            r.kindKnown = kindKnown;
            r.fromList = fromList;
            r.lastAt = now;
            NOTIFY.put(ref.key(), r);
            while (NOTIFY.size() > MAX_ROOMS) {
                Iterator<String> it = NOTIFY.keySet().iterator();
                if (!it.hasNext()) break;
                it.next();
                it.remove();
            }
            saveNotify(ctx);
        }
        return true;
    }

    private static void refreshRooms() {
        new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() {
            @Override public void run() {
                try { ScreenRooms.refresh(); } catch (Throwable ignore) { }
            }
        });
    }

    public static List<NotifyRoom> notifyRooms(Context c) {
        ArrayList<NotifyRoom> out = new ArrayList<NotifyRoom>();
        synchronized (NOTIFY) {
            loadNotify(c);
            Iterator<NRoom> it = NOTIFY.values().iterator();
            while (it.hasNext()) {
                NRoom r = it.next();
                if (r == null || r.ref == null || !r.ref.valid()) continue;
                out.add(new NotifyRoom(r.ref, r.group, r.listKind, r.lastAt, hasSession(r.ref),
                        r.kindKnown, r.fromList));
            }
        }
        return out;
    }

    public static boolean isNotifyRoom(Context c, RoomRef ref) {
        if (c == null || ref == null || !ref.valid()) return false;
        synchronized (NOTIFY) {
            loadNotify(c);
            return NOTIFY.containsKey(ref.key());
        }
    }

    /** 같은 글을 방금 넣었으면 다시 넣지 않는다. 메시지 번호가 없어도 두 번 보내지 않기 위해서다. */
    public static boolean queuedRecently(RoomRef ref, String text) {
        Session s = session(ref);
        if (s == null || text == null) return false;
        if (s.lastQueuedAt <= 0 || System.currentTimeMillis() - s.lastQueuedAt > 180000L) return false;
        return text.equals(s.lastSentText);
    }

    /** 답장을 넣었다는 표시만 한다. 발송 성공으로 세지 않는다. */
    public static void noteQueued(RoomRef ref, String text) {
        Session s = session(ref);
        if (s == null) return;
        s.lastSentText = text == null ? "" : text;
        s.lastMine = System.currentTimeMillis();
        s.lastQueuedAt = s.lastMine;
        s.othersSinceMine = 0;
    }

    private static final class KindRead {
        final String kind;
        final boolean known;

        KindRead(String kind, boolean known) {
            this.kind = kind;
            this.known = known;
        }
    }

    /** 알림이 종류를 말해 주면 known. 못 가르면 일반 채팅방이고 known 은 거짓이다. */
    private static KindRead readKind(Notification n, boolean group) {
        Bundle ex = n == null ? null : n.extras;
        if (ex != null) {
            String[] keys = new String[] {
                    "chat_type", "room_type", "roomType", "link_type", "kakao.chat.type", "type"
            };
            for (int i = 0; i < keys.length; i++) {
                String known = RoomKind.knownType(getCs(ex, keys[i]));
                if (known != null) return new KindRead(known, true);
            }
            Iterator<String> it = ex.keySet().iterator();
            while (it.hasNext()) {
                String key = it.next();
                if (key == null) continue;
                Object v = ex.get(key);
                if (!(v instanceof CharSequence)) continue;
                String known = RoomKind.knownType(v.toString());
                if (known != null && !RoomKind.NORMAL.equals(known)) return new KindRead(known, true);
            }
        }
        String blob = "";
        try {
            if (n != null && n.getChannelId() != null) blob = n.getChannelId();
        } catch (Throwable ignore) { }
        if (ex != null) {
            blob = blob + " " + getCs(ex, Notification.EXTRA_SUB_TEXT);
            blob = blob + " " + getCs(ex, Notification.EXTRA_SUMMARY_TEXT);
        }
        if (blob.indexOf("오픈프로필") >= 0) return new KindRead(RoomKind.OPEN_DM, true);
        if (blob.indexOf("오픈채팅") >= 0 || blob.indexOf("오픈챗") >= 0) {
            return new KindRead(group ? RoomKind.OPEN_ROOM : RoomKind.OPEN_DM, true);
        }
        return new KindRead(RoomKind.NORMAL, false);
    }

    private static String kindLabel(String kind) {
        if (RoomKind.OPEN_ROOM.equals(kind)) return "오픈채팅방";
        if (RoomKind.OPEN_DM.equals(kind)) return "오픈프로필로 온 갠톡";
        return "일반 채팅방";
    }

    private static void loadNotify(Context c) {
        if (notifyLoaded || c == null) return;
        notifyLoaded = true;
        String raw = Prefs.getStr(c, K_NOTIFY_ROOMS, "");
        if (raw == null || raw.length() == 0) return;
        try {
            JSONArray arr = new JSONObject(raw).optJSONArray("r");
            if (arr == null) return;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject j = arr.optJSONObject(i);
                if (j == null) continue;
                RoomRef ref = RoomRef.of(j.optString("a", RoomRef.DEFAULT_ACC), j.optString("n", ""));
                if (!ref.valid()) continue;
                NRoom r = new NRoom();
                r.ref = ref;
                r.group = j.optInt("g", 0) != 0;
                String kind = j.optString("k", RoomKind.NORMAL);
                if (!RoomKind.OPEN_ROOM.equals(kind) && !RoomKind.OPEN_DM.equals(kind)) kind = RoomKind.NORMAL;
                r.listKind = kind;
                if (j.has("ok")) r.kindKnown = j.optInt("ok", 0) != 0;
                else r.kindKnown = !RoomKind.NORMAL.equals(kind);
                r.fromList = j.optInt("f", 0) != 0;
                r.lastAt = j.optLong("t", 0L);
                NOTIFY.put(ref.key(), r);
            }
        } catch (Throwable ignore) { }
    }

    private static void saveNotify(Context c) {
        JSONArray arr = new JSONArray();
        try {
            Iterator<NRoom> it = NOTIFY.values().iterator();
            while (it.hasNext()) {
                NRoom r = it.next();
                if (r == null || r.ref == null) continue;
                JSONObject j = new JSONObject();
                j.put("a", r.ref.acc);
                j.put("n", r.ref.name);
                if (r.group) j.put("g", 1);
                j.put("k", r.listKind);
                if (r.kindKnown) j.put("ok", 1);
                if (r.fromList) j.put("f", 1);
                if (r.lastAt > 0) j.put("t", r.lastAt);
                arr.put(j);
            }
            JSONObject o = new JSONObject();
            o.put("r", arr);
            Prefs.putStr(c, K_NOTIFY_ROOMS, o.toString());
        } catch (Throwable ignore) { }
    }

    /** 마지막으로 본 내 표시이름. 모르면 "". */
    public static String selfName() {
        return (selfName == null) ? "" : selfName;
    }

    /** 그 계정의 내 표시이름. 그 계정에서 못 봤으면 마지막으로 본 이름, 그것도 없으면 "". */
    public static String selfName(String acc) {
        String k = (acc == null || acc.trim().length() == 0) ? RoomRef.DEFAULT_ACC : acc.trim();
        String v = SELF.get(k);
        if (v != null && v.length() > 0) return v;
        return selfName();
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

    // ── 방 캐시 (평문 Prefs · 계정 + 방 이름 + 단체여부 + 감지시각 · 최대 50개) ──
    //
    //  키는 RoomRef.key() 다. 구버전 저장값(줄바꿈으로 이은 방 이름 목록)은 읽을 때
    //  기본 계정("0")·1:1·감지시각 0 으로 채워 넣는다 (UI_V3 6장 하위호환).

    /** 최근 감지된 방 (최신이 앞). 방 관리 화면의 목록에 쓴다. */
    public static List<RoomInfo> knownRooms(Context c) {
        loadRooms(c);
        ArrayList<RoomInfo> out = new ArrayList<RoomInfo>();
        synchronized (ROOMS) {
            Iterator<Map.Entry<String, Room>> it = ROOMS.entrySet().iterator();
            while (it.hasNext()) {
                Room r = it.next().getValue();
                if (r == null) continue;
                out.add(new RoomInfo(r.ref, r.group, r.lastAt));
            }
        }
        java.util.Collections.reverse(out);   // 최근에 본 방이 위로
        return out;
    }

    /** 그 계정에서 감지된 방만 (최신이 앞) */
    public static List<RoomInfo> knownRooms(Context c, String acc) {
        String k = (acc == null || acc.trim().length() == 0) ? RoomRef.DEFAULT_ACC : acc.trim();
        List<RoomInfo> all = knownRooms(c);
        ArrayList<RoomInfo> out = new ArrayList<RoomInfo>();
        for (int i = 0; i < all.size(); i++) {
            RoomInfo r = all.get(i);
            if (r.ref.acc.equals(k)) out.add(r);
        }
        return out;
    }

    /**
     * Context 없이 호출하는 버전. 가능하면 knownRooms(ctx) 를 써라 —
     * 이건 리스너가 한 번도 안 돌았고 앱 컨텍스트도 못 구한 상황에서 빈 목록이 나온다.
     */
    public static List<RoomInfo> knownRooms() {
        return knownRooms(appContext());
    }

    /** 그 계정에서 감지된 방 개수 (계정 화면의 `이 계정의 방 N개`) */
    public static int roomCount(Context c, String acc) {
        return knownRooms(c, acc).size();
    }

    /** 지금까지 확인된 계정키 (방 캐시 · 살아있는 세션 · 계정 레지스트리의 합집합) */
    public static java.util.Set<String> accountsSeen(Context c) {
        LinkedHashSet<String> out = new LinkedHashSet<String>();
        List<Accounts.Acc> regs = Accounts.all(c);
        for (int i = 0; i < regs.size(); i++) out.add(regs.get(i).key);
        loadRooms(c);
        synchronized (ROOMS) {
            Iterator<Map.Entry<String, Room>> it = ROOMS.entrySet().iterator();
            while (it.hasNext()) {
                Room r = it.next().getValue();
                if (r != null) out.add(r.ref.acc);
            }
        }
        Iterator<Map.Entry<String, Session>> si = SESSIONS.entrySet().iterator();
        while (si.hasNext()) {
            Session s = si.next().getValue();
            if (s != null) out.add(s.ref.acc);
        }
        if (out.isEmpty()) out.add(RoomRef.DEFAULT_ACC);
        return java.util.Collections.unmodifiableSet(out);
    }

    /**
     * 그 방을 전에 본 적 있나. 자동응답의 「모르는 사람만」 판정에 쓴다.
     * 계정 구분자가 없는 값이면 계정을 가리지 않고 이름만 본다 (구버전 저장값 호환).
     */
    public static boolean isKnownRoom(String room) {
        if (room == null) return false;
        String v = room.trim();
        if (v.length() == 0) return false;
        if (v.indexOf(RoomRef.SEP) >= 0) return isKnownRoom(RoomRef.parse(v));

        loadRooms(appContext());
        synchronized (ROOMS) {
            Iterator<Map.Entry<String, Room>> it = ROOMS.entrySet().iterator();
            while (it.hasNext()) {
                Room r = it.next().getValue();
                if (r != null && r.ref.name.equals(v)) return true;
            }
        }
        return false;
    }

    /** 계정까지 맞춰서 확인하는 버전 */
    public static boolean isKnownRoom(RoomRef ref) {
        if (ref == null || !ref.valid()) return false;
        loadRooms(appContext());
        synchronized (ROOMS) {
            return ROOMS.containsKey(ref.key());
        }
    }

    /**
     * 감지된 방 1건을 캐시에서 지운다. 멤버 이름이 방으로 잘못 들어간 항목을 지우는 용도다
     * (UI_V3 5장 — ✕ 버튼). 지운 방이 다시 감지되면 또 들어온다.
     */
    public static void forgetRoom(Context c, RoomRef ref) {
        if (c == null || ref == null || !ref.valid()) return;
        loadRooms(c);
        boolean removed;
        synchronized (ROOMS) {
            removed = (ROOMS.remove(ref.key()) != null);
        }
        if (!removed) return;
        SESSIONS.remove(ref.key());
        saveRooms(c);
    }

    /** 그 계정의 감지 방·세션을 전부 지운다 (계정 기록 삭제에 딸려 온다) */
    static void forgetAccount(Context c, String acc) {
        String k = (acc == null || acc.trim().length() == 0) ? RoomRef.DEFAULT_ACC : acc.trim();
        loadRooms(c);
        boolean changed = false;
        synchronized (ROOMS) {
            Iterator<Map.Entry<String, Room>> it = ROOMS.entrySet().iterator();
            while (it.hasNext()) {
                Room r = it.next().getValue();
                if (r != null && r.ref.acc.equals(k)) { it.remove(); changed = true; }
            }
        }
        Iterator<Map.Entry<String, Session>> si = SESSIONS.entrySet().iterator();
        while (si.hasNext()) {
            Session s = si.next().getValue();
            if (s != null && s.ref.acc.equals(k)) si.remove();
        }
        SELF.remove(k);
        if (changed) saveRooms(c);
    }

    /** 감지 캐시를 비운다 (UI_V3 5장 — 감지 목록 전체 지우기. 선택된 방 설정은 건드리지 않는다) */
    public static void clearRooms(Context c) {
        synchronized (ROOMS) {
            ROOMS.clear();
            roomsLoaded = true;
        }
        ROOM_WARNED.clear();
        Prefs.remove(c, K_ROOMS);
    }

    /** 방 이름을 못 믿는 알림을 만났을 때 방마다 한 번만 알려준다 (로그 도배 방지) */
    private static final java.util.Set<String> ROOM_WARNED =
            java.util.Collections.newSetFromMap(new ConcurrentHashMap<String, Boolean>());

    private static void roomSrcWarn(Context c, Msg m) {
        if (m == null || !m.ref.valid()) return;
        if (!ROOM_WARNED.add(m.ref.key())) return;
        if (ROOM_WARNED.size() > 200) ROOM_WARNED.clear();
        Log.add(c, "「" + m.ref.label(c) + "」: 단체방이나 카카오톡이 대화방 이름을 제공하지 않아 "
                + "감지 목록에 등록하지 않았습니다. 알림에 포함된 이름은 발신자입니다. "
                + "해당 대화방을 대상으로 지정하려면 대화방 이름을 직접 입력하십시오.");
    }

    /** 감지된 방을 캐시에 반영한다. Prefs 쓰기는 꼭 필요할 때만 한다 (알림마다 쓰면 안 된다). */
    private static void remember(Context c, RoomRef ref, boolean group, long at) {
        if (ref == null || !ref.valid()) return;
        loadRooms(c);
        String key = ref.key();
        long now = (at > 0) ? at : System.currentTimeMillis();
        boolean save;
        synchronized (ROOMS) {
            Room r = ROOMS.get(key);
            boolean newest = false;
            if (r != null) {
                // 이미 맨 뒤(=가장 최근)면 순서는 건드릴 게 없다
                String last = null;
                Iterator<String> tail = ROOMS.keySet().iterator();
                while (tail.hasNext()) last = tail.next();
                newest = key.equals(last);
            }
            if (r == null) {
                r = new Room();
                r.ref = ref;
                r.group = group;
                r.lastAt = now;
                ROOMS.put(key, r);
                save = true;
            } else {
                save = (r.group != group) || !newest;
                r.group = group;
                if (now > r.lastAt) r.lastAt = now;
                if (!newest) {
                    // LinkedHashMap 은 재삽입해도 순서가 안 바뀐다 → 지우고 다시 넣어 최신으로 올린다
                    ROOMS.remove(key);
                    ROOMS.put(key, r);
                }
            }
            if (r.lastAt - r.savedAt >= ROOM_SAVE_MS) save = true;
            while (ROOMS.size() > MAX_ROOMS) {
                Iterator<String> it = ROOMS.keySet().iterator();
                if (!it.hasNext()) break;
                it.next();
                it.remove();
                save = true;
            }
            if (!save) return;
            stampSaved();
        }
        saveRooms(c);
    }

    /** 방금 저장한 감지시각을 기록한다 (Prefs 쓰기 간격 제한용). synchronized(ROOMS) 안에서만. */
    private static void stampSaved() {
        Iterator<Map.Entry<String, Room>> it = ROOMS.entrySet().iterator();
        while (it.hasNext()) {
            Room r = it.next().getValue();
            if (r != null) r.savedAt = r.lastAt;
        }
    }

    private static void loadRooms(Context c) {
        if (roomsLoaded) return;
        synchronized (ROOMS) {
            if (roomsLoaded) return;
            roomsLoaded = true;
            if (c == null) { roomsLoaded = false; return; }   // 컨텍스트가 생기면 다시 시도한다
            try {
                String raw = Prefs.getStr(c, K_ROOMS, null);
                if (raw == null || raw.trim().length() == 0) return;
                String head = raw.trim();
                boolean done = false;
                if (head.charAt(0) == '{') {
                    // 현재 형식. 방 이름이 '{' 로 시작하는 구버전 값이 섞여 있을 수 있으니
                    // 실패하면 구버전 형식으로 한 번 더 읽는다 (감지 목록을 통째로 잃지 않게).
                    try {
                        loadJson(head);
                        done = true;
                    } catch (Throwable ignore) {
                        ROOMS.clear();
                    }
                }
                if (!done) loadLegacy(raw);
                while (ROOMS.size() > MAX_ROOMS) {
                    Iterator<String> it = ROOMS.keySet().iterator();
                    if (!it.hasNext()) break;
                    it.next();
                    it.remove();
                }
            } catch (Throwable t) {
                Log.add(c, "대화방 목록을 불러오지 못했습니다: " + t);
            }
        }
    }

    /** 현재 형식 (JSON) */
    private static void loadJson(String raw) throws org.json.JSONException {
        org.json.JSONObject o = new org.json.JSONObject(raw);
        org.json.JSONArray arr = o.optJSONArray("r");
        if (arr == null) return;
        for (int i = 0; i < arr.length(); i++) {
            org.json.JSONObject j = arr.optJSONObject(i);
            if (j == null) continue;
            RoomRef ref = RoomRef.of(j.optString("a", RoomRef.DEFAULT_ACC), j.optString("n", ""));
            if (!ref.valid()) continue;
            Room r = new Room();
            r.ref = ref;
            r.group = j.optInt("g", 0) != 0;
            r.lastAt = j.optLong("t", 0L);
            r.savedAt = r.lastAt;
            ROOMS.remove(ref.key());
            ROOMS.put(ref.key(), r);
        }
    }

    /** 구버전 형식 (줄바꿈으로 이은 방 이름). 계정은 기본 계정으로 채운다. */
    private static void loadLegacy(String raw) {
        String[] parts = raw.split("\n");
        for (int i = 0; i < parts.length; i++) {
            RoomRef ref = RoomRef.of(RoomRef.DEFAULT_ACC, parts[i]);
            if (!ref.valid()) continue;
            Room r = new Room();
            r.ref = ref;
            r.group = false;        // 구버전 저장값엔 단체여부가 없다. 다음 알림에서 채워진다
            r.lastAt = 0L;
            r.savedAt = 0L;
            ROOMS.remove(ref.key());
            ROOMS.put(ref.key(), r);
        }
    }

    private static void saveRooms(Context c) {
        if (c == null) return;
        String out;
        synchronized (ROOMS) {
            try {
                org.json.JSONArray arr = new org.json.JSONArray();
                Iterator<Map.Entry<String, Room>> it = ROOMS.entrySet().iterator();
                while (it.hasNext()) {
                    Room r = it.next().getValue();
                    if (r == null) continue;
                    org.json.JSONObject j = new org.json.JSONObject();
                    j.put("a", r.ref.acc);
                    j.put("n", r.ref.name);
                    if (r.group) j.put("g", 1);
                    if (r.lastAt > 0) j.put("t", r.lastAt);
                    arr.put(j);
                }
                org.json.JSONObject o = new org.json.JSONObject();
                o.put("v", 2);
                o.put("r", arr);
                out = o.toString();
            } catch (Throwable t) {
                Log.add(c, "대화방 목록을 저장하지 못했습니다: " + t);
                return;
            }
        }
        Prefs.putStr(c, K_ROOMS, out);
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
