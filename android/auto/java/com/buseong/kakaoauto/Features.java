package com.buseong.kakaoauto;

/**
 * 기능 카탈로그. 이름/설명만 다룬다. 켜고 끄는 건 각 기능의 설정(Settings)이다.
 */
public final class Features {
    private Features() {}

    public static final String MACRO = "macro";
    public static final String ROOMBOT = "roombot";
    public static final String MINIGAME = "minigame";

    public static final String[] ALL = { "macro", "roombot", "minigame" };

    /** 한글 이름 */
    public static String label(String id) {
        if (MACRO.equals(id)) return "자동발송 매크로";
        if (ROOMBOT.equals(id)) return "대화방 관리봇";
        if (MINIGAME.equals(id)) return "미니게임봇";
        return "알 수 없는 기능";
    }

    /** 한 줄 설명 (카드용) */
    public static String desc(String id) {
        if (MACRO.equals(id)) return "대화방별 주기 자동발송 · 이미지 첨부 · 메시지 추적 · 오픈프로필 자동응답";
        if (ROOMBOT.equals(id)) return "입/퇴장 인사, 금지어 감지, 도배 감지, 공지 자동안내";
        if (MINIGAME.equals(id)) return "끝말잇기 · 숫자야구 · 주사위 · 퀴즈 · 랭킹";
        return "";
    }
}
