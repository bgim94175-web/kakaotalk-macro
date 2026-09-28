package com.buseong.kakaoauto;

import android.content.Context;

/**
 * 카카오 계정 등록 상태.
 *
 * 고객 순서는 라이선스 키 → 기능 잠금 해제 → 계정 등록(로그인 다음 카카오톡 확인) → 그 다음에야
 * 매크로와 다른 기능을 설정한다. 카카오톡 확인이 끝나기 전에는 {@link #ready} 가 false 다.
 * 인증코드는 앱이 보여주고 고객이 카카오톡에 입력한다. 비밀번호와 인증코드는 저장하지 않는다.
 */
public final class KakaoAccount {
    private KakaoAccount() {}

    private static final String K_OK = "kakao_reg_ok";
    private static final String K_ID = "kakao_reg_id";

    /** 로그인 뒤 인증코드까지 끝났는가. */
    public static boolean ready(Context c) {
        return c != null && Prefs.getBool(c, K_OK, false);
    }

    /** 등록에 쓴 계정. 없으면 빈 문자열. */
    public static String accountId(Context c) {
        if (c == null) return "";
        String v = Prefs.getStr(c, K_ID, "");
        return (v == null) ? "" : v;
    }

    /**
     * 인증코드 단계가 끝난 뒤에만 부른다.
     * 계정 식별자만 남기고, 비밀번호와 인증코드는 받지 않는다.
     */
    public static void complete(Context c, String accountId) {
        if (c == null) return;
        String id = (accountId == null) ? "" : accountId.trim();
        Prefs.putStr(c, K_ID, id);
        Prefs.putBool(c, K_OK, true);
        Log.add(c, "카카오 계정 등록을 마쳤습니다.");
    }

    /** 로그아웃·등록 해제. 매크로 설정 화면은 다시 닫힌다. */
    public static void clear(Context c) {
        if (c == null) return;
        Prefs.remove(c, K_OK);
        Prefs.remove(c, K_ID);
    }
}
