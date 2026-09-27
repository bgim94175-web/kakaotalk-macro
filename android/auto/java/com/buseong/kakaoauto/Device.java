package com.buseong.kakaoauto;

import android.content.Context;
import android.content.pm.ApplicationInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.os.Build;
import android.os.Debug;
import android.provider.Settings;

import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 기기 식별 + 앱 무결성 지표. 서버가 1키 1기기 고정과 변조 탐지에 쓴다.
 */
public final class Device {
    private Device() {}

    private static final String K_FALLBACK_ID = "fallback_device_id";

    /** 설치 출처로 정상 취급하는 패키지들 (직접 APK 배포라 스토어만으론 부족하다) */
    private static final Set<String> OK_INSTALLERS = new HashSet<String>(Arrays.asList(
            "com.android.vending",
            "com.google.android.packageinstaller",
            "com.android.packageinstaller",
            "com.miui.packageinstaller",
            "com.samsung.android.packageinstaller",
            "com.sec.android.app.samsungapps",
            "com.google.android.apps.nbu.files",
            "com.android.documentsui",
            "com.kakao.talk",
            "com.android.chrome",
            "com.sec.android.app.sbrowser"
    ));

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
                Log.add(c, "기기 ID를 못 읽어서 임시 ID를 만들었어 — 기기를 초기화하면 재등록이 필요해");
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
        String abi = (Build.SUPPORTED_ABIS != null && Build.SUPPORTED_ABIS.length > 0)
                ? n(Build.SUPPORTED_ABIS[0]) : "";
        String s = n(Build.MANUFACTURER) + "|" + n(Build.MODEL) + "|" + n(Build.DEVICE) + "|"
                + n(Build.BOARD) + "|" + Build.VERSION.SDK_INT + "|" + abi;
        fpCache = Crypto.hex(Crypto.sha256(s.getBytes(StandardCharsets.UTF_8)));
        return fpCache;
    }

    /** 내 APK 서명 인증서의 sha256 (소문자 hex). 못 구하면 "". */
    public static String appSigSha256(Context c) {
        if (c == null) return "";
        try {
            byte[] raw;
            if (Build.VERSION.SDK_INT >= 28) raw = sig28(c);
            else raw = sigLegacy(c);
            if (raw == null) return "";
            return Crypto.hex(Crypto.sha256(raw));
        } catch (Throwable t) {
            return "";
        }
    }

    private static byte[] sig28(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(
                    c.getPackageName(), PackageManager.GET_SIGNING_CERTIFICATES);
            if (pi == null || pi.signingInfo == null) return null;
            Signature[] a = pi.signingInfo.getApkContentsSigners();
            if (a == null || a.length == 0) return null;
            return a[0].toByteArray();
        } catch (Throwable t) {
            return null;
        }
    }

    @SuppressWarnings("deprecation")
    private static byte[] sigLegacy(Context c) {
        try {
            PackageInfo pi = c.getPackageManager().getPackageInfo(
                    c.getPackageName(), PackageManager.GET_SIGNATURES);
            if (pi == null || pi.signatures == null || pi.signatures.length == 0) return null;
            return pi.signatures[0].toByteArray();
        } catch (Throwable t) {
            return null;
        }
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

    /**
     * 변조 지표를 콤마로 이어서 준다. 정상이면 "".
     * 가능한 값: debuggable, debugger, installer, emulator, source_path, split, check_fail
     * 서버엔 audit detail 로 올라간다 (이것만으로 차단하진 않는다).
     */
    public static String tamperFlags(Context c) {
        StringBuilder sb = new StringBuilder();
        if (c == null) return "check_fail";
        try {
            ApplicationInfo ai = c.getApplicationInfo();
            if (ai != null && (ai.flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0) put(sb, "debuggable");
            if (Debug.isDebuggerConnected() || Debug.waitingForDebugger()) put(sb, "debugger");

            String inst = installer(c);
            if (inst == null || inst.length() == 0 || !OK_INSTALLERS.contains(inst)) put(sb, "installer");

            String fp = (Build.FINGERPRINT == null) ? "" : Build.FINGERPRINT.toLowerCase(Locale.US);
            String model = (Build.MODEL == null) ? "" : Build.MODEL.toLowerCase(Locale.US);
            if (fp.contains("generic") || fp.contains("emulator")
                    || model.contains("sdk") || model.contains("emulator")) put(sb, "emulator");

            if (ai != null) {
                String src = (ai.sourceDir == null) ? "" : ai.sourceDir;
                if (!src.startsWith("/data/app")) put(sb, "source_path");
                if (ai.splitSourceDirs != null && ai.splitSourceDirs.length > 0) put(sb, "split");
            }
        } catch (Throwable t) {
            put(sb, "check_fail");
        }
        return sb.toString();
    }

    @SuppressWarnings("deprecation")
    private static String installer(Context c) {
        try {
            PackageManager pm = c.getPackageManager();
            if (Build.VERSION.SDK_INT >= 30) {
                try {
                    return pm.getInstallSourceInfo(c.getPackageName()).getInstallingPackageName();
                } catch (Throwable t) {
                    return pm.getInstallerPackageName(c.getPackageName());
                }
            }
            return pm.getInstallerPackageName(c.getPackageName());
        } catch (Throwable t) {
            return null;
        }
    }

    private static void put(StringBuilder sb, String flag) {
        if (sb.length() > 0) sb.append(',');
        sb.append(flag);
    }

    private static String n(String s) {
        return (s == null) ? "" : s;
    }
}
