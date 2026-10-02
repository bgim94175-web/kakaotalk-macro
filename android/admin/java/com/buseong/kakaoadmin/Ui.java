package com.buseong.kakaoadmin;

import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
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
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 뷰 조립기. 사용자앱(KakaoAuto)의 Ui 와 같은 토큰·같은 모양을 쓴다.
 * 다른 점은 primary 버튼/선택 상태가 Theme.PRIMARY(바이올렛) 라는 것뿐.
 * XML 레이아웃도, 외부 라이브러리도 안 쓴다.
 *
 * 관리자앱이라 목록 밀도는 사용자앱보다 높다 — listCard() / chipSm() / kvTight() 를 쓴다.
 * 그래도 여백(좌우 20dp)과 정렬은 지킨다.
 */
public final class Ui {
    private Ui() {}

    /** 토글 콜백 */
    public interface OnToggle { void on(boolean v); }

    /** 세그먼트 선택 콜백 */
    public interface OnPick { void pick(int index); }

    /** 입력 다이얼로그 콜백 */
    public interface OnText { void text(String s); }

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;
    private static final long DAY = 86400000L;

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

    /** 아주 작은 보조 12sp DIM */
    public static TextView hint(Context c, String s) {
        TextView t = base(c, s, 12f, Theme.DIM, false);
        t.setLineSpacing(0, 1.35f);
        return t;
    }

    /** 키·해시처럼 고정폭이 필요한 값 (선택 가능한 박스) */
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

    /** 목록용 한 줄 모노스페이스. 길면 가운데를 … 로 줄인다. 배경 없음. */
    public static TextView monoLine(Context c, String s, float sizeSp, int color) {
        TextView t = new TextView(c);
        t.setText(s == null ? "" : s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeSp);
        t.setTextColor(color);
        t.setTypeface(Typeface.MONOSPACE);
        t.setLetterSpacing(0.02f);
        t.setIncludeFontPadding(false);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        return t;
    }

    /** 큰 키 표시 (승인 결과 등) — 크게, 복사하기 쉽게 */
    public static TextView monoBig(Context c, String s) {
        TextView t = new TextView(c);
        t.setText(s == null ? "" : s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 19f);
        t.setTextColor(Theme.PRIMARY);
        t.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        t.setLetterSpacing(0.04f);
        t.setGravity(Gravity.CENTER);
        t.setBackground(Theme.round(Theme.fade(Theme.PRIMARY, 0.10f), Theme.R_MD,
                Theme.fade(Theme.PRIMARY, 0.28f), 1, c));
        t.setPadding(Theme.dp(c, 12), Theme.dp(c, 16), Theme.dp(c, 12), Theme.dp(c, 16));
        try { t.setTextIsSelectable(true); } catch (Throwable ignore) { }
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

    /** 카드. 패딩 16dp + R_LG + LINE 보더. 아래 12dp 간격. */
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

    /** 목록용 카드 — 카드보다 좁은 패딩/반경. 정보가 많은 행에 쓴다. */
    public static LinearLayout listCard(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackground(Theme.round(Theme.CARD, Theme.R_MD, Theme.LINE, 1, c));
        int ph = Theme.dp(c, 14);
        int pv = Theme.dp(c, 12);
        l.setPadding(ph, pv, ph, pv);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.bottomMargin = Theme.dp(c, 8);
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

    /** 세로 컨테이너 (빈 껍데기) */
    public static LinearLayout col(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
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

    /** 남는 공간을 먹는 빈칸 (가로 줄에서 오른쪽으로 밀 때) */
    public static View grow(Context c) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(0, Theme.dp(c, 1), 1f));
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

    /** 얇은 구분선 (여백 작게 — 목록 안) */
    public static View dividerTight(Context c) {
        View v = new View(c);
        v.setBackgroundColor(Theme.LINE);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, Math.max(1, Theme.dp(c, 1)));
        lp.topMargin = Theme.dp(c, 8);
        lp.bottomMargin = Theme.dp(c, 8);
        v.setLayoutParams(lp);
        return v;
    }

    /** 구역 머리말: 작은 라벨 + 제목 */
    public static LinearLayout sectionHeader(Context c, String labelTxt, String titleTxt) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(c, 18);
        lp.bottomMargin = Theme.dp(c, 12);
        l.setLayoutParams(lp);
        if (labelTxt != null && labelTxt.length() > 0) l.addView(label(c, labelTxt));
        if (titleTxt != null && titleTxt.length() > 0) {
            TextView t = base(c, titleTxt, 18f, Theme.TEXT, true);
            t.setLetterSpacing(-0.01f);
            LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(MATCH, WRAP);
            tp.topMargin = Theme.dp(c, 5);
            t.setLayoutParams(tp);
            l.addView(t);
        }
        return l;
    }

