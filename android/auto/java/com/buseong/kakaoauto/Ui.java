package com.buseong.kakaoauto;

import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/**
 * 뷰 조립기. 모든 화면은 이것만 쓴다. XML 레이아웃도, 외부 라이브러리도 안 쓴다.
 *
 * 원칙 (UI_V3)
 *  - 한 화면에는 한 가지 일만. 상세 설정은 아코디언이 아니라 Nav.push 로 서브화면을 연다.
 *  - 목록은 navRow(제목 + 지금 값 + ›) 를 group() 안에 쌓는다. 제목만 있는 행은 만들지 마라.
 *  - 한 화면에 보이는 항목은 최대 7개, 섹션은 3개 이하 (sectionHeader 로 경계를 만든다).
 *  - 숫자/긴 글 입력은 다이얼로그로 분리하고, 화면엔 "현재 값 + 수정"만 보여준다.
 *  - 그림자·애니메이션·그라디언트 남용 금지. 여백과 글자 위계로 정리한다.
 *
 * 여기서 만든 뷰는 LinearLayout.LayoutParams 를 달고 나온다. 세로 LinearLayout 에 그냥 addView 하면 된다.
 * (FrameLayout 같은 데 직접 넣을 거면 LayoutParams 를 그 부모 것으로 바꿔 끼워라)
 */
public final class Ui {
    private Ui() {}

    /** 토글 콜백 */
    public interface OnToggle { void on(boolean v); }

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    // ── 글자 ──────────────────────────────────────────────────────────────────

    /** 화면 제목 22sp bold */
    public static TextView title(Context c, String s) {
        TextView t = base(c, s, 22f, Theme.TEXT, true);
        t.setLetterSpacing(-0.02f);
        t.setPadding(0, Theme.dp(c, 4), 0, Theme.dp(c, 4));
        return t;
    }

    /** 카드/구역 제목 16sp bold */
    public static TextView h2(Context c, String s) {
        TextView t = base(c, s, 16f, Theme.TEXT, true);
        t.setLetterSpacing(-0.01f);
        return t;
    }

    /**
     * 목록 행 제목 15sp bold. navRow·actionRow·permRow·featureRow 가 전부 이걸 써서
     * 같은 위계의 제목 크기가 한 가지로 통일된다 (화면마다 15/14.5/16sp 로 흔들리던 걸 잡는다).
     * 한 줄 + 말줄임. 레이아웃 파라미터는 호출부가 붙인다.
     */
    public static TextView rowTitle(Context c, String s) {
        TextView t = base(c, s, 15f, Theme.TEXT, true);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        return t;
    }

    /**
     * 18sp bold 경고/강조 한 줄 (잠금 안내 등). 화면 코드에서 raw setTextSize 를 없애려고 둔다.
     * 색은 호출부가 setTextColor 로 바꿔 쓴다 (기본 TEXT).
     */
    public static TextView headline(Context c, String s) {
        TextView t = base(c, s, 18f, Theme.TEXT, true);
        t.setLetterSpacing(-0.01f);
        t.setLineSpacing(0, 1.35f);
        return t;
    }

    /** 12sp 보조 한 줄 (로그 줄처럼 작은 글자). color 0 이면 DIM. raw setTextSize 대체용. */
    public static TextView micro(Context c, String s, int color) {
        TextView t = base(c, s, 12f, (color == 0) ? Theme.DIM : color, false);
        return t;
    }

    /** 작은 머리말 12sp SUB (구역 라벨) */
    public static TextView label(Context c, String s) {
        TextView t = base(c, s, 12f, Theme.SUB, true);
        t.setLetterSpacing(0.06f);
        return t;
    }

    /** 본문 14sp */
    public static TextView body(Context c, String s) {
        TextView t = base(c, s, 14f, Theme.TEXT, false);
        t.setLineSpacing(0, 1.4f);
        return t;
    }

    /** 보조설명 13sp SUB */
    public static TextView sub(Context c, String s) {
        TextView t = base(c, s, 13f, Theme.SUB, false);
        t.setLineSpacing(0, 1.4f);
        return t;
    }

