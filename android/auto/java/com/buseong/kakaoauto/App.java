package com.buseong.kakaoauto;

import android.app.Application;
import android.content.Context;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 전역 초기화 + 크래시 기록.
 *
 *  - 어디서든 앱 컨텍스트가 필요하면 {@link #app()}. (브로드캐스트 리시버가 컨텍스트를 못 줄 때의 보험)
 *  - 앱이 죽으면 스택트레이스를 평문 Prefs "last_crash" 에 commit 으로 박고 Log 에도 남긴 뒤,
 *    원래 기본 핸들러로 그대로 넘긴다 — 죽는 걸 막지 않는다. 삼키면 원인을 영원히 못 찾는다.
 *  - 시작 직후 백그라운드에서 설정을 미리 읽고(복호화 워밍업) 발송 알람이 살아있는지 확인한다.
 *    강제종료 뒤에는 알람이 지워지므로, 앱이 한 번 뜨면 스스로 되살아나야 한다.
 */
public final class App extends Application {

    /** 마지막 크래시 스택트레이스 (평문 Prefs) */
    public static final String K_CRASH = "last_crash";
    /** 마지막 크래시 시각 (epoch ms) */
    public static final String K_CRASH_AT = "last_crash_at";

    /** 스택트레이스를 이 길이까지만 저장한다 (SharedPreferences 를 부풀리지 않게) */
    private static final int CRASH_MAX = 8000;

    private static volatile Context APP;

    /**
     * 앱 컨텍스트. 프로세스가 막 뜨는 중이면 null 일 수 있으니 호출부에서 널 체크해라.
     * (Application 자체가 애플리케이션 컨텍스트라 이걸 그대로 들고 있어도 새지 않는다)
     */
    public static Context app() {
        return APP;
    }

    @Override
    public void onCreate() {
        APP = this;
        super.onCreate();

        installCrashHandler();

        try {
            Log.add(this, "앱 시작 · v" + Device.appVersionName(this)
                    + " (" + Device.appVersion(this) + ")");
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "시작 로그 실패", t);
        }

        warmUp();
    }

    // ── 크래시 핸들러 ─────────────────────────────────────────────────────────

    private void installCrashHandler() {
        final Thread.UncaughtExceptionHandler prev;
        try {
            prev = Thread.getDefaultUncaughtExceptionHandler();
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "기본 크래시 핸들러를 못 읽었어", t);
            return;
        }

        try {
            Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
                @Override public void uncaughtException(Thread th, Throwable e) {
                    try {
                        record(App.this, th, e);
                    } catch (Throwable ignore) {
                        android.util.Log.e("KakaoAuto", "크래시 기록 실패", ignore);
                    }
                    // 우리가 삼키지 않는다 — 원래 핸들러(구글 리포터 등)로 넘긴다
                    if (prev != null) {
                        prev.uncaughtException(th, e);
                    } else {
                        android.os.Process.killProcess(android.os.Process.myPid());
                        System.exit(10);
                    }
                }
            });
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "크래시 핸들러 설치 실패", t);
        }
    }

    /** 크래시 기록. 프로세스가 곧 죽으니 apply 가 아니라 commit 으로 확실히 박는다. */
    private static void record(Context c, Thread th, Throwable e) {
        long now = System.currentTimeMillis();
        String head = headline(e);
        String body = "시각 " + stamp(now) + "\n"
                + "스레드 " + ((th == null) ? "?" : th.getName()) + "\n"
                + "앱 v" + Device.appVersionName(c) + " (" + Device.appVersion(c) + ")\n"
                + "기기 " + Device.deviceName() + " · SDK " + android.os.Build.VERSION.SDK_INT + "\n\n"
                + clip(stack(e));

        try {
            Prefs.sp(c).edit()
                    .putString(K_CRASH, body)
                    .putLong(K_CRASH_AT, now)
                    .commit();
        } catch (Throwable t) {
            android.util.Log.e("KakaoAuto", "크래시 저장 실패", t);
        }

        // Log.add 는 안에서 commit 한다 — 죽는 중에도 남는다
        Log.add(c, "앱이 비정상 종료되었습니다: " + head);
    }

    // ── 마지막 크래시 조회 (내정보 탭에서 보여주면 된다) ───────────────────────

    /** 마지막 크래시 내용. 없으면 null. */
    public static String lastCrash(Context c) {
        if (c == null) return null;
        String v = Prefs.getStr(c, K_CRASH, null);
        return (v == null || v.length() == 0) ? null : v;
    }

    /** 마지막 크래시 시각 (epoch ms). 없으면 0. */
    public static long lastCrashAt(Context c) {
        return (c == null) ? 0L : Prefs.getLong(c, K_CRASH_AT, 0L);
    }

    /** 크래시 기록 지우기 */
    public static void clearCrash(Context c) {
        if (c == null) return;
        Prefs.remove(c, K_CRASH);
        Prefs.remove(c, K_CRASH_AT);
    }

    // ── 시작 워밍업 ───────────────────────────────────────────────────────────

    /**
     * 설정 프리로드 + 알람 자기복구. 메인 스레드를 잡으면 앱이 느려지니까 백그라운드에서 한다.
     * (Settings.load / Scheduler.ensureScheduled 둘 다 스레드 안전하다)
     */
    private void warmUp() {
        final Context c = this;
        Runnable body = new Runnable() {
            @Override public void run() {
                try {
                    Settings.load(c);
                } catch (Throwable t) {
                    Log.add(c, "설정을 사전 로드하지 못했습니다: " + t);
                }
                try {
                    Scheduler.ensureScheduled(c);
                } catch (Throwable t) {
                    Log.add(c, "발송 예약을 확인하지 못했습니다: " + t);
                }
            }
        };
        try {
            Thread th = new Thread(body, "app-init");
            th.setPriority(Thread.MIN_PRIORITY + 2);
            th.start();
        } catch (Throwable t) {
            // 스레드를 못 만들면 그 자리에서라도 설정은 읽어둔다
            Log.add(c, "초기화 스레드를 생성하지 못했습니다: " + t);
            try { Settings.load(c); } catch (Throwable ignore) { /* 위 로그로 충분 */ }
        }
    }

    // ── 문자열 도구 ───────────────────────────────────────────────────────────

    private static String headline(Throwable e) {
        if (e == null) return "알 수 없는 오류";
        String m = e.getMessage();
        String n = e.getClass().getName();
        return (m == null || m.length() == 0) ? n : (n + ": " + m);
    }

    private static String stack(Throwable e) {
        if (e == null) return "(스택트레이스 없음)";
        StringWriter sw = new StringWriter();
        PrintWriter pw = new PrintWriter(sw);
        try {
            e.printStackTrace(pw);
            pw.flush();
            return sw.toString();
        } catch (Throwable t) {
            return "(스택트레이스를 읽지 못했습니다: " + t + ")";
        } finally {
            try { pw.close(); } catch (Throwable ignore) { /* 무시 */ }
        }
    }

    private static String clip(String s) {
        if (s == null) return "";
        if (s.length() <= CRASH_MAX) return s;
        return s.substring(0, CRASH_MAX) + "\n…(생략)";
    }

    private static String stamp(long ms) {
        try {
            return new SimpleDateFormat("yyyy/MM/dd HH:mm:ss", Locale.KOREA).format(new Date(ms));
        } catch (Throwable t) {
            return String.valueOf(ms);
        }
    }
}
