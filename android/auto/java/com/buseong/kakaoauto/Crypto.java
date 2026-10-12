package com.buseong.kakaoauto;

import android.util.Base64;

import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.security.MessageDigest;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 설정 암호화용 저수준 도구. 라이브러리 없이 JCE 내장 것만 쓴다.
 * 예외는 밖으로 안 던진다 — 실패하면 null 이다. 호출하는 쪽에서 null 확인하고 Log 남겨라.
 */
public final class Crypto {
    private Crypto() {}

    private static final char[] HEXC = "0123456789abcdef".toCharArray();
    private static SecureRandom rndCache;

    private static synchronized SecureRandom rnd() {
        if (rndCache == null) rndCache = new SecureRandom();
        return rndCache;
    }

    /** AES-256-GCM 봉인. 결과 형식 "v1:(b64 iv):(b64 ct+tag)". 실패 시 null. */
    public static String seal(byte[] key, String plain) {
        if (key == null || key.length != 32 || plain == null) return null;
        try {
            byte[] iv = new byte[12];
            rnd().nextBytes(iv);
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.ENCRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            byte[] ct = ci.doFinal(plain.getBytes(StandardCharsets.UTF_8));
            return "v1:" + b64(iv) + ":" + b64(ct);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 봉인 해제. 형식이 다르거나 키가 틀리면 null (예외 안 던진다). */
    public static String open(byte[] key, String blob) {
        if (key == null || key.length != 32 || blob == null) return null;
        try {
            String[] p = blob.split(":");
            if (p.length != 3 || !"v1".equals(p[0])) return null;
            byte[] iv = unb64(p[1]);
            byte[] ct = unb64(p[2]);
            // 빈 문자열을 봉인하면 암호문이 태그(16바이트) 뿐이다 → 16 도 정상값이다.
            // (<= 16 으로 막아버리면 "값을 지웠다"는 설정을 다시 못 읽어서 기본값이 되살아난다)
            if (iv == null || ct == null || iv.length != 12 || ct.length < 16) return null;
            Cipher ci = Cipher.getInstance("AES/GCM/NoPadding");
            ci.init(Cipher.DECRYPT_MODE, new SecretKeySpec(key, "AES"), new GCMParameterSpec(128, iv));
            return new String(ci.doFinal(ct), StandardCharsets.UTF_8);
        } catch (Throwable t) {
            return null;
        }
    }

    /** HKDF-SHA256 (extract + expand). RFC 5869. 실패 시 null. */
    public static byte[] hkdf(byte[] ikm, byte[] salt, String info, int len) {
        if (ikm == null || ikm.length == 0 || len <= 0 || len > 255 * 32) return null;
        try {
            byte[] s = (salt == null || salt.length == 0) ? new byte[32] : salt;
            // extract
            Mac ex = Mac.getInstance("HmacSHA256");
            ex.init(new SecretKeySpec(s, "HmacSHA256"));
            byte[] prk = ex.doFinal(ikm);
            // expand
            byte[] inf = (info == null) ? new byte[0] : info.getBytes(StandardCharsets.UTF_8);
            Mac xp = Mac.getInstance("HmacSHA256");
            xp.init(new SecretKeySpec(prk, "HmacSHA256"));
            byte[] out = new byte[len];
            byte[] t = new byte[0];
            int pos = 0;
            int ctr = 1;
            while (pos < len) {
                xp.reset();
                xp.update(t);
                xp.update(inf);
                xp.update((byte) ctr);
                t = xp.doFinal();
                int n = Math.min(t.length, len - pos);
                System.arraycopy(t, 0, out, pos, n);
                pos += n;
                ctr++;
            }
            return out;
        } catch (Throwable e) {
            return null;
        }
    }

    /** HMAC-SHA256. 실패 시 null. */
    public static byte[] hmac(byte[] key, byte[] data) {
        if (key == null || key.length == 0 || data == null) return null;
        try {
            Mac m = Mac.getInstance("HmacSHA256");
            m.init(new SecretKeySpec(key, "HmacSHA256"));
            return m.doFinal(data);
        } catch (Throwable t) {
            return null;
        }
    }

    public static byte[] sha256(byte[] b) {
        if (b == null) return null;
        try {
            return MessageDigest.getInstance("SHA-256").digest(b);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 소문자 hex */
    public static String hex(byte[] b) {
        if (b == null) return "";
        char[] out = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) {
            int v = b[i] & 0xFF;
            out[i * 2] = HEXC[v >>> 4];
            out[i * 2 + 1] = HEXC[v & 0x0F];
        }
        return new String(out);
    }

    /** 난수 바이트 */
    public static byte[] randomBytes(int bytes) {
        byte[] b = new byte[Math.max(0, bytes)];
        if (b.length > 0) rnd().nextBytes(b);
        return b;
    }

    /** 난수 hex (bytes 바이트 → 문자 2*bytes개) */
    public static String randomHex(int bytes) {
        if (bytes <= 0) return "";
        byte[] b = new byte[bytes];
        rnd().nextBytes(b);
        return hex(b);
    }

    /** 개행 없는 base64 */
    public static String b64(byte[] b) {
        if (b == null) return "";
        return Base64.encodeToString(b, Base64.NO_WRAP);
    }

    /** base64 디코드. 형식이 틀리면 null. */
    public static byte[] unb64(String s) {
        if (s == null || s.length() == 0) return null;
        try {
            return Base64.decode(s, Base64.DEFAULT);
        } catch (Throwable t) {
            return null;
        }
    }

    /** 타이밍 안전 비교 (문자열) */
    public static boolean eq(String a, String b) {
        if (a == null || b == null) return a == b;
        if (a.length() != b.length()) return false;
        int d = 0;
        for (int i = 0; i < a.length(); i++) d |= a.charAt(i) ^ b.charAt(i);
        return d == 0;
    }
}
