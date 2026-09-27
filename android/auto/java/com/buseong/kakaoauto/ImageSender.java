package com.buseong.kakaoauto;

import android.content.ClipData;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;

import java.util.ArrayList;
import java.util.List;

/**
 * 이미지 1~5장 전송 오케스트레이션.
 *
 * 흐름:
 *   1. 살아있는 URI 만 최대 5장 고른다
 *   2. {@link KakaoAccessibility#arm} 으로 "다음 카톡 공유창에서 이 방 골라라" 예약
 *   3. ACTION_SEND_MULTIPLE 로 카톡 공유창을 띈다
 *   4. 접근성 서비스가 방 탭 → 전송 탭 → 콜백으로 결과 알림
 *   5. 40초 안에 아무 신호 없으면 예약 풀고 실패 처리
 *
 * 한 번에 한 건만 돌린다(카톡 공유창이 겹치면 둘 다 망한다). 겹쳐 들어온 요청은 줄 세워서 순서대로.
 * 어느 스레드에서 불러도 된다 — 내부 상태는 전부 메인 루퍼에서만 만진다.
 */
public final class ImageSender {
    private ImageSender() {}

    /** 한 번에 보낼 수 있는 최대 장수 */
    public static final int MAX = ImagePicker.MAX;

    /** 완료 신호를 이만큼 기다린다. 넘으면 실패 처리. */
    public static final long TIMEOUT_MS = 40000L;

    /** 연속 전송 사이 숨 고르기 (카톡 공유창이 닫힐 시간) */
    private static final long GAP_MS = 1500L;

    /** 대기열에 이보다 많이 쌓이면 새 요청을 버린다 */
    private static final int MAX_QUEUE = 5;

    private static final String KAKAO = "com.kakao.talk";

    // ── 상태 (메인 스레드에서만 접근) ────────────────────────────────────────
    private static final ArrayList<Job> QUEUE = new ArrayList<Job>();
    /** busy/current 는 busy()·pending() 로 다른 스레드에서도 읽히니까 volatile */
    private static volatile boolean busy = false;
    private static volatile Job current = null;
    private static long seq = 0L;
    private static Handler H = null;

    private static final class Job {
        final long id;
        final Context app;
        final String room;
        final ArrayList<String> uris;
        final Runnable onDone;

