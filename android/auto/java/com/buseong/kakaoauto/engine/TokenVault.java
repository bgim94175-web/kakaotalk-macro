package com.buseong.kakaoauto.engine;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import com.buseong.kakaoauto.Crypto;
import com.buseong.kakaoauto.Prefs;

import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.KeyStore;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * 카카오 로그인 토큰 보관소. 이 폰에만 있고, 평문으로는 어디에도 쓰지 않는다.
 *
 * AndroidKeyStore 의 AES-256-GCM 키(alias kakaoauto_kakao, 기기 밖으로 못 나감)로 봉인해
 * Prefs "kk_tok" 에 넣는다. KeyStore 를 못 쓰는 기기에서는 <b>저장을 거부한다</b> —
 * 토큰은 계정 전체 권한이라 약한 폴백으로 남기지 않는다.
 *
 * 기기 UUID(kk_duuid)는 연결을 해제해도 남긴다. 같은 폰에서 다시 연결할 때 새 기기로 등록되어
 * 확인 코드를 또 받는 일을 줄인다. 라이선스 로그아웃({@link #wipe})에서만 지운다.
 */
final class TokenVault {
    private TokenVault() {}

    private static final String ALIAS = "kakaoauto_kakao";
    private static final String K_TOK = "kk_tok";
    private static final String K_DUUID = "kk_duuid";
    private static final String K_USER = "kk_user";
    private static final String K_HINT = "kk_hint";
    private static final String K_AT = "kk_at";
    private static final String K_FLAG = "kk_flag";

    static final String FLAG_KICKED = "kicked";
    static final String FLAG_REAUTH = "reauth";

    static boolean linked(Context c) {
        String b = Prefs.getStr(c, K_TOK, "");
        return b != null && b.length() > 0;
    }

    static JSONObject load(Context c) {
        String blob = Prefs.getStr(c, K_TOK, "");
        if (blob == null || blob.length() == 0) return null;
        String plain = open(blob);
        if (plain == null) return null;
        try {
            return new JSONObject(plain);
        } catch (Throwable t) {
            return null;
        }
    }

    static boolean save(Context c, JSONObject creds) {
        if (creds == null) return false;
        String blob = seal(creds.toString());
        if (blob == null) return false;
        Prefs.putStr(c, K_TOK, blob);
        String uid = creds.optString("user_id", "");
        if (uid.length() > 0) Prefs.putStr(c, K_USER, uid);
        String du = creds.optString("device_uuid", "");
        if (du.length() > 0) Prefs.putStr(c, K_DUUID, du);
        return true;
    }

    static void markLinked(Context c, String accountHint) {
        Prefs.putStr(c, K_HINT, accountHint == null ? "" : accountHint);
        Prefs.putLong(c, K_AT, System.currentTimeMillis());
        Prefs.remove(c, K_FLAG);
    }

    static String userId(Context c) { return Prefs.getStr(c, K_USER, ""); }
    static String hint(Context c) { return Prefs.getStr(c, K_HINT, ""); }
    static long linkedAt(Context c) { return Prefs.getLong(c, K_AT, 0L); }
    static String deviceUuid(Context c) { return Prefs.getStr(c, K_DUUID, ""); }

    static String flag(Context c) { return Prefs.getStr(c, K_FLAG, ""); }
    static void setFlag(Context c, String f) {
        if (f == null || f.length() == 0) Prefs.remove(c, K_FLAG);
        else Prefs.putStr(c, K_FLAG, f);
    }

    /** 연결 해제: 토큰·표시 정보만 지운다 (기기 UUID 는 남긴다) */
    static void clear(Context c) {
        Prefs.remove(c, K_TOK);
        Prefs.remove(c, K_USER);
        Prefs.remove(c, K_HINT);
        Prefs.remove(c, K_AT);
        Prefs.remove(c, K_FLAG);
    }

    /** 라이선스 로그아웃: 전부 + KeyStore 키까지 */
    static void wipe(Context c) {
        clear(c);
        Prefs.remove(c, K_DUUID);
        try {
            KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
            ks.load(null);
            if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS);
        } catch (Throwable t) {
            android.util.Log.w("KakaoEngine", "keystore delete failed", t);
        }
    }

    /** ab***@kakao.com · 010****5678 */
    static String mask(String account) {
        if (account == null) return "";
        String a = account.trim();
        int at = a.indexOf('@');
        if (at > 0) {
            String head = a.substring(0, Math.min(2, at));
            return head + "***" + a.substring(at);
        }
        if (a.length() >= 8) return a.substring(0, 3) + "****" + a.substring(a.length() - 4);
        return a.length() <= 2 ? "**" : a.substring(0, 1) + "***";
    }

    private static String seal(String plain) {
        try {
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = ci.getIV();
            byte[] ct = ci.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            if (iv == null || iv.length == 0) return null;
            return "k1:" + Crypto.b64(iv) + ":" + Crypto.b64(ct);
        } catch (Throwable t) {
            android.util.Log.w("KakaoEngine", "token seal failed", t);
            return null;
        }
    }

    private static String open(String blob) {
        try {
            String[] p = blob.split(":");
            if (p.length != 3 || !"k1".equals(p[0])) return null;
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, Crypto.unb64(p[1])));
            return new String(ci.doFinal(Crypto.unb64(p[2])), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            android.util.Log.w("KakaoEngine", "token open failed", t);
            return null;
        }
    }

    private static SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        KeyStore.Entry e = ks.getEntry(ALIAS, null);
        if (e instanceof KeyStore.SecretKeyEntry) return ((KeyStore.SecretKeyEntry) e).getSecretKey();
        KeyGenerator g = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        g.init(new KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setUserAuthenticationRequired(false)
                .setRandomizedEncryptionRequired(true)
                .build());
        return g.generateKey();
    }
}