    /** 좌 라벨 · 우 값 한 줄 */
    public static LinearLayout kv(Context c, String k, String v) {
        return kvInner(c, k, v, Theme.dp(c, 7), Theme.TEXT, false);
    }

    /** kv 지만 여백이 좁다 (상세 시트에서 항목이 많을 때) */
    public static LinearLayout kvTight(Context c, String k, String v) {
        return kvInner(c, k, v, Theme.dp(c, 5), Theme.TEXT, false);
    }

    /** kv 인데 값에 색을 준다 */
    public static LinearLayout kvColor(Context c, String k, String v, int color) {
        return kvInner(c, k, v, Theme.dp(c, 5), color, true);
    }

    private static LinearLayout kvInner(Context c, String k, String v, int pv, int color, boolean bold) {
        LinearLayout r = new LinearLayout(c);
        r.setOrientation(LinearLayout.HORIZONTAL);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setPadding(0, pv, 0, pv);
        r.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        TextView kt = base(c, k, 13f, Theme.SUB, false);
        kt.setLayoutParams(new LinearLayout.LayoutParams(WRAP, WRAP));
        r.addView(kt);

        TextView vt = base(c, v, 14f, color, bold);
        vt.setGravity(Gravity.END);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(0, WRAP, 1f);
        vp.leftMargin = Theme.dp(c, 12);
        vt.setLayoutParams(vp);
        r.addView(vt);
        return r;
    }