        Job(long id, Context app, String room, ArrayList<String> uris, Runnable onDone) {
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
        if (ctx == null) { fire(onDone); return; }
        Context app = ctx.getApplicationContext();
        if (app == null) app = ctx;
        final Context c = app;

        String r = (room == null) ? "" : room.trim();
        if (r.length() == 0) {
            Log.add(c, "이미지 전송 취소 — 보낼 방 이름이 비어있어");
            fire(onDone);
            return;
        }

        if (uris == null || uris.isEmpty()) {
            Log.add(c, "이미지 전송 취소 — 첨부된 사진이 없어");
            fire(onDone);
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
            Log.add(c, "첨부 사진 " + dead + "장이 안 읽혀서 건너뛸게 — 지워졌거나 권한이 풀렸어. 다시 골라줘");
        }
        if (ok.isEmpty()) {
            Log.add(c, "이미지 전송 취소 — 보낼 수 있는 사진이 하나도 없어");
            fire(onDone);
            return;
        }
        if (uris.size() > MAX) {
            Log.add(c, "사진은 " + MAX + "장까지야 — 앞 " + ok.size() + "장만 보낼게");
        }

        if (!accessibilityOn(c)) {
            Log.add(c, "접근성 권한이 꺼져 있어서 이미지 전송을 못 했어 — "
                    + "설정 › 접근성 › 설치된 앱 › 카톡 오토 · 자동 조작 을 켜줘");
            fire(onDone);
            return;
        }
        if (!overlayOn(c)) {
            // 앱을 직접 보고 있을 때는 이게 없어도 공유창이 뜬다. 그래서 막지는 않고 경고만 한다.
            // 다만 예약 발송(백그라운드)에서는 100% 실패하므로 확실히 알려준다.
            Log.add(c, "「다른 앱 위에 표시」 권한이 꺼져 있어 — 앱을 보고 있을 때는 될 수 있지만, "
                    + "예약 발송(화면 꺼진 상태)에서는 카톡 공유창이 안 떠. 설정에서 켜줘");
        }

        final String room2 = r;
        final ArrayList<String> list = ok;
        main().post(new Runnable() {
            @Override public void run() {
                if (QUEUE.size() >= MAX_QUEUE) {
                    Log.add(c, "이미지 전송 대기열이 꽉 찼어(" + MAX_QUEUE + "건) — " + room2 + " 건은 버렸어");
                    fire(onDone);
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
            Log.add(c, "접근성 권한 상태를 못 읽었어 — " + t.getClass().getSimpleName());
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
            Ui.toast(c, "「카톡 오토」 를 켜줘");
        } catch (Throwable t) {
            Log.add(c, "「다른 앱 위에 표시」 설정을 못 열었어 — 설정 › 애플리케이션 › 카톡 오토 에서 직접 켜줘");
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
            Ui.toast(c, "설치된 앱 › 카톡 오토 · 자동 조작 을 켜줘");
        } catch (Throwable t) {
            Log.add(c, "접근성 설정 화면을 못 열었어 — " + t.getClass().getSimpleName() + ". 설정 › 접근성 에서 직접 켜줘");
            Ui.toast(c, "설정 › 접근성 에서 직접 켜줘");
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
        // 결과 콜백을 먼저 꽂아두고 공유창을 띈다 (순서 바뀌면 빠른 응답을 놓친다)
        KakaoAccessibility.arm(j.room, TIMEOUT_MS, new KakaoAccessibility.Result() {
            @Override public void done(final boolean ok, final String detail) {
                main().post(new Runnable() {
                    @Override public void run() { finish(j.id, ok, detail); }
                });
            }
        });

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
            KakaoAccessibility.disarm();
            Log.add(j.app, "이미지 전송 실패 — 사진 주소가 깨졌어");
            finish(j.id, false, "사진 주소가 깨졌어");
            return;
        }
        i.putParcelableArrayListExtra(Intent.EXTRA_STREAM, list);

        // EXTRA_STREAM 만 넣으면 읽기 권한이 카톡으로 안 넘어가는 기기가 있다.
        // ClipData 에도 같은 URI 를 실어야 FLAG_GRANT_READ_URI_PERMISSION 이 실제로 먹는다.
        try {
            ClipData cd = ClipData.newUri(j.app.getContentResolver(), "사진", list.get(0));
            for (int k = 1; k < list.size(); k++) cd.addItem(new ClipData.Item(list.get(k)));
            i.setClipData(cd);
        } catch (Throwable t) {
            Log.add(j.app, "사진 권한 전달 준비 실패 — " + t.getClass().getSimpleName() + " (그냥 보내볼게)");
        }

        try {
            j.app.startActivity(i);
        } catch (Throwable t) {
            KakaoAccessibility.disarm();
            Log.add(j.app, "카톡 공유창을 못 열었어 — 카톡이 안 깔렸거나 버전이 너무 달라 ("
                    + t.getClass().getSimpleName() + ")");
            finish(j.id, false, "카톡 공유창을 못 열었어");
            return;
        }

        Log.add(j.app, "사진 " + list.size() + "장 공유창 열었어 — 방: " + j.room + " (최대 "
                + (TIMEOUT_MS / 1000) + "초 기다릴게)");

        // 6초 안에 카톡 화면을 한 번도 못 봤으면 공유창 자체가 안 뜬 거다 (백그라운드 차단이 대표 원인).
        final long launchedAt = System.currentTimeMillis();
        main().postDelayed(new Runnable() {
            @Override public void run() {
                if (current == null || current.id != j.id) return;
                if (KakaoAccessibility.sawKakaoSince(launchedAt)) return;   // 떴다 — 계속 기다린다
                KakaoAccessibility.disarm();
                String why = overlayOn(j.app)
                        ? "카톡이 공유 요청을 무시했어 — 카톡을 최신 버전으로 업데이트해봐"
                        : "「다른 앱 위에 표시」 권한이 꺼져 있어서 안드로이드가 공유창을 막았어 — "
                          + "설정 › 애플리케이션 › 카톡 오토 › 다른 앱 위에 표시 를 켜줘";
                Log.add(j.app, "사진 전송 실패: 카톡 공유창이 안 떴어. " + why);
                finish(j.id, false, "공유창이 안 뜸");
            }
        }, 6000L);

        main().postDelayed(new Runnable() {
            @Override public void run() {
                if (current == null || current.id != j.id) return;   // 이미 끝났다
                KakaoAccessibility.disarm();
                Log.add(j.app, "이미지 전송 시간 초과(" + (TIMEOUT_MS / 1000)
                        + "초) — 카톡 공유창에서 방을 못 골랐어. 접근성 권한과 방 이름을 확인해줘");
                finish(j.id, false, "시간 초과");
            }
        }, TIMEOUT_MS);
    }

    /** 한 건 마무리. 같은 건에 대해 두 번 불려도 두 번째는 무시된다. */
    private static void finish(long id, boolean ok, String detail) {
        Job j = current;
        if (j == null || j.id != id) return;
        current = null;
        busy = false;

        if (!ok) {
            String d = (detail == null || detail.length() == 0) ? "원인 불명" : detail;
            Log.add(j.app, "사진 전송 못 했어 — " + j.room + " (" + d + ")");
        }

        fire(j.onDone);

        if (!QUEUE.isEmpty()) {
            main().postDelayed(new Runnable() {
                @Override public void run() { pump(); }
            }, GAP_MS);
        }
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
