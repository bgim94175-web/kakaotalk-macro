package com.buseong.kakaoauto;

import android.content.Context;
import android.content.SharedPreferences;

import java.nio.charset.StandardCharsets;

/**
 * 저장소. 평문값은 getStr/putStr 계열로, 민감값(방 목록·발송 메시지·트리거·자동응답문 등)은 secGet/secPut 으로.
 *
 * 민감값은 서버가 인증 성공 때만 내려주는 config_key 로 유도한 AES-256-GCM 키로 봉인해서 저장한다.
 * 즉 라이선스 인증을 통과한 적 없는 기기(크랙앱)는 자기 설정을 읽을 수 없다 → 보낼 메시지가 없다.
 */
public final class Prefs {
    private Prefs() {}

    /** 기존 v1.8 과 같은 이름을 유지한다 (설정 이어받기) */
    public static final String PREFS = "kakao_auto";

    private static final String SEC_PREFIX = "s_";
    private static final String INFO = "kakaoauto-cfg-v1";

    /** 유도한 설정키 메모리 캐시. 디스크엔 절대 안 쓴다. */
    private static volatile byte[] keyCache;

    public static SharedPreferences sp(Context c) {
        return c.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    // ── 평문값 ────────────────────────────────────────────────────────────────

    public static String getStr(Context c, String k) { return getStr(c, k, null); }

    public static String getStr(Context c, String k, String def) {
        if (c == null || k == null) return def;
        try { return sp(c).getString(k, def); } catch (Throwable t) { return def; }
    }

    public static void putStr(Context c, String k, String v) {
        if (c == null || k == null) return;
        try {
            if (v == null) sp(c).edit().remove(k).apply();
            else sp(c).edit().putString(k, v).apply();
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "설정 저장 실패 " + k, t);
        }
    }

    public static int getInt(Context c, String k) { return getInt(c, k, 0); }

    public static int getInt(Context c, String k, int def) {
        if (c == null || k == null) return def;
        try { return sp(c).getInt(k, def); } catch (Throwable t) { return def; }
    }

    public static void putInt(Context c, String k, int v) {
        if (c == null || k == null) return;
        try { sp(c).edit().putInt(k, v).apply(); } catch (Throwable t) { /* 무시 */ }
    }

    public static boolean getBool(Context c, String k) { return getBool(c, k, false); }

    public static boolean getBool(Context c, String k, boolean def) {
        if (c == null || k == null) return def;
        try { return sp(c).getBoolean(k, def); } catch (Throwable t) { return def; }
    }

    public static void putBool(Context c, String k, boolean v) {
        if (c == null || k == null) return;
        try { sp(c).edit().putBoolean(k, v).apply(); } catch (Throwable t) { /* 무시 */ }
    }

    public static long getLong(Context c, String k) { return getLong(c, k, 0L); }

    public static long getLong(Context c, String k, long def) {
        if (c == null || k == null) return def;
        try { return sp(c).getLong(k, def); } catch (Throwable t) { return def; }
    }

    public static void putLong(Context c, String k, long v) {
        if (c == null || k == null) return;
        try { sp(c).edit().putLong(k, v).apply(); } catch (Throwable t) { /* 무시 */ }
    }

    public static boolean has(Context c, String k) {
        if (c == null || k == null) return false;
        try { return sp(c).contains(k); } catch (Throwable t) { return false; }
    }

    public static void remove(Context c, String k) {
        if (c == null || k == null) return;
        try { sp(c).edit().remove(k).apply(); } catch (Throwable t) { /* 무시 */ }
    }

    /** 전부 삭제 (공장초기화용). 로그도 같이 날아간다. */
    public static void clearAll(Context c) {
        if (c == null) return;
        try { sp(c).edit().clear().commit(); } catch (Throwable t) { /* 무시 */ }
        clearCache();
    }

    // ── 민감값 ────────────────────────────────────────────────────────────────

    /** 설정 암호화가 가능한 상태인지 (= 인증을 통과해 config_key 를 받았는지) */
    public static boolean secReady(Context c) {
        return key(c) != null;
    }

    /** 봉인된 값을 읽는다. 설정키가 없거나 복호화 실패면 null. */
    public static String secGet(Context c, String name) {
        if (c == null || name == null) return null;
        byte[] k = key(c);
        if (k == null) return null;
        String blob = getStr(c, SEC_PREFIX + name, null);
        if (blob == null || blob.length() == 0) return null;
        String v = Crypto.open(k, blob);
        if (v == null) Log.add(c, "설정을 복호화 못 했어 (" + name + ") — 라이선스 재인증이 필요해");
        return v;
    }

    /** 값을 봉인해서 저장한다. 설정키가 없으면 조용히 무시하고 로그만 남긴다. */
    public static void secPut(Context c, String name, String value) {
        if (c == null || name == null) return;
        if (value == null) { remove(c, SEC_PREFIX + name); return; }
        byte[] k = key(c);
        if (k == null) {
            Log.add(c, "설정키가 없어서 저장을 건너뛰었어 (" + name + ") — 라이선스 인증부터 해줘");
            return;
        }
        String blob = Crypto.seal(k, value);
        if (blob == null) {
            Log.add(c, "설정 암호화에 실패했어 (" + name + ")");
            return;
        }
        putStr(c, SEC_PREFIX + name, blob);
    }

    public static boolean secHas(Context c, String name) {
        return has(c, SEC_PREFIX + (name == null ? "" : name));
    }

    public static void secRemove(Context c, String name) {
        remove(c, SEC_PREFIX + (name == null ? "" : name));
    }

    /** 유도한 설정키 캐시를 버린다. config_key 가 바뀌거나 로그아웃할 때 호출. */
    public static void clearCache() {
        // 배열을 0으로 밀지는 않는다 — 다른 스레드가 같은 배열로 복호화 중이면 그게 깨진다
        keyCache = null;
    }

    /**
     * 설정키 유도: HKDF-SHA256(ikm=base64decode(config_key), salt=device_id, info="kakaoauto-cfg-v1", 32)
     * 한 번 구하면 메모리에 캐시한다.
     */
    private static byte[] key(Context c) {
        byte[] k = keyCache;
        if (k != null) return k;
        if (c == null) return null;
        synchronized (Prefs.class) {
            if (keyCache != null) return keyCache;
            String ck = Keystore.getConfigKey(c);
            if (ck == null || ck.length() == 0) return null;
            byte[] ikm = Crypto.unb64(ck);
            if (ikm == null || ikm.length == 0) {
                Log.add(c, "설정키 형식이 이상해 — 라이선스 재인증이 필요해");
                return null;
            }
            byte[] salt = Device.deviceId(c).getBytes(StandardCharsets.UTF_8);
            byte[] derived = Crypto.hkdf(ikm, salt, INFO, 32);
            if (derived == null) {
                Log.add(c, "설정키 유도에 실패했어");
                return null;
            }
            keyCache = derived;
            return derived;
        }
    }
}