    /** 키·해시처럼 고정폭이 필요한 값 */
    public static TextView mono(Context c, String s) {
        TextView t = new TextView(c);
        t.setText(s == null ? "" : s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        t.setTextColor(Theme.TEXT);
        t.setTypeface(Typeface.MONOSPACE);
        t.setLetterSpacing(0.02f);
        t.setBackground(Theme.round(Theme.CARD2, Theme.R_SM, Theme.LINE, 1, c));
        t.setPadding(Theme.dp(c, 12), Theme.dp(c, 10), Theme.dp(c, 12), Theme.dp(c, 10));
        try { t.setTextIsSelectable(true); } catch (Throwable ignore) { /* 일부 기기에서 예외 */ }
        t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        return t;
    }

    // ── 컨테이너 ──────────────────────────────────────────────────────────────

    /** 스크롤 루트로 쓸 세로 컨테이너. 좌우 20dp, 하단 96dp(탭바 자리) */
    public static LinearLayout screen(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(Theme.dp(c, 20), Theme.dp(c, 8), Theme.dp(c, 20), Theme.dp(c, 96));
        l.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        return l;
    }

    /** screen() 을 감싸는 스크롤뷰 */
    public static ScrollView scroll(Context c, View child) {
        ScrollView s = new ScrollView(c);
        s.setFillViewport(true);
        s.setVerticalScrollBarEnabled(false);
        s.setBackgroundColor(Theme.BG);
        if (child != null) {
            s.addView(child, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        }
        s.setLayoutParams(new LinearLayout.LayoutParams(MATCH, MATCH));
        return s;
    }

    /** 카드. 패딩 16dp + R_LG + LINE 보더. 아래 12dp 간격이 기본으로 붙는다. */
    public static LinearLayout card(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackground(Theme.round(Theme.CARD, Theme.R_LG, Theme.LINE, 1, c));
        int p = Theme.dp(c, 16);
        l.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.bottomMargin = Theme.dp(c, 12);
        l.setLayoutParams(lp);
        return l;
    }

    /** 가로 줄 (세로 가운데 정렬) */
    public static LinearLayout row(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.HORIZONTAL);
        l.setGravity(Gravity.CENTER_VERTICAL);
        l.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        return l;
    }

    /** 정사각 빈칸. 세로 컨테이너면 높이로, 가로 줄이면 너비로 먹는다. */
    public static View spacer(Context c, int dp) {
        View v = new View(c);
        int n = Theme.dp(c, dp);
        v.setLayoutParams(new LinearLayout.LayoutParams(n, n));
        return v;
    }

    /** 1dp 구분선 (위아래 12dp 여백 포함) */
    public static View divider(Context c) {
        View v = new View(c);
        v.setBackgroundColor(Theme.LINE);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, Math.max(1, Theme.dp(c, 1)));
        lp.topMargin = Theme.dp(c, 12);
        lp.bottomMargin = Theme.dp(c, 12);
        v.setLayoutParams(lp);
        return v;
    }

    /**
     * 구역 머리말. **한 줄이다.** (예전엔 라벨+제목 2줄이었는데 목록 화면에서 너무 무거웠다)
     * titleTxt 가 있으면 그걸 쓰고, 없으면 labelTxt 를 쓴다 — 시그니처는 그대로 둔 채 표시만 한 줄로 줄였다.
     * group() 바로 위에 놓는 용도. 아래 여백은 8dp 만 둔다.
     */
    public static LinearLayout sectionHeader(Context c, String labelTxt, String titleTxt) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        // 간격 스케일(4·8·12·16·20·24)에 맞춰 섹션 리듬을 16dp 로 통일한다.
        lp.topMargin = Theme.dp(c, 16);
        lp.bottomMargin = Theme.dp(c, 8);
        l.setLayoutParams(lp);

