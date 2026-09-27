package com.buseong.kakaoauto;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Handler;
import android.os.Looper;

import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 알람 + 부팅 복구를 같이 받는 리시버. (매니페스트에 이 하나만 등록돼 있다)
 *
 *  - {@link Scheduler#ACTION_FIRE}  → 발송 판정/실행 (Scheduler.runDue)
 *  - BOOT_COMPLETED / QUICKBOOT_POWERON / MY_PACKAGE_REPLACED → 알람 다시 걸기 (Scheduler.ensureScheduled)
 *
 * onReceive 는 메인 스레드에서 돈다. 발송은 방 사이 1~3초를 쉬면서 최대 35초까지 걸리니까
 * 여기서 직접 하면 ANR 이다. 그래서 goAsync() 로 브로드캐스트를 붙잡고 별도 스레드로 넘긴다.
 *
 * 다만 브로드캐스트를 오래 붙잡고 있으면 시스템이 "took too long" 으로 프로세스를 잡아간다.
 * 그래서 {@link #HANDOFF_MS} 안에 일이 안 끝나면 PendingResult 만 먼저 놓아준다 —
 * 남은 발송은 Scheduler 가 잡아둔 WakeLock 이 지켜준다. finish() 는 정확히 한 번만 불린다.
 */
public final class AlarmReceiver extends BroadcastReceiver {

    /** 일부 제조사(HTC 등)가 쓰는 빠른부팅 액션 */
    public static final String ACTION_QUICKBOOT = "android.intent.action.QUICKBOOT_POWERON";
    public static final String ACTION_QUICKBOOT_HTC = "com.htc.intent.action.QUICKBOOT_POWERON";

    /** 이 시간 안에 안 끝나면 브로드캐스트는 먼저 놓아준다 */
    private static final long HANDOFF_MS = 8000L;

    @Override
    public void onReceive(Context ctx, Intent intent) {
        final Context c = appCtx(ctx);
        if (c == null) return;

        final String action = (intent == null || intent.getAction() == null) ? "" : intent.getAction();
        final boolean boot = isBoot(action);

        final PendingResult pr;
        try {
            pr = goAsync();
        } catch (Throwable t) {
            // goAsync 가 안 되면(이론상 없음) 그래도 일은 해야 한다 — 스레드만 띄우고 끝낸다
            Log.add(c, "알람을 비동기로 못 받았어: " + t);
            spawn(c, action, boot, null);
            return;
        }

        final AtomicBoolean finished = new AtomicBoolean(false);
        final Runnable finish = new Runnable() {
            @Override public void run() {
                if (!finished.compareAndSet(false, true)) return;
                try {
                    if (pr != null) pr.finish();
                } catch (Throwable t) {
                    android.util.Log.w("KakaoAuto", "브로드캐스트 종료 실패", t);
                }
            }
        };

        // 오래 걸리면 브로드캐스트만 먼저 놓아준다 (일은 계속 돈다)
        try {
            new Handler(Looper.getMainLooper()).postDelayed(finish, HANDOFF_MS);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "브로드캐스트 타임아웃을 못 걸었어", t);
        }

        spawn(c, action, boot, finish);
    }

    /** 실제 일은 전부 이 스레드에서. 어떤 경우에도 finish 는 불린다. */
    private static void spawn(final Context c, final String action,
                              final boolean boot, final Runnable finish) {
        Runnable body = new Runnable() {
            @Override public void run() {
                try {
                    if (boot) {
                        Log.add(c, bootKr(action));
                        Scheduler.ensureScheduled(c);
                    } else if (Scheduler.ACTION_FIRE.equals(action) || action.length() == 0) {
                        Scheduler.runDue(c);
                    } else {
                        Log.add(c, "모르는 알람이 들어와서 무시했어: " + action);
                    }
                } catch (Throwable t) {
                    Log.add(c, "알람 처리 중 오류가 났어: " + t);
                } finally {
                    if (finish != null) {
                        try { finish.run(); } catch (Throwable ignore) { /* 위에서 이미 방어됨 */ }
                    }
                }
            }
        };

        try {
            Thread th = new Thread(body, boot ? "alarm-boot" : "alarm-fire");
            th.setPriority(Thread.NORM_PRIORITY);
            th.start();
        } catch (Throwable t) {
            // 스레드조차 못 만드는 상황. 조용히 버리지 말고 로그는 남긴다.
            Log.add(c, "알람 처리 스레드를 못 만들었어: " + t);
            if (finish != null) {
                try { finish.run(); } catch (Throwable ignore) { /* 무시 */ }
            }
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
            return "앱이 업데이트됐어 — 발송 예약을 되살릴게";
        }
        return "기기가 켜졌어 — 발송 예약을 되살릴게";
    }

    private static Context appCtx(Context c) {
        if (c == null) return App.app();
        Context a = c.getApplicationContext();
        return (a == null) ? c : a;
    }
}
