package com.buseong.kakaoadmin;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 전역 초기화 + 크래시 핸들러 + 앱 로그(링버퍼).
 *
 * 매니페스트에 android:name=".App" 이 없어도 동작한다 —
 * MainActivity.onCreate() 가 {@link #install(Context)} 를 부르면 그때 붙는다(중복 호출 안전).
 * 매니페스트에 등록되면 Application.onCreate() 에서 더 일찍 붙는다. 둘 다 지원한다.
 *
 * 크래시는 v1.4 와 같은 방식으로 저장한다: 스택트레이스를 Prefs 에 넣어두고
 * 다음 실행 때 [설정] → 마지막 크래시 보기 에서 볼 수 있게 한다.
 */
public final class App extends Application {

    /** Prefs 이름 — Api 와 같은 파일을 쓴다 */
    public static final String PREFS = "kakao_admin";

    private static final String K_CRASH    = "last_crash";
    private static final String K_CRASH_AT = "last_crash_at";
    private static final String K_CRASH_SEEN = "last_crash_seen";
    private static final String K_LOG      = "app_log";

    private static final int LOG_LINES = 200;

    private static volatile boolean installed = false;
    private static volatile Context appCtx = null;

    @Override public void onCreate() {
        super.onCreate();
        install(this);
    }

    /** 어디서 불러도 안전. 이미 붙어있으면 아무것도 안 한다. */
    public static synchronized void install(Context c) {
        if (c != null && appCtx == null) appCtx = c.getApplicationContext();
        if (installed) return;
        installed = true;

        final Thread.UncaughtExceptionHandler prev = Thread.getDefaultUncaughtExceptionHandler();
        Thread.setDefaultUncaughtExceptionHandler(new Thread.UncaughtExceptionHandler() {
            @Override public void uncaughtException(Thread t, Throwable e) {
                try {
                    StringWriter sw = new StringWriter();
                    PrintWriter pw = new PrintWriter(sw);
                    pw.println("스레드: " + (t == null ? "?" : t.getName()));
                    pw.println("시각: " + stamp(System.currentTimeMillis()));
                    pw.println("앱: KakaoAdmin v2.0");
                    pw.println("기기: " + android.os.Build.MANUFACTURER + " " + android.os.Build.MODEL
                            + " (SDK " + android.os.Build.VERSION.SDK_INT + ")");
                    pw.println();
                    if (e != null) e.printStackTrace(pw);
                    pw.flush();
                    saveCrash(appCtx, sw.toString());
                    log(appCtx, "앱이 비정상 종료되었습니다: " + (e == null ? "원인 미확인" : String.valueOf(e)));
                } catch (Throwable ignore) {
                    // 크래시 핸들러가 또 죽으면 할 수 있는 게 없다
                }
                if (prev != null) prev.uncaughtException(t, e);
                else android.os.Process.killProcess(android.os.Process.myPid());
            }
        });
        log(c, "관리자앱 시작");
    }

    // ── 크래시 ────────────────────────────────────────────────────────────────

    private static void saveCrash(Context c, String text) {
        SharedPreferences p = prefs(c);
        if (p == null) return;
        p.edit().putString(K_CRASH, text).putLong(K_CRASH_AT, System.currentTimeMillis()).apply();
    }

    /** 저장된 마지막 크래시 스택트레이스. 없으면 null */
    public static String lastCrash(Context c) {
        SharedPreferences p = prefs(c);
        if (p == null) return null;
        String s = p.getString(K_CRASH, null);
        return (s == null || s.length() == 0) ? null : s;
    }

    /** 마지막 크래시 시각(ms). 없으면 0 */
    public static long lastCrashAt(Context c) {
        SharedPreferences p = prefs(c);
        return (p == null) ? 0L : p.getLong(K_CRASH_AT, 0L);
    }

    /**
     * 아직 사용자에게 안 보여준 크래시가 있나. (MainActivity 가 실행 직후 한 번만 알려주려고 쓴다)
     */
    public static boolean crashUnseen(Context c) {
        SharedPreferences p = prefs(c);
        if (p == null) return false;
        long at = p.getLong(K_CRASH_AT, 0L);
        if (at <= 0) return false;
        if (lastCrash(c) == null) return false;
        return at > p.getLong(K_CRASH_SEEN, 0L);
    }

    /** 크래시 알림을 보여줬다고 표시 (내용은 지우지 않는다 — 설정에서 다시 볼 수 있어야 한다) */
    public static void markCrashSeen(Context c) {
        SharedPreferences p = prefs(c);
        if (p != null) p.edit().putLong(K_CRASH_SEEN, System.currentTimeMillis()).apply();
    }

    public static void clearCrash(Context c) {
        SharedPreferences p = prefs(c);
        if (p != null) p.edit().remove(K_CRASH).remove(K_CRASH_AT).remove(K_CRASH_SEEN).apply();
    }

    // ── 로그 (링버퍼 200줄) ───────────────────────────────────────────────────

    /**
     * 사용자에게 보여줄 로그 한 줄. 실패를 조용히 삼키지 말고 전부 여기로 남긴다.
     * 어느 스레드에서 불러도 된다.
     */
    public static synchronized void log(Context c, String msg) {
        if (msg == null) msg = "";
        String line = stamp(System.currentTimeMillis()) + "  " + msg;
        try { android.util.Log.i("KakaoAdmin", msg); } catch (Throwable ignore) { }
        SharedPreferences p = prefs(c);
        if (p == null) return;
        try {
            String old = p.getString(K_LOG, "");
            StringBuilder sb = new StringBuilder();
            if (old != null && old.length() > 0) sb.append(old).append('\n');
            sb.append(line);
            String[] all = sb.toString().split("\n");
            int from = Math.max(0, all.length - LOG_LINES);
            StringBuilder out = new StringBuilder();
            for (int i = from; i < all.length; i++) {
                if (out.length() > 0) out.append('\n');
                out.append(all[i]);
            }
            p.edit().putString(K_LOG, out.toString()).apply();
        } catch (Throwable ignore) {
            // 로그 저장 실패로 앱을 망치진 않는다
        }
    }

    /** 최근 로그 전체 (오래된 → 최신). 없으면 빈 문자열 */
    public static String logDump(Context c) {
        SharedPreferences p = prefs(c);
        if (p == null) return "";
        String s = p.getString(K_LOG, "");
        return s == null ? "" : s;
    }

    public static void logClear(Context c) {
        SharedPreferences p = prefs(c);
        if (p != null) p.edit().remove(K_LOG).apply();
    }

    // ── 내부 ──────────────────────────────────────────────────────────────────

    private static SharedPreferences prefs(Context c) {
        Context use = (c != null) ? c.getApplicationContext() : appCtx;
        if (use == null) return null;
        try { return use.getSharedPreferences(PREFS, Context.MODE_PRIVATE); }
        catch (Throwable t) { return null; }
    }

    private static String stamp(long ms) {
        try {
            return new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA).format(new Date(ms));
        } catch (Throwable t) {
            return String.valueOf(ms);
        }
    }
}
