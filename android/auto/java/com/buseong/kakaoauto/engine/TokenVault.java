package com.buseong.kakaoauto.engine;

import android.content.Context;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;

import com.buseong.kakaoauto.Crypto;
import com.buseong.kakaoauto.KakaoSlots;
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
        return linked(c, activeId(c));
    }

    static boolean linked(Context c, String id) {
        String b = Prefs.getStr(c, tokKey(id), "");
        return b != null && b.length() > 0;
    }

    static JSONObject load(Context c) {
        return load(c, activeId(c));
    }

    static JSONObject load(Context c, String id) {
        String blob = Prefs.getStr(c, tokKey(id), "");
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
        return save(c, activeId(c), creds);
    }

    static boolean save(Context c, String id, JSONObject creds) {
        if (creds == null || id == null || id.length() == 0) return false;
        String blob = seal(creds.toString());
        if (blob == null) return false;
        Prefs.putStr(c, tokKey(id), blob);
        String uid = creds.optString("user_id", "");
        if (uid.length() > 0) Prefs.putStr(c, userKey(id), uid);
        String du = creds.optString("device_uuid", "");
        if (du.length() > 0) Prefs.putStr(c, duKey(id), du);
        return true;
    }

    static void markLinked(Context c, String accountHint) {
        markLinked(c, activeId(c), accountHint);
    }

    static void markLinked(Context c, String id, String accountHint) {
        Prefs.putStr(c, hintKey(id), accountHint == null ? "" : accountHint);
        Prefs.putLong(c, atKey(id), System.currentTimeMillis());
        Prefs.remove(c, flagKey(id));
    }

    static String userId(Context c) { return Prefs.getStr(c, userKey(activeId(c)), ""); }
    static String hint(Context c) { return Prefs.getStr(c, hintKey(activeId(c)), ""); }
    static long linkedAt(Context c) { return Prefs.getLong(c, atKey(activeId(c)), 0L); }
    static String deviceUuid(Context c) { return Prefs.getStr(c, duKey(activeId(c)), ""); }

    static String flag(Context c) { return flag(c, activeId(c)); }
    static String flag(Context c, String id) { return Prefs.getStr(c, flagKey(id), ""); }
    static void setFlag(Context c, String f) { setFlag(c, activeId(c), f); }
    static void setFlag(Context c, String id, String f) {
        if (id == null || id.length() == 0) return;
        if (f == null || f.length() == 0) Prefs.remove(c, flagKey(id));
        else Prefs.putStr(c, flagKey(id), f);
    }

    /** 한 계정의 토큰만 지운다. 다른 계정과 KeyStore 키는 남긴다. */
    static void clear(Context c) {
        clear(c, activeId(c));
    }

    static void clear(Context c, String id) {
        if (id == null || id.length() == 0) return;
        Prefs.remove(c, tokKey(id));
        Prefs.remove(c, userKey(id));
        Prefs.remove(c, hintKey(id));
        Prefs.remove(c, atKey(id));
        Prefs.remove(c, flagKey(id));
    }

    /** 예전 한 계정 저장(kk_tok)을 슬롯 키로 옮긴다. 옛 키는 지우지 않는다. */
    static void adoptLegacy(Context c, String id) {
        if (c == null || id == null || id.length() == 0) return;
        if (linked(c, id)) return;
        String blob = Prefs.getStr(c, K_TOK, "");
        if (blob == null || blob.length() == 0) return;
        Prefs.putStr(c, tokKey(id), blob);
        copyStr(c, K_USER, userKey(id));
        copyStr(c, K_HINT, hintKey(id));
        copyStr(c, K_DUUID, duKey(id));
        copyStr(c, K_FLAG, flagKey(id));
        long at = Prefs.getLong(c, K_AT, 0L);
        if (at > 0) Prefs.putLong(c, atKey(id), at);
    }

    /** 라이선스 로그아웃: 모든 계정의 토큰 + KeyStore 키 */
    static void wipe(Context c) {
        java.util.List<KakaoSlots.Slot> slots = KakaoSlots.all(c);
        for (int i = 0; i < slots.size(); i++) clear(c, slots.get(i).id);
        Prefs.remove(c, K_TOK);
        Prefs.remove(c, K_USER);
        Prefs.remove(c, K_HINT);
        Prefs.remove(c, K_AT);
        Prefs.remove(c, K_FLAG);
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

    private static String activeId(Context c) {
        String id = KakaoSlots.selectedId(c);
        return (id == null || id.length() == 0) ? "main" : id;
    }

    private static String tokKey(String id) { return K_TOK + "." + id; }
    private static String userKey(String id) { return K_USER + "." + id; }
    private static String hintKey(String id) { return K_HINT + "." + id; }
    private static String duKey(String id) { return K_DUUID + "." + id; }
    private static String atKey(String id) { return K_AT + "." + id; }
    private static String flagKey(String id) { return K_FLAG + "." + id; }

    private static void copyStr(Context c, String from, String to) {
        String v = Prefs.getStr(c, from, "");
        if (v != null && v.length() > 0) Prefs.putStr(c, to, v);
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
