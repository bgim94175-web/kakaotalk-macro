package com.buseong.kakaoauto.engine;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import com.buseong.kakaoauto.Features;
import com.buseong.kakaoauto.License;
import com.buseong.kakaoauto.Log;
import com.buseong.kakaoauto.MainActivity;
import com.buseong.kakaoauto.Scheduler;
import com.buseong.kakaoauto.Settings;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 카카오 계정이 연결되고 매크로가 켜져 있는 동안 도는 포그라운드 서비스.
 *
 * 하는 일은 "프로세스를 살려 두기" 하나다. 상주 알림이 있는 프로세스는 제조사 배터리 관리자가
 * 함부로 죽이지 못하고, 그래서 정확한 알람이 울렸을 때 엔진(Node 프로세스)과 LOCO 세션이 살아 있다.
 * 발송 자체는 여전히 Scheduler(알람) 가 한다.
 *
 * 타입은 specialUse — dataSync 는 안드로이드 15 에서 하루 6시간 제한이 붙는다.
 */
public final class EngineService extends Service {

    private static final String CH = "engine";
    private static final int NOTE_ID = 7401;
    private static volatile boolean running = false;
    private static volatile boolean warnedStart = false;

    /** 돌아야 하면 시작(알림 갱신 포함)하고, 아니면 멈춘다. 여러 번 불러도 안전하다. */
    public static void sync(Context ctx) {
        if (ctx == null) return;
        Context c = ctx.getApplicationContext();
        if (shouldRun(c)) {
            try {
                Intent i = new Intent(c, EngineService.class);
                if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i);
                else c.startService(i);
            } catch (Throwable t) {
                // 안드로이드 12+ 는 백그라운드에서의 시작을 막을 수 있다 (배터리 최적화 제외 · 정확한 알람이면 허용)
                if (!warnedStart) {
                    warnedStart = true;
                    Log.add(c, "카카오 연결 유지 서비스를 시작하지 못했습니다. 배터리 최적화 제외를 확인하십시오. ("
                            + t.getClass().getSimpleName() + ")");
                }
            }
        } else if (running) {
            try { c.stopService(new Intent(c, EngineService.class)); } catch (Throwable ignore) { }
            Engine.reapIfIdle(c, 2 * 60 * 1000L);
        }
    }

    public static boolean running() {
        return running;
    }

    static boolean shouldRun(Context c) {
        try {
            if (!Engine.ready(c)) return false;
            if (!License.allowed(c, Features.MACRO)) return false;
            Settings.Macro m = Settings.macro(c);
            return m != null && m.enabled;
        } catch (Throwable t) {
            return false;
        }
    }

    @Override public void onCreate() {
        super.onCreate();
        channel(this);
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = note(this);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTE_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTE_ID, n);
            }
            running = true;
        } catch (Throwable t) {
            Log.add(this, "카카오 연결 유지 알림을 표시하지 못했습니다. (" + t.getClass().getSimpleName() + ")");
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!shouldRun(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        final Context app = getApplicationContext();
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    Engine.impl(app).host().ensureStarted();
                } catch (Throwable t) {
                    android.util.Log.w("KakaoEngine", "warm start failed", t);
                }
            }
        }, "engine-warm").start();
        return START_STICKY;
    }

    @Override public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) {
        return null;
    }

    private static void channel(Context c) {
        if (Build.VERSION.SDK_INT < 26) return;
        try {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null || nm.getNotificationChannel(CH) != null) return;
            NotificationChannel ch = new NotificationChannel(CH, "카카오 연결 유지", NotificationManager.IMPORTANCE_LOW);
            ch.setDescription("예약 발송이 배터리 관리로 중단되지 않도록 표시되는 상주 알림입니다.");
            ch.setShowBadge(false);
            nm.createNotificationChannel(ch);
        } catch (Throwable t) {
            android.util.Log.w("KakaoEngine", "channel failed", t);
        }
    }

    private static Notification note(Context c) {
        String text = "예약 발송 대기 중입니다.";
        try {
            long at = Scheduler.nextAt(c);
            if (at > 0) text = "다음 발송 " + new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date(at));
        } catch (Throwable ignore) { }
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        PendingIntent open = PendingIntent.getActivity(c, 7402, new Intent(c, MainActivity.class), piFlags);
        Notification.Builder b = (Build.VERSION.SDK_INT >= 26)
                ? new Notification.Builder(c, CH) : new Notification.Builder(c);
        b.setSmallIcon(c.getApplicationInfo().icon)
                .setContentTitle("카카오 계정 연결 유지 중")
                .setContentText(text)
                .setContentIntent(open)
                .setOngoing(true)
                .setShowWhen(false);
        if (Build.VERSION.SDK_INT >= 31) b.setForegroundServiceBehavior(Notification.FOREGROUND_SERVICE_IMMEDIATE);
        return b.build();
    }
}
