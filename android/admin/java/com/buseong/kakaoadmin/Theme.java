package com.buseong.kakaoadmin;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;

/**
 * 디자인 토큰 (UI v4b · docs/UI_V4.md). 사용자앱과 같은 밝은 업무용 톤.
 * 스위치·주 버튼·체크는 {@link #PRIMARY}. 탭 색(F_*)은 칩·왼쪽 막대에만 쓴다.
 */
public final class Theme {
    private Theme() {}

    public static final int BG    = 0xFFF2F4F6;
    public static final int BG2   = 0xFFFFFFFF;
    public static final int CARD  = 0xFFFFFFFF;
    public static final int CARD2 = 0xFFF2F4F6;

    public static final int LINE  = 0xFFE5E8EB;
    public static final int LINE2 = 0xFFD1D6DB;

    public static final int TEXT = 0xFF191F28;
    public static final int SUB  = 0xFF4E5968;
    public static final int DIM  = 0xFF8B95A1;

    public static final int PRIMARY = 0xFF3182F6;
    public static final int GOLD    = PRIMARY;
    public static final int GOLD_HI = TEXT;
    /** 정상 · 활성 */
    public static final int ACCENT  = 0xFF087F5B;
    public static final int ACCENT2 = 0xFF4E5968;
    public static final int AMBER   = 0xFFE67700;
    public static final int RED     = 0xFFE03131;
    public static final int VIOLET  = 0xFF5F3DC4;
    public static final int ON_ACCENT = 0xFFFFFFFF;

    public static final int ON_PRIMARY = 0xFFFFFFFF;

    public static final int F_KEYS     = PRIMARY;
    public static final int F_ORDERS   = 0xFF087F5B;
    public static final int F_DEPOSIT  = 0xFF0B7285;
    public static final int F_AUDIT    = 0xFF5F3DC4;
    public static final int F_SETTINGS = 0xFF495057;

    public static final int P_MACRO    = 0xFF1B64DA;
    public static final int P_ROOMBOT  = 0xFF087F5B;
    public static final int P_MINIGAME = 0xFFC2255C;

    public static int feature(String id) {
        if ("macro".equals(id)) return P_MACRO;
        if ("roombot".equals(id)) return P_ROOMBOT;
        if ("minigame".equals(id)) return P_MINIGAME;
        return ACCENT2;
    }

    public static final int R_SM = 4;
    public static final int R_MD = 8;
    public static final int R_LG = 8;
    public static final int R_XL = 12;

    private static int accent = PRIMARY;

    public static int accent() { return accent; }

    public static void setAccent(int color) { accent = (color == 0) ? PRIMARY : color; }

    /** 굵은 산세리프. 세리프는 쓰지 않는다. */
    public static Typeface serif() {
        return Typeface.create("sans-serif", Typeface.BOLD);
    }

    public static int dp(Context c, float v) {
        if (c == null || c.getResources() == null) return (int) (v * 3f + 0.5f);
        return (int) (TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v,
                c.getResources().getDisplayMetrics()) + 0.5f);
    }

    public static int sp(Context c, float v) {
        if (c == null || c.getResources() == null) return (int) (v * 3f + 0.5f);
        return (int) (TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, v,
                c.getResources().getDisplayMetrics()) + 0.5f);
    }

    public static GradientDrawable round(int fill, int radiusDp, int strokeColor, int strokeDp, Context c) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setColor(fill);
        g.setCornerRadius(dp(c, radiusDp));
        if (strokeDp > 0 && strokeColor != 0) g.setStroke(Math.max(1, dp(c, strokeDp)), strokeColor);
        return g;
    }

    /** 단색 면. 그라데이션은 그리지 않는다. */
    public static GradientDrawable sheen(int from, int to, int radiusDp, int strokeColor, Context c) {
        return round(to, radiusDp, 0, 0, c);
    }

    public static GradientDrawable pill(int fill, int stroke, Context c) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setColor(fill);
        g.setCornerRadius(dp(c, 999));
        if (stroke != 0) g.setStroke(Math.max(1, dp(c, 1)), stroke);
        return g;
    }

    public static GradientDrawable circle(int fill, Context c) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(fill);
        return g;
    }

    public static GradientDrawable ring(int fill, int stroke, Context c) {
        GradientDrawable g = circle(fill, c);
        if (stroke != 0) g.setStroke(Math.max(1, dp(c, 1)), stroke);
        return g;
    }

    public static int fade(int color, float ratio) {
        if (ratio < 0f) ratio = 0f;
        if (ratio > 1f) ratio = 1f;
        int a = (int) (((color >>> 24) & 0xFF) * ratio + 0.5f);
        return (a << 24) | (color & 0x00FFFFFF);
    }

    public static int mix(int a, int b, float t) {
        if (t < 0f) t = 0f;
        if (t > 1f) t = 1f;
        int r = (int) (((a >> 16) & 0xFF) * (1 - t) + ((b >> 16) & 0xFF) * t + 0.5f);
        int g = (int) (((a >> 8) & 0xFF) * (1 - t) + ((b >> 8) & 0xFF) * t + 0.5f);
        int bl = (int) ((a & 0xFF) * (1 - t) + (b & 0xFF) * t + 0.5f);
        return 0xFF000000 | (r << 16) | (g << 8) | bl;
    }
}
