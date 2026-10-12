package com.buseong.kakaoauto;

import android.content.Context;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.Locale;

/**
 * 사용자에게 보여주는 활동 로그. 최근 200줄 링버퍼.
 * 에러를 삼키지 말고 여기에 남겨라 — 사용자가 내정보 탭에서 이걸 본다.
 *
 * 주의: 같은 패키지에 이 클래스가 있으니 다른 파일에서 android.util.Log 를 import 하면 충돌난다.
 * 시스템 로그가 필요하면 android.util.Log.i(..) 처럼 풀네임으로 써라.
 */
public final class Log {
    private Log() {}

    private static final String K_LOG = "K_LOG";
    private static final int MAX = 200;
    private static final ArrayList<String> MEM = new ArrayList<String>();
    private static boolean loaded = false;

    /** 한 줄 남긴다. "MM/dd HH:mm:ss 내용" 형태로 저장된다. */
    public static synchronized void add(Context c, String msg) {
        String m = (msg == null) ? "" : msg.replace('\n', ' ').replace('\r', ' ');
        String line = stamp() + " " + m;
        android.util.Log.i("KakaoAuto", line);
        if (c == null) return;
        try {
            load(c);
            MEM.add(line);
            while (MEM.size() > MAX) MEM.remove(0);
            save(c);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "로그 저장 실패", t);
        }
    }

    /** 최신이 위로 오게 이어붙인 전체 로그. 비어있으면 "". */
    public static synchronized String dump(Context c) {
        if (c == null) return "";
        load(c);
        if (MEM.isEmpty()) return "";
        StringBuilder sb = new StringBuilder(MEM.size() * 48);
        for (int i = MEM.size() - 1; i >= 0; i--) {
            sb.append(MEM.get(i));
            if (i > 0) sb.append('\n');
        }
        return sb.toString();
    }

    /** 오래된 것부터(시간순) 이어붙인 전체 로그. 파일로 내보낼 때 쓴다. */
    public static synchronized String dumpAsc(Context c) {
        if (c == null) return "";
        load(c);
        StringBuilder sb = new StringBuilder(MEM.size() * 48);
        for (int i = 0; i < MEM.size(); i++) {
            sb.append(MEM.get(i));
            if (i < MEM.size() - 1) sb.append('\n');
        }
        return sb.toString();
    }

    /** 현재 보관된 줄 수 */
    public static synchronized int count(Context c) {
        if (c == null) return 0;
        load(c);
        return MEM.size();
    }

    public static synchronized void clear(Context c) {
        MEM.clear();
        loaded = true;
        if (c == null) return;
        try {
            Prefs.sp(c).edit().remove(K_LOG).commit();
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "로그 삭제 실패", t);
        }
    }

    private static void load(Context c) {
        if (loaded) return;
        loaded = true;
        try {
            String raw = Prefs.sp(c).getString(K_LOG, null);
            if (raw == null || raw.length() == 0) return;
            String[] lines = raw.split("\n");
            for (int i = 0; i < lines.length; i++) {
                if (lines[i].length() > 0) MEM.add(lines[i]);
            }
            while (MEM.size() > MAX) MEM.remove(0);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "로그 불러오기 실패", t);
        }
    }

    private static void save(Context c) {
        StringBuilder sb = new StringBuilder(MEM.size() * 48);
        for (int i = 0; i < MEM.size(); i++) {
            sb.append(MEM.get(i));
            if (i < MEM.size() - 1) sb.append('\n');
        }
        // 크래시 직후에도 남아야 하니까 apply 말고 commit
        Prefs.sp(c).edit().putString(K_LOG, sb.toString()).commit();
    }

    private static String stamp() {
        try {
            return new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA).format(new Date());
        } catch (Throwable t) {
            return "--/-- --:--:--";
        }
    }
}
