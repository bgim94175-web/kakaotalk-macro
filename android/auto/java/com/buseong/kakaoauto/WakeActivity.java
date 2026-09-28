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
 * <h3>두 번째 역할 — 포그라운드 호출자 만들기</h3>
 * 앱이 화면에 없을 때 startActivity 를 시스템이 조용히 막는 경우가 있다(백그라운드 액티비티 차단).
 * 예외도 안 던지고 로그도 안 남으니 호출부는 "던졌는데 아무 일도 안 일어났다" 만 보게 된다.
 * 그래서 {@link ImageSender} 는 앱이 화면에 없으면 <b>이 액티비티를 먼저 띄우고</b>
 * 여기서 공유 인텐트를 던진다 — 그 순간 호출자는 화면에 보이는 우리 액티비티다.
 *
 * <h3>세 번째 역할 — 차단 여부를 알려주기</h3>
 * {@link #watch} 로 등록해두면 이 액티비티가 <b>실제로 떴는지</b>({@link Watcher#shown})와
 * <b>공유 인텐트 실행 결과</b>({@link Watcher#launched})를 알려준다.
 * 뜨지도 않았다는 사실 자체가 "시스템이 우리 액티비티 실행을 차단했다" 의 유일한 증거다.
 *
 * 화면이 이미 켜져 있고 앱이 화면에 표시된 상태면 {@link ImageSender} 가 이걸 거치지 않는다
 * (필요 없는 단계를 끼워 넣으면 그 자체가 실패 지점이 된다).
 */
public final class WakeActivity extends Activity {

    /** 실행할 인텐트를 담아오는 엑스트라 키 (우리 앱만 쓴다 — 매니페스트에서 exported=false) */
    public static final String EXTRA_RUN = "com.buseong.kakaoauto.WAKE_RUN";

    /** 호출부가 준 식별자 (어느 전송 건의 깨우기인지 구별한다) */
    public static final String EXTRA_ID = "com.buseong.kakaoauto.WAKE_ID";

    /**
     * 이 액티비티가 실제로 떴는지 · 담아온 인텐트가 실행됐는지 호출부에 알려주는 통로.
     * 콜백은 <b>메인 스레드</b>에서 불린다.
     */
    public interface Watcher {
        /** 액티비티가 화면에 떴다 = 시스템이 우리 액티비티 실행을 허용했다 */
        void shown(long id);
        /** 담아온 인텐트 실행 결과. err 가 null 이면 성공. */
        void launched(long id, String err);
    }

    /** 감시자는 한 번에 한 건만 (ImageSender 가 한 번에 한 건만 돌린다) */
    private static volatile Watcher watcher = null;
    private static volatile long watchId = 0L;

    /** id 건의 깨우기 결과를 받는다. 같은 자리를 덮어쓴다. */
    public static void watch(long id, Watcher w) {
        watchId = id;
        watcher = w;
    }

    /** 감시 해제 (그 id 의 감시자일 때만) */
    public static void unwatch(long id) {
        if (watchId == id) watcher = null;
    }

    private static void report(long id, boolean shown, String err) {
        Watcher w = watcher;
        if (w == null || watchId != id) return;
        try {
            if (shown) w.shown(id);
            else w.launched(id, err);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "깨우기 결과 통지 실패", t);
        }
    }

    /** 잠금 해제 콜백을 기다리는 한도. 넘으면 그냥 실행해본다. */
    private static final long DISMISS_WAIT_MS = 1200L;

    /** 화면이 실제로 켜질 시간 (잠금이 안 걸린 경우에도 이만큼은 준다) */
    private static final long WARMUP_MS = 300L;

    private final Handler h = new Handler(Looper.getMainLooper());

    /** 안에 담아온 인텐트를 딱 한 번만 실행한다 (콜백 + 타임아웃이 겹칠 수 있다) */
    private boolean launched = false;

    /** 잠금 해제 실패 안내를 한 번만 남긴다 */
    private boolean lockWarned = false;

    /** 호출부가 준 식별자 (0 = 통지 없음) */
    private long id = 0L;

    /**
     * 공유 인텐트를 감싸서 이 액티비티로 띄우는 인텐트를 만든다.
     * inner 는 우리가 만든 카톡 공유 인텐트여야 한다.
     */
    public static Intent wrap(Context c, Intent inner) {
        return wrap(c, inner, 0L);
    }

    /**
     * 위와 같지만 결과를 돌려받을 식별자를 같이 싣는다 ({@link #watch}).
     * id 가 0 이면 통지하지 않는다.
     */
    public static Intent wrap(Context c, Intent inner, long id) {
        Intent i = new Intent(c, WakeActivity.class);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                | Intent.FLAG_ACTIVITY_CLEAR_TOP
                | Intent.FLAG_ACTIVITY_EXCLUDE_FROM_RECENTS);
        if (inner != null) i.putExtra(EXTRA_RUN, inner);
        if (id != 0L) i.putExtra(EXTRA_ID, id);
        return i;
    }

    @Override
    protected void onCreate(Bundle b) {
        super.onCreate(b);

        // ── 0. "우리 액티비티가 떴다" 를 먼저 알린다 ──
        //  이게 안 오면 시스템이 백그라운드 액티비티 실행을 차단한 것이다.
        //  차단은 예외도 로그도 남기지 않으므로 호출부는 이 신호로만 구별할 수 있다.
        try {
            Intent in0 = getIntent();
            if (in0 != null) id = in0.getLongExtra(EXTRA_ID, 0L);
        } catch (Throwable ignore) { }
        report(id, true, null);

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
            Log.add(this, "화면 절전 해제에 실패했습니다 (" + t.getClass().getSimpleName()
                    + "). 개발자 옵션의 「충전 중 화면 켜짐 유지」 를 활성화하면 이 단계가 생략됩니다.");
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
                        warnLock("잠금 해제 요청이 처리되지 않았습니다");
                        launch(run);          // 그래도 한 번 던져본다 — 될 기기도 있다
                    }
                    @Override public void onDismissCancelled() {
                        warnLock("잠금 해제가 취소되었습니다");
                        launch(run);
                    }
                });
            } catch (Throwable t) {
                warnLock("잠금 해제 요청에 실패했습니다 (" + t.getClass().getSimpleName() + ")");
                launch(run);
            }
            // 콜백이 아예 안 오는 기기가 있다 → 한도 지나면 그냥 실행한다
            h.postDelayed(new Runnable() {
                @Override public void run() {
                    if (!launched) warnLock("잠금 해제 응답이 수신되지 않았습니다");
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
            Log.add(this, "화면 절전 해제 실패: 실행할 카카오톡 인텐트가 전달되지 않았습니다.");
            return null;
        }
        return run;
    }

    /** 잠금 해제 실패 안내 (한 번만) */
    private void warnLock(String why) {
        if (lockWarned) return;
        lockWarned = true;
        Log.add(this, "잠금을 해제하지 못했습니다 (" + why + "). 설정 › 잠금화면 › 화면 잠금 방식을 "
                + "「없음」 으로 설정하십시오. 전용 기기인 경우 이 방식을 권장합니다.");
    }

    /** 담아온 인텐트를 딱 한 번 실행하고 끝낸다 */
    private void launch(Intent run) {
        if (launched) return;
        launched = true;
        try { h.removeCallbacksAndMessages(null); } catch (Throwable ignore) { }

        if (run == null) {
            report(id, false, "실행할 카카오톡 인텐트가 전달되지 않았습니다");
            finish();
            return;
        }
        String err = null;
        try {
            run.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(run);
        } catch (Throwable t) {
            err = "공유창 실행 예외 " + t.getClass().getSimpleName();
            Log.add(this, "화면 절전은 해제되었으나 카카오톡 공유창을 열지 못했습니다 ("
                    + t.getClass().getSimpleName() + "). 카카오톡이 설치되지 않았거나 버전이 호환되지 않습니다.");
        }
        report(id, false, err);
        finish();
    }

    @Override
    protected void onDestroy() {
        try { h.removeCallbacksAndMessages(null); } catch (Throwable ignore) { }
        super.onDestroy();
    }
}
