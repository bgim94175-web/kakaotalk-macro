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
 * config_key(서버가 인증 성공 때만 주는 값) 보관소.
 *
 * 평문 저장은 금지다. AndroidKeyStore 안의 AES 키(alias kakaoauto_cfg)로 한 번 더 봉인해서
 * Prefs 평문키 "ck_blob" 에 넣는다. KeyStore 가 안 되는 기기는 기기지문 유도키로 폴백하고
 * 그 사실을 로그에 남긴다.
 *
 * 저장 형식
 *   k1:(b64 iv):(b64 ct)   AndroidKeyStore 로 봉인
 *   f1:v1:(b64 iv):(b64 ct) 기기지문 폴백 (Crypto.seal 결과에 f1: 접두)
 */
public final class Keystore {
    private Keystore() {}

    private static final String ALIAS = "kakaoauto_cfg";
    private static final String BLOB_KEY = "ck_blob";
    private static final String FB_INFO = "kakaoauto-fallback-v1";

    /** 실행 중 메모리 캐시 */
    private static volatile String cache;

    /** config_key(base64) 저장. null/빈값이면 삭제한다. */
    public static synchronized void putConfigKey(Context c, String b64) {
        if (c == null) return;
        if (b64 == null || b64.length() == 0) { clear(c); return; }
        cache = b64;

        String blob = sealKs(b64);
        if (blob == null) {
            byte[] fk = fallbackKey(c);
            String f = (fk == null) ? null : Crypto.seal(fk, b64);
            if (f == null) {
                Log.add(c, "설정 저장을 준비하지 못했습니다. 앱을 재시작하면 라이선스 재인증이 필요합니다.");
                return;
            }
            blob = "f1:" + f;
            // 어느 보관 방식을 썼는지는 손님 로그에 남기지 않는다 (보호 방식의 차이를 알려주는 셈이다)
            android.util.Log.i("KakaoAuto", "config key: fallback storage");
        }
        Prefs.putStr(c, BLOB_KEY, blob);
        Prefs.clearCache();
    }

    /** 저장된 config_key(base64). 없거나 복호화 실패면 null. */
    public static synchronized String getConfigKey(Context c) {
        if (cache != null) return cache;
        if (c == null) return null;
        String blob = Prefs.getStr(c, BLOB_KEY, null);
        if (blob == null || blob.length() == 0) return null;

        String v = null;
        if (blob.startsWith("k1:")) {
            v = openKs(blob);
        } else if (blob.startsWith("f1:")) {
            byte[] fk = fallbackKey(c);
            v = (fk == null) ? null : Crypto.open(fk, blob.substring(3));
        }
        if (v == null) {
            Log.add(c, "저장된 설정을 열지 못했습니다. 라이선스 재인증이 필요합니다.");
            return null;
        }
        cache = v;
        return v;
    }

    public static boolean has(Context c) {
        return getConfigKey(c) != null;
    }

    /** 로그아웃/초기화용. KeyStore 키와 저장 blob, 메모리 캐시를 모두 지운다. */
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
            SecretKey k = ksKey();
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, k, new GCMParameterSpec(128, iv));
            return new String(ci.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
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

    /** KeyStore 못 쓰는 기기용: 기기지문 + 기기ID 로 유도한 키 */
    private static byte[] fallbackKey(Context c) {
        try {
            String fp = Device.fingerprint(c);
            String did = Device.deviceId(c);
            if (fp == null || fp.length() == 0 || did == null) return null;
            return Crypto.hkdf(fp.getBytes(StandardCharsets.UTF_8),
                    did.getBytes(StandardCharsets.UTF_8), FB_INFO, 32);
        } catch (Throwable t) {
            return null;
        }
    }
}
