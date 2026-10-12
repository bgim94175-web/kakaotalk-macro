package com.buseong.kakaoauto;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 부팅 · 앱 업데이트 복구 전용 리시버.
 *
 * 기기를 끄거나 앱을 업데이트하면 걸어둔 알람이 전부 날아간다. 그래서 여기서 다시 잡는다.
 * 하는 일은 발송 알람 재예약(+ 예전 버전 알람 정리)뿐이다. 발송 자체는 절대 하지 않는다.
 *
 * 이 리시버만 exported="true" 다. 부팅 브로드캐스트는 시스템(다른 UID)이 보내니까 열려 있어야 들어온다.
 * BOOT_COMPLETED · MY_PACKAGE_REPLACED 는 시스템 전용 보호 브로드캐스트라 서드파티가 못 보내고,
 * QUICKBOOT_POWERON 은 보호되지 않지만 하는 일이 재예약뿐이라 외부에서 불려도 무해하다.
 * (실제 발송을 트리거하는 {@link AlarmReceiver} 는 exported="false" 로 닫혀 있다)
 */
public final class BootReceiver extends BroadcastReceiver {

    /** 일부 제조사가 쓰는 빠른부팅 액션 (매니페스트 intent-filter 에도 같이 등록돼 있다) */
    public static final String ACTION_QUICKBOOT = "android.intent.action.QUICKBOOT_POWERON";
    public static final String ACTION_QUICKBOOT_HTC = "com.htc.intent.action.QUICKBOOT_POWERON";

    /** 재예약이 이 시간 안에 안 끝나면 브로드캐스트는 먼저 놓아준다 */
    private static final long HANDOFF_MS = 8000L;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        final Context c = appCtx(ctx);
        if (c == null) return;

        final String action = (intent == null || intent.getAction() == null) ? "" : intent.getAction();
        if (!isBoot(action)) {
            // 우리가 기다리는 부팅 액션이 아니면 아무것도 하지 않는다
            android.util.Log.w("KakaoAuto", "부팅 리시버에 모르는 액션이 들어와서 무시했어: " + action);
            return;
        }

        PendingResult pr = null;
        try {
            pr = goAsync();
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "부팅 브로드캐스트를 비동기로 못 받았어", t);
        }

        final PendingResult held = pr;
        final Runnable finish = new Runnable() {
            private boolean done = false;
            @Override public synchronized void run() {
                if (done) return;
                done = true;
                try {
                    if (held != null) held.finish();
                } catch (Throwable t) {
                    android.util.Log.w("KakaoAuto", "부팅 브로드캐스트 종료 실패", t);
                }
            }
        };

        try {
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(finish, HANDOFF_MS);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "부팅 브로드캐스트 타임아웃을 못 걸었어", t);
        }

        final String act = action;
        Runnable body = new Runnable() {
            @Override public void run() {
                try {
                    Log.add(c, bootKr(act));
                    Scheduler.dropOldAlarm(c);
                    Scheduler.ensureScheduled(c);
                } catch (Throwable t) {
                    Log.add(c, "부팅 후 예약을 복구하지 못했습니다: " + t);
                } finally {
                    try { finish.run(); } catch (Throwable ignore) { /* 위에서 이미 방어됨 */ }
                }
            }
        };

        try {
            Thread th = new Thread(body, "boot-rearm");
            th.setPriority(Thread.NORM_PRIORITY);
            th.start();
        } catch (Throwable t) {
            Log.add(c, "부팅 처리 작업을 생성하지 못했습니다: " + t);
            try { finish.run(); } catch (Throwable ignore) { /* 무시 */ }
        }
    }

    private static boolean isBoot(String action) {
        return Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || ACTION_QUICKBOOT.equals(action)
                || ACTION_QUICKBOOT_HTC.equals(action);
    }

    private static String bootKr(String action) {
        if (Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)) {
            return "앱이 업데이트되었습니다. 발송 예약을 복구합니다.";
        }
        return "기기가 재시작되었습니다. 발송 예약을 복구합니다.";
    }

    private static Context appCtx(Context c) {
        if (c == null) return App.app();
        Context a = c.getApplicationContext();
        return (a == null) ? c : a;
    }
}
