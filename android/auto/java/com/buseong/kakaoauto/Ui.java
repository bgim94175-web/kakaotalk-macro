package com.buseong.kakaoauto;

import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
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
 * 원칙
 *  - 한 화면에 카드 4~6개 이하. 카드 안에서 접어라.
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
                : Theme.round(0x00000000, Theme.R_MD, Theme.LINE2, 1, c));
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
     * 기능 카드. ON 이면 초록 "사용중 · D-N" 칩, EXPIRING 이면 AMBER "만료 임박 · D-N" 칩 + [연장],
     * OFF 면 회색 "미구매" 칩 + [구매하기]. onOpen 이 있으면 카드 전체가 눌린다.
     */
    public static LinearLayout featureCard(Context c, String name, String desc, State st,
                                           long expiresAt, final Runnable onBuy, final Runnable onOpen) {
        final State s = (st == null) ? State.OFF : st;
        LinearLayout card = card(c);

        LinearLayout head = row(c);
        TextView nm = base(c, name, 17f, Theme.TEXT, true);
        nm.setLetterSpacing(-0.01f);
        nm.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        head.addView(nm);

        long d = daysLeft(expiresAt);
        if (s == State.ON) {
            head.addView(chip(c, expiresAt > 0 ? ("사용중 · D-" + d) : "사용중", Theme.ACCENT));
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
