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

    /** 기능 카드 상태 */
    public enum State { ON, OFF, EXPIRING }

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;
    private static final long DAY = 86400000L;

    // ── 글자 ──────────────────────────────────────────────────────────────────

    /** 화면 제목 20sp. 시스템 산세리프. */
    public static TextView title(Context c, String s) {
        TextView t = base(c, s, 20f, Theme.TEXT, true);
        t.setPadding(0, Theme.dp(c, 2), 0, Theme.dp(c, 2));
        return t;
    }

    /** 작은 상태 글자. 자간을 벌리지 않는다. */
    public static TextView eyebrow(Context c, String s, int color) {
        TextView t = base(c, s, 12f, (color == 0) ? Theme.SUB : color, true);
        t.setSingleLine(true);
        return t;
    }

    /**
     * 탭 화면 머리. 기능 색 3dp 막대 + 한글 제목.
     * eyebrowTxt·lead 는 호출 호환용이며 화면에 넣지 않는다 (영문 머리글·태그라인 제거).
     */
    public static LinearLayout pageHead(Context c, String eyebrowTxt, String titleTxt, String lead, int color) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(c, 8);
        lp.bottomMargin = Theme.dp(c, 16);
        l.setLayoutParams(lp);

        LinearLayout top = row(c);
        top.addView(accentBar(c, color, 18));
        TextView t = title(c, titleTxt);
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        top.addView(t);
        l.addView(top);
        return l;
    }

    /** 기능 구분용 3dp 세로 막대. */
    public static View accentBar(Context c, int color, int hDp) {
        View v = new View(c);
        v.setBackground(Theme.round(color, 2, 0, 0, c));
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(Theme.dp(c, 3), Theme.dp(c, hDp));
        bp.rightMargin = Theme.dp(c, 8);
        v.setLayoutParams(bp);
        return v;
    }

    // ── 아이콘 · 기능 표식 ────────────────────────────────────────────────────

    /**
     * 기능 색 표시. 꺾쇠(CHEVRON/BACK)만 글자로 그리고, 나머지는 3dp 색 막대다.
     * 선 아이콘 세트는 화면에 넣지 않는다.
     */
    public static View icon(Context c, int glyph, int color, int sizeDp) {
        if (glyph == Icon.CHEVRON || glyph == Icon.BACK) {
            TextView t = base(c, glyph == Icon.BACK ? "‹" : "›", 18f, color, false);
            t.setGravity(Gravity.CENTER);
            int n = Theme.dp(c, sizeDp);
            t.setLayoutParams(new LinearLayout.LayoutParams(n, n));
            t.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            return t;
        }
        return accentBar(c, color, Math.max(12, Math.min(sizeDp, 18)));
    }

    /** 목록 왼쪽 기능 막대. 시그니처 호환용. 타일·메달은 만들지 않는다. */
    public static FrameLayout iconTile(Context c, int glyph, int color) {
        return iconBox(c, color, 16);
    }

    /** 호환용. 원형 메달 대신 짧은 막대. */
    public static FrameLayout medallion(Context c, int glyph, int color, int sizeDp) {
        return iconBox(c, color, Math.min(sizeDp, 18));
    }

    private static FrameLayout iconBox(Context c, int color, int hDp) {
        FrameLayout f = new FrameLayout(c);
        int w = Theme.dp(c, 3);
        int h = Theme.dp(c, hDp);
        f.setLayoutParams(new LinearLayout.LayoutParams(w, h));
        View bar = new View(c);
        bar.setBackground(Theme.round(color, 2, 0, 0, c));
        f.addView(bar, new FrameLayout.LayoutParams(w, h, Gravity.CENTER));
        f.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        return f;
    }

    /**
     * 기능 머리. 흰 카드 + 왼쪽 색 막대 + 한글 제목 + 설명 한 줄.
     * 영문 머리글·메달·그라데이션은 그리지 않는다. glyph·eyebrowTxt 는 호환용.
     * 돌려준 카드에 스위치·상태 줄을 이어서 addView 하면 된다.
     */
    public static LinearLayout hero(Context c, int color, int glyph, String eyebrowTxt,
                                    String titleTxt, String desc) {
        LinearLayout card = new LinearLayout(c);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setBackground(Theme.round(Theme.CARD, Theme.R_MD, 0, 0, c));
        int p = Theme.dp(c, 16);
        card.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.bottomMargin = Theme.dp(c, 8);
        card.setLayoutParams(lp);

        LinearLayout head = row(c);
        head.addView(accentBar(c, color, 16));
        TextView nm = base(c, titleTxt, 16f, Theme.TEXT, true);
        nm.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        head.addView(nm);
        card.addView(head);

        if (desc != null && desc.length() > 0) {
            TextView d = sub(c, desc);
            LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
            dp.topMargin = Theme.dp(c, 8);
            d.setLayoutParams(dp);
            card.addView(d);
        }
        return card;
    }

    /** 머리 카드 안에서 쓰는 가는 구분선 (기능 색 18%) */
    public static View heroRule(Context c, int color) {
        View v = new View(c);
        v.setBackgroundColor(Theme.fade(color, 0.18f));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, Math.max(1, Theme.dp(c, 1)));
        lp.topMargin = Theme.dp(c, 14);
        lp.bottomMargin = Theme.dp(c, 4);
        v.setLayoutParams(lp);
        return v;
    }

    /**
     * 큰 숫자 + 작은 라벨 한 칸 (머리 카드의 "다음 발송 21:34" 같은 자리). 가로 줄에 weight 1 로 들어간다.
     * 값 TextView 는 칸의 첫 자식이다.
     */
    public static LinearLayout stat(Context c, String labelTxt, String value, int valueColor) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        TextView v = base(c, value, 16f, (valueColor == 0) ? Theme.TEXT : valueColor, true);
        v.setSingleLine(true);
        v.setEllipsize(TextUtils.TruncateAt.END);
        l.addView(v);
        TextView t = base(c, labelTxt, 12f, Theme.SUB, false);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(MATCH, WRAP);
        tp.topMargin = Theme.dp(c, 4);
        t.setLayoutParams(tp);
        l.addView(t);
        return l;
    }

    /** 가는 진행 막대 (done/total). 기능 색으로 채운다. */
    public static View progress(Context c, int done, int total, int color) {
        final int d = Math.max(0, done);
        final int tt = Math.max(1, total);
        FrameLayout f = new FrameLayout(c);
        f.setBackground(Theme.pill(Theme.fade(color, 0.16f), 0, c));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, Theme.dp(c, 4));
        f.setLayoutParams(lp);
        LinearLayout inner = new LinearLayout(c);
        inner.setOrientation(LinearLayout.HORIZONTAL);
        View on = new View(c);
        on.setBackground(Theme.pill(color, 0, c));
        inner.addView(on, new LinearLayout.LayoutParams(0, MATCH, Math.min(d, tt)));
        inner.addView(new View(c), new LinearLayout.LayoutParams(0, MATCH, Math.max(0, tt - d)));
        f.addView(inner, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        return f;
    }

    /** 카드/구역 제목 16sp bold */
    public static TextView h2(Context c, String s) {
        TextView t = base(c, s, 16f, Theme.TEXT, true);
        t.setLetterSpacing(-0.01f);
        return t;
    }

    /** 작은 머리말 12sp SUB (구역 라벨) */
    public static TextView label(Context c, String s) {
        return base(c, s, 12f, Theme.SUB, true);
    }

    /** 본문 14sp */
    public static TextView body(Context c, String s) {
        TextView t = base(c, s, 14f, Theme.TEXT, false);
        t.setLineSpacing(0, 1.5f);
        return t;
    }

    /** 보조설명 13sp SUB */
    public static TextView sub(Context c, String s) {
        TextView t = base(c, s, 13f, Theme.SUB, false);
        t.setLineSpacing(0, 1.5f);
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
        t.setBackground(Theme.round(Theme.BG2, Theme.R_MD, Theme.LINE2, 1, c));
        t.setPadding(Theme.dp(c, 14), Theme.dp(c, 12), Theme.dp(c, 14), Theme.dp(c, 12));
        t.setLineSpacing(0, 1.3f);
        try { t.setTextIsSelectable(true); } catch (Throwable ignore) { /* 일부 기기에서 예외 */ }
        t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        return t;
    }

    // ── 컨테이너 ──────────────────────────────────────────────────────────────

    /** 스크롤 루트로 쓸 세로 컨테이너. 좌우 20dp, 하단 96dp(탭바 자리) */
    public static LinearLayout screen(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(Theme.dp(c, 16), Theme.dp(c, 8), Theme.dp(c, 16), Theme.dp(c, 96));
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
        l.setBackground(Theme.round(Theme.CARD, Theme.R_MD, 0, 0, c));
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
        lp.topMargin = Theme.dp(c, 18);
        lp.bottomMargin = Theme.dp(c, 8);
        l.setLayoutParams(lp);

        String one = (titleTxt != null && titleTxt.length() > 0) ? titleTxt : labelTxt;
        if (one != null && one.length() > 0) {
            LinearLayout r = row(c);
            r.setPadding(0, 0, 0, 0);
            r.addView(accentBar(c, Theme.accent(), 12));
            TextView t = base(c, one, 13f, Theme.SUB, true);
            t.setSingleLine(true);
            t.setEllipsize(TextUtils.TruncateAt.END);
            t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
            r.addView(t);
            l.addView(r);
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

    /** 작은 상태 칩. 4dp 모서리. 배경은 color 12%, 글자는 color. */
    public static TextView chip(Context c, String text, int color) {
        TextView t = base(c, text, 12f, color, true);
        t.setBackground(Theme.round(Theme.fade(color, 0.12f), Theme.R_SM, 0, 0, c));
        t.setPadding(Theme.dp(c, 8), Theme.dp(c, 4), Theme.dp(c, 8), Theme.dp(c, 4));
        t.setGravity(Gravity.CENTER);
        t.setLayoutParams(new LinearLayout.LayoutParams(WRAP, WRAP));
        return t;
    }

    /** 버튼. primary 면 주색 채움, 아니면 흰 면 + 보더. 높이 48dp. 기능 색으로 칠하지 않는다. */
    public static TextView btn(Context c, String s, boolean primary) {
        TextView t = base(c, s, 15f, primary ? Theme.ON_ACCENT : Theme.TEXT, true);
        t.setBackground(primary
                ? Theme.round(Theme.PRIMARY, Theme.R_MD, 0, 0, c)
                : Theme.round(Theme.CARD, Theme.R_MD, Theme.LINE2, 1, c));
        t.setGravity(Gravity.CENTER);
        t.setPadding(Theme.dp(c, 16), Theme.dp(c, 12), Theme.dp(c, 16), Theme.dp(c, 12));
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
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(Theme.dp(c, 40), Theme.dp(c, 22));
        sp.leftMargin = Theme.dp(c, 14);
        sw.setLayoutParams(sp);

        final View track = new View(c);
        track.setTag(Integer.valueOf(Theme.accent()));
        track.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        sw.addView(track);

        final View knob = new View(c);
        FrameLayout.LayoutParams kp = new FrameLayout.LayoutParams(Theme.dp(c, 18), Theme.dp(c, 18));
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
     * 기능 카드. ON 이면 초록 "사용중 · D-N" 칩, EXPIRING 이면 AMBER "만료 임박 · D-N" 칩 + [연장],
     * OFF 면 회색 "미구매" 칩 + [구매하기]. onOpen 이 있으면 카드 전체가 눌린다.
     */
    public static LinearLayout featureCard(Context c, String name, String desc, State st,
                                           long expiresAt, final Runnable onBuy, final Runnable onOpen) {
        return featureCard(c, Theme.GOLD, Icon.SPARK, name, desc, st, expiresAt, onBuy, onOpen);
    }

    /** 기능 카드 (기능 색 · 아이콘 지정판) */
    public static LinearLayout featureCard(Context c, int color, int glyph, String name, String desc, State st,
                                           long expiresAt, final Runnable onBuy, final Runnable onOpen) {
        final State s = (st == null) ? State.OFF : st;
        LinearLayout card = card(c);

        LinearLayout head = row(c);
        head.addView(accentBar(c, color, 16));
        TextView nm = base(c, name, 16f, Theme.TEXT, true);
        nm.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        head.addView(nm);

        long d = daysLeft(expiresAt);
        if (s == State.ON) {
            head.addView(chip(c, expiresAt > 0 ? ("사용 중 · D-" + d) : "사용 중", color));
        } else if (s == State.EXPIRING) {
            head.addView(chip(c, "만료 임박 · D-" + d, Theme.AMBER));
        } else {
            head.addView(chip(c, "미구매", Theme.DIM));
        }
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

        if (s != State.ON) {
            TextView b = btn(c, (s == State.OFF) ? "구매하기" : "연장", s == State.OFF);
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
            bp.topMargin = Theme.dp(c, 14);
            b.setLayoutParams(bp);
            b.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    if (onBuy != null) onBuy.run();
                }
            });
            card.addView(b);
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

    /** 남은 일수 (올림, 음수는 0) */
    public static long daysLeft(long expiresAt) {
        if (expiresAt <= 0) return 0;
        long left = expiresAt - System.currentTimeMillis();
        if (left <= 0) return 0;
        return (left + DAY - 1) / DAY;
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
            setBackground(Theme.round(Theme.CARD, Theme.R_MD, 0, 0, c));
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

    /**
     * 목록 행: 좌 제목 · 우 현재값 · `›`.
     * 값이 비면 `›` 만 남는다. 값은 우측정렬 + 한 줄 + 말줄임이며 행 폭의 절반을 넘지 않는다.
     * onTap 이 있으면 행 전체가 눌린다(누를 때 alpha 0.7).
     *
     * @param valueColor 값 글자색. 0 이면 Theme.SUB. 꺼진 기능은 DIM, 설정이 필요하면 AMBER 를 넘긴다.
     */
    public static LinearLayout navRow(Context c, String title, String value, int valueColor,
                                      final Runnable onTap) {
        NavRow r = new NavRow(c);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setMinimumHeight(Theme.dp(c, ROW_H));
        int ph = Theme.dp(c, ROW_PH);
        int pv = Theme.dp(c, 12);
        r.setPadding(ph, pv, ph, pv);
        r.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        TextView t = base(c, title, 15f, Theme.TEXT, true);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
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

        TextView arrow = base(c, "›", 18f, Theme.DIM, false);
        arrow.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(Theme.dp(c, 16), Theme.dp(c, 20));
        ap.leftMargin = Theme.dp(c, 4);
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

    /** 목록 행 + 왼쪽 기능 아이콘 타일. 어떤 기능의 설정인지 아이콘 색으로 구분된다. */
    public static LinearLayout navRow(Context c, int glyph, int color, String title, String value,
                                      int valueColor, Runnable onTap) {
        LinearLayout r = navRow(c, title, value, valueColor, onTap);
        View bar = accentBar(c, color, 16);
        LinearLayout.LayoutParams tp = (LinearLayout.LayoutParams) bar.getLayoutParams();
        tp.rightMargin = Theme.dp(c, 12);
        r.addView(bar, 0, tp);
        return r;
    }

    /**
     * 두 줄짜리 기능 행: 색 막대 · 이름 · 아래 상태 한 줄 · 오른쪽 칩(없어도 됨) · `›`.
     */
    public static LinearLayout fnRow(Context c, int color, int glyph, String title, String status,
                                     int statusColor, String chipTxt, final Runnable onTap) {
        LinearLayout r = new LinearLayout(c);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setMinimumHeight(Theme.dp(c, 64));
        int ph = Theme.dp(c, ROW_PH);
        r.setPadding(ph, Theme.dp(c, 12), ph, Theme.dp(c, 12));
        r.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        r.addView(accentBar(c, color, 28));

        LinearLayout col = new LinearLayout(c);
        col.setOrientation(LinearLayout.VERTICAL);
        col.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        TextView t = base(c, title, 16f, Theme.TEXT, true);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        col.addView(t);
        if (status != null && status.length() > 0) {
            TextView s = base(c, status, 12.5f, (statusColor == 0) ? Theme.SUB : statusColor, false);
            s.setSingleLine(true);
            s.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(MATCH, WRAP);
            sp.topMargin = Theme.dp(c, 5);
            s.setLayoutParams(sp);
            col.addView(s);
        }
        r.addView(col);

        if (chipTxt != null && chipTxt.length() > 0) {
            TextView ch = chip(c, chipTxt, color);
            LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(WRAP, WRAP);
            cp.leftMargin = Theme.dp(c, 8);
            ch.setLayoutParams(cp);
            r.addView(ch);
        }
        TextView arrow = base(c, "›", 18f, Theme.DIM, false);
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(Theme.dp(c, 16), WRAP);
        ap.leftMargin = Theme.dp(c, 4);
        r.addView(arrow, ap);

        r.setContentDescription(title + ((status == null) ? "" : (", " + status)));
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

    /**
     * 단계 행 (시작 설정): 번호 원(완료면 체크) · 제목 · 설명 · 오른쪽 버튼.
     * current 면 기능 색 테두리로 강조하고 버튼을 채운다.
     */
    public static LinearLayout stepRow(Context c, int no, boolean done, boolean current, boolean optional,
                                       String title, String desc, String btnTxt, final Runnable onTap) {
        LinearLayout root = new LinearLayout(c);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setGravity(Gravity.TOP);
        int p = Theme.dp(c, 16);
        root.setPadding(p, p, p, p);
        root.setBackground(Theme.round(Theme.CARD, Theme.R_MD, current ? Theme.PRIMARY : 0, current ? 1 : 0, c));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.bottomMargin = Theme.dp(c, 10);
        root.setLayoutParams(lp);

        FrameLayout badge = new FrameLayout(c);
        int bs = Theme.dp(c, 30);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(bs, bs);
        bp.rightMargin = Theme.dp(c, 14);
        if (done) {
            badge.setBackground(Theme.round(Theme.fade(Theme.OK, 0.14f), Theme.R_SM, 0, 0, c));
            TextView n = base(c, "✓", 13f, Theme.OK, true);
            n.setGravity(Gravity.CENTER);
            badge.addView(n, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        } else {
            badge.setBackground(Theme.round(Theme.CARD2, Theme.R_SM, 0, 0, c));
            TextView n = base(c, String.valueOf(no), 13f, current ? Theme.PRIMARY : Theme.SUB, true);
            n.setGravity(Gravity.CENTER);
            badge.addView(n, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        }
        root.addView(badge, bp);

        LinearLayout body = new LinearLayout(c);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        LinearLayout head = row(c);
        TextView t = base(c, title, 15f, done ? Theme.SUB : Theme.TEXT, true);
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        head.addView(t);
        String chipTxt = done ? "완료" : (optional ? "권장" : "필요");
        head.addView(badge(c, chipTxt, done ? Theme.OK : (optional ? Theme.SUB : Theme.AMBER)));
        body.addView(head);
        if (desc != null && desc.length() > 0) {
            TextView d = base(c, desc, 12.5f, Theme.SUB, false);
            d.setLineSpacing(0, 1.4f);
            LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
            dp.topMargin = Theme.dp(c, 5);
            d.setLayoutParams(dp);
            body.addView(d);
        }
        if (btnTxt != null && btnTxt.length() > 0 && onTap != null) {
            TextView b = btn(c, btnTxt, current && !done);
            b.setPadding(Theme.dp(c, 16), Theme.dp(c, 11), Theme.dp(c, 16), Theme.dp(c, 11));
            b.setMinimumHeight(Theme.dp(c, 44));
            LinearLayout.LayoutParams bbp = new LinearLayout.LayoutParams(WRAP, WRAP);
            bbp.topMargin = Theme.dp(c, 12);
            b.setLayoutParams(bbp);
            b.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    try { onTap.run(); } catch (Throwable t2) { Log.add(v.getContext(), "설정 열기 실패: " + t2); }
                }
            });
            body.addView(b);
        }
        root.addView(body);
        return root;
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

    /** checkRow 의 체크박스. 켜짐=만들 때의 Theme.accent() 채움+체크, 꺼짐=LINE2 보더. 직접 그린다(위젯 의존 없음). */
    public static final class Check extends View {
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path tick = new Path();
        private final float radius;
        private final float border;
        private final float stroke;
        private final int color = Theme.PRIMARY;
        private boolean on;

        Check(Context c, boolean on) {
            super(c);
            this.on = on;
            radius = Theme.dp(c, 2);
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
                paint.setColor(color);
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

    /** 작은 배지 (11sp, 4dp). `단체` / `1:1` 처럼 두세 글자만 넣는다. */
    public static TextView badge(Context c, String text, int color) {
        int col = (color == 0) ? Theme.SUB : color;
        TextView t = base(c, text, 11f, col, true);
        t.setBackground(Theme.round(Theme.fade(col, 0.10f), Theme.R_SM, 0, 0, c));
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
            TextView b = base(c, action, 13f, Theme.PRIMARY, true);
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
                w.setBackgroundDrawable(Theme.round(Theme.CARD, Theme.R_XL, 0, 0, c));
            }
            View mv = d.findViewById(android.R.id.message);
            if (mv instanceof TextView) {
                TextView m = (TextView) mv;
                m.setTextColor(Theme.SUB);
                m.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
                m.setLineSpacing(0, 1.45f);
            }
            styleDialogBtn(d.getButton(AlertDialog.BUTTON_POSITIVE), Theme.PRIMARY, true);
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
        track.setBackground(on ? Theme.pill(Theme.PRIMARY, 0, c) : Theme.pill(Theme.LINE2, 0, c));
        knob.setBackground(Theme.circle(0xFFFFFFFF, c));
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
        t.setTypeface(bold ? Typeface.create("sans-serif", Typeface.BOLD) : Typeface.SANS_SERIF);
        t.setIncludeFontPadding(false);
        t.setLineSpacing(0, 1.35f);
        return t;
    }
}
