package com.buseong.kakaoauto;

import android.app.KeyguardManager;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ResolveInfo;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 이미지 1~5장 전송 오케스트레이션. 경로가 세 계열이고 <b>이 순서로</b> 시도한다.
 *
 * <h3>경로 A — 알림 답장에 사진 첨부 (화면이 아예 안 움직인다)</h3>
 * 카톡이 알림 답장 {@code RemoteInput} 에 이미지 데이터 타입을 허용해뒀으면
 * ({@link KakaoListener#imageTypesFor}) 공유창도 접근성도 안 쓰고 그냥 실어 보낸다.
 * MIME 하나당 URI 하나라서 <b>한 장씩 순서대로</b> 보낸다.
 * 되는지 안 되는지는 기기/카톡 버전마다 다르니 <b>런타임에 확인해서 로그로 알려준다.</b>
 *
 * <h3>경로 B — 채팅방 내부 첨부 시트 (현장에서 유일하게 관측된 화면)</h3>
 * 근거: {@code docs/field/kakao-attach-sheet-26.8.2.md} (실기기 뷰 트리).
 * 알림 contentIntent({@link KakaoListener#openIntentFor})로 채팅방을 열고,
 * {@code KakaoAccessibility.armAttach} 가 첨부(+) → {@code 사진} → 썸네일 선택 → {@code btn_send} 를 밟는다.
 * 사진은 <b>촬영/저장 시각</b>으로 지목한다 — 썸네일 {@code contentDescription} 이
 * {@code "사진, 9월 28일 오전 8:20"} 형식이라 {@link ImagePicker#kakaoDescList} 가 만든 문자열과
 * 정확 일치로 찾을 수 있다. 시각을 못 읽는 사진은 <b>이 경로로 지목할 수 없다</b>.
 *
 * <h3>경로 C — 공유창 + 접근성 조작 (폴백)</h3>
 * <b>실기기 두 번의 시도에서 카톡 공유 대상 선택 화면이 한 번도 관측되지 않았다</b>
 * (안드로이드 16 + 백그라운드 실행 제한으로 판단된다). 그래서 기본 경로가 아니라 폴백이고,
 * {@link #SHARE_SHOW_MS} 안에 카톡 창이 안 보이면 다음 경로로 <b>빠르게</b> 넘어간다.
 * 예전에는 이 경로가 기본이어서, 안 뜨는 창을 9초씩 기다리다 40초를 통째로 버렸다.
 *
 * 여기가 현장에서 제일 많이 깨지는 자리다. 그래서 <b>한 번 던져보고 실패로 끝내지 않고</b>
 * 실행 경로를 순서대로 올라간다. 어느 경로로 성공했는지는 반드시 로그에 남긴다.
 *
 *   0. 받을 액티비티가 실제로 있는지 {@code queryIntentActivities} 로 먼저 확인한다.
 *      없으면 어떤 경로로도 안 되므로 여기서 끝낸다 (= 원인 (a)).
 *   1. {@link KakaoAccessibility#arm} 으로 "다음 카톡 공유창에서 이 방 골라라" 예약
 *   2. 앱이 화면에 표시된 상태면 <b>직접 실행</b>. 아니면 {@link WakeActivity} <b>경유 실행</b> —
 *      우리 액티비티를 먼저 띄워 포그라운드 호출자로 만든 다음 공유 인텐트를 던진다.
 *   3. WakeActivity 가 뜨지도 않았으면 <b>시스템이 우리 액티비티 실행을 차단</b>한 것이다
 *      (= 원인 (b)). 백그라운드 액티비티 차단은 예외를 던지지 않으므로 이 신호로만 구별된다.
 *   4. 그래도 안 되면 컴포넌트를 명시해서 한 번 더 던진다.
 *   5. 공유창은 떴는데 접근성이 못 봤거나 방을 못 고른 경우는 접근성 쪽 덤프가 원인을 말한다
 *      (= 원인 (c)).
 *
 * <h3>어느 경로를 탔는지 반드시 남긴다</h3>
 * 경로가 세 개라 "실패했다" 만 적으면 아무것도 고칠 수 없다. 그래서 경로마다
 * <b>시도했는지 · 건너뛰었으면 왜 · 실패했으면 어디서</b> 를 {@code Job.routes} 에 쌓아
 * 로그와 진단({@link #diag})에 같이 찍는다. 포그라운드/백그라운드도 같은 자리에 적는다 —
 * 예약 발송과 수동 발송은 실패 원인이 완전히 다르다.
 *
 * 한 번에 한 건만 돌린다(카톡 공유창이 겹치면 둘 다 망한다). 겹쳐 들어온 요청은 줄 세워서 순서대로.
 * 어느 스레드에서 불러도 된다 — 내부 상태는 전부 메인 루퍼에서만 만진다.
 *
 * <h3>대화방 값 규칙 (중요)</h3>
 * 여기 들어오는 대화방은 {@link RoomRef} 다. 세 용도를 절대 섞지 않는다.
 *   <ul>
 *     <li><b>화면 매칭</b> = {@code ref.name} — 카톡 화면에 실제로 보이는 문자열</li>
 *     <li><b>세션 조회</b> = {@code ref} — 계정까지 맞춰야 엉뚱한 계정으로 안 나간다</li>
 *     <li><b>사용자 표시</b> = {@code ref.label(ctx)}</li>
 *   </ul>
 * 예전에는 {@code RoomRef.key()}(= {@code "0␁방이름"})를 그대로 화면 매칭에 넘겨서
 * 카톡 화면의 어떤 텍스트와도 일치할 수 없었다. 문자열 한 종류로 뭉쳐 쓰면 같은 사고가 반복된다.
 *
 * 실패하면 <b>어느 단계에서 왜</b> 를 반드시 남긴다. 공유창이 뜨기 전에 죽는 경로는 접근성 쪽
 * 화면 덤프가 없으니까 여기서 최소 진단을 만들어 같은 자리에 저장한다({@link #diag}).
 */
public final class ImageSender {
    private ImageSender() {}

    /** 한 번에 보낼 수 있는 최대 장수 */
    public static final int MAX = ImagePicker.MAX;

    /** 공유 세션 하나당 완료 신호를 이만큼 기다린다. 넘으면 실패 처리. */
    public static final long TIMEOUT_MS = 40000L;

    /** 연속 전송 사이 숨 고르기 (카톡 공유창이 닫힐 시간) */
    private static final long GAP_MS = 1500L;

    /** 알림 답장으로 사진을 연달아 보낼 때 사이 간격 (너무 빠르면 카톡이 순서를 뒤집거나 흘린다) */
    private static final long REPLY_GAP_MS = 1500L;

    /** 대기열에 이보다 많이 쌓이면 새 요청을 버린다 */
    private static final int MAX_QUEUE = 5;

    /**
     * 공유 인텐트를 던진 뒤 카톡 창을 이만큼 기다린다. 넘으면 다음 경로로 올라간다.
     *
     * 공유창은 이제 <b>폴백</b>이다. 실기기 두 번의 시도에서 공유 대상 선택 화면이 한 번도
     * 관측되지 않았으므로, 오래 기다리는 것 자체가 손해다 — 기다린 시간만큼 채팅방 첨부 경로가
     * 늦어지고 예약 발송의 실행 예산도 줄어든다. 6초 내 미표시면 원인을 적고 빠르게 포기한다.
     */
    private static final long SHARE_SHOW_MS = 6000L;

    /**
     * 채팅방을 열라고 알림 인텐트를 던진 뒤 카톡 창을 이만큼 기다린다.
     * 안 뜨면 백그라운드 액티비티 차단으로 보고 다음 경로로 넘어간다.
     */
    private static final long ATTACH_OPEN_MS = 6000L;

    /**
     * 첨부 경로에서 사진 시각 후보를 최대 몇 개까지 바꿔가며 시도하나.
     * 카카오톡이 표시하는 시각이 우리가 읽은 값과 1분 차이날 수 있어서 한 번으로 끝내면 안 되고,
     * 그렇다고 무한정 늘리면 한 건이 전송 대기열을 오래 잡는다.
     */
    private static final int ATTACH_TRIES = 3;

    /**
     * {@link WakeActivity} 가 화면에 뜨는 데 주는 시간.
     * 이 시간 안에 우리 액티비티조차 안 떴으면 <b>시스템이 액티비티 실행을 차단</b>한 것이다.
     * 백그라운드 액티비티 차단은 예외를 던지지 않으므로 이게 유일한 구별 신호다.
     */
    private static final long WAKE_SHOW_MS = 3000L;

    /** 백그라운드에서 공유창이 이 횟수만큼 연속으로 안 뜨면 "백그라운드 불가" 로 확정한다 */
    public static final int BG_FAIL_LIMIT = 3;

    private static final String KAKAO = "com.kakao.talk";

    // ── 실행 경로 이름 (로그·진단에 그대로 찍힌다) ─────────────────────────────
    private static final String P_DIRECT = "직접 실행";
    private static final String P_WAKE = "화면 활성화 후 실행";
    private static final String P_COMPONENT = "직접 실행(대상 지정)";

    // ── 전송 경로 이름 (경로 계열 — 위의 공유 인텐트 실행 경로와 다른 층이다) ────
    private static final String R_REPLY = "알림 답장";
    private static final String R_ATTACH = "채팅방 첨부";
    private static final String R_SHARE = "공유창";

    /** 화면이 꺼지고 잠겨 있어서 못 보낸 경우의 안내 (전용 폰이면 잠금을 없애는 게 정답이다) */
    private static final String LOCK_HELP =
            "화면이 꺼져 있고 잠금이 설정되어 이미지를 전송하지 못했습니다. "
            + "설정 › 잠금화면 › 화면 잠금 방식을 「없음」 으로 변경하고, "
            + "개발자 옵션의 「충전 중 화면 켜짐 유지」 를 활성화하십시오.";

    /** 타사 접근성 자동화 앱이 켜져 있을 때의 안내 (차단은 하지 않는다 — 안내만) */
    public static final String OTHER_ACC_HELP =
            "다른 접근성 자동화 앱이 활성 상태입니다. 이미지 전송 중에는 해당 앱의 클릭 동작을 "
            + "중지하십시오. 자동 클릭이 공유 화면을 함께 조작하면 전송이 실패할 수 있습니다.";

    /** 백그라운드 공유창 연속 실패 횟수 (평문 Prefs) */
    private static final String K_BG_FAILS = "img_bg_fails";
    /** 백그라운드 전송 불가로 확정된 시각 (0 = 아님) */
    private static final String K_BG_BLOCKED_AT = "img_bg_blocked_at";

    // ── 상태 (메인 스레드에서만 접근) ────────────────────────────────────────
    private static final ArrayList<Job> QUEUE = new ArrayList<Job>();
    /** busy/current 는 busy()·pending() 로 다른 스레드에서도 읽히니까 volatile */
    private static volatile boolean busy = false;
    private static volatile Job current = null;
    private static long seq = 0L;
    private static Handler H = null;
    /** 타사 접근성 앱 안내를 이 프로세스에서 이미 남겼나 (같은 줄을 매 주기 반복하지 않는다) */
    private static volatile boolean warnedOtherAcc = false;

    /** 결과(성공 여부 + 원인)까지 받는 콜백. 진단 화면이 이걸 쓴다. */
    public interface Done {
        void done(boolean ok, String detail);
    }

    /** 카톡이 실제로 선언해둔 공유 수신 액티비티 (런타임 조회 결과 — 하드코딩 금지) */
    private static final class Share {
        ComponentName multi = null;
        ComponentName single = null;
        boolean multiExported = true;
        boolean singleExported = true;
        /**
         * 조회 자체가 실패했나 (예외). <b>"받을 액티비티가 없다" 와 절대 같게 취급하지 않는다</b> —
         * 조회 실패를 없음으로 읽으면 실제로는 보낼 수 있는 상황에서 전송을 스스로 포기한다.
         */
        boolean queryFailed = false;

        boolean none() { return multi == null && single == null; }

        String text() {
            if (queryFailed) return "조회 실패 (수신 대상 존재 여부 미확인)";
            return "여러 장(ACTION_SEND_MULTIPLE) " + one(multi, multiExported)
                    + " · 한 장(ACTION_SEND) " + one(single, singleExported);
        }

        private static String one(ComponentName cn, boolean exported) {
            if (cn == null) return "없음";
            return cn.getClassName() + (exported ? "" : " (exported=false · 외부 실행 불가)");
        }
    }

    private static final class Job {
        final long id;
        final Context app;
        /** 대화방 참조. 화면 매칭은 ref.name, 세션 조회는 ref, 표시는 label */
        final RoomRef ref;
        /** 사용자에게 보여줄 이름 (계정이 2개 이상이면 계정명까지) */
        final String label;
        final ArrayList<String> uris;
        final Done onDone;

        /**
         * 경로별 결과 한 줄씩 ("채팅방 첨부 → 대화방 열기 인텐트 없음"). 로그·진단에 그대로 찍는다.
         * 이게 없으면 "실패했다" 만 남아서 어느 경로가 왜 막혔는지 아무도 모른다.
         */
        final ArrayList<String> routes = new ArrayList<String>(4);

        // ── 채팅방 첨부 경로 상태 ──
        /**
         * 사진별 후보 문자열 ({@link ImagePicker#kakaoDescList}). 시각을 읽은 사진만 들어간다.
         * <b>대기열에 넣기 전에(= 호출자 스레드에서) 미리 만들어 둔다</b> — MediaStore 조회와 EXIF
         * 읽기는 파일 I/O 라서 메인 루퍼에서 하면 ANR 위험이 있다.
         */
        final ArrayList<List<String>> descs;
        /** 시각을 못 읽어서 첨부 경로에서 제외한 장수 */
        final int noTime;
        /** 채팅방 열기 인텐트를 던진 시각 (0 = 아직) */
        volatile long attachAt = 0L;
        /** 첨부 경로를 실제로 시도했나 (진단에 "안 해봤다" 와 "해보고 실패" 를 구별해 적는다) */
        volatile boolean attachTried = false;
        /** 지금 쓰고 있는 사진 시각 후보 번호 (0 = 가장 유력한 값) */
        int attachVariant = 0;

        // ── 공유창 경로 상태 ──
        Share share = null;
        /** ACTION_SEND_MULTIPLE 수신 액티비티가 없어서 한 장씩 보내는 모드 */
        boolean single = false;
        /** 단건 모드에서 다음에 보낼 인덱스 */
        int cursor = 0;
        /** 이번 공유 세션에 실을 URI */
        ArrayList<String> batch = new ArrayList<String>();
        /** 공유 세션 번호. 워치독이 지난 세션에 대고 짖는 걸 막는다. */
        volatile long session = 0L;
        /** 이번 세션에서 순서대로 시도할 경로 */
        String[] paths = new String[0];
        int pathIdx = 0;
        /** 실패한 경로와 이유 (진단에 그대로 찍는다) */
        final ArrayList<String> trail = new ArrayList<String>(4);
        /** 성공한 경로 */
        String usedPath = "";
        /** 공유창 경로로 실제 보낸 장수 (단건 모드에서 중간 실패를 정직하게 적으려면 필요하다) */
        int sentByShare = 0;

        /** 공유 인텐트를 던진 시점에 앱이 화면에 있었나 (= 백그라운드 차단 판정 근거) */
        volatile boolean fg = false;
        /** 공유창을 띄우려고 WakeActivity 로 화면을 깨웠나 */
        volatile boolean woke = false;
        /** 공유 인텐트를 던진 시각 (0 = 아직) */
        volatile long launchedAt = 0L;
        /** WakeActivity 가 실제로 화면에 떴나 (안 떴으면 시스템 차단) */
        volatile boolean wakeShown = false;
        /** WakeActivity 가 공유 인텐트를 실행하다 만난 오류 */
        volatile String wakeErr = "";
        /** 백그라운드에서 공유창을 한 번도 못 본 실패였나 */
        volatile boolean bgMiss = false;
        /** 마지막으로 등록한 깨우기 감시자 id (0 = 없음). 끝날 때 반드시 해제한다. */
        volatile long wakeId = 0L;

        Job(long id, Context app, RoomRef ref, String label, ArrayList<String> uris,
            ArrayList<List<String>> descs, int noTime, Done onDone) {
            this.id = id;
            this.app = app;
            this.ref = ref;
            this.label = label;
            this.uris = uris;
            this.descs = descs;
            this.noTime = noTime;
            this.onDone = onDone;
        }
    }

    // ── 공개 API ────────────────────────────────────────────────────────────

    /**
     * room 방으로 사진을 보낸다. uris 는 최대 5장, 안 읽히는 건 알아서 걸러낸다.
     * onDone 은 성공이든 실패든 <b>정확히 한 번</b> 메인 스레드에서 불린다 (null 허용).
     */
    public static void send(Context ctx, RoomRef room, List<String> uris, final Runnable onDone) {
        sendWithResult(ctx, room, uris, new Done() {
            @Override public void done(boolean ok, String detail) {
                fire(onDone);
            }
        });
    }

    /** 저장값(키) 으로 부르는 구버전 호출부용. {@link RoomRef#parse} 로 풀어서 넘긴다. */
    public static void send(Context ctx, String room, List<String> uris, final Runnable onDone) {
        send(ctx, RoomRef.parse(room), uris, onDone);
    }

    /** 저장값(키) 으로 부르는 구버전 호출부용. {@link RoomRef#parse} 로 풀어서 넘긴다. */
    public static void sendWithResult(Context ctx, String room, List<String> uris, final Done onDone) {
        sendWithResult(ctx, RoomRef.parse(room), uris, onDone);
    }

    /**
     * 위와 같지만 <b>왜 실패했는지</b>까지 받는다. 진단 버튼이 이걸 쓴다.
     * onDone 은 성공이든 실패든 정확히 한 번 메인 스레드에서 불린다 (null 허용).
     *
     * (이름을 따로 둔 이유: send(.., null) 호출부가 있어서 오버로드로 만들면 컴파일이 모호해진다)
     */
    public static void sendWithResult(Context ctx, RoomRef room, List<String> uris, final Done onDone) {
        if (ctx == null) { fire(onDone, false, "앱 컨텍스트가 없습니다."); return; }
        Context app = ctx.getApplicationContext();
        if (app == null) app = ctx;
        final Context c = app;

        final RoomRef ref = (room == null) ? RoomRef.of("") : room;
        if (!ref.valid()) {
            Log.add(c, "이미지 전송을 취소했습니다. 방 이름이 비어 있습니다.");
            fire(onDone, false, "방 이름이 비어 있습니다.");
            return;
        }
        final String label = ref.label(c);

        if (uris == null || uris.isEmpty()) {
            Log.add(c, "이미지 전송을 취소했습니다. 첨부된 이미지가 없습니다.");
            fire(onDone, false, "첨부된 이미지가 없습니다.");
            return;
        }

        // 살아있는 것만, 최대 5장
        ArrayList<String> ok = new ArrayList<String>();
        int dead = 0;
        for (int i = 0; i < uris.size() && ok.size() < MAX; i++) {
            String s = uris.get(i);
            if (s == null || s.trim().length() == 0) continue;
            String u = s.trim();
            if (ok.contains(u)) continue;
            if (ImagePicker.alive(c, u)) ok.add(u);
            else dead++;
        }
        if (dead > 0) {
            Log.add(c, "첨부 이미지 " + dead + "장을 읽을 수 없어 제외했습니다. 파일이 삭제되었거나 접근 권한이 해제되었습니다. 이미지를 다시 선택하십시오.");
        }
        if (ok.isEmpty()) {
            Log.add(c, "이미지 전송을 취소했습니다. 전송 가능한 이미지가 없습니다.");
            fire(onDone, false, "첨부 이미지를 읽을 수 없습니다. 이미지를 다시 선택하십시오.");
            return;
        }
        if (uris.size() > MAX) {
            Log.add(c, "이미지는 최대 " + MAX + "장까지 전송됩니다. 앞의 " + ok.size() + "장만 전송합니다.");
        }

        // 타사 접근성 자동화 앱은 차단하지 않는다. 다만 클릭이 서로 엉켜 실패하는 사례가 있어
        // 전송을 시작하는 시점에 한 번은 반드시 알린다 (진단에도 같은 항목이 들어간다).
        warnOtherAccessibility(c);

        // 알림 답장으로 사진을 보낼 수 있는 방이면 접근성·오버레이·화면 상태가 전부 필요 없다.
        // 그래서 그 경우에는 여기서 막지 않는다 (막으면 제일 좋은 경로를 스스로 닫는 셈이다).
        if (!replyImageReady(c, ref)) {
            if (!accessibilityOn(c)) {
                Log.add(c, "접근성 권한이 비활성 상태여서 이미지를 전송하지 못했습니다. "
                        + "설정 › 접근성 › 설치된 앱 › 카톡 오토 · 자동 조작 을 활성화하십시오.");
                fire(onDone, false, "접근성 권한이 비활성 상태입니다.");
                return;
            }
            if (!overlayOn(c)) {
                // 앱을 직접 보고 있을 때는 이게 없어도 공유창이 뜬다. 그래서 막지는 않고 경고만 한다.
                Log.add(c, "「다른 앱 위에 표시」 권한이 비활성 상태입니다. 앱이 화면에 표시된 상태에서는 "
                        + "동작할 수 있으나, 예약 발송에서는 시스템이 공유창 실행을 차단할 수 있습니다. 설정에서 활성화하십시오.");
            }
        }

        // 채팅방 첨부 경로가 쓸 "사진 지목 문자열" 을 여기서 미리 만든다.
        //  ★ 반드시 여기서 만든다 — MediaStore 조회와 EXIF 읽기는 파일 I/O 이고,
        //    대기열 처리는 메인 루퍼에서 돌기 때문에 거기서 하면 사진 5장에 ANR 위험이 생긴다.
        //    (여기는 호출자 스레드다: 예약 발송은 백그라운드, 수동 발송은 UI 스레드이며
        //     UI 스레드에서는 바로 위 alive() 검사도 이미 같은 수준의 I/O 를 한다.)
        final ArrayList<List<String>> descs = new ArrayList<List<String>>(MAX);
        int missing = 0;
        for (int i = 0; i < ok.size(); i++) {
            List<String> cand = ImagePicker.kakaoDescList(c, ok.get(i));
            if (cand == null || cand.isEmpty()) {
                missing++;
                Log.add(c, "이미지의 촬영·저장 시각을 읽지 못했습니다 — " + ImagePicker.shortUri(ok.get(i))
                        + ". 채팅방 첨부 경로로는 이 사진을 지목할 수 없습니다.");
                continue;
            }
            descs.add(cand);
        }

        final ArrayList<String> list = ok;
        final int noTime = missing;
        main().post(new Runnable() {
            @Override public void run() {
                if (QUEUE.size() >= MAX_QUEUE) {
                    Log.add(c, "이미지 전송 대기열이 한도(" + MAX_QUEUE + "건)에 도달했습니다. 대화방 "
                            + label + " 건은 취소되었습니다.");
                    fire(onDone, false, "전송 대기열이 한도에 도달했습니다.");
                    return;
                }
                seq++;
                QUEUE.add(new Job(seq, c, ref, label, list, descs, noTime, onDone));
                pump();
            }
        });
    }

    /** 지금 전송 중인가 */
    public static boolean busy() {
        return busy;
    }

    /** 대기 중인 건수 */
    public static int pending() {
        return QUEUE.size();
    }

    /**
     * 접근성 서비스가 켜져 있나.
     * 서비스가 실제로 붙어있으면(connected) 그게 가장 확실하고,
     * 아니면 시스템 설정의 허용 목록을 본다.
     */
    public static boolean accessibilityOn(Context c) {
        if (KakaoAccessibility.connected()) return true;
        if (c == null) return false;
        try {
            String flat = android.provider.Settings.Secure.getString(c.getContentResolver(),
                    android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (flat == null || flat.trim().length() == 0) return false;
            String pkg = c.getPackageName();
            String cls = KakaoAccessibility.class.getName();
            String[] parts = flat.split(":");
            for (int i = 0; i < parts.length; i++) {
                String p = (parts[i] == null) ? "" : parts[i].trim();
                if (p.length() == 0) continue;
                if (p.equalsIgnoreCase(pkg + "/" + cls)) return true;
                if (p.equalsIgnoreCase(pkg + "/." + KakaoAccessibility.class.getSimpleName())) return true;
                ComponentName cn = ComponentName.unflattenFromString(p);
                if (cn != null && pkg.equals(cn.getPackageName()) && cls.equals(cn.getClassName())) return true;
            }
        } catch (Throwable t) {
            Log.add(c, "접근성 권한 상태를 확인하지 못했습니다 — " + t.getClass().getSimpleName());
        }
        return false;
    }

    /**
     * "다른 앱 위에 표시" 가 켜져 있나.
     * 앱이 화면에 없을 때 startActivity 를 시스템이 조용히 막는 경우(백그라운드 액티비티 차단)에
     * 이 권한이 면제 사유 중 하나로 쓰인다. <b>다만 유일한 사유는 아니고, 있다고 항상 통과하는 것도 아니다</b> —
     * 그래서 이 값 하나로 실패 원인을 단정하지 않는다. (오버레이 창을 그리는 데 쓰지는 않는다)
     */
    public static boolean overlayOn(Context c) {
        if (c == null) return false;
        try {
            return android.provider.Settings.canDrawOverlays(c);
        } catch (Throwable t) {
            return false;
        }
    }

    /** "다른 앱 위에 표시" 설정 화면 인텐트 (이 앱 항목으로 바로) */
    public static Intent overlaySettingsIntent(Context c) {
        Intent i = new Intent(android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION);
        try {
            if (c != null) i.setData(Uri.parse("package:" + c.getPackageName()));
        } catch (Throwable ignore) { }
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return i;
    }

    /** "다른 앱 위에 표시" 설정 열기 */
    public static void openOverlaySettings(Context c) {
        if (c == null) return;
        try {
            c.startActivity(overlaySettingsIntent(c));
            Ui.toast(c, "「카톡 오토」 항목을 활성화하십시오.");
        } catch (Throwable t) {
            Log.add(c, "「다른 앱 위에 표시」 설정 화면을 열지 못했습니다. 설정 › 애플리케이션 › 카톡 오토 에서 직접 활성화하십시오.");
            Ui.toast(c, "설정 › 애플리케이션 › 카톡 오토 › 다른 앱 위에 표시");
        }
    }

    /** 접근성 설정 화면으로 보내는 인텐트 */
    public static Intent settingsIntent() {
        Intent i = new Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        return i;
    }

    /** 접근성 설정 화면 열기. 못 열면 로그 + 토스트. */
    public static void openSettings(Context c) {
        if (c == null) return;
        try {
            c.startActivity(settingsIntent());
            Ui.toast(c, "설치된 앱 › 카톡 오토 · 자동 조작 을 활성화하십시오.");
        } catch (Throwable t) {
            Log.add(c, "접근성 설정 화면을 열지 못했습니다 (" + t.getClass().getSimpleName() + "). 설정 › 접근성 에서 직접 활성화하십시오.");
            Ui.toast(c, "설정 › 접근성 에서 직접 활성화하십시오.");
        }
    }

    // ── 앱이 화면에 있나 ─────────────────────────────────────────────────────

    /**
     * 우리 프로세스가 지금 화면에 표시된 상태인가.
     * 백그라운드 액티비티 차단은 예외를 던지지 않으므로, 실패를 해석할 때
     * "예약 발송(백그라운드)이었나 수동 발송(포그라운드)이었나" 가 가장 중요한 단서다.
     * 못 읽으면 <b>백그라운드로 본다</b> — 낙관적으로 보면 진단이 거짓말을 한다.
     */
    public static boolean foregroundNow(Context c) {
        if (c == null) return false;
        try {
            android.app.ActivityManager am =
                    (android.app.ActivityManager) c.getSystemService(Context.ACTIVITY_SERVICE);
            if (am == null) return false;
            List<android.app.ActivityManager.RunningAppProcessInfo> ps = am.getRunningAppProcesses();
            if (ps == null) return false;
            int mypid = android.os.Process.myPid();
            for (int i = 0; i < ps.size(); i++) {
                android.app.ActivityManager.RunningAppProcessInfo p = ps.get(i);
                if (p == null || p.pid != mypid) continue;
                return p.importance
                        <= android.app.ActivityManager.RunningAppProcessInfo.IMPORTANCE_FOREGROUND;
            }
        } catch (Throwable ignore) { }
        return false;
    }

    // ── 백그라운드 전송 불가 판정 ────────────────────────────────────────────

    /**
     * 백그라운드에서 공유창이 반복 실패해 "예약 발송으로는 이미지를 보낼 수 없다" 로 확정된 시각.
     * 0 이면 확정되지 않았다. {@link Scheduler} 가 이 값으로 "한 번만 알림" 을 판단한다.
     */
    public static long backgroundBlockedAt(Context c) {
        if (c == null) return 0L;
        try { return Prefs.getLong(c, K_BG_BLOCKED_AT, 0L); } catch (Throwable t) { return 0L; }
    }

    /**
     * 지금 이 방으로 이미지를 보내려 하면 <b>어차피 실패한다</b>고 볼 수 있나.
     * 세 조건이 동시에 맞을 때만 true 다 — 조건 하나라도 다르면 시도해봐야 한다.
     *   <ol>
     *     <li>백그라운드 전송 불가로 이미 확정됐다 ({@link #BG_FAIL_LIMIT} 회 연속 실패)</li>
     *     <li>그 방은 알림 답장으로 사진을 못 받는다 (답장 경로는 화면 상태와 무관하다)</li>
     *     <li>지금 앱이 화면에 없다 (화면에 있으면 공유창은 뜬다)</li>
     *   </ol>
     */
    public static boolean blockedInBackground(Context c, RoomRef ref) {
        if (c == null || ref == null || !ref.valid()) return false;
        if (backgroundBlockedAt(c) <= 0L) return false;
        if (replyImageReady(c, ref)) return false;
        if (foregroundNow(c)) return false;
        return true;
    }

    /**
     * 위와 같지만 <b>채팅방 첨부 경로까지</b> 따진다. 첨부 경로는 공유창과 무관하게 동작하므로
     * "공유창 불가 확정" 이 이 경로를 막는 근거가 되지 않는다 — 막아버리면 실제로 되는 경로를
     * 스스로 닫는 셈이다. 예약 발송({@link Scheduler})은 반드시 이 버전을 쓴다.
     *
     * @param uris 보낼 이미지. 사진의 촬영·저장 시각을 읽을 수 있어야 첨부 경로로 지목할 수 있다.
     */
    public static boolean blockedInBackground(Context c, RoomRef ref, List<String> uris) {
        if (!blockedInBackground(c, ref)) return false;
        if (attachReady(c, ref, uris)) return false;
        return true;
    }

    /** 백그라운드 전송 불가 확정을 해제한다 (사용자가 권한을 고치고 다시 시도할 때). */
    public static void clearBackgroundBlocked(Context c) {
        if (c == null) return;
        try {
            Prefs.remove(c, K_BG_BLOCKED_AT);
            Prefs.remove(c, K_BG_FAILS);
        } catch (Throwable ignore) { }
    }

    /** 백그라운드 공유창 실패 1회 적립. 한도에 닿으면 불가로 확정한다. */
    private static void bgFail(Context c) {
        if (c == null) return;
        try {
            int n = Prefs.getInt(c, K_BG_FAILS, 0) + 1;
            Prefs.putInt(c, K_BG_FAILS, n);
            if (n >= BG_FAIL_LIMIT && Prefs.getLong(c, K_BG_BLOCKED_AT, 0L) <= 0L) {
                Prefs.putLong(c, K_BG_BLOCKED_AT, System.currentTimeMillis());
                Log.add(c, "백그라운드 상태에서 카카오톡 공유창이 " + BG_FAIL_LIMIT
                        + "회 연속 표시되지 않았습니다. 예약 발송에서는 이미지를 생략하고 텍스트만 발송합니다. "
                        + "이미지는 앱이 화면에 표시된 상태에서 매크로 › 이미지 첨부 › 즉시 발송 으로 전송하십시오.");
            }
        } catch (Throwable ignore) { }
    }

    /** 전송이 한 번이라도 성공하면 적립을 비운다 (권한을 고쳤을 수 있다 — 다시 시도할 기회를 준다). */
    private static void bgOk(Context c) {
        if (c == null) return;
        try {
            if (Prefs.getInt(c, K_BG_FAILS, 0) != 0 || Prefs.getLong(c, K_BG_BLOCKED_AT, 0L) > 0L) {
                clearBackgroundBlocked(c);
            }
        } catch (Throwable ignore) { }
    }

    // ── 큐 돌리기 ────────────────────────────────────────────────────────────

    private static void pump() {
        if (busy) return;
        if (QUEUE.isEmpty()) return;
        Job j = QUEUE.remove(0);
        busy = true;
        current = j;
        start(j);
    }

    /**
     * 경로 선택. <b>A(알림 답장) → B(채팅방 첨부) → C(공유창)</b> 순서다.
     *
     * 공유창이 마지막인 이유는 실기기에서 한 번도 안 떴기 때문이다(확정된 사실).
     * 건너뛴 경로도 <b>왜 건너뛰었는지</b> 를 남긴다 — 그게 없으면 "채팅방 첨부를 시도했는데
     * 실패한 것" 과 "애초에 재료가 없어서 시도조차 못 한 것" 이 로그에서 똑같이 보인다.
     */
    private static void start(final Job j) {
        // 포그라운드 여부를 여기서 한 번 확정한다. 어느 경로로 가든 진단에 이 값이 필요하다
        // (예약 발송과 수동 발송은 실패 원인이 완전히 다르다).
        j.fg = foregroundNow(j.app);
        Log.add(j.app, "이미지 " + j.uris.size() + "장 전송을 시작합니다. 대화방: " + j.label
                + " · 앱 상태: " + fgText(j.fg) + " · 화면: " + screenState(j.app));

        // 경로 A — 되면 화면이 아예 안 움직인다.
        if (replyImageReady(j.app, j.ref)) {
            sendByReply(j, 0, 0);
            return;
        }
        route(j, R_REPLY, replyWhy(j.app, j.ref));
        afterReply(j);
    }

    /**
     * 알림 답장 경로를 못 쓰거나(또는 첫 장부터 실패해서) 화면 조작 경로로 내려왔다.
     * 채팅방 첨부 → 공유창 순서로 시도한다.
     */
    private static void afterReply(final Job j) {
        // 경로 B — 채팅방 첨부. 현장에서 구조가 전부 확인된 유일한 화면이다.
        if (startAttach(j)) return;

        // 경로 C — 공유창 폴백. 백그라운드에서 이미 불가로 확정됐으면 헛시도하지 않는다.
        if (!j.fg && backgroundBlockedAt(j.app) > 0L) {
            route(j, R_SHARE, "시도하지 않음(백그라운드 공유창 불가로 확정된 상태)");
            failAllRoutes(j);
            return;
        }
        startShare(j);
    }

    /** 알림 답장 경로를 못 쓰는 이유 한 줄 (진단에 그대로 찍힌다) */
    private static String replyWhy(Context c, RoomRef ref) {
        try {
            if (!replyImageEnabled(c)) return "건너뜀(설정에서 비활성)";
            if (!KakaoListener.listenerBound()) {
                return KakaoListener.connected(c)
                        ? "사용 불가(알림 리스너 미연결 — 카카오톡 알림 1회 수신 필요)"
                        : "사용 불가(알림 읽기 권한 비활성)";
            }
            java.util.Set<String> t = KakaoListener.imageTypesFor(ref);
            if (t == null || t.isEmpty()) {
                return "사용 불가(카카오톡이 답장창에 이미지 타입을 제공하지 않거나 대화방 세션 없음)";
            }
            return "사용 불가(원인 미확정)";
        } catch (Throwable t) {
            return "확인 실패(" + t.getClass().getSimpleName() + ")";
        }
    }

    /** 경로 결과 한 줄 적립 */
    private static void route(Job j, String name, String why) {
        if (j == null) return;
        j.routes.add(name + " → " + why);
    }

    /** 경로 기록을 한 줄로 */
    private static String routeText(Job j) {
        if (j.routes.isEmpty()) return "없음";
        StringBuilder b = new StringBuilder(160);
        for (int i = 0; i < j.routes.size(); i++) {
            if (i > 0) b.append(" / ");
            b.append(j.routes.get(i));
        }
        return b.toString();
    }

    /** 포그라운드 여부를 사람 말로 (로그·진단에서 같은 문구를 쓴다) */
    private static String fgText(boolean fg) {
        return fg ? "화면 표시 중(수동 발송)" : "백그라운드(예약 발송)";
    }

    /**
     * 세 경로가 모두 막혔다. <b>정직하게</b> 끝낸다 — 백그라운드면 텍스트만 나간 상태이므로
     * 그 사실을 남긴다({@link Scheduler} 가 이 결과를 받아 하루 1회만 사용자에게 알린다).
     */
    private static void failAllRoutes(final Job j) {
        String why = "이미지 전송 가능한 경로가 없습니다. " + routeText(j)
                + (j.fg ? "" : " 예약 발송(백그라운드)에서는 이미지를 생략하고 텍스트만 발송됩니다.");
        // since 에 첨부 시도 시각을 넘긴다 — 접근성이 그 뒤에 더 자세한 화면 덤프를 남겼으면
        // 이 요약으로 덮지 않는다(덮으면 진단이 후퇴한다).
        diag(j, "전송 경로 없음 — 알림 답장·채팅방 첨부·공유창 모두 사용 불가", j.attachAt, why);
        Log.add(j.app, "이미지 전송 실패: " + why);
        if (!j.fg) j.bgMiss = true;
        finish(j.id, false, why);
    }

    // ── 경로 A: 알림 답장에 사진 첨부 ──────────────────────────────────────────

    /** 알림 답장 사진 경로를 사용자가 껐나 (Prefs 평문 키) */
    private static final String K_REPLY_IMG_OFF = "reply_img_off";

    /** 알림 답장으로 사진 보내기가 켜져 있나 (기본 켜짐) */
    public static boolean replyImageEnabled(Context c) {
        return !Prefs.getBool(c, K_REPLY_IMG_OFF, false);
    }

    /**
     * 알림 답장 사진 경로를 켜고 끈다.
     * 카톡이 "이미지 받는다" 고 선언해놓고 실제로는 무시하는 경우가 있을 수 있는데,
     * 그러면 앱은 보낸 줄 알고 성공으로 보고한다(카톡이 올렸는지 확인할 API 가 없다).
     * 사용자가 "로그엔 보냈다는데 카톡엔 안 올라왔다" 를 발견하면 이걸 꺼서 공유창 경로로 되돌린다.
     */
    public static void setReplyImageEnabled(Context c, boolean on) {
        Prefs.putBool(c, K_REPLY_IMG_OFF, !on);
        Log.add(c, on ? "이미지를 알림 답장으로 발송 — 활성화 (화면 조작이 발생하지 않습니다)"
                      : "이미지를 알림 답장으로 발송 — 비활성화 (공유창을 통해 발송합니다)");
    }

    /**
     * 이 방에 알림 답장으로 사진을 보낼 수 있나.
     * 알림 읽기 권한이 붙어 있고, 그 방 세션이 살아있고, 카톡이 이미지 타입을 허용해둬야 한다.
     */
    public static boolean replyImageReady(Context c, RoomRef ref) {
        try {
            if (ref == null || !ref.valid()) return false;
            if (!replyImageEnabled(c)) return false;
            if (!KakaoListener.listenerBound()) return false;
            java.util.Set<String> types = KakaoListener.imageTypesFor(ref);
            return types != null && !types.isEmpty();
        } catch (Throwable t) {
            return false;
        }
    }

    /** 저장값(키) 으로 부르는 구버전 호출부용 */
    public static boolean replyImageReady(Context c, String room) {
        return replyImageReady(c, RoomRef.parse(room));
    }

    /**
     * 사진을 한 장씩 알림 답장으로 보낸다. 메인 스레드에서만 돈다.
     *
     * 한 장도 못 보냈으면 공유창 경로로 폴백한다. 이미 몇 장 나갔으면 폴백하지 않는다 —
     * 공유창으로 다시 보내면 나간 장이 중복된다(그게 더 나쁘다).
     *
     * 카톡이 실제로 올렸는지는 확인할 방법이 없으니 <b>어느 경로로 보냈는지 로그에 남긴다.</b>
     */
    private static void sendByReply(final Job j, final int idx, final int sent) {
        if (current == null || current.id != j.id) return;   // 이미 끝난 건

        if (idx >= j.uris.size()) {
            route(j, R_REPLY, "성공(" + sent + "장)");
            Log.add(j.app, "이미지 " + sent + "장을 알림 답장으로 전송했습니다. 대화방: " + j.label
                    + " · 화면 조작은 발생하지 않았습니다. 카카오톡에서 실제 업로드 여부를 확인하십시오.");
            finish(j.id, true, "알림 답장으로 " + sent + "장을 전송했습니다(화면 조작 없음). 카카오톡에서 업로드 여부를 확인하십시오.");
            return;
        }

        Uri u = null;
        try { u = Uri.parse(j.uris.get(idx)); } catch (Throwable ignore) { }

        boolean ok = (u != null) && KakaoListener.sendImageTo(j.app, j.ref, u);
        if (!ok) {
            if (sent == 0) {
                route(j, R_REPLY, "실패(첫 장부터 카카오톡이 받지 않음)");
                Log.add(j.app, "알림 답장 경로로 이미지를 전송하지 못했습니다. 화면 조작 경로로 전환합니다"
                        + "(카카오톡 화면이 일시적으로 전환됩니다).");
                afterReply(j);
                return;
            }
            route(j, R_REPLY, "부분 성공(" + sent + "/" + j.uris.size() + "장)");
            Log.add(j.app, "알림 답장으로 " + sent + "/" + j.uris.size() + "장만 전송했습니다. 대화방: " + j.label
                    + ". 남은 " + (j.uris.size() - sent) + "장은 직접 전송하십시오"
                    + "(중복 발송 방지를 위해 공유창 경로로 재시도하지 않습니다).");
            diag(j, "알림 답장 " + (idx + 1) + "번째 이미지에서 실패", 0L, "앞의 " + sent + "장은 이미 전송되었습니다.");
            finish(j.id, false, "알림 답장으로 " + sent + "장만 전송했습니다. 남은 이미지는 직접 전송하십시오.");
            return;
        }

        final int next = sent + 1;
        main().postDelayed(new Runnable() {
            @Override public void run() { sendByReply(j, idx + 1, next); }
        }, REPLY_GAP_MS);
    }

    // ── 경로 B: 채팅방 내부 첨부 시트 ─────────────────────────────────────────
    //
    //  근거: docs/field/kakao-attach-sheet-26.8.2.md (실기기 뷰 트리, 카카오톡 26.8.2)
    //   · 첨부 메뉴 목록 rv_chat_tool · 항목 이름은 `앨범` 이 아니라 `사진`
    //   · 최근 사진 스트립 rv_media · 썸네일 desc="사진, 9월 28일 오전 8:20"
    //   · 전송 버튼 btn_send 의 enabled 가 선택 여부를 그대로 반영한다
    //  화면 조작은 KakaoAccessibility.armAttach 가 한다. 여기서는 재료(사진 지목 문자열)를
    //  만들고 채팅방을 열어주는 일까지만 한다.

    /** 채팅방 첨부 경로를 사용자가 껐나 (Prefs 평문 키) */
    private static final String K_ATTACH_OFF = "attach_img_off";

    /** 채팅방 첨부 경로가 켜져 있나 (기본 켜짐) */
    public static boolean attachEnabled(Context c) {
        return !Prefs.getBool(c, K_ATTACH_OFF, false);
    }

    /**
     * 채팅방 첨부 경로를 켜고 끈다.
     * 이 경로는 카카오톡 화면을 실제로 조작하므로(채팅방이 열리고 시트가 떴다 닫힌다),
     * 화면이 움직이는 걸 원하지 않는 사용자는 끌 수 있어야 한다.
     */
    public static void setAttachEnabled(Context c, boolean on) {
        Prefs.putBool(c, K_ATTACH_OFF, !on);
        Log.add(c, on ? "이미지를 채팅방 첨부로 발송 — 활성화 (채팅방이 열리고 화면이 조작됩니다)"
                      : "이미지를 채팅방 첨부로 발송 — 비활성화 (공유창을 통해 발송합니다)");
    }

    /**
     * 이 방으로 채팅방 첨부 경로를 쓸 수 있나 (재료가 다 있나).
     * 세 가지가 전부 필요하다 — 접근성 권한 · 채팅방을 여는 알림 인텐트 · 사진을 지목할 시각.
     */
    public static boolean attachReady(Context c, RoomRef ref, List<String> uris) {
        if (c == null || ref == null || !ref.valid()) return false;
        if (!attachEnabled(c)) return false;
        if (!accessibilityOn(c)) return false;
        try {
            if (KakaoListener.openIntentFor(ref) == null) return false;
        } catch (Throwable t) {
            return false;
        }
        if (uris == null) return false;
        for (int i = 0; i < uris.size(); i++) {
            if (ImagePicker.kakaoDesc(c, uris.get(i)) != null) return true;
        }
        return false;
    }

    /**
     * 채팅방 첨부 경로를 시작한다 (재료 확인 + 첫 후보로 첫 시도).
     *
     * @return true 면 이 경로가 건을 가져갔다(결과는 콜백으로 온다). false 면 <b>시도조차 못 했고</b>
     *         이유를 {@code j.routes} 에 적었으니 호출부가 다음 경로로 내려가야 한다.
     */
    private static boolean startAttach(final Job j) {
        if (!attachEnabled(j.app)) {
            route(j, R_ATTACH, "건너뜀(설정에서 비활성)");
            return false;
        }
        if (!accessibilityOn(j.app)) {
            route(j, R_ATTACH, "사용 불가(접근성 권한 비활성)");
            return false;
        }

        // 1) 사진을 시각으로 지목할 수 있나 (후보는 대기열에 넣기 전에 이미 만들어져 있다).
        //    시각을 못 읽은 사진은 이 경로로 지목할 수 없다.
        if (j.descs.isEmpty()) {
            route(j, R_ATTACH, "사용 불가(첨부 이미지 " + j.uris.size()
                    + "장 전부 촬영·저장 시각을 읽지 못해 사진을 지목할 수 없음)");
            return false;
        }
        if (j.noTime > 0) {
            Log.add(j.app, "첨부 이미지 " + j.noTime + "장은 촬영·저장 시각을 읽지 못해 채팅방 첨부 경로에서 제외합니다. "
                    + j.descs.size() + "장만 전송합니다.");
        }

        // 2) 채팅방을 여는 수단이 있나. 알림 contentIntent 가 유일한 직행 수단이다.
        if (openIntent(j) == null) {
            route(j, R_ATTACH, "사용 불가(대화방 열기 인텐트 없음 — 해당 대화방의 카카오톡 알림이 "
                    + "1회 이상 수신되어야 생성됨)");
            return false;
        }

        j.attachVariant = 0;
        return attachAttempt(j);
    }

    /** 대화방을 여는 알림 인텐트 (없으면 null) */
    private static android.app.PendingIntent openIntent(Job j) {
        try { return KakaoListener.openIntentFor(j.ref); } catch (Throwable t) { return null; }
    }

    /**
     * 첨부 경로 한 번 시도 — {@code j.attachVariant} 번째 후보로 예약하고 채팅방을 연다.
     *
     * @return true 면 시도했다(결과는 콜백 또는 워치독으로 온다). false 면 시도하지 못했다.
     */
    private static boolean attachAttempt(final Job j) {
        android.app.PendingIntent open = openIntent(j);
        if (open == null) {
            route(j, R_ATTACH, "사용 불가(대화방 열기 인텐트 만료 — 카카오톡이 해당 알림을 정리함)");
            return false;
        }

        // 접근성에 "채팅방 첨부 시트에서 이 사진들을 골라 보내라" 예약. 방을 여는 건 우리 몫이다.
        j.session++;
        final long sess = j.session;
        final int variant = j.attachVariant;
        j.attachTried = true;
        if (armAttach(j, sess, variant) == 0L) {
            j.attachTried = false;
            route(j, R_ATTACH, "사용 불가(접근성 첨부 흐름 예약 실패)");
            return false;
        }

        // 채팅방 열기. 이미 그 방이 열려 있어도 그냥 던진다 — 같은 방을 앞으로 가져오는 것뿐이라
        // 부작용이 없고, "열려 있나" 를 우리가 알 방법이 없어서 조건을 걸면 그 판정이 새 실패 지점이 된다.
        // 백그라운드에서는 이 단계도 시스템이 막을 수 있는데, 막히면 예외가 아니라
        // "카톡 창이 안 뜸" 으로만 나타나므로 워치독으로 판정한다.
        try {
            open.send(j.app, 0, null, null, null, null, attachOptions());
        } catch (android.app.PendingIntent.CanceledException e) {
            KakaoAccessibility.disarm();
            j.attachTried = false;
            route(j, R_ATTACH, "사용 불가(대화방 열기 인텐트 만료 — 카카오톡이 해당 알림을 정리함)");
            return false;
        } catch (Throwable t) {
            KakaoAccessibility.disarm();
            j.attachTried = false;
            route(j, R_ATTACH, "사용 불가(대화방 열기 실패 " + t.getClass().getSimpleName() + ")");
            return false;
        }
        j.attachAt = System.currentTimeMillis();

        Log.add(j.app, "채팅방 첨부 경로로 이미지 " + j.descs.size() + "장을 전송합니다. 대화방: " + j.label
                + " · 앱 상태: " + fgText(j.fg)
                + " · 사진 지목: \"" + descsFor(j, variant)[0] + "\""
                + (variant == 0 ? "" : " (후보 " + (variant + 1) + "번)"));

        // 채팅방이 뜨는지 본다. 안 뜨면 백그라운드 액티비티 차단이다 → 공유창 폴백으로.
        final long at = j.attachAt;
        main().postDelayed(new Runnable() {
            @Override public void run() {
                if (current == null || current.id != j.id || j.session != sess) return;
                // 채팅방이 이미 열려 있었으면 새 창 이벤트가 안 날 수도 있다. 그때는 접근성이
                // 이번 시도에서 카톡 이벤트를 몇 건이라도 받았는지로 판정한다 —
                // 진행 중인 시도를 6초에 끊어버리면 되는 경로를 우리가 망치는 셈이다.
                if (KakaoAccessibility.sawKakaoSince(at)) return;   // 떴다 — 계속 기다린다
                if (KakaoAccessibility.kakaoEventCount() > 0) return;
                attachGiveUp(j, sess, "카카오톡 채팅방이 " + (ATTACH_OPEN_MS / 1000)
                        + "초 내에 표시되지 않았습니다"
                        + (j.fg ? "" : " (시스템이 백그라운드 상태의 화면 실행을 차단한 것으로 판단됩니다)"), false);
            }
        }, ATTACH_OPEN_MS);

        // 접근성이 아무 신호도 안 주는 경우의 최후 방어선
        main().postDelayed(new Runnable() {
            @Override public void run() {
                if (current == null || current.id != j.id || j.session != sess) return;
                // 후보를 바꿔도 같은 자리에서 또 40초를 버린다. 접근성이 응답하지 않는 상태이므로
                // 재시도하지 않고 바로 다음 경로로 내려간다.
                attachGiveUp(j, sess, "시간 초과(" + (TIMEOUT_MS / 1000)
                        + "초) — 접근성 서비스가 첨부 결과를 전달하지 않았습니다", false);
            }
        }, TIMEOUT_MS);
        return true;
    }

    /**
     * 백그라운드에서도 알림 인텐트가 액티비티를 띄울 수 있게 옵션을 붙인다 (API 34+).
     * 없으면 null 을 돌려주고 그냥 던진다 — 옵션이 없어서 막히는 것과 예외는 다른 문제다.
     */
    private static android.os.Bundle attachOptions() {
        try {
            if (android.os.Build.VERSION.SDK_INT < 34) return null;
            android.app.ActivityOptions o = android.app.ActivityOptions.makeBasic();
            o.setPendingIntentBackgroundActivityStartMode(
                    android.app.ActivityOptions.MODE_BACKGROUND_ACTIVITY_START_ALLOWED);
            return o.toBundle();
        } catch (Throwable t) {
            return null;
        }
    }

    /**
     * 첨부 경로 한 시도가 실패했다.
     *
     * 카카오톡 창이 떴다면(= 채팅방까지는 갔다) 실패 원인은 사진 지목 쪽일 수 있으므로
     * <b>다음 후보(±1분·다른 시각 출처)로 한 번 더</b> 시도한다. 창이 아예 안 떴으면 후보를 바꿔도
     * 같은 결과라서 바로 공유창 폴백으로 내려간다.
     */
    private static void attachGiveUp(final Job j, final long sess, String why, boolean retryable) {
        if (current == null || current.id != j.id || j.session != sess) return;
        j.session++;   // 이 경로의 워치독을 전부 무효화한다

        // ★ disarm() 보다 먼저 읽는다. disarm 이 이번 시도의 이벤트 카운터를 비운다.
        boolean sawRoom = (j.attachAt > 0L)
                && (KakaoAccessibility.sawKakaoSince(j.attachAt) || KakaoAccessibility.kakaoEventCount() > 0);
        KakaoAccessibility.disarm();
        route(j, R_ATTACH, "후보 " + (j.attachVariant + 1) + "번 실패(" + why + ")");

        if (retryable && sawRoom && j.attachVariant + 1 < variantCount(j)) {
            j.attachVariant++;
            String next = descsFor(j, j.attachVariant)[0];
            Log.add(j.app, "채팅방 첨부 경로 실패: " + why + ". 사진 시각 후보를 \"" + next
                    + "\" 로 바꿔 재시도합니다(표시 시각이 1분 차이날 수 있습니다).");
            if (attachAttempt(j)) return;
        }
        Log.add(j.app, "채팅방 첨부 경로 실패: " + why + ". 공유창 경로로 전환합니다.");

        if (!j.fg && backgroundBlockedAt(j.app) > 0L) {
            route(j, R_SHARE, "시도하지 않음(백그라운드 공유창 불가로 확정된 상태)");
            failAllRoutes(j);
            return;
        }
        startShare(j);
    }

    /** 접근성이 첨부 경로의 결과를 알려왔다 */
    private static void attachDone(final Job j, final long sess, boolean ok, String detail) {
        if (current == null || current.id != j.id || j.session != sess) return;

        if (ok) {
            j.session++;   // 워치독 무효화
            route(j, R_ATTACH, "성공(" + j.descs.size() + "장)");
            String head = "이미지 " + j.descs.size() + "장을 채팅방 첨부로 전송했습니다.";
            Log.add(j.app, head + " 대화방: " + j.label
                    + (j.noTime > 0 ? (" · 시각 확인 불가 " + j.noTime + "장 제외") : "")
                    + " · " + routeText(j));
            if (j.noTime == 0) {
                finish(j.id, true, head);
            } else {
                // 일부만 나갔다. 성공으로 보고하면 사용자는 전부 갔다고 믿는다 — 그게 실패보다 나쁘다.
                finish(j.id, false, "이미지 " + j.descs.size() + "/" + j.uris.size()
                        + "장만 전송했습니다. 나머지 " + j.noTime
                        + "장은 촬영·저장 시각을 읽지 못해 카카오톡 첨부 화면에서 지목할 수 없었습니다. "
                        + "해당 이미지를 다시 선택하십시오.");
            }
            return;
        }
        attachGiveUp(j, sess, (detail == null || detail.length() == 0) ? "원인 확인 불가" : detail, true);
    }

    // ── KakaoAccessibility.armAttach 연결부 ───────────────────────────────────

    /**
     * 첨부 시트 흐름을 예약한다.
     *
     * {@code armAttach} 의 계약은 <b>사진 1장 = desc 1개</b>다 (접근성 쪽이 배열 길이를 대상 장수로 읽고,
     * 화면에서 못 찾은 desc 가 하나라도 있으면 실패로 끝낸다). 그래서 ±1분 후보를 한 번에 같이 넘기면
     * 있지도 않은 사진을 찾다가 반드시 실패한다 — 후보는 <b>시도를 나눠서</b> 쓴다
     * ({@link #attachGiveUp} 이 다음 후보로 한 번 더 예약한다).
     *
     * @param variant 후보 번호. 0 이 가장 유력한 값이고, 그 뒤가 ±1분·다른 시각 출처다.
     * @return 예약 id (0 이면 예약 실패)
     */
    private static long armAttach(final Job j, final long sess, int variant) {
        String[] want = descsFor(j, variant);
        if (want.length == 0) return 0L;
        try {
            return KakaoAccessibility.armAttach(j.ref, want, TIMEOUT_MS,
                    new KakaoAccessibility.Result() {
                        @Override public void done(final boolean ok, final String detail) {
                            main().post(new Runnable() {
                                @Override public void run() { attachDone(j, sess, ok, detail); }
                            });
                        }
                    }, j.app);
        } catch (Throwable t) {
            Log.add(j.app, "채팅방 첨부 예약에 실패했습니다 — " + t.getClass().getSimpleName());
            return 0L;
        }
    }

    /**
     * variant 번째 후보로 사진별 desc 하나씩 (= 접근성에 넘길 배열).
     * 그 사진에 후보가 그만큼 없으면 가장 유력한 첫 후보를 쓴다.
     */
    private static String[] descsFor(Job j, int variant) {
        String[] out = new String[j.descs.size()];
        for (int i = 0; i < j.descs.size(); i++) {
            List<String> c = j.descs.get(i);
            out[i] = c.get((variant < c.size()) ? variant : 0);
        }
        return out;
    }

    /** 사진 지목 후보가 가장 많은 사진의 후보 개수 (= 시도해볼 수 있는 variant 수) */
    private static int variantCount(Job j) {
        int n = 0;
        for (int i = 0; i < j.descs.size(); i++) {
            int c = j.descs.get(i).size();
            if (c > n) n = c;
        }
        return (n > ATTACH_TRIES) ? ATTACH_TRIES : n;
    }

    // ── 경로 C: 공유창 + 접근성 조작 (폴백) ────────────────────────────────────

    private static void startShare(final Job j) {
        // 여기까지 왔으면 접근성이 반드시 필요하다.
        // (대기열에 들어갈 때는 알림 답장 경로가 살아있어서 접근성 검사를 안 했을 수 있고,
        //  그 사이 세션이 죽어서 이리로 떨어지기도 한다. 그때 40초를 통째로 버리면 안 된다.)
        if (!accessibilityOn(j.app)) {
            route(j, R_SHARE, "사용 불가(접근성 권한 비활성)");
            diag(j, "공유창 경로가 필요하나 접근성 권한이 비활성 상태", 0L,
                    "알림 답장 경로도 사용할 수 없는 상태입니다. 두 경로 모두 차단되어 전송이 불가합니다.");
            Log.add(j.app, "이미지 전송 실패: 공유창 경로가 필요하나 접근성 권한이 비활성 상태입니다. "
                    + "설정 › 접근성 › 설치된 앱 › 카톡 오토 · 자동 조작 을 활성화하십시오.");
            finish(j.id, false, "접근성 권한이 비활성 상태입니다.");
            return;
        }

        // ── 원인 (a) 판별: 카톡에 받을 액티비티가 아예 없나 ──
        //  매니페스트에 <queries><package com.kakao.talk> 가 있어서 QUERY_ALL_PACKAGES 없이 조회된다.
        //  "받을 액티비티 없음" 과 "던졌는데 응답 없음" 은 완전히 다른 원인인데,
        //  이 조회 없이는 둘을 절대 구별할 수 없다.
        Share sh = resolveShare(j.app);
        j.share = sh;
        if (sh.queryFailed) {
            // 조회가 안 됐을 뿐이다. 이걸 "없음" 으로 읽고 포기하면 보낼 수 있는 건도 못 보낸다.
            Log.add(j.app, "카카오톡 공유 수신 대상을 조회하지 못했습니다. 조회 없이 전송을 시도합니다.");
        } else if (sh.none()) {
            route(j, R_SHARE, "사용 불가(카카오톡에 이미지 공유 수신 대상 없음)");
            diag(j, "카카오톡에 이미지 공유를 받을 대상이 없습니다", 0L,
                    "queryIntentActivities 결과가 비어 있습니다. 카카오톡 버전이 이미지 공유를 지원하지 않거나 "
                    + "설치가 손상되었습니다. 카카오톡을 최신 버전으로 업데이트하십시오.");
            Log.add(j.app, "이미지 전송 실패: 카카오톡에 이미지 공유 수신 대상이 없습니다 ("
                    + kakaoInfo(j.app) + "). 카카오톡을 최신 버전으로 업데이트하십시오.");
            finish(j.id, false, "카카오톡이 이미지 공유를 받을 수 없는 상태입니다. 카카오톡을 최신 버전으로 업데이트하십시오.");
            return;
        }
        // ACTION_SEND_MULTIPLE 을 안 받는 버전이면 한 장씩 보낸다 (조건부 폴백 — 기본 경로가 아니다).
        // 조회가 실패한 경우에는 폴백하지 않는다 — 근거 없이 4장을 4건으로 쪼개면 도배가 된다.
        j.single = !sh.queryFailed && sh.multi == null && sh.single != null;
        if (j.single && j.uris.size() > 1) {
            Log.add(j.app, "카카오톡이 여러 장 동시 공유(ACTION_SEND_MULTIPLE)를 지원하지 않습니다. "
                    + j.uris.size() + "장을 한 장씩 순서대로 전송합니다.");
        }

        j.cursor = 0;
        j.sentByShare = 0;
        openSession(j);
    }

    /** 공유 세션 하나를 연다 (= 예약 + 경로 순서 결정 + 첫 경로 시도) */
    private static void openSession(final Job j) {
        if (current == null || current.id != j.id) return;

        j.session++;
        final long sess = j.session;

        j.batch = new ArrayList<String>(MAX);
        if (j.single) {
            j.batch.add(j.uris.get(j.cursor));
        } else {
            j.batch.addAll(j.uris);
        }
        j.launchedAt = 0L;
        j.wakeShown = false;
        j.wakeErr = "";
        j.usedPath = "";
        j.woke = false;
        j.trail.clear();
        j.pathIdx = 0;

        // 경로 순서. 앱이 화면에 있으면 직접 실행이 가장 짧다(불필요한 단계는 그 자체가 실패 지점).
        // 화면에 없거나 잠겨 있으면 우리 액티비티를 먼저 띄워 포그라운드 호출자로 만든다.
        final boolean ready = screenReady(j.app);
        final boolean fg = foregroundNow(j.app);
        j.fg = fg;
        j.paths = (ready && fg)
                ? new String[] { P_DIRECT, P_COMPONENT }
                : new String[] { P_WAKE, P_DIRECT, P_COMPONENT };

        // 결과 콜백을 먼저 꽂아두고 공유창을 띈다 (순서 바뀌면 빠른 응답을 놓친다)
        //  ★ ctx(j.app)를 반드시 같이 넘긴다. 접근성 설정은 켜져 있는데 서비스가 실제로는
        //    안 붙어 있는 상태(업데이트 직후·시스템이 죽인 뒤)가 현장에서 제일 흔한 실패인데,
        //    ctx 없이 부르면 arm 쪽 안내 로그가 Log.add(null) 로 사라지고 그 시점 덤프도 안 남는다.
        //  ★ RoomRef 를 그대로 넘기는 오버로드를 쓴다. 이름과 계정을 한 문자열로 합치지 않는 게
        //    핵심이다 — 화면에서 찾는 것은 ref.name, 계정까지 필요한 조회는 ref.key() 다.
        KakaoAccessibility.arm(j.ref, TIMEOUT_MS, new KakaoAccessibility.Result() {
            @Override public void done(final boolean ok, final String detail) {
                main().post(new Runnable() {
                    @Override public void run() { shareDone(j, sess, ok, detail); }
                });
            }
        }, j.app);

        Log.add(j.app, "이미지 " + j.batch.size() + "장의 공유창을 실행합니다(폴백 경로). 대화방: " + j.label
                + " · 앱 상태: " + fgText(fg)
                + " · 화면: " + (ready ? "사용 가능" : screenState(j.app))
                + " · 수신 대상: " + sh(j).text());

        tryPath(j, sess);

        // 세션 전체 한도. 접근성이 아무 신호도 안 주는 경우의 최후 방어선.
        main().postDelayed(new Runnable() {
            @Override public void run() {
                if (current == null || current.id != j.id || j.session != sess) return;
                diag(j, "시간 초과(" + (TIMEOUT_MS / 1000) + "초) — 접근성 서비스가 신호를 전달하지 않았습니다.",
                        j.launchedAt, "접근성 서비스가 화면 기록도 남기지 못했습니다. 서비스가 연결되지 않았거나 종료된 상태로 판단됩니다.");
                KakaoAccessibility.disarm();
                Log.add(j.app, "이미지 전송 시간 초과(" + (TIMEOUT_MS / 1000)
                        + "초): 카카오톡 공유창에서 대화방을 선택하지 못했습니다. 접근성 권한과 대화방 이름을 확인하십시오.");
                finish(j.id, false, "시간 초과: 접근성 서비스가 원인을 기록하지 못했습니다. "
                        + "접근성 권한을 재설정한 후 다시 시도하십시오.");
            }
        }, TIMEOUT_MS);
    }

    private static Share sh(Job j) {
        return (j.share == null) ? new Share() : j.share;
    }

    /**
     * 로그·진단에 쓸 경로 이름.
     * 컴포넌트 조회에 실패했으면 세 번째 경로는 "컴포넌트 지정" 이 아니라 그냥 재시도다 —
     * 하지 않은 일을 했다고 적으면 진단이 거짓말을 한다.
     */
    private static String pathLabel(Job j, String id) {
        if (!P_COMPONENT.equals(id)) return id;
        Share s = sh(j);
        boolean have = j.single
                ? (s.single != null && s.singleExported)
                : (s.multi != null && s.multiExported);
        return have ? P_COMPONENT : "직접 실행(재시도 · 대상 조회 실패)";
    }

    /** 이번 세션의 pathIdx 번째 경로로 공유 인텐트를 던진다 */
    private static void tryPath(final Job j, final long sess) {
        if (current == null || current.id != j.id || j.session != sess) return;
        if (j.pathIdx >= j.paths.length) { shareFail(j, sess); return; }

        final int pi = j.pathIdx;
        final String path = j.paths[pi];

        Intent i = shareIntent(j, P_COMPONENT.equals(path));
        if (i == null) {
            // 공유창을 띄우기도 전에 죽는다 → 접근성 덤프가 없다. 최소 진단이라도 남긴다.
            diag(j, "이미지 주소(URI) 파싱 실패 — 공유 인텐트를 생성하지 못했습니다.", 0L,
                    "첨부 " + j.batch.size() + "개 전부 Uri.parse 단계에서 실패했습니다.");
            KakaoAccessibility.disarm();
            Log.add(j.app, "이미지 전송 실패: 이미지 주소가 손상되었습니다. 진단 기록을 저장했습니다"
                    + " (매크로 › 이미지 첨부 › 화면 진단 보기).");
            finish(j.id, false, "이미지 주소가 손상되었습니다. 진단 기록을 저장했습니다 (매크로 › 이미지 첨부 › 화면 진단 보기).");
            return;
        }

        if (P_WAKE.equals(path)) {
            final long wid = j.id * 1000L + sess;
            j.woke = true;
            j.wakeId = wid;
            WakeActivity.watch(wid, new WakeActivity.Watcher() {
                @Override public void shown(long id) {
                    j.wakeShown = true;
                }
                @Override public void launched(long id, String err) {
                    if (err != null && err.length() > 0) j.wakeErr = err;
                }
            });
            try {
                j.app.startActivity(WakeActivity.wrap(j.app, i, wid));
            } catch (Throwable t) {
                WakeActivity.unwatch(wid);
                j.wakeId = 0L;
                nextPath(j, sess, pi, "startActivity 예외 " + t.getClass().getSimpleName());
                return;
            }
            j.launchedAt = System.currentTimeMillis();
            j.usedPath = pathLabel(j, path);

            // 우리 액티비티조차 안 떴으면 시스템이 액티비티 실행을 차단한 것이다.
            // 차단은 예외를 던지지 않으므로 이 신호 말고는 구별할 방법이 없다.
            main().postDelayed(new Runnable() {
                @Override public void run() {
                    if (current == null || current.id != j.id || j.session != sess) return;
                    if (j.pathIdx != pi) return;
                    if (j.wakeShown) return;
                    nextPath(j, sess, pi, "화면 활성화 단계가 실행되지 않았습니다"
                            + " (시스템이 백그라운드 상태의 화면 실행을 차단한 것으로 판단됩니다)");
                }
            }, WAKE_SHOW_MS);
        } else {
            try {
                j.app.startActivity(i);
            } catch (Throwable t) {
                nextPath(j, sess, pi, "startActivity 예외 " + t.getClass().getSimpleName());
                return;
            }
            j.launchedAt = System.currentTimeMillis();
            j.usedPath = pathLabel(j, path);
        }

        final long launchedAt = j.launchedAt;
        // 공유창이 뜨는지 본다. 넘으면 다음 경로로 올라간다.
        main().postDelayed(new Runnable() {
            @Override public void run() {
                if (current == null || current.id != j.id || j.session != sess) return;
                if (j.pathIdx != pi) return;
                if (KakaoAccessibility.sawKakaoSince(launchedAt)) return;   // 떴다 — 계속 기다린다
                String why = "카카오톡 창이 " + (SHARE_SHOW_MS / 1000) + "초 내에 표시되지 않았습니다";
                if (j.wakeErr.length() > 0) why = why + " (" + j.wakeErr + ")";
                nextPath(j, sess, pi, why);
            }
        }, SHARE_SHOW_MS);
    }

    /** 이 경로는 실패했다 — 기록하고 다음 경로로 (없으면 세션 실패) */
    private static void nextPath(final Job j, final long sess, final int pi, String why) {
        if (current == null || current.id != j.id || j.session != sess) return;
        if (j.pathIdx != pi) return;   // 이미 넘어갔다 (워치독 두 개가 겹칠 수 있다)

        j.trail.add(pathLabel(j, j.paths[pi]) + " → " + why);
        j.pathIdx = pi + 1;

        if (j.pathIdx < j.paths.length) {
            Log.add(j.app, "이미지 전송 경로 「" + pathLabel(j, j.paths[pi]) + "」 실패: " + why
                    + ". 다음 경로 「" + pathLabel(j, j.paths[j.pathIdx]) + "」 로 재시도합니다.");
            tryPath(j, sess);
            return;
        }
        shareFail(j, sess);
    }

    /** 이번 세션의 모든 경로가 실패했다 */
    private static void shareFail(final Job j, final long sess) {
        if (current == null || current.id != j.id || j.session != sess) return;

        int ev = 0;
        try { ev = KakaoAccessibility.kakaoEventCount(); } catch (Throwable ignore) { }
        final boolean sawWindow = ev > 0
                || ((j.launchedAt > 0L) && KakaoAccessibility.sawKakaoSince(j.launchedAt));
        final boolean stillLocked = j.woke && !screenReady(j.app);

        // ── 원인 후보를 정직하게 나열한다. 확정할 수 없는 것을 확정으로 적지 않는다. ──
        String why;
        if (stillLocked) {
            why = LOCK_HELP;
        } else if (!j.wakeShown && j.woke) {
            // 우리 액티비티조차 못 떴다 = 시스템 차단. 이건 거의 확정이다.
            why = "시스템이 백그라운드 상태의 화면 실행을 차단했습니다. "
                    + "「다른 앱 위에 표시」 권한을 활성화하고, 설정 › 배터리 › 백그라운드 사용 제한 에서 "
                    + "이 앱을 「잠들지 않는 앱」 으로 등록하십시오. "
                    + "이미지 전송은 앱이 화면에 표시된 상태에서 가장 안정적으로 동작합니다.";
        } else if (sawWindow) {
            why = "카카오톡 화면은 표시되었으나 대화방 「" + j.ref.name + "」 을 선택하지 못했습니다. "
                    + "대화방 이름이 카카오톡 화면의 표시 이름과 일치하는지 확인하십시오.";
        } else {
            why = "원인 미확정. 후보 3가지: (1) 카카오톡이 공유 요청에 응답하지 않았습니다"
                    + "(카카오톡을 최신 버전으로 업데이트하십시오) "
                    + "(2) 시스템이 화면 실행을 차단했습니다"
                    + "(「다른 앱 위에 표시」 권한과 배터리 사용 제한 해제를 확인하십시오) "
                    + "(3) 접근성 서비스가 카카오톡 창을 감지하지 못했습니다"
                    + "(앱 업데이트 후에는 접근성 권한을 다시 활성화해야 합니다).";
        }
        if (!j.fg) {
            why = why + " 예약 발송(백그라운드)에서 발생했습니다.";
        }

        route(j, R_SHARE, "실패(실행 경로 " + j.paths.length + "개 전부 실패 · " + trailText(j) + ")");
        diag(j, "공유창 실행 실패 — 시도한 경로 " + j.paths.length + "개 전부 실패", j.launchedAt, why);
        KakaoAccessibility.disarm();

        // 백그라운드 + 카톡 창을 한 번도 못 봤다 = 예약 발송으로는 안 되는 상태다.
        // 이게 한도만큼 쌓이면 Scheduler 가 이미지를 생략하고 텍스트만 보낸다.
        j.bgMiss = (!j.fg) && !sawWindow;

        String head = (j.sentByShare > 0)
                ? ("이미지 " + j.sentByShare + "/" + j.uris.size() + "장만 전송되었습니다. ")
                : "";
        Log.add(j.app, "이미지 전송 실패: " + head + why + " 진단 기록을 저장했습니다.");
        finish(j.id, false, head + why);
    }

    /** 접근성 서비스가 이번 세션의 결과를 알려왔다 */
    private static void shareDone(final Job j, final long sess, boolean ok, String detail) {
        if (current == null || current.id != j.id || j.session != sess) return;
        j.session++;   // 이 세션의 워치독을 전부 무효화한다

        if (!ok) {
            String head = (j.sentByShare > 0)
                    ? ("이미지 " + j.sentByShare + "/" + j.uris.size() + "장만 전송되었습니다. ")
                    : "";
            String trail = trailText(j);
            route(j, R_SHARE, "실패(공유창 표시 후 " + ((detail == null || detail.length() == 0)
                    ? "원인 확인 불가" : detail) + ")");
            Log.add(j.app, "이미지 전송 실패: " + head
                    + ((detail == null || detail.length() == 0) ? "원인 확인 불가" : detail)
                    + (trail.length() == 0 ? "" : (" · 시도한 경로: " + trail)));
            finish(j.id, false, head + ((detail == null || detail.length() == 0) ? "원인 확인 불가" : detail));
            return;
        }

        j.sentByShare += j.batch.size();
        if (!j.single || j.cursor + 1 >= j.uris.size()) {
            route(j, R_SHARE, "성공(" + j.sentByShare + "장 · " + j.usedPath + ")");
        }
        Log.add(j.app, "이미지 " + j.batch.size() + "장을 공유창 경로로 전송했습니다. 대화방: " + j.label
                + " · 성공 경로: " + (j.usedPath.length() == 0 ? "확인 불가" : j.usedPath)
                + (j.trail.isEmpty() ? "" : (" (앞서 실패한 경로: " + trailText(j) + ")")));

        // 단건 모드면 남은 장을 이어서 보낸다
        if (j.single && j.cursor + 1 < j.uris.size()) {
            j.cursor++;
            main().postDelayed(new Runnable() {
                @Override public void run() { openSession(j); }
            }, GAP_MS);
            return;
        }

        finish(j.id, true, "이미지 " + j.sentByShare + "장을 전송했습니다 (" + j.usedPath + ").");
    }

    private static String trailText(Job j) {
        if (j.trail.isEmpty()) return "";
        StringBuilder b = new StringBuilder();
        for (int i = 0; i < j.trail.size(); i++) {
            if (i > 0) b.append(" / ");
            b.append(j.trail.get(i));
        }
        return b.toString();
    }

    /**
     * 이번 배치를 실을 공유 인텐트.
     *
     * @param explicit true 면 런타임 조회로 얻은 컴포넌트를 명시한다 (카톡 내부 인텐트 라우팅 우회용).
     *        컴포넌트를 소스에 하드코딩하지 않는다 — 카톡 버전마다 바뀐다.
     */
    private static Intent shareIntent(Job j, boolean explicit) {
        ArrayList<Uri> list = new ArrayList<Uri>(j.batch.size());
        for (int k = 0; k < j.batch.size(); k++) {
            try { list.add(Uri.parse(j.batch.get(k))); } catch (Throwable ignore) { }
        }
        if (list.isEmpty()) return null;

        Share s = sh(j);
        Intent i;
        if (j.single) {
            i = new Intent(Intent.ACTION_SEND);
            i.putExtra(Intent.EXTRA_STREAM, list.get(0));
            if (explicit && s.single != null && s.singleExported) i.setComponent(s.single);
        } else {
            i = new Intent(Intent.ACTION_SEND_MULTIPLE);
            i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, list);
            if (explicit && s.multi != null && s.multiExported) i.setComponent(s.multi);
        }
        i.setType("image/*");
        i.setPackage(KAKAO);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

        // EXTRA_STREAM 만 넣으면 읽기 권한이 카톡으로 안 넘어가는 기기가 있다.
        // ClipData 에도 같은 URI 를 실어야 FLAG_GRANT_READ_URI_PERMISSION 이 실제로 먹는다.
        try {
            ClipData cd = ClipData.newUri(j.app.getContentResolver(), "이미지", list.get(0));
            for (int k = 1; k < list.size(); k++) cd.addItem(new ClipData.Item(list.get(k)));
            i.setClipData(cd);
        } catch (Throwable t) {
            Log.add(j.app, "이미지 접근 권한 전달 준비에 실패했습니다 — " + t.getClass().getSimpleName()
                    + " (권한 전달 없이 발송을 시도합니다)");
        }
        return i;
    }

    // ── 카톡 공유 수신 액티비티 조회 ─────────────────────────────────────────

    /**
     * 카톡이 선언해둔 이미지 공유 수신 액티비티를 런타임에 조회한다.
     * 매니페스트의 {@code <queries><package com.kakao.talk>} 덕분에 QUERY_ALL_PACKAGES 없이 된다.
     * <b>결과를 소스에 하드코딩하지 않는다</b> — 카톡 버전마다 바뀐다.
     */
    private static Share resolveShare(Context c) {
        Share s = new Share();
        boolean[] err = new boolean[1];

        ResolveInfo m = pick(c, Intent.ACTION_SEND_MULTIPLE, err);
        if (m != null && m.activityInfo != null) {
            s.multi = new ComponentName(m.activityInfo.packageName, m.activityInfo.name);
            s.multiExported = m.activityInfo.exported;
        }
        ResolveInfo o = pick(c, Intent.ACTION_SEND, err);
        if (o != null && o.activityInfo != null) {
            s.single = new ComponentName(o.activityInfo.packageName, o.activityInfo.name);
            s.singleExported = o.activityInfo.exported;
        }
        s.queryFailed = err[0] && s.none();
        return s;
    }

    /**
     * 그 액션으로 카톡이 받는 액티비티 하나 (exported 인 것을 우선한다).
     * 조회가 예외로 끝나면 err[0] 을 세운다 — 호출부가 "없음" 과 구별해야 한다.
     */
    private static ResolveInfo pick(Context c, String action, boolean[] err) {
        try {
            Intent i = new Intent(action);
            i.setType("image/*");
            i.setPackage(KAKAO);
            List<ResolveInfo> l = c.getPackageManager().queryIntentActivities(i, 0);
            if (l == null || l.isEmpty()) return null;
            for (int k = 0; k < l.size(); k++) {
                ResolveInfo ri = l.get(k);
                if (ri != null && ri.activityInfo != null && ri.activityInfo.exported) return ri;
            }
            return l.get(0);
        } catch (Throwable t) {
            err[0] = true;
            return null;
        }
    }

    // ── 화면 상태 ────────────────────────────────────────────────────────────

    /**
     * 공유창을 바로 띄울 수 있는 화면 상태인가 (켜져 있고 + 잠금이 안 걸려 있고).
     * 못 읽으면 <b>준비된 걸로 본다</b> — 확실하지도 않은데 깨우기 단계를 끼워 넣으면
     * 그 단계 자체가 새 실패 지점이 된다.
     */
    public static boolean screenReady(Context c) {
        if (c == null) return false;
        boolean on = true;
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            if (pm != null) on = pm.isInteractive();
        } catch (Throwable ignore) { }
        if (!on) return false;
        try {
            KeyguardManager km = (KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null && km.isKeyguardLocked()) return false;
        } catch (Throwable ignore) { }
        return true;
    }

    /** 화면 상태를 사람 말로 (로그·진단용) */
    private static String screenState(Context c) {
        String on = "?", lock = "?";
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            if (pm != null) on = pm.isInteractive() ? "켜짐" : "꺼짐";
        } catch (Throwable ignore) { }
        try {
            KeyguardManager km = (KeyguardManager) c.getSystemService(Context.KEYGUARD_SERVICE);
            if (km != null) {
                lock = km.isKeyguardLocked()
                        ? ("잠김" + (km.isDeviceSecure() ? "(보안 잠금 · 자동 해제 불가)" : "(보안 잠금 아님 · 자동 해제 가능)"))
                        : "해제됨";
            }
        } catch (Throwable ignore) { }
        return on + " · 잠금 " + lock;
    }

    // ── 최소 진단 (공유창이 뜨기 전에 죽는 경로용) ────────────────────────────

    /**
     * 덤프가 안 남는 실패 경로를 메운다.
     * 공유창이 뜨기도 전에 죽으면 접근성 쪽 화면 덤프가 아예 없어서 사용자가 받을 단서가 0 이 된다.
     * 그래서 "무슨 단계에서 · 화면 상태 · 접근성 연결 상태 · 다른 접근성 앱" 만이라도 같은 자리에 남긴다.
     *
     * @param since 0 이 아니면, 접근성이 그 시각 이후에 이미 자기 덤프를 남겼으면 <b>건드리지 않는다</b>.
     *              그쪽이 훨씬 자세한데 우리 요약으로 덮으면 진단이 후퇴한다.
     */
    private static void diag(Job j, String step, long since, String extra) {
        if (j == null || j.app == null) return;
        try {
            if (since > 0L && KakaoAccessibility.lastDumpAt(j.app) >= since) return;
            KakaoAccessibility.saveDump(j.app, buildDiag(j, step, extra));
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "이미지 전송 진단 기록 실패", t);
        }
    }

    private static String buildDiag(Job j, String step, String extra) {
        StringBuilder b = new StringBuilder(1536);
        String now = new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA).format(new Date());
        b.append("=== 이미지 전송 진단 ").append(now).append(" ===\n");
        b.append("※ 카카오톡 화면에 도달하기 전에 실패했거나 접근성 서비스가 응답하지 않은 상태입니다.\n");
        b.append("   화면 뷰 트리 기록이 없으므로 아래 항목(특히 「전송 경로」)으로 원인을 판단합니다.\n");
        b.append("단계: ").append(step).append('\n');
        if (extra != null && extra.length() > 0) b.append("힌트: ").append(extra).append('\n');
        // 이름과 계정을 절대 한 문자열로 합치지 않는다 (합쳐 쓰다 화면 매칭이 깨진 적이 있다)
        b.append("방 이름: \"").append(j.ref.name).append("\"\n");
        b.append("대상 계정: ").append(accLabel(j.app, j.ref)).append('\n');
        b.append("첨부 이미지: ").append(j.uris.size()).append("장");
        if (j.single) b.append(" · 단건 모드(ACTION_SEND) ").append(j.cursor + 1).append("번째");
        if (j.sentByShare > 0) b.append(" · 전송 완료 ").append(j.sentByShare).append("장");
        b.append('\n');
        // 어느 경로를 탔고 어디서 막혔나 — 경로가 3개라 이 줄이 없으면 원인 분석이 불가하다
        b.append("전송 경로: ").append(routeText(j)).append('\n');
        b.append(attachBlock(j));
        b.append("앱 상태: ").append(fgText(j.fg))
                .append(" ← ActivityManager 프로세스 중요도 판정").append('\n');
        b.append("화면: ").append(screenState(j.app))
                .append(" · 절전 해제: ").append(j.woke ? "시도함(WakeActivity)" : "불필요(화면 켜짐 상태)")
                .append('\n');
        if (j.woke) {
            b.append("화면 활성화 단계 실행: ").append(yn(j.wakeShown))
                    .append(j.wakeShown ? "" : " ← 앱 자체 화면조차 실행되지 않았습니다(시스템 차단 판단 근거)");
            if (j.wakeErr.length() > 0) b.append(" · 오류: ").append(j.wakeErr);
            b.append('\n');
        }
        b.append("카카오톡 공유 수신 대상: ").append(sh(j).text()).append('\n');
        b.append("시도한 실행 경로: ").append(j.trail.isEmpty() ? "없음" : trailText(j)).append('\n');
        b.append("공유 인텐트 전달 시각: ")
                .append(j.launchedAt == 0L ? "전달되지 않음"
                        : (new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date(j.launchedAt))
                           + " (" + ((System.currentTimeMillis() - j.launchedAt) / 1000) + "초 전)"))
                .append('\n');
        b.append("카카오톡 창 감지: ")
                .append(j.launchedAt == 0L ? "해당 없음"
                        : yn(KakaoAccessibility.sawKakaoSince(j.launchedAt)));
        int ev = 0;
        try { ev = KakaoAccessibility.kakaoEventCount(); } catch (Throwable ignore) { }
        b.append(" · 창 이벤트 ").append(ev).append("건")
                .append(ev == 0 ? " ← 0 건이면 공유창이 표시되지 않은 상태입니다"
                        : " ← 창은 표시되었고 대화방 선택·전송 단계에서 실패한 상태입니다")
                .append('\n');
        b.append("접근성 서비스 연결: ").append(yn(KakaoAccessibility.connected()))
                .append(" · 설정 허용: ").append(yn(accessibilityOn(j.app)))
                .append(" · 접근성 예약 이름: \"").append(safe(KakaoAccessibility.armedRoom())).append("\"\n");
        b.append("다른 앱 위에 표시: ").append(yn(overlayOn(j.app))).append('\n');
        b.append("알림 읽기 권한: 설정 허용 ").append(yn(KakaoListener.connected(j.app)))
                .append(" · 실제 연결 ").append(yn(KakaoListener.listenerBound())).append('\n');
        b.append("알림 답장 이미지 첨부: ");
        try {
            java.util.Set<String> t = KakaoListener.imageTypesFor(j.ref);
            b.append((t == null || t.isEmpty()) ? "불가(카카오톡이 이미지 타입을 제공하지 않거나 대화방 세션 없음)"
                    : ("가능 " + t));
        } catch (Throwable t) {
            b.append("확인 실패 (").append(t.getClass().getSimpleName()).append(")");
        }
        b.append('\n');
        b.append("백그라운드 전송 불가 확정: ");
        long bl = backgroundBlockedAt(j.app);
        b.append(bl <= 0L ? "아님"
                : (new SimpleDateFormat("MM/dd HH:mm", Locale.KOREA).format(new Date(bl))
                   + " 이후 예약 발송에서 이미지 생략"));
        b.append('\n');
        b.append("카카오톡 설치: ").append(kakaoInfo(j.app)).append('\n');
        b.append("기기: ").append(android.os.Build.MANUFACTURER).append(' ')
                .append(android.os.Build.MODEL).append(" · 안드로이드 ")
                .append(android.os.Build.VERSION.RELEASE)
                .append(" (API ").append(android.os.Build.VERSION.SDK_INT).append(")\n");
        b.append("활성 상태인 타사 접근성 앱: ").append(otherAccessibility(j.app)).append('\n');
        b.append("\n위 내용을 그대로 복사하여 전달하십시오 (매크로 › 이미지 첨부 › 화면 진단 보기).\n");
        return b.toString();
    }

    /**
     * 채팅방 첨부 경로의 재료 상태. 이 경로가 왜 안 됐는지는 여기 세 줄로 다 나온다 —
     * 대화방 열기 인텐트 · 사진 지목 문자열 · 접근성 첨부 흐름 탑재 여부.
     */
    private static String attachBlock(Job j) {
        StringBuilder b = new StringBuilder(320);
        b.append("채팅방 첨부 경로: ").append(attachEnabled(j.app) ? "활성" : "비활성(설정)")
                .append(" · 시도 ").append(yn(j.attachTried))
                .append(j.attachTried ? (" · 사진 시각 후보 " + (j.attachVariant + 1) + "번까지 시도") : "")
                .append('\n');
        b.append("대화방 열기 인텐트(알림 contentIntent): ");
        try {
            b.append(KakaoListener.openIntentFor(j.ref) != null ? "보유"
                    : "없음(해당 대화방 알림 미수신 — 채팅방을 열 수단이 없습니다)");
        } catch (Throwable t) {
            b.append("확인 실패(").append(t.getClass().getSimpleName()).append(')');
        }
        b.append('\n');
        b.append("사진 지목(촬영·저장 시각): ");
        if (j.descs.isEmpty() && j.noTime == 0) {
            b.append("미확인(이 경로를 시도하지 않았습니다)");
        } else {
            b.append("지목 가능 ").append(j.descs.size()).append("장");
            if (j.noTime > 0) b.append(" · 시각 확인 불가 ").append(j.noTime).append("장(제외)");
            if (!j.descs.isEmpty()) b.append(" · 첫 후보 \"").append(j.descs.get(0).get(0)).append('"');
        }
        b.append('\n');
        if (j.attachAt > 0L) {
            b.append("채팅방 열기 시각: ")
                    .append(new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date(j.attachAt)))
                    .append(" · 이후 카카오톡 창 감지: ").append(yn(KakaoAccessibility.sawKakaoSince(j.attachAt)))
                    .append('\n');
        }
        return b.toString();
    }

    private static String yn(boolean v) { return v ? "Y" : "N"; }

    private static String safe(String v) { return (v == null) ? "" : v; }

    /** 계정을 사람이 읽을 수 있게 (계정 이름 + 계정키) */
    private static String accLabel(Context c, RoomRef r) {
        String n = "";
        try { n = Accounts.nameOf(c, r.acc); } catch (Throwable ignore) { }
        if (n == null || n.length() == 0) n = r.isDefault() ? "기본 계정" : "이름 미확인";
        return n + " (계정키 " + r.acc + ")";
    }

    /** 카톡 설치 여부 + 버전 */
    private static String kakaoInfo(Context c) {
        try {
            android.content.pm.PackageInfo pi =
                    c.getPackageManager().getPackageInfo(KAKAO, 0);
            return "있음 v" + pi.versionName;
        } catch (Throwable t) {
            return "없음(또는 조회 불가) — " + t.getClass().getSimpleName();
        }
    }

    /**
     * 우리 것 말고 켜져 있는 접근성 앱들.
     * 다른 접근성 앱이 카톡 화면을 같이 만지면 클릭이 서로 엉켜서 원인 없이 실패한다 —
     * 현장에서 자주 나오는데 로그만 보면 절대 모르는 항목이다.
     */
    public static String otherAccessibility(Context c) {
        if (c == null) return "조회 실패 — 컨텍스트 없음";
        try {
            String flat = android.provider.Settings.Secure.getString(c.getContentResolver(),
                    android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES);
            if (flat == null || flat.trim().length() == 0) return "없음";
            String mine = c.getPackageName();
            StringBuilder out = new StringBuilder();
            String[] parts = flat.split(":");
            for (int i = 0; i < parts.length; i++) {
                String p = (parts[i] == null) ? "" : parts[i].trim();
                if (p.length() == 0) continue;
                if (p.startsWith(mine + "/")) continue;   // 우리 것은 위에서 따로 적었다
                if (out.length() > 0) out.append(", ");
                out.append(p);
            }
            return (out.length() == 0) ? "없음" : out.toString();
        } catch (Throwable t) {
            return "조회 실패 — " + t.getClass().getSimpleName();
        }
    }

    /** 타사 접근성 자동화 앱이 켜져 있나 (매크로 화면 안내에 쓴다) */
    public static boolean otherAccessibilityOn(Context c) {
        String v = otherAccessibility(c);
        return !("없음".equals(v) || v.startsWith("조회 실패"));
    }

    /**
     * 타사 접근성 앱 안내를 남긴다. 이 프로세스에서 한 번만 — 매 주기 같은 줄을 쌓으면
     * 정작 실패 로그가 묻힌다. 진단 덤프에는 시도마다 들어간다.
     */
    private static void warnOtherAccessibility(Context c) {
        if (warnedOtherAcc) return;
        String other = otherAccessibility(c);
        if ("없음".equals(other) || other.startsWith("조회 실패")) return;
        warnedOtherAcc = true;
        Log.add(c, OTHER_ACC_HELP + " 활성 앱: " + other);
    }

    /** 한 건 마무리. 같은 건에 대해 두 번 불려도 두 번째는 무시된다. */
    private static void finish(long id, boolean ok, String detail) {
        Job j = current;
        if (j == null || j.id != id) return;
        current = null;
        busy = false;

        // 깨우기 감시자를 남겨두면 Job(과 완료 콜백)이 계속 붙들린다
        if (j.wakeId != 0L) {
            try { WakeActivity.unwatch(j.wakeId); } catch (Throwable ignore) { }
            j.wakeId = 0L;
        }

        String d = (detail == null || detail.length() == 0) ? (ok ? j.label : "원인 불명") : detail;
        if (!ok) {
            Log.add(j.app, "이미지 전송 실패: " + j.label + " (" + d + ")");
            if (j.bgMiss) bgFail(j.app);
        } else {
            bgOk(j.app);
        }

        fire(j.onDone, ok, d);

        if (!QUEUE.isEmpty()) {
            main().postDelayed(new Runnable() {
                @Override public void run() { pump(); }
            }, GAP_MS);
        }
    }

    /** 결과 콜백을 메인 스레드에서 한 번 부른다. 안에서 터져도 여기서 먹는다. */
    private static void fire(final Done d, final boolean ok, final String detail) {
        if (d == null) return;
        fire(new Runnable() {
            @Override public void run() { d.done(ok, detail); }
        });
    }

    /** onDone 을 메인 스레드에서 한 번 부른다. 안에서 터져도 여기서 먹는다. */
    private static void fire(final Runnable r) {
        if (r == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            try { r.run(); } catch (Throwable t) {
                android.util.Log.w("KakaoAuto", "이미지 전송 완료 콜백 오류", t);
            }
            return;
        }
        main().post(new Runnable() {
            @Override public void run() {
                try { r.run(); } catch (Throwable t) {
                    android.util.Log.w("KakaoAuto", "이미지 전송 완료 콜백 오류", t);
                }
            }
        });
    }

    private static synchronized Handler main() {
        if (H == null) H = new Handler(Looper.getMainLooper());
        return H;
    }
}