    /** 값이 길어서 한 줄에 못 들어가는 항목 (라벨 위 / 값 아래) */
    public static LinearLayout kvStack(Context c, String k, String v) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        int pv = Theme.dp(c, 5);
        l.setPadding(0, pv, 0, pv);
        l.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        l.addView(base(c, k, 12f, Theme.SUB, false));
        TextView vt = base(c, v, 13.5f, Theme.TEXT, false);
        vt.setLineSpacing(0, 1.35f);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(MATCH, WRAP);
        vp.topMargin = Theme.dp(c, 2);
        vt.setLayoutParams(vp);
        l.addView(vt);
        return l;
    }

    /** 비어있음 안내 박스 */
    public static LinearLayout emptyBox(Context c, String msg) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER);
        l.setBackground(Theme.round(Theme.BG2, Theme.R_MD, Theme.LINE, 1, c));
        int p = Theme.dp(c, 24);
        l.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(c, 4);
        lp.bottomMargin = Theme.dp(c, 8);
        l.setLayoutParams(lp);
        TextView t = base(c, msg, 13.5f, Theme.DIM, false);
        t.setGravity(Gravity.CENTER);
        t.setLineSpacing(0, 1.4f);
        l.addView(t);
        return l;
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

    /** 작은 칩 — 목록 안에서 여러 개 나란히 놓을 때 */
    public static TextView chipSm(Context c, String text, int color) {
        TextView t = base(c, text, 11f, color, true);
        t.setBackground(Theme.pill(Theme.fade(color, 0.12f), Theme.fade(color, 0.22f), c));
        t.setPadding(Theme.dp(c, 8), Theme.dp(c, 4), Theme.dp(c, 8), Theme.dp(c, 4));
        t.setGravity(Gravity.CENTER);
        t.setSingleLine(true);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(WRAP, WRAP);
        lp.rightMargin = Theme.dp(c, 5);
        t.setLayoutParams(lp);
        return t;
    }

    /** 버튼. primary 면 PRIMARY(바이올렛) 채움, 아니면 투명 + 보더. 높이 48dp. */
    public static TextView btn(Context c, String s, boolean primary) {
        TextView t = base(c, s, 14f, primary ? Theme.ON_PRIMARY : Theme.TEXT, primary);
        t.setBackground(primary
                ? Theme.round(Theme.PRIMARY, Theme.R_MD, 0, 0, c)
                : Theme.round(Theme.TRANSPARENT, Theme.R_MD, Theme.LINE2, 1, c));
        t.setGravity(Gravity.CENTER);
        t.setPadding(Theme.dp(c, 18), Theme.dp(c, 14), Theme.dp(c, 18), Theme.dp(c, 14));
        t.setMinimumHeight(Theme.dp(c, 48));
        t.setClickable(true);
        t.setFocusable(true);
        press(t);
        return t;
    }

    /** 위험한 동작용 버튼 (빨강 보더 + 빨강 글자) */
    public static TextView btnDanger(Context c, String s) {
        TextView t = base(c, s, 14f, Theme.RED, true);
        t.setBackground(Theme.round(Theme.fade(Theme.RED, 0.10f), Theme.R_MD, Theme.fade(Theme.RED, 0.35f), 1, c));
        t.setGravity(Gravity.CENTER);
        t.setPadding(Theme.dp(c, 18), Theme.dp(c, 14), Theme.dp(c, 18), Theme.dp(c, 14));
        t.setMinimumHeight(Theme.dp(c, 48));
        t.setClickable(true);
        t.setFocusable(true);
        press(t);
        return t;
    }

    /** 작고 납작한 버튼 (목록 행 안의 [승인]/[취소] 같은 것). color 톤으로 칠한다. */
    public static TextView btnSm(Context c, String s, int color, boolean filled) {
        TextView t = base(c, s, 13f, filled ? Theme.ON_PRIMARY : color, true);
        t.setBackground(filled
                ? Theme.pill(color, 0, c)
                : Theme.pill(Theme.fade(color, 0.12f), Theme.fade(color, 0.30f), c));
        t.setGravity(Gravity.CENTER);
        t.setPadding(Theme.dp(c, 16), Theme.dp(c, 9), Theme.dp(c, 16), Theme.dp(c, 9));
        t.setMinimumHeight(Theme.dp(c, 36));
        t.setSingleLine(true);
        t.setClickable(true);
        t.setFocusable(true);
        press(t);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(WRAP, WRAP);
        lp.rightMargin = Theme.dp(c, 8);
        t.setLayoutParams(lp);
        return t;
    }

    /** 입력칸 */
    public static EditText field(Context c, String hintTxt) {
        EditText e = new EditText(c);
        e.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
        e.setTextColor(Theme.TEXT);
        e.setHintTextColor(Theme.DIM);
        if (hintTxt != null) e.setHint(hintTxt);
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

    /** 숫자 입력칸 */
    public static EditText numField(Context c, String hintTxt) {
        EditText e = field(c, hintTxt);
        e.setInputType(InputType.TYPE_CLASS_NUMBER);
        e.setSingleLine(true);
        e.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        return e;
    }

    /** 비밀번호 입력칸 */
    public static EditText pwField(Context c, String hintTxt) {
        EditText e = field(c, hintTxt);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        e.setSingleLine(true);
        e.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        e.setTypeface(Typeface.MONOSPACE);
        return e;
    }

    /** 한 줄 입력칸 (검색·키 등) */
    public static EditText lineField(Context c, String hintTxt) {
        EditText e = field(c, hintTxt);
        e.setSingleLine(true);
        e.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        return e;
    }

    /**
     * 세그먼트 선택. 항목이 4개 이하면 폭을 나눠 채우고, 많으면 좌우로 스크롤된다.
     * 선택은 뷰 태그(Integer)에 들어있다 → segmentIndex(view)
     */
    public static View segment(Context c, final String[] labels, int selected, final OnPick cb) {
        final LinearLayout inner = new LinearLayout(c);
        inner.setOrientation(LinearLayout.HORIZONTAL);
        inner.setGravity(Gravity.CENTER_VERTICAL);
        int pad = Theme.dp(c, 4);
        inner.setPadding(pad, pad, pad, pad);
        inner.setBackground(Theme.pill(Theme.BG2, Theme.LINE, c));

        final int n = (labels == null) ? 0 : labels.length;
        final boolean fill = n > 0 && n <= 4;
        final int[] cur = new int[] { Math.max(0, Math.min(selected, Math.max(0, n - 1))) };

        for (int i = 0; i < n; i++) {
            final int idx = i;
            TextView t = base(c, labels[i], 13f, Theme.SUB, true);
            t.setGravity(Gravity.CENTER);
            t.setSingleLine(true);
            t.setPadding(Theme.dp(c, 14), Theme.dp(c, 9), Theme.dp(c, 14), Theme.dp(c, 9));
            t.setClickable(true);
            t.setFocusable(true);
            LinearLayout.LayoutParams lp = fill
                    ? new LinearLayout.LayoutParams(0, WRAP, 1f)
                    : new LinearLayout.LayoutParams(WRAP, WRAP);
            t.setLayoutParams(lp);
            t.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    if (cur[0] == idx) return;
                    cur[0] = idx;
                    paintSegment(inner, idx);
                    if (cb != null) {
                        try { cb.pick(idx); }
                        catch (Throwable e) { App.log(v.getContext(), "세그먼트 처리 실패: " + e); }
                    }
                }
            });
            inner.addView(t);
        }
        paintSegment(inner, cur[0]);

        if (fill) {
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
            inner.setLayoutParams(lp);
            return inner;
        }
        HorizontalScrollView hs = new HorizontalScrollView(c);
        hs.setHorizontalScrollBarEnabled(false);
        hs.addView(inner, new FrameLayout.LayoutParams(WRAP, WRAP));
        hs.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        return hs;
    }

    /** 세그먼트를 코드로 다시 칠한다 (콜백 없음). segment() 가 돌려준 뷰를 넣어라. */
    public static void setSegment(View segmentView, int index) {
        LinearLayout inner = segmentInner(segmentView);
        if (inner != null) paintSegment(inner, index);
    }

    /** 현재 선택된 세그먼트 번호 (못 찾으면 0) */
    public static int segmentIndex(View segmentView) {
        LinearLayout inner = segmentInner(segmentView);
        if (inner == null) return 0;
        Object t = inner.getTag();
        return (t instanceof Integer) ? ((Integer) t).intValue() : 0;
    }

    private static LinearLayout segmentInner(View v) {
        if (v instanceof LinearLayout) return (LinearLayout) v;
        if (v instanceof HorizontalScrollView && ((HorizontalScrollView) v).getChildCount() > 0) {
            View ch = ((HorizontalScrollView) v).getChildAt(0);
            if (ch instanceof LinearLayout) return (LinearLayout) ch;
        }
        return null;
    }

    private static void paintSegment(LinearLayout inner, int sel) {
        inner.setTag(Integer.valueOf(sel));
        Context c = inner.getContext();
        for (int i = 0; i < inner.getChildCount(); i++) {
            View v = inner.getChildAt(i);
            if (!(v instanceof TextView)) continue;
            TextView t = (TextView) v;
            boolean on = (i == sel);
            t.setTextColor(on ? Theme.PRIMARY : Theme.SUB);
            t.setBackground(on
                    ? Theme.pill(Theme.fade(Theme.PRIMARY, 0.16f), Theme.fade(Theme.PRIMARY, 0.30f), c)
                    : null);
        }
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
                    try { cb.on(now); } catch (Throwable t) { App.log(v.getContext(), "설정 적용 실패: " + t); }
                }
            }
        });
        return root;
    }

    /**
     * 체크박스 줄 (기능 다중선택용). 상태는 태그(Boolean) → isOn(view)
     */
    public static LinearLayout checkRow(Context c, String titleTxt, String desc, boolean on, final OnToggle cb) {
        final LinearLayout root = new LinearLayout(c);
        root.setOrientation(LinearLayout.HORIZONTAL);
        root.setGravity(Gravity.CENTER_VERTICAL);
        int pv = Theme.dp(c, 10);
        root.setPadding(0, pv, 0, pv);
        root.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        final TextView box = base(c, "", 13f, Theme.ON_PRIMARY, true);
        box.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(Theme.dp(c, 22), Theme.dp(c, 22));
        bp.rightMargin = Theme.dp(c, 12);
        box.setLayoutParams(bp);
        root.addView(box);

        LinearLayout right = new LinearLayout(c);
        right.setOrientation(LinearLayout.VERTICAL);
        right.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        right.addView(base(c, titleTxt, 14.5f, Theme.TEXT, true));
        if (desc != null && desc.length() > 0) {
            TextView dv = base(c, desc, 12f, Theme.SUB, false);
            dv.setLineSpacing(0, 1.3f);
            LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
            dp.topMargin = Theme.dp(c, 2);
            dv.setLayoutParams(dp);
            right.addView(dv);
        }
        root.addView(right);

        paintCheck(c, box, on);
        root.setTag(Boolean.valueOf(on));
        root.setClickable(true);
        root.setFocusable(true);
        root.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                boolean now = !isOn(root);
                root.setTag(Boolean.valueOf(now));
                paintCheck(v.getContext(), box, now);
                if (cb != null) {
                    try { cb.on(now); } catch (Throwable t) { App.log(v.getContext(), "선택 처리 실패: " + t); }
                }
            }
        });
        return root;
    }

    /** switchRow / checkRow 의 현재 상태 */
    public static boolean isOn(View v) {
        Object t = (v == null) ? null : v.getTag();
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

    /** 통계 요약 타일. 가로 줄에 weight 1 로 들어간다. */
    public static LinearLayout statTile(Context c, String labelTxt, String value, int color) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER_HORIZONTAL);
        l.setBackground(Theme.round(Theme.CARD, Theme.R_MD, Theme.LINE, 1, c));
        int pv = Theme.dp(c, 10);
        l.setPadding(Theme.dp(c, 6), pv, Theme.dp(c, 6), pv);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, WRAP, 1f);
        lp.rightMargin = Theme.dp(c, 6);
        l.setLayoutParams(lp);

        TextView v = base(c, value, 18f, color, true);
        v.setGravity(Gravity.CENTER);
        v.setSingleLine(true);
        v.setLetterSpacing(-0.02f);
        l.addView(v);

        TextView t = base(c, labelTxt, 10.5f, Theme.SUB, false);
        t.setGravity(Gravity.CENTER);
        t.setSingleLine(true);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(MATCH, WRAP);
        tp.topMargin = Theme.dp(c, 3);
        t.setLayoutParams(tp);
        l.addView(t);
        return l;
    }

    /** 하단 탭 버튼 */
    public static LinearLayout tabButton(Context c, String labelTxt, boolean active) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER);
        l.setPadding(0, Theme.dp(c, 9), 0, Theme.dp(c, 9));
        l.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        l.setClickable(true);
        l.setFocusable(true);

        View dot = new View(c);
        LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(Theme.dp(c, 5), Theme.dp(c, 5));
        dp.bottomMargin = Theme.dp(c, 5);
        dot.setLayoutParams(dp);
        dot.setBackground(Theme.circle(active ? Theme.PRIMARY : Theme.TRANSPARENT, c));
        l.addView(dot);

        TextView t = base(c, labelTxt, 12.5f, active ? Theme.TEXT : Theme.DIM, active);
        t.setGravity(Gravity.CENTER);
        l.addView(t);
        return l;
    }

    /**
     * 감사기록 종류 색 — 경보 종류(Api.isAlertKind: mismatch/takeover/bad_sig/tamper/
     * bad_deposit_token/bad_admin_pw · 서버 alert_kinds 우선) = RED,
     * activate = ACCENT, reset/order = AMBER, 나머지 SUB.
     */
    public static int auditColor(String kind) {
        String k = (kind == null) ? "" : kind;
        // 경보 목록은 Api 한 곳에서만 정한다 — 서버가 내려준 alert_kinds 가 있으면 그게 우선이고
        // (그래서 bad_admin_pw 처럼 새로 생긴 종류도 앱을 안 고쳐도 붉게 뜬다),
        // 없으면 Api 의 하드코딩 폴백을 쓴다.
        if (Api.isAlertKind(k)) return Theme.RED;
        if (k.equals("activate")) return Theme.ACCENT;
        if (k.equals("reset") || k.equals("order")) return Theme.AMBER;
        return Theme.SUB;
    }

    // ── 알림 / 다이얼로그 ─────────────────────────────────────────────────────

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

    /** 클립보드 복사 + 토스트. 실패하면 로그에 남긴다. */
    public static void copy(Context c, String what, String text) {
        if (c == null || text == null) return;
        try {
            ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) throw new IllegalStateException("클립보드 서비스 없음");
            cm.setPrimaryClip(ClipData.newPlainText(what == null ? "복사" : what, text));
            toast(c, (what == null ? "" : what + " ") + "복사되었습니다");
        } catch (Throwable t) {
            App.log(c, "복사 실패: " + t);
            toast(c, "복사에 실패했습니다");
        }
    }

    /** 다크 다이얼로그 빌더. res/values/styles.xml 의 AppDialog 스타일을 쓴다(없으면 기본 다크). */
    public static AlertDialog.Builder dialog(Context c, String titleTxt) {
        AlertDialog.Builder b = new AlertDialog.Builder(c, dialogStyle(c));
        if (titleTxt != null && titleTxt.length() > 0) {
            TextView t = base(c, titleTxt, 18f, Theme.TEXT, true);
            t.setLetterSpacing(-0.01f);
            int ph = Theme.dp(c, 22);
            t.setPadding(ph, Theme.dp(c, 22), ph, Theme.dp(c, 6));
            b.setCustomTitle(t);
        }
        return b;
    }

    private static int dialogStyle(Context c) {
        try {
            int id = c.getResources().getIdentifier("AppDialog", "style", c.getPackageName());
            if (id != 0) return id;
        } catch (Throwable ignore) { }
        return android.R.style.Theme_Material_Dialog_Alert;
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
            styleDialogBtn(d.getButton(AlertDialog.BUTTON_POSITIVE), Theme.PRIMARY, true);
            styleDialogBtn(d.getButton(AlertDialog.BUTTON_NEGATIVE), Theme.SUB, false);
            styleDialogBtn(d.getButton(AlertDialog.BUTTON_NEUTRAL), Theme.SUB, false);
        } catch (Throwable t) {
            // 모양만 못 입힌 거니까 넘어간다
        }
        return d;
    }

    /** 다이얼로그 본문으로 쓸 스크롤 컨테이너 (좌우 22dp 패딩) */
    public static ScrollView dialogBody(Context c, View content) {
        ScrollView s = new ScrollView(c);
        s.setVerticalScrollBarEnabled(false);
        int ph = Theme.dp(c, 22);
        s.setPadding(ph, Theme.dp(c, 6), ph, Theme.dp(c, 10));
        if (content != null) {
            s.addView(content, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        }
        return s;
    }

    /**
     * 확인 다이얼로그. danger 면 확인 글자가 빨갛다.
     * 위험한 동작(삭제/회수/차단)은 **반드시** 이걸 거쳐라.
     */
    public static void confirm(Context c, String titleTxt, String msg, String okLabel,
                               final boolean danger, final Runnable onOk) {
        AlertDialog.Builder b = dialog(c, titleTxt);
        b.setMessage(msg == null ? "" : msg);
        b.setNegativeButton("취소", null);
        b.setPositiveButton(okLabel == null ? "확인" : okLabel, new android.content.DialogInterface.OnClickListener() {
            @Override public void onClick(android.content.DialogInterface d, int w) {
                if (onOk != null) onOk.run();
            }
        });
        AlertDialog d = showDark(b);
        if (danger && d != null) styleDialogBtn(d.getButton(AlertDialog.BUTTON_POSITIVE), Theme.RED, true);
    }

    /** 한 줄(또는 여러 줄) 입력 다이얼로그 */
    public static void input(Context c, String titleTxt, String hintTxt, String preset,
                             boolean multiline, final OnText cb) {
        final EditText e = multiline ? field(c, hintTxt) : lineField(c, hintTxt);
        if (multiline) e.setMinLines(3);
        if (preset != null) {
            e.setText(preset);
            try { e.setSelection(preset.length()); } catch (Throwable ignore) { }
        }
        LinearLayout box = col(c);
        box.addView(e);
        AlertDialog.Builder b = dialog(c, titleTxt);
        b.setView(dialogBody(c, box));
        b.setNegativeButton("취소", null);
        b.setPositiveButton("확인", new android.content.DialogInterface.OnClickListener() {
            @Override public void onClick(android.content.DialogInterface d, int w) {
                if (cb != null) cb.text(e.getText() == null ? "" : e.getText().toString().trim());
            }
        });
        showDark(b);
    }

    /** 긴 글 보여주기 (로그·크래시·원문) */
    public static void showText(Context c, String titleTxt, String text) {
        LinearLayout box = col(c);
        TextView t = new TextView(c);
        t.setText((text == null || text.length() == 0) ? "(내용 없음)" : text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11.5f);
        t.setTextColor(Theme.SUB);
        t.setTypeface(Typeface.MONOSPACE);
        t.setLineSpacing(0, 1.35f);
        try { t.setTextIsSelectable(true); } catch (Throwable ignore) { }
        box.addView(t);

        final String copyText = text;
        AlertDialog.Builder b = dialog(c, titleTxt);
        b.setView(dialogBody(c, box));
        b.setNegativeButton("닫기", null);
        final Context cc = c;
        b.setPositiveButton("복사", new android.content.DialogInterface.OnClickListener() {
            @Override public void onClick(android.content.DialogInterface d, int w) {
                copy(cc, titleTxt, copyText == null ? "" : copyText);
            }
        });
        showDark(b);
    }

    // ── 값 서식 ───────────────────────────────────────────────────────────────

    /** 남은 일수 (올림, 음수는 0) */
    public static long daysLeft(long expiresAt) {
        if (expiresAt <= 0) return 0;
        long left = expiresAt - System.currentTimeMillis();
        if (left <= 0) return 0;
        return (left + DAY - 1) / DAY;
    }

    /** MM/dd HH:mm */
    public static String fmtMin(long ms) { return fmt(ms, "MM/dd HH:mm"); }

    /** MM/dd HH:mm:ss (감사기록) */
    public static String fmtSec(long ms) { return fmt(ms, "MM/dd HH:mm:ss"); }

    /** yyyy-MM-dd HH:mm */
    public static String fmtFull(long ms) { return fmt(ms, "yyyy-MM-dd HH:mm"); }

    /** yyyy-MM-dd */
    public static String fmtDay(long ms) { return fmt(ms, "yyyy-MM-dd"); }

    public static String fmt(long ms, String pattern) {
        if (ms <= 0) return "-";
        try {
            return new SimpleDateFormat(pattern, Locale.KOREA).format(new Date(ms));
        } catch (Throwable t) {
            return String.valueOf(ms);
        }
    }

    /** 1234567 → "1,234,567" */
    public static String num(long v) {
        boolean neg = v < 0;
        String s = Long.toString(Math.abs(v));
        StringBuilder sb = new StringBuilder();
        int cnt = 0;
        for (int i = s.length() - 1; i >= 0; i--) {
            sb.append(s.charAt(i));
            if (++cnt % 3 == 0 && i > 0) sb.append(',');
        }
        if (neg) sb.append('-');
        return sb.reverse().toString();
    }

    /** 39047 → "39,047원" */
    public static String won(long v) { return num(v) + "원"; }

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
        track.setBackground(Theme.pill(on ? Theme.PRIMARY : Theme.LINE2, 0, c));
        knob.setBackground(Theme.circle(on ? Theme.TEXT : Theme.SUB, c));
        ViewGroup.LayoutParams p = knob.getLayoutParams();
        if (p instanceof FrameLayout.LayoutParams) {
            FrameLayout.LayoutParams fp = (FrameLayout.LayoutParams) p;
            fp.gravity = Gravity.CENTER_VERTICAL | (on ? Gravity.END : Gravity.START);
            knob.setLayoutParams(fp);
        }
    }

    private static void paintCheck(Context c, TextView box, boolean on) {
        if (box == null) return;
        box.setText(on ? "✓" : "");
        box.setBackground(on
                ? Theme.round(Theme.PRIMARY, Theme.R_XS, 0, 0, c)
                : Theme.round(Theme.TRANSPARENT, Theme.R_XS, Theme.LINE2, 1, c));
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
