package com.buseong.kakaoauto;

import java.math.BigInteger;
import java.security.MessageDigest;

/**
 * 순수 자바 Ed25519 서명 <b>검증</b>기 (RFC 8032).
 *
 * 왜 직접 만들었냐:
 *   안드로이드는 13(API 33) 부터만 "Ed25519" 를 기본 제공한다.
 *   우리 minSdk 는 26 이라서 안드로이드 8~12 기기에서는
 *   Signature.getInstance("Ed25519") 가 NoSuchAlgorithmException 으로 죽는다.
 *   그러면 서버 응답 서명을 하나도 못 확인해서 앱이 영구히 bad_signature 로 막힌다.
 *   그래서 플랫폼이 못 해줄 때 쓰는 폴백으로 직접 구현했다.
 *
 * 외부 라이브러리 0개 — BigInteger + MessageDigest(SHA-512) 만 쓴다.
 * 비밀키를 다루지 않는 검증 전용이라 상수시간 구현은 필요 없다.
 * 서명 1회 검증에 최신 기기 수 ms, 구형 기기 수십 ms 수준이라 하트비트 주기에 전혀 부담 없다.
 */
final class Ed25519 {

    private Ed25519() { }

    private static final BigInteger ZERO = BigInteger.ZERO;
    private static final BigInteger ONE  = BigInteger.ONE;
    private static final BigInteger TWO  = BigInteger.valueOf(2);   // BigInteger.TWO 는 API 31+ 라서 안 쓴다

    /** 소수 p = 2^255 - 19 */
    private static final BigInteger P = TWO.pow(255).subtract(BigInteger.valueOf(19));

    /** 곡선 상수 d = -121665 / 121666 (mod p) */
    private static final BigInteger D =
            BigInteger.valueOf(-121665).multiply(BigInteger.valueOf(121666).modInverse(P)).mod(P);

    /** 군의 위수 L = 2^252 + 27742317777372353535851937790883648493 */
    private static final BigInteger L =
            TWO.pow(252).add(new BigInteger("27742317777372353535851937790883648493"));

    /** sqrt(-1) mod p — p ≡ 5 (mod 8) 이라 2^((p-1)/4) 가 답이다 */
    private static final BigInteger SQRT_M1 =
            TWO.modPow(P.subtract(ONE).divide(BigInteger.valueOf(4)), P);

    /** 기준점 B — 확장좌표 (X:Y:Z:T), By = 4/5 (mod p) */
    private static final BigInteger[] BASE;

    static {
        BigInteger by = BigInteger.valueOf(4).multiply(BigInteger.valueOf(5).modInverse(P)).mod(P);
        BigInteger bx = recoverX(by, 0);
        if (bx == null) throw new IllegalStateException("Ed25519 기준점 계산 실패");
        BASE = new BigInteger[] { bx, by, ONE, bx.multiply(by).mod(P) };
    }

    // ── 공개 API ────────────────────────────────────────────────────────────────

    /**
     * SPKI(DER) 형식 공개키로 서명을 검증한다.
     * SPKI 는 12바이트 헤더 + 32바이트 원시키라서 뒤 32바이트만 떼어 쓴다.
     *
     * @return 서명이 맞으면 true. 형식이 깨졌거나 안 맞으면 false (예외를 던지지 않는다)
     */
    static boolean verifySpki(byte[] spki, byte[] msg, byte[] sig) {
        if (spki == null || spki.length < 32) return false;
        byte[] raw = new byte[32];
        System.arraycopy(spki, spki.length - 32, raw, 0, 32);
        return verify(raw, msg, sig);
    }

    /** 원시 32바이트 공개키로 서명(64바이트)을 검증한다. */
    static boolean verify(byte[] pub, byte[] msg, byte[] sig) {
        try {
            if (pub == null || pub.length != 32) return false;
            if (sig == null || sig.length != 64) return false;
            if (msg == null) return false;

            byte[] rEnc = new byte[32];
            byte[] sEnc = new byte[32];
            System.arraycopy(sig, 0, rEnc, 0, 32);
            System.arraycopy(sig, 32, sEnc, 0, 32);

            BigInteger[] a = decode(pub);
            BigInteger[] r = decode(rEnc);
            if (a == null || r == null) return false;

            BigInteger s = leToBig(sEnc);
            if (s.compareTo(L) >= 0) return false;      // 위조 가능한 가변 서명 차단

            MessageDigest md = MessageDigest.getInstance("SHA-512");
            md.update(rEnc);
            md.update(pub);
            md.update(msg);
            BigInteger k = leToBig(md.digest()).mod(L);

            BigInteger[] left  = scalarMult(s, BASE);            // [s]B
            BigInteger[] right = add(r, scalarMult(k, a));       // R + [k]A
            return equal(left, right);
        } catch (Throwable t) {
            return false;
        }
    }

