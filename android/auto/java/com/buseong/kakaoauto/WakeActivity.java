package com.buseong.kakaoauto;

import android.app.Activity;
import android.app.KeyguardManager;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.WindowManager;

/**
 * 화면을 깨우고 잠금을 풀고서 안에 담아온 인텐트를 실행하는 투명 액티비티.
 *
 * 왜 필요하냐: 화면이 꺼져 있거나 잠겨 있으면 카톡 공유창이 못 뜬다.
 * 이 앱은 <b>매크로 전용 폰</b>(평소에 안 쓰는 여분 폰)에서 도니까 깨워도 상관없다.
 *
 * 흐름:
 *   1. 화면 켜기 + 잠금화면 위에 표시 (API 27+ 는 setTurnScreenOn / 그 아래는 window flag)
 *   2. {@link KeyguardManager#requestDismissKeyguard} 로 잠금 해제 요청
 *      — <b>보안 잠금(패턴·PIN·지문)이 걸려 있으면 실패한다.</b> 그때는 로그로 알려준다.
 *   3. 받아온 공유 인텐트를 실행하고 바로 {@link #finish()}
 *
 * 화면이 이미 켜져 있고 안 잠겨 있으면 {@link ImageSender} 가 이걸 거치지 않는다
 * (필요 없는 단계를 끼워 넣으면 그 자체가 실패 지점이 된다).
 */
public final class WakeActivity extends Activity {

    /** 실행할 인텐트를 담아오는 엑스트라 키 (우리 앱만 쓴다 — 매니페스트에서 exported=false) */
    public static final String EXTRA_RUN = "com.buseong.kakaoauto.WAKE_RUN";

    /** 잠금 해제 콜백을 기다리는 한도. 넘으면 그냥 실행해본다. */
    private static final long DISMISS_WAIT_MS = 1200L;

    /** 화면이 실제로 켜질 시간 (잠금이 안 걸린 경우에도 이만큼은 준다) */
    private static final long WARMUP_MS = 300L;

    private final Handler h = new Handler(Looper.getMainLooper());

    /** 안에 담아온 인텐트를 딱 한 번만 실행한다 (콜백 + 타임아웃이 겹칠 수 있다) */
    private boolean launched = false;

    /** 잠금 해제 실패 안내를 한 번만 남긴다 */
    private boolean lockWarned = false;

    /**
     * 공유 인텐트를 감싸서 이 액티비티로 띄우는 인텐트를 만든다.
     * inner 는 우리가 만든 카톡 공유 인텐트여야 한다.
     */
    public static Intent wrap(Context c, Intent inner) {
        Intent i = new Intent(c, WakeActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        if (inner != null) i.putExtra(EXTRA_RUN, inner);
        return i;
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        // ── 1. 화면 켜기 + 잠금화면 위에 표시 ──
        try {
            if (Build.VERSION.SDK_INT >= 27) {
                setShowWhenLocked(true);
                setTurnScreenOn(true);
            } else {
                getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                        | WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON);
            }
            // 켜진 화면이 공유창 뜨기 전에 다시 꺼지면 처음부터 헛수고다
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        } catch (Throwable t) {
            Log.add(this, "화면을 깨우는 데 실패했어 — " + t.getClass().getSimpleName()
                    + ". 개발자 옵션의 「충전 중 화면 켜짐 유지」 를 켜두면 이 단계가 필요 없어");
        }

        final Intent run = readRun();

        // ── 2. 잠금 해제 요청 ──
        boolean locked = false;
        KeyguardManager km = null;
        try {
            km = (KeyguardManager) getSystemService(Context.KEYGUARD_SERVICE);
            locked = (km != null) && km.isKeyguardLocked();
        } catch (Throwable ignore) { /* 못 읽으면 잠기지 않은 걸로 본다 */ }

        if (locked && km != null) {
            try {
                km.requestDismissKeyguard(this, new KeyguardManager.KeyguardDismissCallback() {
                    @Override public void onDismissSucceeded() {
                        launch(run);
                    }
                    @Override public void onDismissError() {
                        warnLock("잠금 해제 요청이 안 먹혔어");
                        launch(run);          // 그래도 한 번 던져본다 — 될 기기도 있다
                    }
                    @Override public void onDismissCancelled() {
                        warnLock("잠금 해제가 취소됐어");
                        launch(run);
                    }
                });
            } catch (Throwable t) {
                warnLock("잠금 해제를 요청하다 실패했어 — " + t.getClass().getSimpleName());
                launch(run);
            }
            // 콜백이 아예 안 오는 기기가 있다 → 한도 지나면 그냥 실행한다
            h.postDelayed(new Runnable() {
                @Override public void run() {
                    if (!launched) warnLock("잠금 해제 응답이 안 왔어");
                    launch(run);
                }
            }, DISMISS_WAIT_MS);
        } else {
            // 잠금은 없다 — 화면이 실제로 켜질 짬만 주고 바로 실행
            h.postDelayed(new Runnable() {
                @Override public void run() { launch(run); }
            }, WARMUP_MS);
        }
    }

    /** 담아온 인텐트 꺼내기. 우리가 만든 카톡용 인텐트가 아니면 안 쓴다. */
    private Intent readRun() {
        Intent in = getIntent();
        if (in == null) return null;
        Intent run = null;
        try {
            android.os.Parcelable p = in.getParcelableExtra(EXTRA_RUN);
            if (p instanceof Intent) run = (Intent) p;
        } catch (Throwable ignore) { /* 아래에서 null 처리한다 */ }
        if (run == null) return null;
        // exported=false 라 외부에서 못 부르지만, 그래도 카톡으로 가는 인텐트만 실행한다
        String pkg = run.getPackage();
        if (pkg == null && run.getComponent() != null) pkg = run.getComponent().getPackageName();
        if (!"com.kakao.talk".equals(pkg)) {
            Log.add(this, "화면 깨우기 실패 — 실행할 카톡 인텐트가 안 들어왔어");
            return null;
        }
        return run;
    }

    /** 잠금 해제 실패 안내 (한 번만) */
    private void warnLock(String why) {
        if (lockWarned) return;
        lockWarned = true;
        Log.add(this, "잠금을 못 풀었어(" + why + ") — 설정 › 잠금화면 › 화면 잠금 방식을 "
                + "「없음」 으로 바꿔줘. 전용 폰이면 그게 제일 확실해");
    }

    /** 담아온 인텐트를 딱 한 번 실행하고 끝낸다 */
    private void launch(Intent run) {
        if (launched) return;
        launched = true;
        try { h.removeCallbacksAndMessages(null); } catch (Throwable ignore) { }

        if (run == null) {
            finish();
            return;
        }
        try {
            run.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(run);
        } catch (Throwable t) {
            Log.add(this, "화면은 깨웠는데 카톡 공유창을 못 열었어 — "
                    + t.getClass().getSimpleName() + " (카톡이 안 깔렸거나 버전이 너무 달라)");
        }
        finish();
    }

    @Override
    protected void onDestroy() {
        try { h.removeCallbacksAndMessages(null); } catch (Throwable ignore) { }
        super.onDestroy();
    }
}
