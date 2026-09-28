package com.buseong.kakaoauto;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;

/**
 * 디자인 토큰 (UI v4 · docs/UI_V4.md). 색/라운드/치수/서체는 전부 여기서만 가져다 쓴다.
 * 화면 코드에 색상 리터럴(0xFF...)을 직접 박지 마라. 톤이 깨진다.
 *
 * 바탕은 오닉스(거의 검정) + 아이보리 글자, 브랜드는 샴페인 골드 하나다.
 * 기능마다 보석 톤 액센트가 하나씩 있다 (F_*). 기능 화면 안의 스위치·체크·주 버튼은
 * {@link #accent()} 를 따라가서, 어느 기능을 만지고 있는지 색만 봐도 구분된다.
 */
public final class Theme {
    private Theme() {}

    // ── 바탕 계층 (어두운 데서 밝은 쪽으로)
    public static final int BG    = 0xFF0A0B0F;
    public static final int BG2   = 0xFF0F1116;
    public static final int CARD  = 0xFF15171D;
    public static final int CARD2 = 0xFF1C1F27;

    // ── 보더 (흰색 알파)
    public static final int LINE  = 0x12FFFFFF;
    public static final int LINE2 = 0x24FFFFFF;

    // ── 글자 (따뜻한 아이보리 계열)
    public static final int TEXT = 0xFFF2EEE6;
    public static final int SUB  = 0xFFA39E95;
    public static final int DIM  = 0xFF6B675F;

    // ── 브랜드 · 상태
    public static final int GOLD    = 0xFFD4B27A;
    public static final int GOLD_HI = 0xFFEBD4A6;
    public static final int OK      = 0xFF74D39A;
    /** 설정 필요 · 주의. 골드와 헷갈리지 않게 채도 높은 오렌지로 둔다 */
    public static final int AMBER   = 0xFFF79A5B;
    public static final int RED     = 0xFFEF6F6F;
    /** 중립 안내 박스 */
    public static final int ACCENT2 = 0xFF9FB0C8;

    /** 옛 이름. 브랜드 골드와 같다 (기존 화면 코드 호환) */
    public static final int ACCENT = GOLD;
    public static final int VIOLET = 0xFFB39AF3;
    /** 액센트로 채운 면 위의 글자 */
    public static final int ON_ACCENT = 0xFF14110B;

    // ── 기능별 액센트 (홈·탭·서브화면·목록 아이콘이 같은 값을 쓴다)
    public static final int F_HOME     = GOLD;
    public static final int F_MACRO    = 0xFF84A3F6;   // 사파이어
    public static final int F_TRIGGER  = 0xFFB39AF3;   // 자수정
    public static final int F_REPLY    = 0xFF5FC6DC;   // 아쿠아마린
    public static final int F_ROOMBOT  = 0xFF5ECC9C;   // 제이드
    public static final int F_MINIGAME = 0xFFEE8FB2;   // 로즈
    public static final int F_ROOMS    = 0xFFC3CAD6;   // 펄
    public static final int F_ACCOUNT  = GOLD;

    // ── 라운드 반경 (dp)
    public static final int R_SM = 10;
    public static final int R_MD = 14;
    public static final int R_LG = 18;
    public static final int R_XL = 24;

    // ── 지금 그리는 화면의 기능 액센트
    private static int accent = GOLD;

    /** 지금 만드는 화면의 기능 색. 스위치·체크·주 버튼·구역 머리말이 이 값을 쓴다. */
    public static int accent() { return accent; }

    public static void setAccent(int color) { accent = (color == 0) ? GOLD : color; }

    // ── 서체
    private static Typeface serifBold;

    /** 화면 제목·큰 숫자용 세리프. 한글은 기기 명조(Noto Serif CJK 등)로 떨어진다. */
    public static Typeface serif() {
        if (serifBold == null) {
            try {
                serifBold = Typeface.create("serif", Typeface.BOLD);
            } catch (Throwable t) {
                serifBold = Typeface.DEFAULT_BOLD;
            }
        }
        return serifBold;
    }

    /** dp → px */
    public static int dp(Context c, float v) {
        if (c == null || c.getResources() == null) return (int) (v * 3f + 0.5f);
        return (int) (TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                c.getResources().getDisplayMetrics()) + 0.5f);
    }

    /** sp → px (글자 크기는 setTextSize(COMPLEX_UNIT_SP,..) 를 쓰고, 이건 여백 계산용) */
    public static int sp(Context c, float v) {
        if (c == null || c.getResources() == null) return (int) (v * 3f + 0.5f);
        return (int) (TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v,
                c.getResources().getDisplayMetrics()) + 0.5f);
    }

    /** 라운드 사각형. strokeColor 0 또는 strokeDp 0 이면 보더 없음. */
    public static GradientDrawable round(int fill, int radiusDp, int strokeColor, int strokeDp, Context c) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setColor(fill);
        g.setCornerRadius(dp(c, radiusDp));
        if (strokeDp > 0 && strokeColor != 0) g.setStroke(Math.max(1, dp(c, strokeDp)), strokeColor);
        return g;
    }

    /** 대각선으로 은은하게 번지는 면 (기능 머리 카드 전용). from 이 왼쪽 위. */
    public static GradientDrawable sheen(int from, int to, int radiusDp, int strokeColor, Context c) {
        GradientDrawable g = new GradientDrawable(GradientDrawable.Orientation.TL_BR, new int[] { from, to });
        g.setShape(GradientDrawable.RECTANGLE);
        g.setCornerRadius(dp(c, radiusDp));
        if (strokeColor != 0) g.setStroke(Math.max(1, dp(c, 1)), strokeColor);
        return g;
    }

    /** 완전 둥근 pill. stroke 0 이면 보더 없음. */
    public static GradientDrawable pill(int fill, int stroke, Context c) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setColor(fill);
        g.setCornerRadius(dp(c, 999));
        if (stroke != 0) g.setStroke(Math.max(1, dp(c, 1)), stroke);
        return g;
    }

    /** 원형 (토글 노브, 점 표시 등) */
    public static GradientDrawable circle(int fill, Context c) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(fill);
        return g;
    }

    /** 테두리가 있는 원 (기능 메달) */
    public static GradientDrawable ring(int fill, int stroke, Context c) {
        GradientDrawable g = circle(fill, c);
        if (stroke != 0) g.setStroke(Math.max(1, dp(c, 1)), stroke);
        return g;
    }

    /** 색을 지정한 불투명도로 낮춘다. ratio 0~1 */
    public static int fade(int color, float ratio) {
        if (ratio < 0f) ratio = 0f;
        if (ratio > 1f) ratio = 1f;
        int a = (int) (((color >>> 24) & 0xFF) * ratio + 0.5f);
        return (a << 24) | (color & 0x00FFFFFF);
    }

    /** 두 불투명 색을 섞는다 (t=0 이면 a, 1 이면 b) */
    public static int mix(int a, int b, float t) {
        if (t < 0f) t = 0f;
        if (t > 1f) t = 1f;
        int r = (int) (((a >> 16) & 0xFF) * (1 - t) + ((b >> 16) & 0xFF) * t + 0.5f);
        int g = (int) (((a >> 8) & 0xFF) * (1 - t) + ((b >> 8) & 0xFF) * t + 0.5f);
        int bl = (int) ((a & 0xFF) * (1 - t) + (b & 0xFF) * t + 0.5f);
        return 0xFF000000 | (r << 16) | (g << 8) | bl;
    }
}
