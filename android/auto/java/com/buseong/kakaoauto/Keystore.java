package com.buseong.kakaoauto;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * config_key(설정 암호화 키 재료) 보관소. 처음 쓸 때 Prefs 가 기기 안에서 난수로 만든다.
 * (v2.0 이하에서 받아둔 값이 있으면 그 값을 그대로 이어서 쓴다)
 *
 * 평문 저장은 금지다. AndroidKeyStore 안의 AES 키(alias kakaoauto_cfg)로 한 번 더 봉인해서
 * Prefs 평문키 "ck_blob" 에 넣는다. KeyStore 가 안 되는 기기는 기기지문 유도키로 폴백하고
 * 그 사실을 로그에 남긴다.
 *
 * 저장 형식
 *   k1:(b64 iv):(b64 ct)   AndroidKeyStore 로 봉인
 *   f1:v1:(b64 iv):(b64 ct) 기기지문 폴백(예전 형식: 지문에 안드로이드 버전이 들어가 OS 업데이트 뒤에는 그 버전으로 다시 열어 본다)
 *   f2:v1:(b64 iv):(b64 ct) 기기ID 폴백(안드로이드 버전이 바뀌어도 같은 키)
 */
public final class Keystore {
    private Keystore() {}

    private static final String ALIAS = "kakaoauto_cfg";
    private static final String BLOB_KEY = "ck_blob";
    private static final String FB_INFO = "kakaoauto-fallback-v1";
    private static final String FB2_INFO = "kakaoauto-fallback-v2";
    private static final String FAIL_N = "ck_fail_n";
    private static final String FAIL_AT = "ck_fail_at";

    /** 실행 중 메모리 캐시 */
    private static volatile String cache;
    /** "열지 못했습니다" 로그는 실행마다 한 번만 */
    private static boolean failLogged;

    /** config_key(base64) 저장. 기기에 보관했으면 true(못 했으면 false — 이번 실행의 설정은 다음에 열리지 않으니 저장하지 않는다). */
    public static synchronized boolean putConfigKey(Context c, String b64) {
        return putConfigKey(c, b64, true);
    }

    /** useKs=false 면 키 저장소를 쓰지 않고 기기ID 형식(f2)으로만 봉인한다(키 저장소가 안 되던 기기의 예전 값을 옮길 때). */
    private static boolean putConfigKey(Context c, String b64, boolean useKs) {
        if (c == null || b64 == null || b64.length() == 0) return false;
        String blob = useKs ? sealKs(b64) : null;
        if (blob == null || openKs(blob) == null) {
            byte[] fk = stableKey(c);
            String f = (fk == null) ? null : Crypto.seal(fk, b64);
            if (f == null) {
                Log.add(c, "설정 저장 공간을 기기에 보관하지 못했습니다. 앱을 다시 실행해 주십시오.");
                return false;
            }
            blob = "f2:" + f;
            android.util.Log.i("KakaoAuto", "config key: fallback storage");
        }
        if (!Prefs.sp(c).edit().putString(BLOB_KEY, blob).commit()) return false;
        cache = b64;
        Prefs.remove(c, FAIL_N);
        Prefs.remove(c, FAIL_AT);
        Prefs.clearCache();
        return true;
    }

    /** 저장된 config_key(base64). 없거나 복호화 실패면 null. */
    public static synchronized String getConfigKey(Context c) {
        if (cache != null) return cache;
        if (c == null) return null;
        String blob = Prefs.getStr(c, BLOB_KEY, null);
        if (blob == null || blob.length() == 0) return null;

        String v = null;
        boolean reseal = false;
        if (blob.startsWith("k1:")) {
            v = openKs(blob);
        } else if (blob.startsWith("f2:")) {
            byte[] fk = stableKey(c);
            v = (fk == null) ? null : Crypto.open(fk, blob.substring(3));
        } else if (blob.startsWith("f1:")) {
            // 예전 형식: 지금 버전으로 먼저, 안 되면 OS 업데이트 전 버전들로 열어 본다. 열리면 바뀌지 않는 형식으로 다시 봉인한다.
            String body = blob.substring(3);
            byte[] fk = fallbackKey(c, Device.fingerprint(c));
            v = (fk == null) ? null : Crypto.open(fk, body);
            for (int sdk = android.os.Build.VERSION.SDK_INT - 1; v == null && sdk >= 21; sdk--) {
                fk = fallbackKey(c, Device.fingerprint(sdk));
                v = (fk == null) ? null : Crypto.open(fk, body);
            }
            reseal = v != null;
        }
        if (v == null) {
            if (!failLogged) Log.add(c, "저장된 설정 키를 열지 못했습니다.");
            failLogged = true;
            return null;
        }
        cache = v;
        Prefs.remove(c, FAIL_N);
        Prefs.remove(c, FAIL_AT);
        // 키 저장소가 안 되던 기기라 f1 이었다 → 키 저장소 대신 바뀌지 않는 f2 로 옮긴다
        if (reseal) putConfigKey(c, v, false);
        return v;
    }