    // ── 점 연산 (확장 좌표 X:Y:Z:T, RFC 8032 부록의 참조 구현과 같은 식) ──────────

    /** 통합 덧셈 — 같은 점을 넣으면 두 배 연산으로도 그대로 동작한다 */
    private static BigInteger[] add(BigInteger[] p1, BigInteger[] p2) {
        BigInteger a = p1[1].subtract(p1[0]).multiply(p2[1].subtract(p2[0])).mod(P);
        BigInteger b = p1[1].add(p1[0]).multiply(p2[1].add(p2[0])).mod(P);
        BigInteger c = TWO.multiply(p1[3]).multiply(p2[3]).multiply(D).mod(P);
        BigInteger d = TWO.multiply(p1[2]).multiply(p2[2]).mod(P);
        BigInteger e = b.subtract(a);
        BigInteger f = d.subtract(c);
        BigInteger g = d.add(c);
        BigInteger h = b.add(a);
        return new BigInteger[] {
                e.multiply(f).mod(P),
                g.multiply(h).mod(P),
                f.multiply(g).mod(P),
                e.multiply(h).mod(P),
        };
    }

    /** 이중화-덧셈 스칼라 곱. k 는 음수가 아니어야 한다. */
    private static BigInteger[] scalarMult(BigInteger k, BigInteger[] pt) {
        BigInteger[] acc = new BigInteger[] { ZERO, ONE, ONE, ZERO };   // 항등원
        for (int i = k.bitLength() - 1; i >= 0; i--) {
            acc = add(acc, acc);
            if (k.testBit(i)) acc = add(acc, pt);
        }
        return acc;
    }

    /** 사영좌표라서 값이 달라도 같은 점일 수 있다 → 교차곱으로 비교한다 */
    private static boolean equal(BigInteger[] p1, BigInteger[] p2) {
        if (p1[0].multiply(p2[2]).subtract(p2[0].multiply(p1[2])).mod(P).signum() != 0) return false;
        if (p1[1].multiply(p2[2]).subtract(p2[1].multiply(p1[2])).mod(P).signum() != 0) return false;
        return true;
    }

    // ── 인코딩 / 디코딩 ─────────────────────────────────────────────────────────

    /** 32바이트(리틀엔디언 y + 최상위비트 = x 홀짝) → 확장좌표 점. 형식이 틀리면 null */
    private static BigInteger[] decode(byte[] enc) {
        byte[] le = new byte[32];
        System.arraycopy(enc, 0, le, 0, 32);
        int sign = ((le[31] & 0xFF) >>> 7) & 1;
        le[31] = (byte) (le[31] & 0x7F);

        BigInteger y = leToBig(le);
        if (y.compareTo(P) >= 0) return null;           // 정규화 안 된 좌표는 거부
        BigInteger x = recoverX(y, sign);
        if (x == null) return null;
        return new BigInteger[] { x, y, ONE, x.multiply(y).mod(P) };
    }

    /** y 와 x 의 홀짝 비트로 x 를 복원한다. 곡선 위에 없으면 null */
    private static BigInteger recoverX(BigInteger y, int sign) {
        BigInteger y2 = y.multiply(y).mod(P);
        BigInteger u = y2.subtract(ONE).mod(P);
        BigInteger v = D.multiply(y2).add(ONE).mod(P);
        if (v.signum() == 0) return null;

        BigInteger a = u.multiply(v.modInverse(P)).mod(P);
        if (a.signum() == 0) return (sign == 1) ? null : ZERO;   // x=0 인데 부호가 1 이면 무효

        // p ≡ 5 (mod 8) → 제곱근 후보는 a^((p+3)/8), 틀리면 sqrt(-1) 을 곱해 한 번 더
        BigInteger x = a.modPow(P.add(BigInteger.valueOf(3)).divide(BigInteger.valueOf(8)), P);
        if (!x.multiply(x).mod(P).equals(a)) {
            x = x.multiply(SQRT_M1).mod(P);
            if (!x.multiply(x).mod(P).equals(a)) return null;    // 제곱잉여가 아님 = 곡선 밖
        }
        if (x.testBit(0) != (sign == 1)) x = P.subtract(x).mod(P);
        return x;
    }

    /** 리틀엔디언 바이트열 → 부호 없는 정수 */
    private static BigInteger leToBig(byte[] le) {
        byte[] be = new byte[le.length];
        for (int i = 0; i < le.length; i++) be[i] = le[le.length - 1 - i];
        return new BigInteger(1, be);
    }
}
