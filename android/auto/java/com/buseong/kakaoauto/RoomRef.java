package com.buseong.kakaoauto;

import android.content.Context;

/**
 * 대화방 하나를 가리키는 값. <b>카카오톡 계정 + 방 이름</b> 두 축으로 이뤄진다.
 *
 * 왜 계정 축이 필요한가 — 삼성 듀얼 메신저·직장 프로필처럼 한 폰에 카톡이 두 개 깔리면
 * 알림이 서로 다른 UserHandle 로 온다. 같은 이름의 방("공지")이 두 계정에 동시에 있을 수 있고,
 * 발송에 쓰는 RemoteInput 세션도 계정별로 따로다. 방을 이름 하나로만 잡으면 엉뚱한 계정으로 나간다.
 *
 * 직렬화 형태(= {@link #key()})는 {@code 계정키 + '\u0001' + 방이름} 이다.
 * 구분자가 없는 문자열은 <b>구버전 저장값</b>으로 보고 계정키를 {@link #DEFAULT_ACC} 로 채운다
 * (UI_V3 6장 하위호환) — 기존 사용자 설정이 그대로 살아야 한다.
 *
 * 불변 객체다. 만들 때 방 이름의 제어문자(구분자 포함)를 털어내니까 키가 깨질 일이 없다.
 */
public final class RoomRef {

    /** 기본 계정(= 폰 주 사용자 프로필)의 계정키. 구버전 저장값도 전부 이 계정으로 읽는다. */
    public static final String DEFAULT_ACC = "0";

    /** 계정키와 방 이름을 잇는 구분자. 방 이름에는 절대 들어갈 수 없는 제어문자다. */
    public static final char SEP = '\u0001';

    /** 계정키 ({@link Accounts#keyOf}) */
    public final String acc;

    /** 대화방 이름 (카톡이 알려준 그대로, 앞뒤 공백만 정리) */
    public final String name;

    private RoomRef(String acc, String name) {
        this.acc = acc;
        this.name = name;
    }

    public static RoomRef of(String acc, String name) {
        return new RoomRef(normAcc(acc), normName(name));
    }

    /** 방 이름만 알 때 (= 기본 계정) */
    public static RoomRef of(String name) {
        return new RoomRef(DEFAULT_ACC, normName(name));
    }

    /**
     * 저장값 한 개를 되읽는다. 구분자가 없으면 구버전 저장값이라 계정키를 {@link #DEFAULT_ACC} 로 채운다.
     * null 이나 빈 문자열이면 이름이 빈 참조가 나온다 ({@link #valid()} 로 확인).
     */
    public static RoomRef parse(String key) {
        if (key == null) return new RoomRef(DEFAULT_ACC, "");
        int i = key.indexOf(SEP);
        if (i < 0) return new RoomRef(DEFAULT_ACC, normName(key));
        return new RoomRef(normAcc(key.substring(0, i)), normName(key.substring(i + 1)));
    }

    /** 저장·맵키용 문자열. {@link #parse} 로 그대로 되읽는다. */
    public String key() {
        return acc + SEP + name;
    }

    /** 기본 계정인가 */
    public boolean isDefault() {
        return DEFAULT_ACC.equals(acc);
    }

    /** 쓸 수 있는 참조인가 (방 이름이 비어 있으면 못 쓴다) */
    public boolean valid() {
        return name.length() > 0;
    }

    /**
     * 화면·로그에 쓰는 이름. 계정 이야기는 붙이지 않는다 —
     * 계정이 하나뿐인 사용자에게 계정 표기가 보이면 그게 곧 불필요한 복잡도다(UI_V3 6장).
     * 계정까지 같이 보여야 하는 자리에서는 {@link #label(Context)} 를 쓴다.
     */
    public String label() {
        return name;
    }

    /**
     * 계정이 2개 이상 감지된 기기에서만 계정 이름을 덧붙인 표기 (`공지 · 업무 계정`).
     * 계정이 하나면 {@link #label()} 과 같다.
     */
    public String label(Context c) {
        if (c == null || !Accounts.multi(c)) return name;
        String an = Accounts.nameOf(c, acc);
        if (an.length() == 0) return name;
        return name + " · " + an;
    }

    @Override public boolean equals(Object o) {
        if (o == this) return true;
        if (!(o instanceof RoomRef)) return false;
        RoomRef r = (RoomRef) o;
        return acc.equals(r.acc) && name.equals(r.name);
    }

    @Override public int hashCode() {
        return acc.hashCode() * 31 + name.hashCode();
    }

    /** 사용자 노출 문구에 그대로 섞여도 안전하게 방 이름만 낸다. */
    @Override public String toString() {
        return name;
    }

    // ── 정규화 ────────────────────────────────────────────────────────────────

    private static String normAcc(String v) {
        String s = strip(v);
        return (s.length() == 0) ? DEFAULT_ACC : s;
    }

    private static String normName(String v) {
        return strip(v);
    }

    /** 앞뒤 공백 정리 + 제어문자 제거. 구분자(\u0001)·개행이 이름에 섞여 키가 깨지는 걸 막는다. */
    private static String strip(String v) {
        if (v == null) return "";
        int n = v.length();
        StringBuilder sb = null;
        for (int i = 0; i < n; i++) {
            char ch = v.charAt(i);
            if (ch >= ' ') {
                if (sb != null) sb.append(ch);
                continue;
            }
            if (sb == null) sb = new StringBuilder(n).append(v, 0, i);
        }
        String out = (sb == null) ? v : sb.toString();
        return out.trim();
    }
}