    /**
     * 저장된 blob 이 열리지 않을 때 새로 만들어도 되는지. 키 저장소(k1)는 잠깐 실패할 수 있으니 바로 포기하지 않는다:
     * 10분 넘게 떨어진 실패를 하나로 세어 3번째에야 true. 기기 값으로 여는 형식(f1·f2)은 다시 해도 같으니 바로 true.
     */
    public static synchronized boolean giveUp(Context c) {
        String blob = Prefs.getStr(c, BLOB_KEY, null);
        if (blob == null || !blob.startsWith("k1:")) return true;
        long now = System.currentTimeMillis();
        int n = Prefs.getInt(c, FAIL_N, 0);
        long at = Prefs.getLong(c, FAIL_AT, 0L);
        if (n == 0 || now - at >= 10 * 60 * 1000L || now < at) {
            n++;
            Prefs.putInt(c, FAIL_N, n);
            Prefs.putLong(c, FAIL_AT, now);
        }
        return n >= 3;
    }

    public static boolean has(Context c) {
        return getConfigKey(c) != null;
    }

    /** 저장된 blob 이 있는지 (열 수 있는지와는 별개) */
    public static boolean hasBlob(Context c) {
        String blob = Prefs.getStr(c, BLOB_KEY, null);
        return blob != null && blob.length() > 0;
    }

    /** 열리지 않는 blob 을 지우지 않고 옆으로 옮겨 둔다 (새 키를 만들기 직전에 부른다). */
    public static synchronized void retireBlob(Context c) {
        if (c == null) return;
        String blob = Prefs.getStr(c, BLOB_KEY, null);
        if (blob == null || blob.length() == 0) return;
        Prefs.putStr(c, BLOB_KEY + "_old", blob);
        // 그 키로 잠긴 설정도 옆에 남긴다(새 키로 저장하면 덮이므로)
        String saved = Prefs.getStr(c, "s_" + Settings.SLOT, null);
        if (saved != null) Prefs.putStr(c, "s_" + Settings.SLOT + "_old", saved);
        Prefs.remove(c, BLOB_KEY);
        cache = null;
    }

    /** 초기화용. KeyStore 키와 저장 blob, 메모리 캐시를 모두 지운다. */
    public static synchronized void clear(Context c) {
        cache = null;
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
        } catch (Throwable t) {
            // 지우기 실패는 치명적이지 않다 — blob 을 없애면 어차피 못 쓴다
            android.util.Log.w("KakaoAuto", "키저장소 삭제 실패", t);
        }
        if (c != null) {
            Prefs.remove(c, BLOB_KEY);
            Prefs.clearCache();
        }
    }

    // ── 내부 ──────────────────────────────────────────────────────────────────

    private static String sealKs(String plain) {
        try {
            SecretKey k = ksKey();
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.ENCRYPT_MODE, k);
            byte[] iv = ci.getIV();
            byte[] ct = ci.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            if (iv == null || iv.length == 0) return null;
            return "k1:" + Crypto.b64(iv) + ":" + Crypto.b64(ct);
        } catch (Throwable t) {
            return null;
        }
    }

    private static String openKs(String blob) {
        try {
            String[] p = blob.split(":");
            if (p.length != 3) return null;
            byte[] iv = Crypto.unb64(p[1]);
            byte[] ct = Crypto.unb64(p[2]);
            if (iv == null || ct == null || iv.length == 0) return null;
            SecretKey k = loadKs();
            if (k == null) return null;
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, iv));
            return new String(ci.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 있는 키만 꺼낸다(열 때는 새 키를 만들지 않는다 — 잠깐 실패를 '없음'으로 보고 덮어쓰면 옛 값을 영영 못 연다) */
    private static SecretKey loadKs() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(ALIAS, null);
        return (e instanceof KeyStore.SecretKeyEntry) ? ((KeyStore.SecretKeyEntry) e).getSecretKey() : null;
    }

    private static SecretKey ksKey() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) {
            return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        }
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .setRandomizedEncryptionRequired(true)
                .build());
        return g.generateKey();
    }

    /** 예전(f1) 형식의 키: 기기지문 + 기기ID 로 유도 */
    private static byte[] fallbackKey(Context c, String fp) {
        try {
            String did = Device.deviceId(c);
            if (fp == null || fp.length() == 0 || did == null) return null;
            return Crypto.hkdf(fp.getBytes(StandardCharsets.UTF_8),
                    did.getBytes(StandardCharsets.UTF_8), FB_INFO, 32);
        } catch (Throwable t) {
            return null;
        }
    }

    /** KeyStore 못 쓰는 기기용(f2): 기기ID + 앱 이름으로 유도 — 안드로이드 버전이 바뀌어도 같다 */
    private static byte[] stableKey(Context c) {
        try {
            String did = Device.deviceId(c);
            if (did == null || did.length() == 0) return null;
            return Crypto.hkdf(did.getBytes(StandardCharsets.UTF_8),
                    c.getPackageName().getBytes(StandardCharsets.UTF_8), FB2_INFO, 32);
        } catch (Throwable t) {
            return null;
        }
    }
}
