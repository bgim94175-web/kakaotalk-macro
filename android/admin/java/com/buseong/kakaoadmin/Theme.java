package com.buseong.kakaoadmin;

import android.content.Context;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;

/**
 * 디자인 토큰. 사용자앱(KakaoAuto)의 Theme 과 **값이 완전히 같다** — 패키지만 다르다.
 * 다른 점은 하나뿐: 관리자앱은 주 액센트를 VIOLET 으로 쓴다(PRIMARY), 민트(ACCENT)는 보조.
 *
 * 화면 코드에 색상 리터럴(0xFF...)을 직접 박지 마라. 톤이 깨진다.
 */
public final class Theme {
    private Theme() {}

    // ── 배경 계층 (어두운 데서 밝은 쪽으로)
    public static final int BG    = 0xFF0B0F14;
    public static final int BG2   = 0xFF111823;
    public static final int CARD  = 0xFF151D29;
    public static final int CARD2 = 0xFF1B2533;

    // ── 보더 (흰색 알파)
    public static final int LINE  = 0x14FFFFFF;
    public static final int LINE2 = 0x22FFFFFF;

    // ── 글자
    public static final int TEXT = 0xFFEAF0F7;
    public static final int SUB  = 0xFF93A2B5;
    public static final int DIM  = 0xFF5E6E82;

    // ── 액센트 (사용자앱과 같은 값)
    public static final int ACCENT  = 0xFF3DDC97;
    public static final int ACCENT2 = 0xFF2BB4F0;
    public static final int AMBER   = 0xFFFFC65C;
    public static final int RED     = 0xFFFF6B6B;
    public static final int VIOLET  = 0xFFA78BFA;
    public static final int ON_ACCENT = 0xFF07130D;

    // ── 관리자앱 주색 (사용자앱과 구분하려고 바이올렛)
    public static final int PRIMARY    = VIOLET;
    public static final int ON_PRIMARY = 0xFF170B2E;

    // ── 라운드 반경 (dp)
    public static final int R_SM = 10;
    public static final int R_MD = 14;
    public static final int R_LG = 20;
    public static final int R_XL = 26;

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

    /** 색을 지정한 불투명도로 낮춘다. ratio 0~1 */
    public static int fade(int color, float ratio) {
        if (ratio < 0f) ratio = 0f;
        if (ratio > 1f) ratio = 1f;
        int a = (int) (((color >>> 24) & 0xFF) * ratio + 0.5f);
        return (a << 24) | (color & 0x00FFFFFF);
    }
}
