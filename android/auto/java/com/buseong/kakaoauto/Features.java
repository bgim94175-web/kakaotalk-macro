package com.buseong.kakaoauto;

import android.content.Context;

import java.net.URLEncoder;

/**
 * 기능 카탈로그. 3종을 따로 결제한다 — 기능마다 만료일이 따로 돈다.
 * 어떤 기능이 켜졌는지는 서버 응답(features 맵)만이 진실이다. 여기선 이름/설명/구매주소만 다룬다.
 */
public final class Features {
    private Features() {}

    public static final String MACRO = "macro";
    public static final String ROOMBOT = "roombot";
    public static final String MINIGAME = "minigame";

    public static final String[] ALL = { "macro", "roombot", "minigame" };

    /** 구매 페이지 기본 주소. 서버가 다른 주소를 알려주면 Prefs "purchase_base" 에 덮어써라. */
    public static final String DEFAULT_BASE = "https://kakaotalk-macro.onrender.com";

    private static final String K_BASE = "purchase_base";

    public static boolean valid(String id) {
        if (id == null) return false;
        for (int i = 0; i < ALL.length; i++) if (ALL[i].equals(id)) return true;
        return false;
    }

    /** 한글 이름 */
    public static String label(String id) {
        if (MACRO.equals(id)) return "자동발송 매크로";
        if (ROOMBOT.equals(id)) return "대화방 관리봇";
        if (MINIGAME.equals(id)) return "미니게임봇";
        return "알 수 없는 기능";
    }

    /** 한 줄 설명 (카드용) */
    public static String desc(String id) {
        if (MACRO.equals(id)) return "보낼 방별 쿨타임 발송 · 이미지 첨부 · 경쟁사 저격 · 갠톡 자동응답";
        if (ROOMBOT.equals(id)) return "입/퇴장 인사, 금지어 감지, 도배 감지, 공지 자동안내";
        if (MINIGAME.equals(id)) return "끝말잇기 · 숫자야구 · 주사위 · 퀴즈 · 랭킹";
        return "";
    }

    /** 여러 줄 설명 (구매 유도 다이얼로그용) */
    public static String descLong(String id) {
        if (MACRO.equals(id)) {
            return "· 방마다 쿨타임을 정해 자동 발송\n"
                 + "· 이미지 최대 5장 첨부 발송\n"
                 + "· 특정 메시지가 올라오면 즉시 반응 (경쟁사 저격)\n"
                 + "· 개인톡에 자동응답 (갠톡 자동응답)";
        }
        if (ROOMBOT.equals(id)) {
            return "· 입장/퇴장 인사 자동 발송\n"
                 + "· 금지어 감지 후 경고 (횟수 누적)\n"
                 + "· 도배 감지 후 경고\n"
                 + "· 공지·규칙 명령 자동 안내";
        }
        if (MINIGAME.equals(id)) {
            return "· 끝말잇기 · 숫자야구 · 주사위 · 가위바위보\n"
                 + "· 퀴즈 50문항 내장\n"
                 + "· 대화방별 점수 랭킹";
        }
        return "";
    }

    /** 기능별 대표색 (칩·아이콘 색을 통일하려고) */
    public static int color(String id) {
        if (MACRO.equals(id)) return Theme.F_MACRO;
        if (ROOMBOT.equals(id)) return Theme.F_ROOMBOT;
        if (MINIGAME.equals(id)) return Theme.F_MINIGAME;
        return Theme.SUB;
    }

    /** 기능별 아이콘 (Icon 글리프) */
    public static int icon(String id) {
        if (MACRO.equals(id)) return Icon.SEND;
        if (ROOMBOT.equals(id)) return Icon.SHIELD;
        if (MINIGAME.equals(id)) return Icon.DICE;
        return Icon.SPARK;
    }

    /** 구매 웹 기본주소. 끝의 "/" 와 "/buy" 는 떼서 돌려준다. */
    public static String purchaseBase(Context c) {
        String base = Prefs.getStr(c, K_BASE, DEFAULT_BASE);
        if (base == null) base = DEFAULT_BASE;
        base = base.trim();
        if (!base.startsWith("http://") && !base.startsWith("https://")) base = DEFAULT_BASE;
        while (base.endsWith("/")) base = base.substring(0, base.length() - 1);
        if (base.endsWith("/buy")) base = base.substring(0, base.length() - 4);
        if (base.length() == 0) base = DEFAULT_BASE;
        return base;
    }

    /** 구매 딥링크. 등록된 라이선스 키가 있으면 같이 붙인다(연장용). */
    public static String buyUrl(Context c, String id) {
        String key = null;
        try {
            License.State s = License.state(c);
            if (s != null) key = s.key;
        } catch (Throwable t) {
            key = null; // 라이선스 모듈이 아직 준비 안 됐으면 키 없이 보낸다
        }
        return buyUrl(c, id, key);
    }

    /** 키를 직접 넘기는 버전 (License 를 안 거치고 싶을 때) */
    public static String buyUrl(Context c, String id, String key) {
        StringBuilder sb = new StringBuilder(purchaseBase(c));
        sb.append("/buy");
        if (valid(id)) sb.append("?feature=").append(enc(id));
        else sb.append("?feature=");
        if (key != null && key.trim().length() > 0) sb.append("&key=").append(enc(key.trim()));
        return sb.toString();
    }

    /** 키 조회/기기 초기화 요청 페이지 */
    public static String myUrl(Context c) {
        return purchaseBase(c) + "/my";
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode(s, "UTF-8");
        } catch (Throwable t) {
            return s;
        }
    }
}