        String one = (titleTxt != null && titleTxt.length() > 0) ? titleTxt : labelTxt;
        if (one != null && one.length() > 0) {
            TextView t = base(c, one, 13f, Theme.SUB, true);
            t.setLetterSpacing(0.02f);
            t.setSingleLine(true);
            t.setEllipsize(TextUtils.TruncateAt.END);
            t.setPadding(Theme.dp(c, 4), 0, Theme.dp(c, 4), 0);
            t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            l.addView(t);
        }
        return l;
    }

    /** 좌 라벨 · 우 값 한 줄 */
    public static LinearLayout kv(Context c, String k, String v) {
        LinearLayout r = new LinearLayout(c);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        int pv = Theme.dp(c, 7);
        r.setPadding(0, pv, 0, pv);
        r.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        TextView kt = base(c, k, 13f, Theme.SUB, false);
        kt.setLayoutParams(new LinearLayout.LayoutParams(WRAP, WRAP));
        r.addView(kt);

        TextView vt = base(c, v, 14f, Theme.TEXT, false);
        vt.setGravity(Gravity.END);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(0, WRAP, 1f);
        vp.leftMargin = Theme.dp(c, 12);
        vt.setLayoutParams(vp);
        r.addView(vt);
        return r;
    }

    // ── 조작 요소 ─────────────────────────────────────────────────────────────

    /** pill 칩. 배경은 color 12%, 글자는 color. */
    public static TextView chip(Context c, String text, int color) {
        TextView t = base(c, text, 12f, color, true);
        t.setBackground(Theme.pill(Theme.fade(color, 0.12f), Theme.fade(color, 0.24f), c));
        t.setPadding(Theme.dp(c, 10), Theme.dp(c, 5), Theme.dp(c, 10), Theme.dp(c, 5));
        t.setGravity(Gravity.CENTER);
        t.setLayoutParams(new LinearLayout.LayoutParams(WRAP, WRAP));
        return t;
    }

    /** 버튼. primary 면 ACCENT 채움, 아니면 투명 + 보더. 높이 48dp. */
    public static TextView btn(Context c, String s, boolean primary) {
        TextView t = base(c, s, 14f, primary ? Theme.ON_ACCENT : Theme.TEXT, primary);
        t.setBackground(primary
                ? Theme.round(Theme.ACCENT, Theme.R_MD, 0, 0, c)
                : Theme.round(Theme.TRANSPARENT, Theme.R_MD, Theme.LINE2, 1, c));
        t.setGravity(Gravity.CENTER);
        t.setPadding(Theme.dp(c, 18), Theme.dp(c, 14), Theme.dp(c, 18), Theme.dp(c, 14));
        t.setMinimumHeight(Theme.dp(c, 48));
        t.setClickable(true);
        t.setFocusable(true);
        press(t);
        return t;
    }

    /** 입력칸 */
    public static EditText field(Context c, String hint) {
        EditText e = new EditText(c);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
        e.setTextColor(Theme.TEXT);
        e.setHintTextColor(Theme.DIM);
        if (hint != null) e.setHint(hint);
        e.setTypeface(Typeface.DEFAULT);
        e.setBackground(Theme.round(Theme.CARD2, Theme.R_MD, Theme.LINE2, 1, c));
        int p = Theme.dp(c, 14);
        e.setPadding(p, p, p, p);
        e.setMinimumHeight(Theme.dp(c, 48));
        e.setGravity(Gravity.TOP | Gravity.START);
        e.setLineSpacing(0, 1.3f);
        e.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        return e;
    }

    /**
     * 좌측 제목+설명, 우측 36x20dp 토글. 누르면 즉시 모양이 바뀌고 콜백이 온다.
     * 현재 상태는 뷰의 태그(Boolean)에 들어있다 → isOn(view) / setOn(view,b)
     */
    public static LinearLayout switchRow(Context c, String titleTxt, String desc, boolean on, final OnToggle cb) {
        final LinearLayout root = new LinearLayout(c);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        int pv = Theme.dp(c, 12);
        root.setPadding(0, pv, 0, pv);
        root.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        LinearLayout left = new LinearLayout(c);
        left.setOrientation(LinearLayout.VERTICAL);
        left.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        left.addView(base(c, titleTxt, 15f, Theme.TEXT, true));
        if (desc != null && desc.length() > 0) {
            TextView dv = base(c, desc, 12.5f, Theme.SUB, false);
            dv.setLineSpacing(0, 1.35f);
            LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
            dp.topMargin = Theme.dp(c, 3);
            dv.setLayoutParams(dp);
            left.addView(dv);
        }
        root.addView(left);

        FrameLayout sw = new FrameLayout(c);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(Theme.dp(c, 36), Theme.dp(c, 20));
        sp.leftMargin = Theme.dp(c, 14);
        sw.setLayoutParams(sp);

        final View track = new View(c);
        track.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        sw.addView(track);

        final View knob = new View(c);
        FrameLayout.LayoutParams kp = new FrameLayout.LayoutParams(Theme.dp(c, 16), Theme.dp(c, 16));
        kp.gravity = Gravity.CENTER_VERTICAL | Gravity.START;
        kp.leftMargin = Theme.dp(c, 2);
        kp.rightMargin = Theme.dp(c, 2);
        knob.setLayoutParams(kp);
        sw.addView(knob);
        root.addView(sw);

        paintSwitch(c, track, knob, on);
        root.setTag(Boolean.valueOf(on));
        root.setClickable(true);
        root.setFocusable(true);
        root.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                boolean now = !isOn(root);
                root.setTag(Boolean.valueOf(now));
                paintSwitch(v.getContext(), track, knob, now);
                if (cb != null) {
                    try { cb.on(now); } catch (Throwable t) { Log.add(v.getContext(), "설정 적용 실패: " + t); }
                }
            }
        });
        return root;
    }

    /** switchRow 의 현재 상태 */
    public static boolean isOn(View switchRow) {
        Object t = (switchRow == null) ? null : switchRow.getTag();
        return (t instanceof Boolean) && ((Boolean) t).booleanValue();
    }

    /** switchRow 상태를 코드로 바꾼다 (콜백은 안 부른다) */
    public static void setOn(View switchRow, boolean on) {
        if (!(switchRow instanceof LinearLayout)) return;
        LinearLayout r = (LinearLayout) switchRow;
        for (int i = 0; i < r.getChildCount(); i++) {
            View v = r.getChildAt(i);
            if (v instanceof FrameLayout && ((FrameLayout) v).getChildCount() >= 2) {
                paintSwitch(r.getContext(), ((FrameLayout) v).getChildAt(0),
                        ((FrameLayout) v).getChildAt(1), on);
                r.setTag(Boolean.valueOf(on));
                return;
            }
        }
    }

    /**
     * 기능 카드. 이름 옆에 상태 칩(chipText/chipColor)을 붙인다. onOpen 이 있으면 카드 전체가 눌린다.
     */
    public static LinearLayout featureCard(Context c, String name, String desc,
                                           String chipText, int chipColor, final Runnable onOpen) {
        LinearLayout card = card(c);

        LinearLayout head = row(c);
        TextView nm = base(c, name, 17f, Theme.TEXT, true);
        nm.setLetterSpacing(-0.01f);
        nm.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        head.addView(nm);

        if (chipText != null && chipText.length() > 0) head.addView(chip(c, chipText, chipColor));
        if (onOpen != null) {
            TextView arrow = base(c, "›", 19f, Theme.DIM, false);
            LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(WRAP, WRAP);
            ap.leftMargin = Theme.dp(c, 8);
            arrow.setLayoutParams(ap);
            head.addView(arrow);
        }
        card.addView(head);

        if (desc != null && desc.length() > 0) {
            TextView ds = sub(c, desc);
            LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
            dp.topMargin = Theme.dp(c, 8);
            ds.setLayoutParams(dp);
            card.addView(ds);
        }

        if (onOpen != null) {
            card.setClickable(true);
            card.setFocusable(true);
            card.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { onOpen.run(); }
            });
            press(card);
        }
        return card;
    }

    /** 눌림 효과 (리플 라이브러리 없이 알파만) */
    public static void press(final View v) {
        if (v == null) return;
        v.setOnTouchListener(new View.OnTouchListener() {
            @Override public boolean onTouch(View vv, MotionEvent e) {
                int a = e.getActionMasked();
                if (a == MotionEvent.ACTION_DOWN) vv.setAlpha(0.7f);
                else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL
                        || a == MotionEvent.ACTION_OUTSIDE) vv.setAlpha(1f);
                return false;
            }
        });
    }

    // ── 목록형 컴포넌트 (UI_V3 9장) ───────────────────────────────────────────
    //  화면은 "제목 + 지금 값 + ›" 행만 쌓는다. 상세는 Nav.push 로 서브화면을 연다.
    //  행의 좌우 패딩은 행이 갖고 group() 은 0 이다 → 구분선이 카드 폭 전체에 닿는다.

    private static final Object SEP_TAG = new Object();

    /** 행 높이·좌우 패딩 (navRow / navRowSwitch / checkRow 가 같이 쓴다) */
    private static final int ROW_H = 56;
    private static final int ROW_PH = 16;

    /**
     * 행들을 담는 카드. addView 로 자식을 붙이면 **자식 사이에만** 1dp 구분선이 자동으로 들어간다.
     * 컨테이너 좌우 패딩은 0 이다 (행이 자기 패딩을 갖는다).
     * 중간 삽입(index 지정)에는 구분선을 넣지 않는다 — 목록은 위에서 아래로 쌓는 것만 쓴다.
     */
    public static LinearLayout group(Context c) {
        return new Group(c);
    }

    /** group() 의 실제 구현. 바깥에서 직접 new 하지 말고 group() 을 써라. */
    public static final class Group extends LinearLayout {
        private boolean inserting;

        Group(Context c) {
            super(c);
            setOrientation(LinearLayout.VERTICAL);
            setBackground(Theme.round(Theme.CARD, Theme.R_LG, Theme.LINE, 1, c));
            setPadding(0, 0, 0, 0);
            try { setClipToOutline(true); } catch (Throwable ignore) { /* 모양만 손해 */ }
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
            lp.bottomMargin = Theme.dp(c, 12);
            setLayoutParams(lp);
        }

        @Override public void addView(View child, int index, ViewGroup.LayoutParams params) {
            boolean appending = (index < 0 || index >= getChildCount());
            if (!inserting && child != null && appending && getChildCount() > 0) {
                inserting = true;
                try {
                    View sep = new View(getContext());
                    sep.setBackgroundColor(Theme.LINE);
                    sep.setTag(SEP_TAG);
                    super.addView(sep, -1, new LinearLayout.LayoutParams(
                            MATCH, Math.max(1, Theme.dp(getContext(), 1))));
                } catch (Throwable ignore) {
                    // 구분선 실패는 무해
                } finally {
                    inserting = false;
                }
            }
            super.addView(child, index, params);
        }
    }

    // 리딩 글리프 종류. 기능별로 색+형태를 같이 줘서 한눈에 구별되게 한다.
    public static final int GLYPH_NONE     = -1;
    public static final int GLYPH_MACRO    = 0;   // 발송 (삼각형)
    public static final int GLYPH_ROOMBOT  = 1;   // 말풍선
    public static final int GLYPH_MINIGAME = 2;   // 주사위

    /**
     * 목록 행: 좌 제목 · 우 현재값 · `›`.
     * 값이 비면 `›` 만 남는다. 값은 우측정렬 + 한 줄 + 말줄임이며 행 폭의 절반을 넘지 않는다.
     * onTap 이 있으면 행 전체가 눌린다(누를 때 alpha 0.7).
     *
     * @param valueColor 값 글자색. 0 이면 Theme.SUB. 꺼진 기능은 DIM, 설정이 필요하면 AMBER 를 넘긴다.
     */
    public static LinearLayout navRow(Context c, String title, String value, int valueColor,
                                      final Runnable onTap) {
        return navRow(c, GLYPH_NONE, 0, title, value, valueColor, onTap);
    }

    /**
     * 리딩 배지(24dp 원형 + 기능 글리프)가 붙는 목록 행.
     * 기능 행(매크로·방 관리봇·미니게임봇)에 색+형태로 즉시 구별되는 아이콘을 준다.
     *
     * @param glyphKind {@link #GLYPH_NONE} 이면 배지 없이 일반 행과 같다.
     * @param accent    배지 액센트 색 (0 이면 Theme.ACCENT). Theme 토큰만 넘겨라.
     */
    public static LinearLayout navRow(Context c, int glyphKind, int accent, String title,
                                      String value, int valueColor, final Runnable onTap) {
        NavRow r = new NavRow(c);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setMinimumHeight(Theme.dp(c, ROW_H));
        int ph = Theme.dp(c, ROW_PH);
        int pv = Theme.dp(c, 12);
        r.setPadding(ph, pv, ph, pv);
        r.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        if (glyphKind != GLYPH_NONE) {
            Glyph badge = new Glyph(c, glyphKind, (accent == 0) ? Theme.ACCENT : accent);
            LinearLayout.LayoutParams gp =
                    new LinearLayout.LayoutParams(Theme.dp(c, 24), Theme.dp(c, 24));
            gp.rightMargin = Theme.dp(c, 12);
            badge.setLayoutParams(gp);
            r.addView(badge);
        }

        TextView t = rowTitle(c, title);
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        r.addView(t);

        boolean has = (value != null && value.length() > 0);
        TextView v = base(c, has ? value : "", 14f, (valueColor == 0) ? Theme.SUB : valueColor, false);
        v.setGravity(Gravity.END);
        v.setSingleLine(true);
        v.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(WRAP, WRAP);
        vp.leftMargin = Theme.dp(c, 12);
        v.setLayoutParams(vp);
        if (!has) v.setVisibility(View.GONE);
        r.addView(v);
        r.value = v;

        TextView arrow = base(c, "›", 19f, Theme.DIM, false);
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(WRAP, WRAP);
        ap.leftMargin = Theme.dp(c, 8);
        arrow.setLayoutParams(ap);
        r.addView(arrow);

        r.setContentDescription(has ? ((title == null ? "" : title) + ", " + value) : title);
        if (onTap != null) {
            r.setClickable(true);
            r.setFocusable(true);
            press(r);
            r.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View vv) {
                    try { onTap.run(); } catch (Throwable t2) { Log.add(vv.getContext(), "화면 열기 실패: " + t2); }
                }
            });
        }
        return r;
    }

    /** navRow 의 값 글자가 행 폭의 절반을 넘지 않게 재는 행 */
    private static final class NavRow extends LinearLayout {
        TextView value;
        private int cap = -1;

        NavRow(Context c) { super(c); }

        @Override protected void onMeasure(int wSpec, int hSpec) {
            if (value != null) {
                int half = (MeasureSpec.getSize(wSpec) - getPaddingLeft() - getPaddingRight()) / 2;
                if (half > 0 && half != cap) {
                    cap = half;
                    value.setMaxWidth(half);
                }
            }
            super.onMeasure(wSpec, hSpec);
        }
    }

    /**
     * navRow 의 리딩 배지. 원형 배경(액센트 14%) 위에 기능별 글리프를 직접 그린다.
     * 라이브러리 의존 없이 Canvas 로만 그려서 세 기능이 색·형태로 즉시 구별된다.
     */
    public static final class Glyph extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();
        private final int kind;
        private final int accent;

        Glyph(Context c, int kind, int accent) {
            super(c);
            this.kind = kind;
            this.accent = accent;
        }

        @Override protected void onDraw(Canvas cv) {
            float w = getWidth();
            float h = getHeight();
            if (w <= 0 || h <= 0) return;
            float cx = w / 2f;
            float cy = h / 2f;
            float u = Math.min(w, h);

            paint.setStyle(Paint.Style.FILL);
            paint.setColor(Theme.fade(accent, 0.14f));
            cv.drawCircle(cx, cy, u / 2f, paint);
            paint.setColor(accent);

            switch (kind) {
                case GLYPH_MACRO: {   // 발송 — 오른쪽을 가리키는 삼각형
                    path.rewind();
                    path.moveTo(cx - u * 0.15f, cy - u * 0.17f);
                    path.lineTo(cx + u * 0.20f, cy);
                    path.lineTo(cx - u * 0.15f, cy + u * 0.17f);
                    path.close();
                    cv.drawPath(path, paint);
                    break;
                }
                case GLYPH_ROOMBOT: { // 대화방 — 말풍선
                    float bw = u * 0.42f;
                    float bh = u * 0.30f;
                    float left = cx - bw / 2f;
                    float top = cy - bh / 2f - u * 0.04f;
                    cv.drawRoundRect(left, top, left + bw, top + bh,
                            u * 0.09f, u * 0.09f, paint);
                    path.rewind();
                    path.moveTo(cx - u * 0.07f, top + bh - u * 0.01f);
                    path.lineTo(cx - u * 0.15f, top + bh + u * 0.11f);
                    path.lineTo(cx + u * 0.02f, top + bh - u * 0.01f);
                    path.close();
                    cv.drawPath(path, paint);
                    break;
                }
                case GLYPH_MINIGAME: { // 게임 — 주사위 4점
                    float d = u * 0.075f;
                    float off = u * 0.12f;
                    cv.drawCircle(cx - off, cy - off, d, paint);
                    cv.drawCircle(cx + off, cy - off, d, paint);
                    cv.drawCircle(cx - off, cy + off, d, paint);
                    cv.drawCircle(cx + off, cy + off, d, paint);
                    break;
                }
                default: {            // 단색 점
                    cv.drawCircle(cx, cy, u * 0.14f, paint);
                }
            }
        }
    }

    /**
     * 목록 행 + 토글. 값 대신 스위치가 오른쪽에 붙는다 (서브화면으로 안 가는 on/off 설정용).
     * 상태는 switchRow 와 같게 뷰 태그에 들어있다 → isOn(view) / setOn(view, b) 가 그대로 쓰인다.
     */
    public static LinearLayout navRowSwitch(Context c, String title, String sub, boolean on,
                                            OnToggle cb) {
        LinearLayout r = switchRow(c, title, sub, on, cb);
        int ph = Theme.dp(c, ROW_PH);
        r.setPadding(ph, Theme.dp(c, 12), ph, Theme.dp(c, 12));
        r.setMinimumHeight(Theme.dp(c, ROW_H));
        press(r);
        return r;
    }

    /**
     * 체크박스 행. 다중 선택 목록(대상 방, 사용 계정)에 쓴다.
     * 왼쪽 체크 영역과 오른쪽 ✕ 영역의 터치가 분리돼 있다 — 지우려다 선택이 바뀌는 일이 없다.
     *
     * @param badges  제목 아래에 붙는 짧은 배지들 (`단체` / `1:1`). null 이면 없음
     * @param onDelete null 이면 ✕ 를 아예 안 만든다
     */
    public static LinearLayout checkRow(Context c, String title, String sub, String[] badges,
                                        boolean checked, final OnToggle cb, final Runnable onDelete) {
        LinearLayout root = new LinearLayout(c);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        root.setMinimumHeight(Theme.dp(c, 60));
        root.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        LinearLayout tap = new LinearLayout(c);
        tap.setOrientation(LinearLayout.HORIZONTAL);
        tap.setGravity(Gravity.CENTER_VERTICAL);
        int pv = Theme.dp(c, 12);
        tap.setPadding(Theme.dp(c, ROW_PH), pv, Theme.dp(c, 8), pv);
        tap.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        tap.setClickable(true);
        tap.setFocusable(true);
        press(tap);

        final Check box = new Check(c, checked);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(Theme.dp(c, 22), Theme.dp(c, 22));
        bp.rightMargin = Theme.dp(c, 12);
        box.setLayoutParams(bp);
        tap.addView(box);

        LinearLayout col = new LinearLayout(c);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));

        TextView t = base(c, title, 15f, Theme.TEXT, true);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        col.addView(t);

        boolean hasSub = (sub != null && sub.length() > 0);
        boolean hasBadge = (badges != null && badges.length > 0);
        if (hasSub || hasBadge) {
            LinearLayout line2 = new LinearLayout(c);
            line2.setOrientation(LinearLayout.HORIZONTAL);
            line2.setGravity(Gravity.CENTER_VERTICAL);
            LinearLayout.LayoutParams l2 = new LinearLayout.LayoutParams(MATCH, WRAP);
            l2.topMargin = Theme.dp(c, 5);
            line2.setLayoutParams(l2);

            if (hasBadge) {
                for (int i = 0; i < badges.length; i++) {
                    String b = badges[i];
                    if (b == null || b.length() == 0) continue;
                    TextView bv = badge(c, b, Theme.SUB);
                    LinearLayout.LayoutParams bvp = new LinearLayout.LayoutParams(WRAP, WRAP);
                    bvp.rightMargin = Theme.dp(c, 6);
                    bv.setLayoutParams(bvp);
                    line2.addView(bv);
                }
            }
            if (hasSub) {
                TextView sv = base(c, sub, 12.5f, Theme.DIM, false);
                sv.setSingleLine(true);
                sv.setEllipsize(TextUtils.TruncateAt.END);
                sv.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
                line2.addView(sv);
            }
            col.addView(line2);
        }
        tap.addView(col);
        root.addView(tap);

        final String nm = (title == null) ? "" : title;
        tap.setContentDescription(nm + (checked ? ", 선택됨" : ", 선택 안 됨"));
        tap.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                boolean now = !box.isChecked();
                box.set(now);
                v.setContentDescription(nm + (now ? ", 선택됨" : ", 선택 안 됨"));
                if (cb != null) {
                    try { cb.on(now); } catch (Throwable t2) { Log.add(v.getContext(), "선택 저장 실패: " + t2); }
                }
            }
        });

        if (onDelete != null) {
            TextView x = base(c, "✕", 15f, Theme.DIM, false);
            x.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams xp = new LinearLayout.LayoutParams(Theme.dp(c, 48), Theme.dp(c, 48));
            xp.rightMargin = Theme.dp(c, 4);
            x.setLayoutParams(xp);
            x.setClickable(true);
            x.setFocusable(true);
            x.setContentDescription(nm + " 삭제");
            press(x);
            x.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    try { onDelete.run(); } catch (Throwable t2) { Log.add(v.getContext(), "삭제 실패: " + t2); }
                }
            });
            root.addView(x);
        }
        return root;
    }

    /** checkRow 의 체크박스. 켜짐=ACCENT 채움+체크, 꺼짐=LINE2 보더. 직접 그린다(위젯 의존 없음). */
    public static final class Check extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path tick = new Path();
        private final float radius;
        private final float border;
        private final float stroke;
        private boolean on;

        Check(Context c, boolean on) {
            super(c);
            this.on = on;
            radius = Theme.dp(c, Theme.R_XS);
            border = Math.max(1f, Theme.dp(c, 1.5f));
            stroke = Math.max(2f, Theme.dp(c, 2));
        }

        public boolean isChecked() { return on; }

        public void set(boolean b) {
            if (on == b) return;
            on = b;
            invalidate();
        }

        @Override protected void onDraw(Canvas cv) {
            float w = getWidth();
            float h = getHeight();
            if (w <= 0 || h <= 0) return;
            if (on) {
                paint.setStyle(Paint.Style.FILL);
                paint.setColor(Theme.ACCENT);
                cv.drawRoundRect(0f, 0f, w, h, radius, radius, paint);

                tick.rewind();
                tick.moveTo(w * 0.25f, h * 0.52f);
                tick.lineTo(w * 0.43f, h * 0.70f);
                tick.lineTo(w * 0.76f, h * 0.31f);
                paint.setStyle(Paint.Style.STROKE);
                paint.setColor(Theme.ON_ACCENT);
                paint.setStrokeWidth(stroke);
                paint.setStrokeCap(Paint.Cap.ROUND);
                paint.setStrokeJoin(Paint.Join.ROUND);
                cv.drawPath(tick, paint);
            } else {
                float in = border / 2f;
                paint.setStyle(Paint.Style.STROKE);
                paint.setStrokeWidth(border);
                paint.setColor(Theme.LINE2);
                cv.drawRoundRect(in, in, w - in, h - in, radius, radius, paint);
            }
        }
    }

    /** 작은 배지 (10sp pill, 색상 12% 배경). `단체` / `1:1` 처럼 두세 글자만 넣는다. */
    public static TextView badge(Context c, String text, int color) {
        int col = (color == 0) ? Theme.SUB : color;
        TextView t = base(c, text, 10f, col, true);
        t.setBackground(Theme.pill(Theme.fade(col, 0.12f), 0, c));
        t.setPadding(Theme.dp(c, 7), Theme.dp(c, 3), Theme.dp(c, 7), Theme.dp(c, 3));
        t.setGravity(Gravity.CENTER);
        t.setSingleLine(true);
        t.setLayoutParams(new LinearLayout.LayoutParams(WRAP, WRAP));
        return t;
    }

    /**
     * 되돌리기 스낵바. 붙이면 5초 뒤 스스로 사라지고, action 을 누르면 실행 후 즉시 사라진다.
     * 화면에서 떼어지면 Handler 콜백도 같이 정리한다 (화면을 나가도 타이머가 살아있지 않다).
     * 하단에 띄우려면 Nav.snack(...) 을 써라 — 탭바 높이까지 맞춰서 붙여준다.
     */
    public static View snack(Context c, String msg, String action, final Runnable onAction) {
        final Snack s = new Snack(c);
        s.setOrientation(LinearLayout.HORIZONTAL);
        s.setGravity(Gravity.CENTER_VERTICAL);
        s.setBackground(Theme.round(Theme.CARD2, Theme.R_MD, Theme.LINE2, 1, c));
        s.setPadding(Theme.dp(c, 14), Theme.dp(c, 10), Theme.dp(c, 8), Theme.dp(c, 10));
        s.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        TextView t = base(c, msg, 13f, Theme.TEXT, false);
        t.setMaxLines(2);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setLineSpacing(0, 1.3f);
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        s.addView(t);

        if (action != null && action.length() > 0) {
            TextView b = base(c, action, 13f, Theme.ACCENT, true);
            b.setGravity(Gravity.CENTER);
            b.setMinimumHeight(Theme.dp(c, 48));
            b.setMinimumWidth(Theme.dp(c, 48));
            b.setPadding(Theme.dp(c, 14), 0, Theme.dp(c, 14), 0);
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(WRAP, WRAP);
            bp.leftMargin = Theme.dp(c, 8);
            b.setLayoutParams(bp);
            b.setClickable(true);
            b.setFocusable(true);
            press(b);
            b.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    s.dismiss();
                    if (onAction != null) {
                        try { onAction.run(); } catch (Throwable t2) { Log.add(v.getContext(), "되돌리기 실패: " + t2); }
                    }
                }
            });
            s.addView(b);
        }
        return s;
    }

    /** snack() 의 실제 구현. 5초 타이머를 스스로 들고 있다. */
    public static final class Snack extends LinearLayout {
        /** 화면에 머무는 시간 */
        public static final long SHOW_MS = 5000L;

        private final Handler h = new Handler(Looper.getMainLooper());
        private final Runnable gone = new Runnable() {
            @Override public void run() { dismiss(); }
        };

        Snack(Context c) { super(c); }

        @Override protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            ViewGroup.LayoutParams lp = getLayoutParams();
            if (lp instanceof FrameLayout.LayoutParams) {
                FrameLayout.LayoutParams f = (FrameLayout.LayoutParams) lp;
                if (f.gravity <= 0) {
                    f.gravity = Gravity.BOTTOM;
                    setLayoutParams(f);
                }
            }
            h.removeCallbacks(gone);
            h.postDelayed(gone, SHOW_MS);
        }

        @Override protected void onDetachedFromWindow() {
            h.removeCallbacks(gone);
            super.onDetachedFromWindow();
        }

        /** 지금 치운다 (타이머도 정리) */
        public void dismiss() {
            h.removeCallbacks(gone);
            if (getParent() instanceof ViewGroup) {
                try { ((ViewGroup) getParent()).removeView(this); return; } catch (Throwable ignore) { }
            }
            setVisibility(View.GONE);
        }
    }

    // ── 알림 ──────────────────────────────────────────────────────────────────

    /** 어느 스레드에서 불러도 된다 */
    public static void toast(final Context c, final String s) {
        if (c == null || s == null) return;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            try { Toast.makeText(c, s, Toast.LENGTH_SHORT).show(); } catch (Throwable ignore) { }
            return;
        }
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override public void run() {
                try { Toast.makeText(c, s, Toast.LENGTH_SHORT).show(); } catch (Throwable ignore) { }
            }
        });
    }

    /** 다크 다이얼로그 빌더. 띄울 때는 showDark(builder) 를 쓰면 배경까지 다크로 맞춰준다. */
    public static AlertDialog.Builder dialog(Context c, String titleTxt) {
        AlertDialog.Builder b = new AlertDialog.Builder(c, android.R.style.Theme_Material_Dialog_Alert);
        if (titleTxt != null && titleTxt.length() > 0) {
            TextView t = base(c, titleTxt, 18f, Theme.TEXT, true);
            t.setLetterSpacing(-0.01f);
            int ph = Theme.dp(c, 22);
            t.setPadding(ph, Theme.dp(c, 22), ph, Theme.dp(c, 6));
            b.setCustomTitle(t);
        }
        return b;
    }

    public static AlertDialog showDark(AlertDialog.Builder b) {
        if (b == null) return null;
        return showDark(b.create());
    }

    /** show() 하고 창 배경·글자색을 앱 톤으로 맞춘다 */
    public static AlertDialog showDark(AlertDialog d) {
        if (d == null) return null;
        try {
            d.show();
        } catch (Throwable t) {
            return d;
        }
        try {
            Context c = d.getContext();
            Window w = d.getWindow();
            if (w != null) {
                w.setBackgroundDrawable(Theme.round(Theme.CARD, Theme.R_LG, Theme.LINE2, 1, c));
            }
            View mv = d.findViewById(android.R.id.message);
            if (mv instanceof TextView) {
                TextView m = (TextView) mv;
                m.setTextColor(Theme.SUB);
                m.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
                m.setLineSpacing(0, 1.45f);
            }
            styleDialogBtn(d.getButton(AlertDialog.BUTTON_POSITIVE), Theme.ACCENT, true);
            styleDialogBtn(d.getButton(AlertDialog.BUTTON_NEGATIVE), Theme.SUB, false);
            styleDialogBtn(d.getButton(AlertDialog.BUTTON_NEUTRAL), Theme.SUB, false);
        } catch (Throwable t) {
            // 모양만 못 입힌 거니까 넘어간다
        }
        return d;
    }

    // ── 내부 ──────────────────────────────────────────────────────────────────

    private static void styleDialogBtn(Button b, int color, boolean bold) {
        if (b == null) return;
        b.setTextColor(color);
        b.setAllCaps(false);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
        b.setTypeface(bold ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
    }

    private static void paintSwitch(Context c, View track, View knob, boolean on) {
        if (track == null || knob == null) return;
        track.setBackground(Theme.pill(on ? Theme.ACCENT : Theme.LINE2, 0, c));
        knob.setBackground(Theme.circle(on ? Theme.TEXT : Theme.SUB, c));
        ViewGroup.LayoutParams p = knob.getLayoutParams();
        if (p instanceof FrameLayout.LayoutParams) {
            FrameLayout.LayoutParams fp = (FrameLayout.LayoutParams) p;
            fp.gravity = Gravity.CENTER_VERTICAL | (on ? Gravity.END : Gravity.START);
            knob.setLayoutParams(fp);
        }
    }

    private static TextView base(Context c, String s, float sizeSp, int color, boolean bold) {
        TextView t = new TextView(c);
        t.setText(s == null ? "" : s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        t.setTextColor(color);
        t.setTypeface(bold ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
        t.setIncludeFontPadding(false);
        return t;
    }
}
