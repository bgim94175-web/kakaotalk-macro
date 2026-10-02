package com.buseong.kakaoadmin;

import android.app.Application;
import android.content.Context;
import android.content.SharedPreferences;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

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
                    pw.println("작업: " + (t == null ? "?" : t.getName()));
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
        // 민감정보(라이선스 키·앱 서명)는 logcat 과 평문 Prefs 어디에도 전체값이 남지 않게 가린다.
        msg = redact(msg);
        String line = stamp(System.currentTimeMillis()) + "  " + msg;
        // 릴리스(서명) 빌드에서는 logcat 출력을 끈다 — 버그리포트·ADB·기기 백업 경로로
        // 로그가 새 나가지 않게 한다. 운영 로그는 아래 앱 내 링버퍼로만 본다.
        try { if (debuggable(c)) android.util.Log.i("KakaoAdmin", msg); } catch (Throwable ignore) { }
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

    /** 라이선스 키: KAKA-ABCD-EFGH-IJKL → KAKA-****-****-IJKL (서버 purchase.js 와 같은 규칙) */
    private static final Pattern KEY_RE =
            Pattern.compile("KAKA-[A-Z0-9]{4}-[A-Z0-9]{4}-([A-Z0-9]{4})");
    /** 앱 서명 등 긴 16진수(해시) → 앞4·뒤4만 */
    private static final Pattern HEX_RE =
            Pattern.compile("\\b[0-9a-fA-F]{32,}\\b");

    /**
     * 로그에 남기기 전에 민감정보를 가린다.
     * 라이선스 키는 뒤 4자만, 앱 서명(긴 16진수 해시)은 앞4·뒤4만 남긴다.
     * 호출부가 전체값을 그대로 넘겨도 logcat·평문 Prefs 어디에도 전체값이 남지 않는다.
     * 로그는 "어느 키였는지" 식별만 되면 되므로 뒤 4자만으로 운영에 지장이 없다.
     */
    static String redact(String msg) {
        if (msg == null || msg.length() == 0) return msg;
        String out = msg;
        try {
            out = KEY_RE.matcher(out).replaceAll("KAKA-****-****-$1");
        } catch (Throwable ignore) { /* 가림에 실패해도 로그 자체는 남긴다 */ }
        try {
            Matcher mh = HEX_RE.matcher(out);
            StringBuffer sb = new StringBuffer(out.length());
            while (mh.find()) {
                String h = mh.group();
                String rep = h.substring(0, 4) + "…" + h.substring(h.length() - 4);
                mh.appendReplacement(sb, Matcher.quoteReplacement(rep));
            }
            mh.appendTail(sb);
            out = sb.toString();
        } catch (Throwable ignore) { /* 가림에 실패해도 로그 자체는 남긴다 */ }
        return out;
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

    /**
     * 디버그 빌드인지 판단한다. BuildConfig 를 생성하지 않는 수동 빌드이므로
     * 매니페스트의 debuggable 플래그로 본다. 릴리스(서명) 빌드는 이 플래그가 꺼져 있어
     * logcat 출력이 비활성화된다.
     */
    private static boolean debuggable(Context c) {
        Context use = (c != null) ? c.getApplicationContext() : appCtx;
        if (use == null) return false;
        try {
            return (use.getApplicationInfo().flags
                    & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        } catch (Throwable t) {
            return false;
        }
    }

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
