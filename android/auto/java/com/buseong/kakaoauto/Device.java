package com.buseong.kakaoauto;

import android.content.Context;
import android.content.pm.PackageInfo;
import android.os.Build;
import android.provider.Settings;

import java.nio.charset.StandardCharsets;
import java.util.Locale;

/**
 * 기기 정보. deviceId·fingerprint 는 설정 암호화 키를 만들 때(Prefs·Keystore) 쓰고,
 * 나머지는 화면·로그에 보여주는 용도다. 밖으로 보내는 일은 없다.
 */
public final class Device {
    private Device() {}

    private static final String K_FALLBACK_ID = "fallback_device_id";

    private static String idCache;
    private static String fpCache;

    /** 기기 ID = ANDROID_ID. 못 읽으면 앱 안에서 만든 난수 ID로 폴백한다. */
    public static synchronized String deviceId(Context c) {
        if (idCache != null) return idCache;
        String id = null;
        if (c != null) {
            try {
                id = Settings.Secure.getString(c.getContentResolver(), Settings.Secure.ANDROID_ID);
            } catch (Throwable t) {
                id = null;
            }
        }
        if (id == null || id.length() < 8
                || "9774d56d682e549c".equals(id)
                || "0000000000000000".equals(id)) {
            id = Prefs.getStr(c, K_FALLBACK_ID, null);
            if (id == null || id.length() == 0) {
                id = "fb" + Crypto.randomHex(15);
                Prefs.putStr(c, K_FALLBACK_ID, id);
                Log.add(c, "기기 ID를 읽지 못해 앱 전용 임시 ID를 생성했습니다.");
            }
        }
        idCache = id;
        return id;
    }

    /** 사람이 보는 기기 이름 */
    public static String deviceName() {
        String m = (Build.MANUFACTURER == null) ? "" : Build.MANUFACTURER.trim();
        String d = (Build.MODEL == null) ? "" : Build.MODEL.trim();
        if (d.length() == 0) return (m.length() == 0) ? "알 수 없는 기기" : m;
        if (m.length() == 0) return d;
        if (d.toLowerCase(Locale.US).startsWith(m.toLowerCase(Locale.US))) return d;
        return m + " " + d;
    }

    /** 하드웨어 지문 = sha256(MANUFACTURER|MODEL|DEVICE|BOARD|SDK_INT|ABI) */
    public static synchronized String fingerprint(Context c) {
        if (fpCache != null) return fpCache;
        fpCache = fingerprint(Build.VERSION.SDK_INT);
        return fpCache;
    }

    /** 지문을 다른 안드로이드 버전(SDK_INT)으로 구한다 — OS 업데이트 전에 봉인한 예전 값을 다시 열 때만 쓴다. */
    public static String fingerprint(int sdk) {
        String abi = (Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0)
                ? n(Build.SUPPORTED_ABIS[0]) : "";
        String s = n(Build.MANUFACTURER) + "|" + n(Build.MODEL) + "|" + n(Build.DEVICE) + "|"
                + n(Build.BOARD) + "|" + sdk + "|" + abi;
        return Crypto.hex(Crypto.sha256(s.getBytes(StandardCharsets.UTF_8)));
    }

    /** versionCode. 못 구하면 0. */
    @SuppressWarnings("deprecation")
    public static int appVersion(Context c) {
        if (c == null) return 0;
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            if (Build.VERSION.SDK_INT >= 28) return (int) pi.getLongVersionCode();
            return pi.versionCode;
        } catch (Throwable t) {
            return 0;
        }
    }

    public static String appVersionName(Context c) {
        if (c == null) return "";
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(c.getPackageName(), 0);
            return (pi.versionName == null) ? "" : pi.versionName;
        } catch (Throwable t) {
            return "";
        }
    }

    private static String n(String s) {
        return (s == null) ? "" : s;
    }
}
