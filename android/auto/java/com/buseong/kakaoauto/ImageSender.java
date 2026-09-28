package com.buseong.kakaoauto;

import android.app.KeyguardManager;
import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
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
 * 이미지 1~5장 전송 오케스트레이션. 경로가 두 개다.
 *
 * <h3>경로 A — 알림 답장에 사진 첨부 (화면이 아예 안 움직인다)</h3>
 * 카톡이 알림 답장 {@code RemoteInput} 에 이미지 데이터 타입을 허용해뒀으면
 * ({@link KakaoListener#imageTypesFor}) 공유창도 접근성도 안 쓰고 그냥 실어 보낸다.
 * MIME 하나당 URI 하나라서 <b>한 장씩 순서대로</b> 보낸다.
 * 되는지 안 되는지는 기기/카톡 버전마다 다르니 <b>런타임에 확인해서 로그로 알려준다.</b>
 *
 * <h3>경로 B — 공유창 + 접근성 조작 (화면이 잠깐 움직인다)</h3>
 *   1. 살아있는 URI 만 최대 5장 고른다
 *   2. {@link KakaoAccessibility#arm} 으로 "다음 카톡 공유창에서 이 방 골라라" 예약
 *   3. 화면이 꺼져 있거나 잠겨 있으면 {@link WakeActivity} 를 거쳐, 아니면 바로
 *      ACTION_SEND_MULTIPLE 로 카톡 공유창을 띈다
 *   4. 접근성 서비스가 방 탭 → 전송 탭 → 콜백으로 결과 알림
 *   5. 40초 안에 아무 신호 없으면 예약 풀고 실패 처리
 *
 * 한 번에 한 건만 돌린다(카톡 공유창이 겹치면 둘 다 망한다). 겹쳐 들어온 요청은 줄 세워서 순서대로.
 * 어느 스레드에서 불러도 된다 — 내부 상태는 전부 메인 루퍼에서만 만진다.
 *
 * 실패하면 <b>어느 단계에서 왜</b> 를 반드시 남긴다. 공유창이 뜨기 전에 죽는 경로는 접근성 쪽
 * 화면 덤프가 없으니까 여기서 최소 진단을 만들어 같은 자리에 저장한다({@link #diag}).
 */
public final class ImageSender {
    private ImageSender() {}

    /** 한 번에 보낼 수 있는 최대 장수 */
    public static final int MAX = ImagePicker.MAX;

    /** 완료 신호를 이만큼 기다린다. 넘으면 실패 처리. */
    public static final long TIMEOUT_MS = 40000L;

    /** 연속 전송 사이 숨 고르기 (카톡 공유창이 닫힐 시간) */
    private static final long GAP_MS = 1500L;

    /** 알림 답장으로 사진을 연달아 보낼 때 사이 간격 (너무 빠르면 카톡이 순서를 뒤집거나 흘린다) */
    private static final long REPLY_GAP_MS = 1500L;

    /** 대기열에 이보다 많이 쌓이면 새 요청을 버린다 */
    private static final int MAX_QUEUE = 5;

    private static final String KAKAO = "com.kakao.talk";

    /** 화면이 꺼지고 잠겨 있어서 못 보낸 경우의 안내 (전용 폰이면 잠금을 없애는 게 정답이다) */
    private static final String LOCK_HELP =
            "화면이 꺼져 있고 잠금이 설정되어 이미지를 전송하지 못했습니다. "
            + "설정 › 잠금화면 › 화면 잠금 방식을 「없음」 으로 변경하고, "
            + "개발자 옵션의 「충전 중 화면 켜짐 유지」 를 활성화하십시오.";

    // ── 상태 (메인 스레드에서만 접근) ────────────────────────────────────────
    private static final ArrayList<Job> QUEUE = new ArrayList<Job>();
    /** busy/current 는 busy()·pending() 로 다른 스레드에서도 읽히니까 volatile */
    private static volatile boolean busy = false;
    private static volatile Job current = null;
    private static long seq = 0L;
    private static Handler H = null;

    /** 결과(성공 여부 + 원인)까지 받는 콜백. 진단 화면이 이걸 쓴다. */
    public interface Done {
        void done(boolean ok, String detail);
    }

    private static final class Job {
        final long id;
        final Context app;
        final String room;
        final ArrayList<String> uris;
        final Done onDone;

        /** 공유창을 띄우려고 WakeActivity 로 화면을 깨웠나 (진단에 쓴다) */
        volatile boolean woke = false;
        /** 공유 인텐트를 던진 시각 (0 = 아직) */
        volatile long launchedAt = 0L;

        Job(long id, Context app, String room, ArrayList<String> uris, Done onDone) {
            this.id = id;
            this.app = app;
            this.room = room;
            this.uris = uris;
            this.onDone = onDone;
        }
    }

    // ── 공개 API ────────────────────────────────────────────────────────────

    /**
     * room 방으로 사진을 보낸다. uris 는 최대 5장, 안 읽히는 건 알아서 걸러낸다.
     * onDone 은 성공이든 실패든 <b>정확히 한 번</b> 메인 스레드에서 불린다 (null 허용).
     */
    public static void send(Context ctx, String room, List<String> uris, final Runnable onDone) {
        sendWithResult(ctx, room, uris, new Done() {
            @Override public void done(boolean ok, String detail) {
                fire(onDone);
            }
        });
    }

    /**
     * 위와 같지만 <b>왜 실패했는지</b>까지 받는다. 진단 버튼이 이걸 쓴다.
     * onDone 은 성공이든 실패든 정확히 한 번 메인 스레드에서 불린다 (null 허용).
     *
     * (이름을 따로 둔 이유: send(.., null) 호출부가 있어서 오버로드로 만들면 컴파일이 모호해진다)
     */
    public static void sendWithResult(Context ctx, String room, List<String> uris, final Done onDone) {
        if (ctx == null) { fire(onDone, false, "앱 컨텍스트가 없습니다."); return; }
        Context app = ctx.getApplicationContext();
        if (app == null) app = ctx;
        final Context c = app;

        String r = (room == null) ? "" : room.trim();
        if (r.length() == 0) {
            Log.add(c, "이미지 전송을 취소했습니다. 대상 대화방 이름이 비어 있습니다.");
            fire(onDone, false, "대상 대화방 이름이 비어 있습니다.");
            return;
        }

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

        // 알림 답장으로 사진을 보낼 수 있는 방이면 접근성·오버레이·화면 상태가 전부 필요 없다.
        // 그래서 그 경우에는 여기서 막지 않는다 (막으면 제일 좋은 경로를 스스로 닫는 셈이다).
        if (!replyImageReady(c, r)) {
            if (!accessibilityOn(c)) {
                Log.add(c, "접근성 권한이 비활성 상태여서 이미지를 전송하지 못했습니다. "
                        + "설정 › 접근성 › 설치된 앱 › 카톡 오토 · 자동 조작 을 활성화하십시오.");
                fire(onDone, false, "접근성 권한이 비활성 상태입니다.");
                return;
            }
            if (!overlayOn(c)) {
                // 앱을 직접 보고 있을 때는 이게 없어도 공유창이 뜬다. 그래서 막지는 않고 경고만 한다.
                // 다만 예약 발송(백그라운드)에서는 100% 실패하므로 확실히 알려준다.
                Log.add(c, "「다른 앱 위에 표시」 권한이 비활성 상태입니다. 앱을 실행 중일 때는 동작할 수 있으나, "
                        + "예약 발송(화면 꺼진 상태)에서는 카카오톡 공유창이 표시되지 않습니다. 설정에서 활성화하십시오.");
            }
        }

        final String room2 = r;
        final ArrayList<String> list = ok;
        main().post(new Runnable() {
            @Override public void run() {
                if (QUEUE.size() >= MAX_QUEUE) {
                    Log.add(c, "이미지 전송 대기열이 한도(" + MAX_QUEUE + "건)에 도달했습니다. 대화방 " + room2 + " 건은 취소되었습니다.");
                    fire(onDone, false, "전송 대기열이 한도에 도달했습니다.");
                    return;
                }
                seq++;
                QUEUE.add(new Job(seq, c, room2, list, onDone));
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
     * 안드로이드 10+ 는 앱이 화면에 없을 때 startActivity 를 조용히 막는다(백그라운드 액티비티 차단).
     * 이 권한이 있으면 예외로 허용되는데, 매크로는 백그라운드에서 도니까
     * <b>이게 없으면 카톡 공유창이 아예 안 뜬다.</b> (오버레이를 그리는 데 쓰지는 않는다)
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

    // ── 큐 돌리기 ────────────────────────────────────────────────────────────

    private static void pump() {
        if (busy) return;
        if (QUEUE.isEmpty()) return;
        Job j = QUEUE.remove(0);
        busy = true;
        current = j;
        start(j);
    }

    private static void start(final Job j) {
        // 경로 A 를 먼저 본다 — 되면 화면이 아예 안 움직인다.
        if (replyImageReady(j.app, j.room)) {
            sendByReply(j, 0, 0);
            return;
        }
        startShare(j);
    }

    // ── 경로 A: 알림 답장에 사진 첨부 ──────────────────────────────────────────

    /**
     * 이 방에 알림 답장으로 사진을 보낼 수 있나.
     * 알림 읽기 권한이 붙어 있고, 그 방 세션이 살아있고, 카톡이 이미지 타입을 허용해둬야 한다.
     */
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

    public static boolean replyImageReady(Context c, String room) {
        try {
            if (!replyImageEnabled(c)) return false;
            if (!KakaoListener.listenerBound()) return false;
            java.util.Set<String> types = KakaoListener.imageTypesFor(room);
            return types != null && !types.isEmpty();
        } catch (Throwable t) {
            return false;
        }
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
            Log.add(j.app, "이미지 " + sent + "장을 알림 답장으로 전송했습니다. 대화방: " + j.room
                    + " · 화면 조작은 발생하지 않았습니다. 카카오톡에서 실제 업로드 여부를 확인하십시오.");
            finish(j.id, true, "알림 답장으로 " + sent + "장을 전송했습니다(화면 조작 없음). 카카오톡에서 업로드 여부를 확인하십시오.");
            return;
        }

        Uri u = null;
        try { u = Uri.parse(j.uris.get(idx)); } catch (Throwable ignore) { }

        boolean ok = (u != null) && KakaoListener.sendImageTo(j.app, j.room, u);
        if (!ok) {
            if (sent == 0) {
                Log.add(j.app, "알림 답장 경로로 이미지를 전송하지 못했습니다. 공유창 경로로 전환합니다"
                        + "(화면이 일시적으로 전환됩니다).");
                startShare(j);
                return;
            }
            Log.add(j.app, "알림 답장으로 " + sent + "/" + j.uris.size() + "장만 전송했습니다. 대화방: " + j.room
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

    // ── 경로 B: 공유창 + 접근성 조작 ──────────────────────────────────────────

    private static void startShare(final Job j) {
        // 여기까지 왔으면 접근성이 반드시 필요하다.
        // (대기열에 들어갈 때는 알림 답장 경로가 살아있어서 접근성 검사를 안 했을 수 있고,
        //  그 사이 세션이 죽어서 이리로 떨어지기도 한다. 그때 40초를 통째로 버리면 안 된다.)
        if (!accessibilityOn(j.app)) {
            diag(j, "공유창 경로가 필요하나 접근성 권한이 비활성 상태", 0L,
                    "알림 답장 경로도 사용할 수 없는 상태입니다. 두 경로 모두 차단되어 전송이 불가합니다.");
            Log.add(j.app, "이미지 전송 실패: 공유창 경로가 필요하나 접근성 권한이 비활성 상태입니다. "
                    + "설정 › 접근성 › 설치된 앱 › 카톡 오토 · 자동 조작 을 활성화하십시오.");
            finish(j.id, false, "접근성 권한이 비활성 상태입니다.");
            return;
        }

        // 결과 콜백을 먼저 꽂아두고 공유창을 띈다 (순서 바뀌면 빠른 응답을 놓친다)
        //  ★ ctx(j.app)를 반드시 같이 넘긴다. 접근성 설정은 켜져 있는데 서비스가 실제로는
        //    안 붙어 있는 상태(업데이트 직후·시스템이 죽인 뒤)가 현장에서 제일 흔한 실패인데,
        //    ctx 없이 부르면 arm 쪽 안내 로그가 Log.add(null) 로 사라지고 그 시점 덤프도 안 남는다.
        //    = 사용자가 받는 단서가 0 이 된다. 진단이 틀리게 도는 것보다 없는 게 더 나쁘다.
        KakaoAccessibility.arm(j.room, TIMEOUT_MS, new KakaoAccessibility.Result() {
            @Override public void done(final boolean ok, final String detail) {
                main().post(new Runnable() {
                    @Override public void run() { finish(j.id, ok, detail); }
                });
            }
        }, j.app);

        Intent i = new Intent(Intent.ACTION_SEND_MULTIPLE);
        i.setType("image/*");
        i.setPackage(KAKAO);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);

        ArrayList<Uri> list = new ArrayList<Uri>(j.uris.size());
        for (int k = 0; k < j.uris.size(); k++) {
            try {
                list.add(Uri.parse(j.uris.get(k)));
            } catch (Throwable ignore) { }
        }
        if (list.isEmpty()) {
            // 공유창을 띄우기도 전에 죽는다 → 접근성 덤프가 없다. 최소 진단이라도 남긴다.
            diag(j, "이미지 주소(URI) 파싱 실패 — 공유 인텐트를 생성하지 못했습니다.", 0L,
                    "첨부 " + j.uris.size() + "개 전부 Uri.parse 단계에서 실패했습니다.");
            KakaoAccessibility.disarm();
            Log.add(j.app, "이미지 전송 실패: 이미지 주소가 손상되었습니다. 진단 기록을 저장했습니다"
                    + " (매크로 › 이미지 첨부 › 화면 진단 보기).");
            finish(j.id, false, "이미지 주소가 손상되었습니다. 진단 기록을 저장했습니다 (매크로 › 이미지 첨부 › 화면 진단 보기).");
            return;
        }
        i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, list);

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

        // 화면이 꺼져 있거나 잠겨 있으면 공유창이 못 뜬다. 전용 폰이니까 깨워도 된다.
        // 이미 켜져 있고 안 잠겨 있으면 바로 띈다 — 필요 없는 단계는 그 자체가 실패 지점이다.
        final boolean ready = screenReady(j.app);
        j.woke = !ready;
        if (!ready) {
            Log.add(j.app, "화면 상태: " + screenState(j.app) + ". 절전 해제 후 공유창을 실행합니다.");
        }

        try {
            j.app.startActivity(ready ? i : WakeActivity.wrap(j.app, i));
        } catch (Throwable t) {
            diag(j, ready ? "공유창 startActivity 실패" : "화면 깨우기(WakeActivity) startActivity 실패",
                    0L, t.getClass().getSimpleName());
            KakaoAccessibility.disarm();
            if (ready) {
                Log.add(j.app, "카카오톡 공유창을 열지 못했습니다. 카카오톡이 설치되지 않았거나 버전이 호환되지 않습니다 ("
                        + t.getClass().getSimpleName() + "). 진단 기록을 저장했습니다.");
                finish(j.id, false, "카카오톡 공유창을 열지 못했습니다. 진단 기록을 저장했습니다 (매크로 › 이미지 첨부 › 화면 진단 보기).");
            } else {
                Log.add(j.app, LOCK_HELP + " (" + t.getClass().getSimpleName() + ")");
                finish(j.id, false, "화면이 꺼져 있고 잠금이 설정되어 전송하지 못했습니다. 화면 잠금 방식을 「없음」 으로 설정하십시오.");
            }
            return;
        }

        j.launchedAt = System.currentTimeMillis();
        Log.add(j.app, "이미지 " + list.size() + "장의 공유창을 열었습니다. 대화방: " + j.room
                + (ready ? "" : " (화면 절전 해제 후)") + " · 최대 " + (TIMEOUT_MS / 1000) + "초 대기");

        // 6초 안에 카톡 화면을 한 번도 못 봤으면 공유창 자체가 안 뜬 거다 (백그라운드 차단이 대표 원인).
        final long launchedAt = j.launchedAt;
        main().postDelayed(new Runnable() {
            @Override public void run() {
                if (current == null || current.id != j.id) return;
                if (KakaoAccessibility.sawKakaoSince(launchedAt)) return;   // 떴다 — 계속 기다린다
                // 깨우기를 시도했는데 아직도 준비가 안 됐으면 보안 잠금이 범인이다
                boolean stillLocked = j.woke && !screenReady(j.app);
                String why;
                if (stillLocked) {
                    why = LOCK_HELP;
                } else if (!overlayOn(j.app)) {
                    why = "「다른 앱 위에 표시」 권한이 비활성 상태여서 시스템이 공유창을 차단했습니다. "
                            + "설정 › 애플리케이션 › 카톡 오토 › 다른 앱 위에 표시 를 활성화하십시오.";
                } else {
                    why = "카카오톡이 공유 요청에 응답하지 않았습니다. 카카오톡을 최신 버전으로 업데이트하십시오.";
                }
                // 접근성은 아직 armed 로 기다리는 중이라 자기 덤프를 안 남겼다 → 우리가 남긴다
                diag(j, "공유창이 6초 내에 표시되지 않았습니다 (카카오톡 화면 미확인)", launchedAt, why);
                KakaoAccessibility.disarm();
                Log.add(j.app, "이미지 전송 실패: 카카오톡 공유창이 표시되지 않았습니다. " + why + " 진단 기록을 저장했습니다.");
                finish(j.id, false, "카카오톡 공유창이 표시되지 않았습니다. " + why);
            }
        }, 6000L);

        main().postDelayed(new Runnable() {
            @Override public void run() {
                if (current == null || current.id != j.id) return;   // 이미 끝났다
                // 접근성이 우리보다 먼저 포기하고 화면 덤프를 남겼으면 그걸 덮어쓰지 않는다
                // (그쪽 덤프가 훨씬 자세하다). 아무것도 안 남겼을 때만 우리 요약을 넣는다.
                diag(j, "시간 초과(" + (TIMEOUT_MS / 1000) + "초) — 접근성 서비스가 신호를 전달하지 않았습니다.",
                        launchedAt, "접근성 서비스가 화면 기록도 남기지 못했습니다. 서비스가 연결되지 않았거나 종료된 상태로 판단됩니다.");
                KakaoAccessibility.disarm();
                Log.add(j.app, "이미지 전송 시간 초과(" + (TIMEOUT_MS / 1000)
                        + "초): 카카오톡 공유창에서 대화방을 선택하지 못했습니다. 접근성 권한과 대화방 이름을 확인하십시오.");
                finish(j.id, false, "시간 초과: 접근성 서비스가 원인을 기록하지 못했습니다. "
                        + "접근성 권한을 재설정한 후 다시 시도하십시오.");
            }
        }, TIMEOUT_MS);
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
        StringBuilder b = new StringBuilder(1024);
        String now = new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA).format(new Date());
        b.append("=== 이미지 전송 진단 ").append(now).append(" ===\n");
        b.append("※ 공유창 표시 전(또는 접근성 서비스가 응답하지 않은 상태)에 실패했습니다.\n");
        b.append("   화면 뷰 트리 기록이 없으므로 아래 항목으로 원인을 판단합니다.\n");
        b.append("단계: ").append(step).append('\n');
        if (extra != null && extra.length() > 0) b.append("힌트: ").append(extra).append('\n');
        b.append("대상 대화방: \"").append(j.room).append("\" · 이미지 ").append(j.uris.size()).append("장\n");
        b.append("화면: ").append(screenState(j.app))
                .append(" · 절전 해제: ").append(j.woke ? "시도함(WakeActivity)" : "불필요(화면 켜짐 상태)")
                .append('\n');
        b.append("공유 인텐트 전달 시각: ")
                .append(j.launchedAt == 0L ? "전달되지 않음"
                        : (new SimpleDateFormat("HH:mm:ss", Locale.KOREA).format(new Date(j.launchedAt))
                           + " (" + ((System.currentTimeMillis() - j.launchedAt) / 1000) + "초 전)"))
                .append('\n');
        b.append("접근성 서비스 연결: ").append(yn(KakaoAccessibility.connected()))
                .append(" · 설정 허용: ").append(yn(accessibilityOn(j.app)))
                .append(" · 대상 대화방: \"").append(safe(KakaoAccessibility.armedRoom())).append("\"\n");
        b.append("다른 앱 위에 표시: ").append(yn(overlayOn(j.app))).append('\n');
        b.append("알림 읽기 권한: 설정 허용 ").append(yn(KakaoListener.connected(j.app)))
                .append(" · 실제 연결 ").append(yn(KakaoListener.listenerBound())).append('\n');
        b.append("알림 답장 이미지 첨부: ");
        try {
            java.util.Set<String> t = KakaoListener.imageTypesFor(j.room);
            b.append((t == null || t.isEmpty()) ? "불가(카카오톡이 이미지 타입을 제공하지 않거나 대화방 세션 없음)"
                    : ("가능 " + t));
        } catch (Throwable t) {
            b.append("확인 실패 (").append(t.getClass().getSimpleName()).append(")");
        }
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

    private static String yn(boolean v) { return v ? "Y" : "N"; }

    private static String safe(String v) { return (v == null) ? "" : v; }

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
    private static String otherAccessibility(Context c) {
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

    /** 한 건 마무리. 같은 건에 대해 두 번 불려도 두 번째는 무시된다. */
    private static void finish(long id, boolean ok, String detail) {
        Job j = current;
        if (j == null || j.id != id) return;
        current = null;
        busy = false;

        String d = (detail == null || detail.length() == 0) ? (ok ? j.room : "원인 불명") : detail;
        if (!ok) {
            Log.add(j.app, "이미지 전송 실패: " + j.room + " (" + d + ")");
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
