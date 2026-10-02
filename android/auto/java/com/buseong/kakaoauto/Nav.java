package com.buseong.kakaoauto;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.net.Uri;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 하단 탭바 + 화면 전환 + 서브화면 스택, 그리고 화면들이 같이 쓰는 조립 도우미.
 *
 * 화면 규약: 각 화면은 {@code static View build(MainActivity)} 로 뷰를 만들고,
 * 값이 바뀌어 다시 그려야 하면 {@code static void refresh()} 를 제공한다.
 * 탭 전환은 컨테이너를 비우고 새로 만든 뷰를 꽂는다 → 스크롤 위치는 자동으로 맨 위.
 *
 * 설정 상세는 {@link #push(MainActivity, String, View)} 로 서브화면을 연다 (UI_V3 2장).
 * 서브화면에서는 탭바가 숨고 상단에 {@code ‹ 제목} 바가 붙는다. 뒤로가기 키는
 * MainActivity.onBackPressed → {@link #pop()} 순서로 처리된다.
 *
 * 색·여백은 전부 Theme/Ui 에서 가져온다. 여기 말고 화면 코드에 숫자를 박지 마라.
 */
public final class Nav {
    private Nav() {}

    // ── 탭 ────────────────────────────────────────────────────────────────────

    public static final int HOME = 0;
    public static final int MACRO = 1;
    public static final int BOT = 2;
    public static final int ACCOUNT = 3;

    private static final String[] TAB_NAMES = { "홈", "매크로", "봇", "내정보" };

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private static int cur = HOME;
    private static WeakReference<MainActivity> ACT;
    private static WeakReference<ViewGroup> HOST;
    private static WeakReference<LinearLayout> BAR;
    private static WeakReference<View> BAR_ROOT;

    /** 올라가 있는 서브화면들 (아래 → 위). 비어있으면 탭 화면을 보고 있는 것이다. */
    private static final ArrayList<View> SUBS = new ArrayList<View>();

    /** 같은 행을 빠르게 두 번 눌러 같은 서브화면이 두 장 쌓이는 것을 막는 디바운스 창 */
    private static final long PUSH_DEBOUNCE_MS = 300L;
    private static long lastPushAt = 0L;

    /** 지금 보고 있는 탭 */
    public static int current() { return cur; }

    /**
     * 탭바를 만들고 화면 컨테이너를 기억한다. MainActivity 가 인증 통과 후 한 번 부른다.
     * 돌려준 뷰를 화면 맨 아래에 붙여라.
     */
    public static LinearLayout buildBar(MainActivity a, ViewGroup contentHost) {
        ACT = new WeakReference<MainActivity>(a);
        HOST = new WeakReference<ViewGroup>(contentHost);

        LinearLayout barRoot = new LinearLayout(a);
        barRoot.setOrientation(LinearLayout.VERTICAL);
        barRoot.setBackgroundColor(Theme.CARD);

        View top = new View(a);
        top.setBackgroundColor(Theme.LINE);
        barRoot.addView(top, new LinearLayout.LayoutParams(MATCH, Math.max(1, Theme.dp(a, 1))));

        LinearLayout row = new LinearLayout(a);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setPadding(0, Theme.dp(a, 6), 0, Theme.dp(a, 8));
        barRoot.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));

        for (int i = 0; i < TAB_NAMES.length; i++) {
            final int idx = i;
            LinearLayout item = new LinearLayout(a);
            item.setOrientation(LinearLayout.VERTICAL);
            item.setGravity(Gravity.CENTER);
            item.setMinimumHeight(Theme.dp(a, 48));
            item.setClickable(true);
            item.setFocusable(true);
            Ui.press(item);

            TextView name = new TextView(a);
            name.setText(TAB_NAMES[i]);
            name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
            name.setIncludeFontPadding(false);
            name.setGravity(Gravity.CENTER);
            item.addView(name, new LinearLayout.LayoutParams(WRAP, WRAP));

            View dot = new View(a);
            LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(Theme.dp(a, 4), Theme.dp(a, 4));
            dp.topMargin = Theme.dp(a, 5);
            item.addView(dot, dp);

            item.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { go(idx); }
            });

            LinearLayout.LayoutParams ip = new LinearLayout.LayoutParams(0, WRAP, 1f);
            row.addView(item, ip);
        }

        BAR = new WeakReference<LinearLayout>(row);
        BAR_ROOT = new WeakReference<View>(barRoot);
        SUBS.clear();           // 셸을 다시 만들면 예전 서브화면은 이미 사라졌다
        barRoot.setVisibility(View.VISIBLE);
        paintBar();
        return barRoot;
    }

    /** 탭 이동. 같은 탭을 다시 눌러도 새로 그린다(맨 위로 올라간다). */
    public static void go(int tab) {
        MainActivity a = act();
        ViewGroup host = host();
        if (a == null || host == null) return;
        if (tab < 0 || tab > ACCOUNT) tab = HOME;
        cur = tab;
        SUBS.clear();           // 탭을 옮기면 서브화면 스택은 초기화된다
        setBarVisible(true);
        paintBar();

        View v;
        try {
            v = screen(a, tab);
        } catch (Throwable t) {
            Log.add(a, "화면 구성 실패 (" + TAB_NAMES[tab] + "): " + t);
            v = crashView(a, t);
        }
        try {
            host.removeAllViews();
            host.addView(v, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        } catch (Throwable t) {
            Log.add(a, "화면 표시 실패: " + t);
        }
    }

    /** 지금 탭을 제자리에서 다시 채운다 (스크롤 위치 유지) */
    public static void reload() {
        MainActivity a = act();
        if (a == null) return;
        try {
            // 탭 화면과 그 위에 쌓인 서브화면을 같이 갱신한다.
            // 시스템 설정(권한 등)을 다녀온 뒤 서브화면만 옛 상태로 남는 문제가 있었다.
            if (cur == HOME) MainActivity.refreshHome();
            else if (cur == MACRO) { ScreenMacro.refresh(); MacroDetail.refresh(); }
            else if (cur == BOT) { ScreenBot.refresh(); BotDetail.refresh(); }
            else ScreenAccount.refresh();
        } catch (Throwable t) {
            Log.add(a, "화면 갱신 실패: " + t);
        }
    }

    /** 잠금화면으로 돌아갈 때 참조를 끊는다 (액티비티 누수 방지) */
    public static void detach() {
        SUBS.clear();
        ACT = null;
        HOST = null;
        BAR = null;
        BAR_ROOT = null;
        cur = HOME;
    }

    // ── 서브화면 스택 (UI_V3 2장) ─────────────────────────────────────────────
    //  설정 상세는 아코디언이 아니라 풀스크린 서브화면으로 연다.
    //  탭 화면은 그 밑에 그대로 남아있다 → 되돌아올 때 스크롤 위치가 살아있고,
    //  서브화면끼리도 각자 스크롤을 갖는다 (같은 뷰를 재사용하지 않으니 섞이지 않는다).

    /**
     * 서브화면을 올린다. 상단에 `‹ 제목` 바가 고정으로 붙고 하단 탭바는 숨는다.
     * 중첩 푸시가 된다 (대상 방 → 계정 설정). 탭을 옮기면 스택은 비워진다.
     *
     * @param content 화면 본문. 보통 Ui.scroll(Ui.screen(...)) 을 넘긴다. LayoutParams 는 여기서 덮어쓴다.
     */
    public static void push(MainActivity a, String title, View content) {
        ViewGroup host = host();
        if (a == null || a.isFinishing() || host == null || content == null) return;

        // 연타 방지 — 페이드 애니메이션(140ms) 중에도 입력을 받으므로 같은 행을 두 번 누르면
        // 같은 서브화면이 스택에 2장 쌓인다. 바로 직전 push 와 너무 가까우면 무시한다.
        long now = android.os.SystemClock.uptimeMillis();
        if (now - lastPushAt < PUSH_DEBOUNCE_MS) return;
        lastPushAt = now;

        LinearLayout wrap = new LinearLayout(a);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setBackgroundColor(Theme.BG);
        // 아래 화면으로 터치가 새지 않게 (FrameLayout 은 안 먹은 터치를 다음 자식에게 넘긴다)
        wrap.setClickable(true);
        wrap.setFocusable(true);

        wrap.addView(subBar(a, title), new LinearLayout.LayoutParams(MATCH, WRAP));
        wrap.addView(content, new LinearLayout.LayoutParams(MATCH, 0, 1f));

        try {
            host.addView(wrap, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        } catch (Throwable t) {
            Log.add(a, "서브화면 표시 실패 (" + title + "): " + t);
            return;
        }
        SUBS.add(wrap);
        setBarVisible(false);

        // 전환은 알파 페이드만 (밀고 당기는 애니메이션은 라이브러리 없이 하면 더 어색하다)
        try {
            wrap.setAlpha(0f);
            wrap.animate().alpha(1f).setDuration(140L).start();
        } catch (Throwable ignore) {
            wrap.setAlpha(1f);
        }
    }

    /** 맨 위 서브화면을 닫는다. 스택이 비어 있으면 false (뒤로가기 키가 이걸 보고 앱을 닫는다). */
    public static boolean pop() {
        if (SUBS.isEmpty()) return false;
        View top = SUBS.remove(SUBS.size() - 1);
        try {
            if (top.getParent() instanceof ViewGroup) ((ViewGroup) top.getParent()).removeView(top);
        } catch (Throwable t) {
            Log.add(top.getContext(), "서브화면 닫기 실패: " + t);
        }
        if (SUBS.isEmpty()) setBarVisible(true);
        return true;
    }

    /** 서브화면에 있는가 (탭바 숨김 판단) */
    public static boolean inSub() { return !SUBS.isEmpty(); }

    /** 서브화면 상단 바: `‹ 제목`. 뒤로 영역은 48dp 정사각. */
    private static LinearLayout subBar(final MainActivity a, String title) {
        LinearLayout barCol = new LinearLayout(a);
        barCol.setOrientation(LinearLayout.VERTICAL);
        barCol.setBackgroundColor(Theme.BG);

        LinearLayout row = new LinearLayout(a);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setMinimumHeight(Theme.dp(a, 56));
        row.setPadding(Theme.dp(a, 4), Theme.dp(a, 4), Theme.dp(a, 16), Theme.dp(a, 4));

        TextView back = new TextView(a);
        back.setText("‹");
        back.setTextSize(TypedValue.COMPLEX_UNIT_SP, 26f);
        back.setTextColor(Theme.TEXT);
        back.setGravity(Gravity.CENTER);
        back.setIncludeFontPadding(false);
        back.setContentDescription("뒤로");
        back.setClickable(true);
        back.setFocusable(true);
        Ui.press(back);
        back.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { pop(); }
        });
        row.addView(back, new LinearLayout.LayoutParams(Theme.dp(a, 48), Theme.dp(a, 48)));

        TextView t = new TextView(a);
        t.setText((title == null) ? "" : title);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17f);
        t.setTextColor(Theme.TEXT);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setLetterSpacing(-0.01f);
        t.setIncludeFontPadding(false);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(0, WRAP, 1f);
        tp.leftMargin = Theme.dp(a, 2);
        row.addView(t, tp);

        barCol.addView(row, new LinearLayout.LayoutParams(MATCH, WRAP));

        View line = new View(a);
        line.setBackgroundColor(Theme.LINE);
        barCol.addView(line, new LinearLayout.LayoutParams(MATCH, Math.max(1, Theme.dp(a, 1))));
        return barCol;
    }

    private static void setBarVisible(boolean show) {
        View b = (BAR_ROOT == null) ? null : BAR_ROOT.get();
        if (b == null) return;
        b.setVisibility(show ? View.VISIBLE : View.GONE);
    }

    /**
     * 되돌리기 스낵바를 지금 화면 하단에 띄운다 (탭바 위). 5초 뒤 스스로 사라진다.
     * 탭을 옮기거나 화면을 다시 그리면 같이 정리된다.
     */
    public static View snack(String msg, String action, Runnable onAction) {
        ViewGroup host = host();
        if (host == null) return null;
        Context c = host.getContext();
        View s = Ui.snack(c, msg, action, onAction);
        int side = Theme.dp(c, 16);
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(MATCH, WRAP);
        lp.gravity = Gravity.BOTTOM;
        lp.leftMargin = side;
        lp.rightMargin = side;
        lp.bottomMargin = inSub() ? side : (side + barHeight(c));
        try {
            host.addView(s, lp);
        } catch (Throwable t) {
            Log.add(c, "안내 표시 실패: " + t);
            return null;
        }
        return s;
    }

    private static int barHeight(Context c) {
        View b = (BAR_ROOT == null) ? null : BAR_ROOT.get();
        int h = (b == null) ? 0 : b.getHeight();
        return (h > 0) ? h : Theme.dp(c, 64);
    }

    private static View screen(MainActivity a, int tab) {
        if (tab == MACRO) return ScreenMacro.build(a);
        if (tab == BOT) return ScreenBot.build(a);
        if (tab == ACCOUNT) return ScreenAccount.build(a);
        return MainActivity.buildHome(a);
    }

    private static MainActivity act() { return (ACT == null) ? null : ACT.get(); }
    private static ViewGroup host() { return (HOST == null) ? null : HOST.get(); }

    private static void paintBar() {
        LinearLayout row = (BAR == null) ? null : BAR.get();
        if (row == null) return;
        for (int i = 0; i < row.getChildCount(); i++) {
            View child = row.getChildAt(i);
            if (!(child instanceof LinearLayout)) continue;
            LinearLayout item = (LinearLayout) child;
            if (item.getChildCount() < 2) continue;
            boolean on = (i == cur);
            View nv = item.getChildAt(0);
            if (nv instanceof TextView) {
                TextView t = (TextView) nv;
                t.setTextColor(on ? Theme.ACCENT : Theme.DIM);
                t.setTypeface(on ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            }
            View dot = item.getChildAt(1);
            dot.setBackground(on ? Theme.circle(Theme.ACCENT, item.getContext()) : null);
            dot.setVisibility(on ? View.VISIBLE : View.INVISIBLE);
        }
    }

    private static View crashView(Context c, Throwable t) {
        LinearLayout col = Ui.screen(c);
        col.addView(Ui.title(c, "화면을 열지 못했습니다"));
        LinearLayout card = Ui.card(c);
        card.addView(Ui.sub(c, "화면을 구성하는 중 오류가 발생했습니다. 내정보 탭의 활동 로그를 확인하십시오.\n\n"
                + t.getClass().getSimpleName() + ": " + t.getMessage()));
        col.addView(card);
        return Ui.scroll(c, col);
    }

    // ── 접히는 카드 ───────────────────────────────────────────────────────────

    /** fold() 가 돌려주는 손잡이. card 를 화면에 붙이고, 내용은 body 에 넣는다. */
    public static final class Fold {
        public final LinearLayout card;
        public final LinearLayout body;
        private final TextView sum;
        private final TextView caret;
        Ui.OnToggle cb;

        Fold(LinearLayout card, LinearLayout body, TextView sum, TextView caret) {
            this.card = card;
            this.body = body;
            this.sum = sum;
            this.caret = caret;
        }

        /** 펼침/접힘이 바뀔 때 알려준다 (화면을 다시 그려도 상태를 기억하려고) */
        public void onToggle(Ui.OnToggle c) { this.cb = c; }

        /** 접힌 상태에서 보이는 요약값 */
        public void summary(String s) {
            if (sum == null) return;
            sum.setText((s == null) ? "" : s);
            sum.setVisibility((s == null || s.length() == 0) ? View.GONE : View.VISIBLE);
        }

        public boolean isOpen() { return body.getVisibility() == View.VISIBLE; }

        public void open(boolean b) {
            body.setVisibility(b ? View.VISIBLE : View.GONE);
            if (caret != null) caret.setText(b ? "▾" : "▸");
        }
    }

    /**
     * 제목 + 요약값만 보이는 카드. 머리를 누르면 body 가 펼쳐진다.
     *
     * ★ UI_V3 부터 아코디언은 **내정보 탭의 '고급' 한 곳에서만** 쓴다.
     * 다른 화면에서 설정 상세를 열 때는 fold 가 아니라 {@link #push(MainActivity, String, View)} +
     * {@code Ui.navRow} 를 써라 (접혀 있으면 안에 뭐가 있는지 모르고, 펼치면 경계가 사라진다).
     */
    public static Fold fold(Context c, String titleTxt, String summary, boolean open) {
        LinearLayout card = Ui.card(c);

        LinearLayout head = Ui.row(c);
        head.setMinimumHeight(Theme.dp(c, 48));

        LinearLayout left = new LinearLayout(c);
        left.setOrientation(LinearLayout.VERTICAL);
        left.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        left.addView(Ui.h2(c, titleTxt));

        TextView sum = Ui.sub(c, (summary == null) ? "" : summary);
        sum.setMaxLines(2);
        sum.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(MATCH, WRAP);
        sp.topMargin = Theme.dp(c, 4);
        sum.setLayoutParams(sp);
        if (summary == null || summary.length() == 0) sum.setVisibility(View.GONE);
        left.addView(sum);
        head.addView(left);

        TextView caret = new TextView(c);
        caret.setText(open ? "▾" : "▸");
        caret.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15f);
        caret.setTextColor(Theme.DIM);
        caret.setIncludeFontPadding(false);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(WRAP, WRAP);
        cp.leftMargin = Theme.dp(c, 12);
        caret.setLayoutParams(cp);
        head.addView(caret);

        LinearLayout body = new LinearLayout(c);
        body.setOrientation(LinearLayout.VERTICAL);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
        bp.topMargin = Theme.dp(c, 6);
        body.setLayoutParams(bp);
        body.setVisibility(open ? View.VISIBLE : View.GONE);

        final Fold f = new Fold(card, body, sum, caret);
        head.setClickable(true);
        head.setFocusable(true);
        Ui.press(head);
        head.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                f.open(!f.isOpen());
                if (f.cb != null) {
                    try { f.cb.on(f.isOpen()); } catch (Throwable t) { /* 상태 기억 실패는 무해 */ }
                }
            }
        });

        card.addView(head);
        card.addView(body);
        return f;
    }

    /**
     * 접힘 카드 여러 개를 카드 하나로 묶는다 (구분선으로 나눈다).
     * fold 와 같이 내정보 '고급' 전용이다. 목록 화면은 {@code Ui.group()} 을 쓴다.
     */
    public static LinearLayout foldGroup(Context c, Fold... folds) {
        LinearLayout card = Ui.card(c);
        boolean first = true;
        if (folds != null) {
            for (int i = 0; i < folds.length; i++) {
                Fold f = folds[i];
                if (f == null || f.card == null) continue;
                List<View> kids = new ArrayList<View>();
                for (int k = 0; k < f.card.getChildCount(); k++) kids.add(f.card.getChildAt(k));
                f.card.removeAllViews();
                if (!first) card.addView(Ui.divider(c));
                for (int k = 0; k < kids.size(); k++) card.addView(kids.get(k));
                first = false;
            }
        }
        return card;
    }

    // ── 자잘한 조립 ───────────────────────────────────────────────────────────

    /** 세로 컨테이너 (가로 꽉, 세로 내용만큼) */
    public static LinearLayout col(Context c) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        return l;
    }

    /** 세로 여백만 먹는 빈칸 */
    public static View gap(Context c, int dpv) {
        View v = new View(c);
        v.setLayoutParams(new LinearLayout.LayoutParams(MATCH, Theme.dp(c, dpv)));
        return v;
    }

    /** 검증 실패를 보여주는 빨간 한 줄. 처음엔 숨어있다. */
    public static TextView errLine(Context c) {
        TextView t = new TextView(c);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        t.setTextColor(Theme.RED);
        t.setLineSpacing(0, 1.35f);
        t.setIncludeFontPadding(false);
        t.setVisibility(View.GONE);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(c, 6);
        t.setLayoutParams(lp);
        return t;
    }

    public static void errText(TextView v, String msg) {
        if (v == null) return;
        if (msg == null || msg.length() == 0) { errClear(v); return; }
        v.setText(msg);
        v.setVisibility(View.VISIBLE);
    }

    public static void errClear(TextView v) {
        if (v == null) return;
        v.setText("");
        v.setVisibility(View.GONE);
    }

    /**
     * 제목 + 현재값 + 오른쪽 버튼 한 줄.
     * 다이얼로그 안(form/editNums)이나 '고급' 아코디언 안에서 쓴다.
     * 화면 본문의 설정 항목은 {@code Ui.navRow} + 서브화면으로 옮겼다.
     */
    public static LinearLayout actionRow(Context c, String titleTxt, String value,
                                        String btnLabel, final Runnable onTap) {
        LinearLayout r = Ui.row(c);
        r.setMinimumHeight(Theme.dp(c, 48));
        int pv = Theme.dp(c, 6);
        r.setPadding(0, pv, 0, pv);

        LinearLayout left = new LinearLayout(c);
        left.setOrientation(LinearLayout.VERTICAL);
        left.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));

        TextView t = Ui.rowTitle(c, titleTxt);
        left.addView(t, new LinearLayout.LayoutParams(MATCH, WRAP));

        if (value != null && value.length() > 0) {
            TextView v = Ui.sub(c, value);
            v.setMaxLines(2);
            v.setEllipsize(TextUtils.TruncateAt.END);
            LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(MATCH, WRAP);
            vp.topMargin = Theme.dp(c, 3);
            v.setLayoutParams(vp);
            left.addView(v);
        }
        r.addView(left);

        if (btnLabel != null && btnLabel.length() > 0) {
            TextView b = Ui.btn(c, btnLabel, false);
            b.setPadding(Theme.dp(c, 14), Theme.dp(c, 12), Theme.dp(c, 14), Theme.dp(c, 12));
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(WRAP, WRAP);
            bp.leftMargin = Theme.dp(c, 12);
            b.setLayoutParams(bp);
            b.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { if (onTap != null) onTap.run(); }
            });
            r.addView(b);
        }
        return r;
    }

    /** 가로폭 꽉 채우는 버튼 (카드 안 주 동작용) */
    public static TextView wideBtn(Context c, String s, boolean primary, final Runnable onTap) {
        TextView b = Ui.btn(c, s, primary);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(c, 12);
        b.setLayoutParams(lp);
        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { if (onTap != null) onTap.run(); }
        });
        return b;
    }

    /** 스위치만 있는 작은 토글 (한 줄 안에서 오른쪽에 붙일 때) */
    public static LinearLayout toggle(Context c, boolean on, Ui.OnToggle cb) {
        return toggle(c, null, on, cb);
    }

    /**
     * 이름이 붙은 작은 토글. 글자는 안 보이지만 스크린리더는 name 을 읽는다
     * (제목이 왼쪽 줄에 따로 있는 경우용 — 무명 컨트롤을 만들지 마라).
     */
    public static LinearLayout toggle(Context c, final String name, boolean on, final Ui.OnToggle cb) {
        final String nm = (name == null) ? "" : name;
        LinearLayout sw = Ui.switchRow(c, "", null, on, new Ui.OnToggle() {
            @Override public void on(boolean v) {
                if (cb != null) cb.on(v);
            }
        });
        sw.setMinimumHeight(Theme.dp(c, 48));
        sw.setPadding(0, Theme.dp(c, 6), 0, Theme.dp(c, 6));
        sw.setLayoutParams(new LinearLayout.LayoutParams(Theme.dp(c, 54), WRAP));
        if (nm.length() > 0) sw.setContentDescription(nm + " 스위치");
        return sw;
    }

    /** 안내 박스. color 로 톤을 잡고, 버튼은 없어도 된다. */
    public static LinearLayout note(Context c, String text, int color, String btnLabel, final Runnable onTap) {
        LinearLayout box = new LinearLayout(c);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setBackground(Theme.round(Theme.fade(color, 0.10f), Theme.R_MD, Theme.fade(color, 0.24f), 1, c));
        int p = Theme.dp(c, 14);
        box.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(c, 12);
        box.setLayoutParams(lp);

        TextView t = new TextView(c);
        t.setText((text == null) ? "" : text);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        t.setTextColor(Theme.SUB);
        t.setLineSpacing(0, 1.45f);
        box.addView(t, new LinearLayout.LayoutParams(MATCH, WRAP));

        if (btnLabel != null && btnLabel.length() > 0) {
            TextView b = Ui.btn(c, btnLabel, false);
            b.setTextColor(color);
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
            bp.topMargin = Theme.dp(c, 12);
            b.setLayoutParams(bp);
            b.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { if (onTap != null) onTap.run(); }
            });
            box.addView(b);
        }
        return box;
    }

    /** 로딩 중 버튼 잠금. 같은 버튼을 두 번 누르는 사고를 막는다. */
    public static void busy(TextView b, boolean on, String busyText, String idleText) {
        if (b == null) return;
        b.setEnabled(!on);
        b.setClickable(!on);
        b.setAlpha(on ? 0.55f : 1f);
        b.setText(on ? busyText : idleText);
    }

    // ── 기능 새로고침 (결제 직후) ─────────────────────────────────────────────

    /** 같은 버튼이 여러 화면에 있어서, 진행 중인지는 한 곳에서 본다 */
    private static boolean refreshing = false;

    /**
     * 결제 직후 기능 상태를 다시 받아온다 (/entitlements).
     * 진행 중에는 버튼을 잠금 + "확인 중…" 으로 바꾸고, 끝나면 그 자리에서 결과를 알려준다.
     * 탭은 옮기지 않는다 — 사용자가 있던 자리에서 해결되는 게 낫다.
     *
     * @param feature 켜졌는지 확인할 기능. null 이면 전체 상태만 맞춘다(내정보의 [기능 새로고침]).
     * @param idleLabel 끝난 뒤 버튼에 되돌릴 라벨
     */
    public static void refreshFeature(final MainActivity a, final TextView btn,
                                      final String feature, final String idleLabel) {
        if (a == null || a.isFinishing()) return;
        final String idle = (idleLabel == null || idleLabel.length() == 0) ? "다시 확인" : idleLabel;
        if (refreshing) { Ui.toast(a, "확인이 진행 중입니다."); return; }
        refreshing = true;
        busy(btn, true, "확인 중…", idle);

        final boolean wasOn = (feature != null) && License.allowed(a, feature);
        final boolean wasShellOk = shellOk(a);
        // feature 가 null 인 경우(내정보의 전체 새로고침)에도 "무엇이 켜졌는지" 를 말해준다
        final boolean[] before = new boolean[Features.ALL.length];
        for (int i = 0; i < Features.ALL.length; i++) {
            before[i] = License.allowed(a, Features.ALL[i]);
        }

        License.refresh(a, new License.Cb() {
            @Override public void done(boolean ok, String reason) {
                refreshing = false;
                busy(btn, false, "확인 중…", idle);
                if (a.isFinishing()) return;

                if (!ok) {
                    String why = License.reasonKr(reason);
                    if (why == null || why.length() == 0) why = "확인 실패";
                    Log.add(a, "기능 새로고침 실패: " + why);
                    Ui.toast(a, why);
                    // 잠김·만료 같은 상태 변화는 바로 화면에 반영해야 한다
                    redraw(a, wasShellOk);
                    failDialog(a, btn, feature, idle, why);
                    return;
                }

                boolean nowOn = (feature == null) || License.allowed(a, feature);
                if (nowOn) {
                    if (feature != null && !wasOn) {
                        Ui.toast(a, Features.label(feature) + " 기능이 활성화되었습니다");
                    } else {
                        String fresh = newlyOn(a, before);
                        Ui.toast(a, (fresh.length() > 0) ? (fresh + " 기능이 활성화되었습니다") : "최신 상태로 갱신되었습니다");
                    }
                    redraw(a, wasShellOk);
                    return;
                }
                // 서버 응답은 받았는데 아직 안 켜진 경우 — 입금 확인에서 발급까지 시간이 걸린다
                redraw(a, wasShellOk);
                notYetDialog(a, btn, feature, idle);
            }
        });
    }

    /** 새로고침 전에는 꺼져 있었는데 지금은 켜진 기능 이름들 ("매크로 · 방 관리봇"), 없으면 빈 문자열 */
    private static String newlyOn(MainActivity a, boolean[] before) {
        StringBuilder sb = new StringBuilder();
        if (before == null) return "";
        for (int i = 0; i < Features.ALL.length && i < before.length; i++) {
            if (before[i]) continue;
            if (!License.allowed(a, Features.ALL[i])) continue;
            if (sb.length() > 0) sb.append(" · ");
            sb.append(Features.label(Features.ALL[i]));
        }
        return sb.toString();
    }

    /** 라이선스 셸(잠금화면 ↔ 탭)이 바뀌었으면 통째로, 아니면 지금 화면만 제자리 갱신 */
    static void redraw(MainActivity a, boolean wasShellOk) {
        if (a == null || a.isFinishing()) return;
        try {
            if (shellOk(a) != wasShellOk) a.renderShell();
            else reload();
        } catch (Throwable t) {
            Log.add(a, "화면 재구성 실패: " + t);
        }
    }

    /** 인증된 상태(탭 화면을 보여줄 수 있는가)인가 */
    static boolean shellOk(MainActivity a) {
        try {
            License.State s = License.state(a);
            return s != null && s.licensed && !s.locked;
        } catch (Throwable t) {
            return false;
        }
    }

    private static void notYetDialog(final MainActivity a, final TextView btn,
                                     final String feature, final String idle) {
        final String buyFeat = (feature == null) ? Features.MACRO : feature;
        String name = Features.label(buyFeat);
        AlertDialog.Builder b = Ui.dialog(a, "반영 대기 중");
        b.setMessage(name + " 기능이 아직 비활성 상태입니다.\n"
                + "입금 확인 후 발급까지 시간이 소요될 수 있습니다. 1~2분 후 [다시 확인]을 선택하십시오.\n"
                + "결제 전이라면 구매 페이지에서 결제 후 즉시 활성화됩니다.");
        b.setPositiveButton("다시 확인", new android.content.DialogInterface.OnClickListener() {
            @Override public void onClick(android.content.DialogInterface d, int w) {
                refreshFeature(a, btn, feature, idle);
            }
        });
        b.setNeutralButton("구매 페이지 열기", new android.content.DialogInterface.OnClickListener() {
            @Override public void onClick(android.content.DialogInterface d, int w) {
                Gate.openBuy(a, buyFeat);
            }
        });
        b.setNegativeButton("닫기", null);
        Ui.showDark(b);
        Log.add(a, Features.label(buyFeat) + " 새로고침 — 미활성 상태");
    }

    private static void failDialog(final MainActivity a, final TextView btn, final String feature,
                                   final String idle, String why) {
        AlertDialog.Builder b = Ui.dialog(a, "확인 실패");
        b.setMessage(why + "\n\n네트워크 상태를 확인한 후 [다시 확인]을 선택하십시오.");
        b.setPositiveButton("다시 확인", new android.content.DialogInterface.OnClickListener() {
            @Override public void onClick(android.content.DialogInterface d, int w) {
                refreshFeature(a, btn, feature, idle);
            }
        });
        b.setNegativeButton("닫기", null);
        Ui.showDark(b);
    }

    // ── 줄바꿈 되는 칩 묶음 ──────────────────────────────────────────────────

    /**
     * 자식들을 가로로 놓다가 폭이 모자라면 다음 줄로 내리는 컨테이너.
     * (라이브러리 없이 칩 목록을 자연스럽게 보여주려고 직접 만들었다)
     */
    public static final class Flow extends ViewGroup {
        private final int gapPx;

        public Flow(Context c) {
            super(c);
            gapPx = Theme.dp(c, 8);
        }

        @Override protected void onMeasure(int wSpec, int hSpec) {
            int maxW = MeasureSpec.getSize(wSpec);
            if (maxW <= 0) maxW = Theme.dp(getContext(), 320);
            int x = 0, y = 0, lineH = 0;
            for (int i = 0; i < getChildCount(); i++) {
                View ch = getChildAt(i);
                if (ch.getVisibility() == GONE) continue;
                ch.measure(MeasureSpec.makeMeasureSpec(maxW, MeasureSpec.AT_MOST),
                        MeasureSpec.makeMeasureSpec(0, MeasureSpec.UNSPECIFIED));
                int cw = ch.getMeasuredWidth();
                int chh = ch.getMeasuredHeight();
                if (x > 0 && x + cw > maxW) { x = 0; y += lineH + gapPx; lineH = 0; }
                x += cw + gapPx;
                if (chh > lineH) lineH = chh;
            }
            setMeasuredDimension(maxW, y + lineH);
        }

        @Override protected void onLayout(boolean changed, int l, int t, int r, int b) {
            int maxW = r - l;
            if (maxW <= 0) return;
            int x = 0, y = 0, lineH = 0;
            for (int i = 0; i < getChildCount(); i++) {
                View ch = getChildAt(i);
                if (ch.getVisibility() == GONE) continue;
                int cw = ch.getMeasuredWidth();
                int chh = ch.getMeasuredHeight();
                if (x > 0 && x + cw > maxW) { x = 0; y += lineH + gapPx; lineH = 0; }
                ch.layout(x, y, x + cw, y + chh);
                x += cw + gapPx;
                if (chh > lineH) lineH = chh;
            }
        }
    }

    /** 위에 여백이 붙은 Flow */
    public static Flow flow(Context c) {
        Flow f = new Flow(c);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(c, 10);
        f.setLayoutParams(lp);
        return f;
    }

    /** 누르면 지워지는 칩 (오른쪽에 ✕). 터치영역은 권장 최소 48dp 를 지킨다. */
    public static TextView removableChip(Context c, String text, int color, final Runnable onRemove) {
        String label = (text == null) ? "" : text;
        TextView t = Ui.chip(c, label + "  ✕", color);
        t.setMaxWidth(Theme.dp(c, 200));
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.MIDDLE);
        t.setPadding(Theme.dp(c, 14), Theme.dp(c, 13), Theme.dp(c, 14), Theme.dp(c, 13));
        t.setMinimumHeight(Theme.dp(c, 48));
        t.setMinimumWidth(Theme.dp(c, 48));
        t.setClickable(true);
        t.setFocusable(true);
        t.setContentDescription(label + ", 삭제");
        Ui.press(t);
        t.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { if (onRemove != null) onRemove.run(); }
        });
        return t;
    }

    /**
     * 칩 목록을 그린다. 비어있으면 "없음" 안내를 대신 넣는다.
     * rebuild 를 다시 부르기만 하면 화면이 갱신된다.
     */
    public static void fillChips(Flow into, List<String> items, int color, String emptyText,
                                final ChipTap onTap) {
        if (into == null) return;
        into.removeAllViews();
        Context c = into.getContext();
        if (items == null || items.isEmpty()) {
            TextView t = Ui.sub(c, (emptyText == null) ? "없음" : emptyText);
            into.addView(t);
            return;
        }
        for (int i = 0; i < items.size(); i++) {
            final String v = items.get(i);
            into.addView(removableChip(c, v, color, new Runnable() {
                @Override public void run() { if (onTap != null) onTap.tap(v); }
            }));
        }
    }

    public interface ChipTap { void tap(String value); }

    /**
     * 칩 목록 편집기. 칩을 누르면 목록에서 빼고 onChange 를 부른 뒤 다시 그린다.
     * (목록 자체를 고치니까 호출한 쪽은 onChange 에서 저장만 하면 된다)
     */
    public static void chipEditor(final Flow flow, final List<String> items, final int color,
                                  final String emptyText, final Runnable onChange) {
        fillChips(flow, items, color, emptyText, new ChipTap() {
            @Override public void tap(final String v) {
                final Runnable del = new Runnable() {
                    @Override public void run() {
                        items.remove(v);
                        if (onChange != null) onChange.run();
                        chipEditor(flow, items, color, emptyText, onChange);
                    }
                };
                Activity a = activityOf(flow);
                if (a == null) { del.run(); return; }
                // 탭 한 번에 지워버리면 되돌릴 방법이 없다 → 한 번 묻는다
                confirm(a, "「" + v + "」 삭제", "목록에서 제거하고 즉시 저장합니다.", "삭제", del);
            }
        });
    }

    /** 뷰가 올라가 있는 Activity 를 찾는다 (없으면 null) */
    private static Activity activityOf(View v) {
        if (v == null) return null;
        Context c = v.getContext();
        while (c instanceof android.content.ContextWrapper) {
            if (c instanceof Activity) return (Activity) c;
            c = ((android.content.ContextWrapper) c).getBaseContext();
        }
        return null;
    }

    // ── 다이얼로그 ───────────────────────────────────────────────────────────

    /** 저장 콜백. null 을 돌려주면 창을 닫고, 문장을 돌려주면 창을 열어둔 채 빨간 줄로 보여준다. */
    public interface OnSave { String save(); }

    /**
     * 내용(content)을 담은 다크 입력창. 저장 버튼은 OnSave 가 null 을 돌려줄 때만 닫힌다
     * → 검증 실패 때 사용자가 입력한 값이 안 날아간다.
     */
    public static AlertDialog form(final Activity a, String titleTxt, LinearLayout content,
                                   String saveLabel, final OnSave onSave) {
        LinearLayout wrap = new LinearLayout(a);
        wrap.setOrientation(LinearLayout.VERTICAL);
        int ph = Theme.dp(a, 22);
        wrap.setPadding(ph, Theme.dp(a, 6), ph, Theme.dp(a, 18));

        if (content != null) {
            content.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            wrap.addView(content);
        }
        final TextView err = errLine(a);
        wrap.addView(err);

        LinearLayout btns = Ui.row(a);
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(MATCH, WRAP);
        rp.topMargin = Theme.dp(a, 18);
        btns.setLayoutParams(rp);

        TextView cancel = Ui.btn(a, "취소", false);
        cancel.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        final TextView save = Ui.btn(a, (saveLabel == null) ? "저장" : saveLabel, true);
        LinearLayout.LayoutParams svp = new LinearLayout.LayoutParams(0, WRAP, 1.2f);
        svp.leftMargin = Theme.dp(a, 10);
        save.setLayoutParams(svp);
        btns.addView(cancel);
        btns.addView(save);
        wrap.addView(btns);

        ScrollView sc = new ScrollView(a);
        sc.setVerticalScrollBarEnabled(false);
        sc.addView(wrap, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));

        AlertDialog.Builder b = Ui.dialog(a, titleTxt);
        b.setView(sc);
        final AlertDialog d = b.create();

        cancel.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                try { d.dismiss(); } catch (Throwable ignore) { }
            }
        });
        save.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String bad;
                try {
                    bad = (onSave == null) ? null : onSave.save();
                } catch (Throwable t) {
                    bad = "저장 중 오류가 발생했습니다: " + t.getClass().getSimpleName();
                    Log.add(a, "설정 저장 실패: " + t);
                }
                if (bad == null) {
                    try { d.dismiss(); } catch (Throwable ignore) { }
                    return;
                }
                errText(err, bad);
            }
        });
        Ui.showDark(d);
        return d;
    }

    /** 한 줄/여러 줄 텍스트를 고치는 창. 검증은 OnText 가 문장을 돌려주면 실패로 본다. */
    public interface OnText { String text(String value); }

    public static void editText(final Activity a, String titleTxt, String hint, String value,
                                boolean multiline, String help, final OnText cb) {
        LinearLayout body = col(a);
        if (help != null && help.length() > 0) {
            TextView h = Ui.sub(a, help);
            LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
            hp.bottomMargin = Theme.dp(a, 10);
            h.setLayoutParams(hp);
            body.addView(h);
        }
        final EditText f = Ui.field(a, hint);
        if (multiline) {
            f.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
            f.setMinLines(4);
            f.setMaxLines(10);
        } else {
            f.setSingleLine(true);
            f.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        }
        f.setText((value == null) ? "" : value);
        try { f.setSelection(f.getText().length()); } catch (Throwable ignore) { }
        body.addView(f);

        form(a, titleTxt, body, "저장", new OnSave() {
            @Override public String save() {
                return (cb == null) ? null : cb.text(f.getText().toString());
            }
        });
    }

    /** 숫자 여러 개를 한 번에 고치는 창. 각 칸 아래에 자기 오류가 붙는다. */
    public static final class NumField {
        public final String label;
        public final String hint;
        public final int min;
        public final int max;
        public int value;
        EditText edit;
        TextView err;

        public NumField(String label, String hint, int min, int max, int value) {
            this.label = label;
            this.hint = hint;
            this.min = min;
            this.max = max;
            this.value = value;
        }
    }

    /** 전부 통과하면 OnNums 가 불린다. OnNums 가 문장을 돌려주면 창은 열린 채로 그 문장을 보여준다. */
    public interface OnNums { String ok(); }

    public static void editNums(final Activity a, String titleTxt, String help,
                                final NumField[] fields, final OnNums cb) {
        LinearLayout body = col(a);
        if (help != null && help.length() > 0) {
            TextView h = Ui.sub(a, help);
            LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
            hp.bottomMargin = Theme.dp(a, 6);
            h.setLayoutParams(hp);
            body.addView(h);
        }
        for (int i = 0; i < fields.length; i++) {
            final NumField nf = fields[i];
            TextView lb = Ui.label(a, nf.label);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
            lp.topMargin = Theme.dp(a, 12);
            lp.bottomMargin = Theme.dp(a, 6);
            lb.setLayoutParams(lp);
            body.addView(lb);

            nf.edit = Ui.field(a, nf.hint);
            nf.edit.setSingleLine(true);
            nf.edit.setInputType(InputType.TYPE_CLASS_NUMBER);
            nf.edit.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
            nf.edit.setText(String.valueOf(nf.value));
            body.addView(nf.edit);

            nf.err = errLine(a);
            body.addView(nf.err);
        }

        form(a, titleTxt, body, "저장", new OnSave() {
            @Override public String save() {
                boolean bad = false;
                for (int i = 0; i < fields.length; i++) {
                    NumField nf = fields[i];
                    errClear(nf.err);
                    int v;
                    try {
                        v = Integer.parseInt(nf.edit.getText().toString().trim());
                    } catch (Throwable t) {
                        errText(nf.err, "숫자만 입력하십시오");
                        bad = true;
                        continue;
                    }
                    if (v < nf.min || v > nf.max) {
                        errText(nf.err, nf.min + " ~ " + nf.max + " 사이의 값을 입력하십시오");
                        bad = true;
                        continue;
                    }
                    nf.value = v;
                }
                if (bad) return "";
                return (cb == null) ? null : cb.ok();
            }
        });
    }

    /** 하나 고르기 (라디오). 고르면 바로 닫힌다. */
    public interface OnPick { void pick(int index); }

    public static void choose(final Activity a, String titleTxt, String[] labels, String[] descs,
                              int selected, final OnPick cb) {
        LinearLayout body = col(a);
        AlertDialog.Builder b = Ui.dialog(a, titleTxt);
        ScrollView sc = new ScrollView(a);
        sc.setVerticalScrollBarEnabled(false);
        LinearLayout wrap = new LinearLayout(a);
        wrap.setOrientation(LinearLayout.VERTICAL);
        int ph = Theme.dp(a, 14);
        wrap.setPadding(ph, Theme.dp(a, 8), ph, Theme.dp(a, 14));
        wrap.addView(body);
        sc.addView(wrap, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        b.setView(sc);
        b.setNegativeButton("취소", null);
        final AlertDialog d = b.create();

        for (int i = 0; i < labels.length; i++) {
            final int idx = i;
            boolean on = (i == selected);
            LinearLayout r = Ui.row(a);
            r.setMinimumHeight(Theme.dp(a, 52));
            int pv = Theme.dp(a, 10);
            r.setPadding(Theme.dp(a, 8), pv, Theme.dp(a, 8), pv);
            r.setClickable(true);
            r.setFocusable(true);
            Ui.press(r);

            View dot = new View(a);
            dot.setBackground(on ? Theme.pill(Theme.ACCENT, 0, a)
                                 : Theme.pill(Theme.TRANSPARENT, Theme.LINE2, a));
            LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(Theme.dp(a, 16), Theme.dp(a, 16));
            dp.rightMargin = Theme.dp(a, 12);
            r.addView(dot, dp);

            LinearLayout tcol = new LinearLayout(a);
            tcol.setOrientation(LinearLayout.VERTICAL);
            tcol.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
            TextView lt = new TextView(a);
            lt.setText(labels[i]);
            lt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
            lt.setTextColor(on ? Theme.ACCENT : Theme.TEXT);
            lt.setTypeface(on ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            lt.setIncludeFontPadding(false);
            tcol.addView(lt, new LinearLayout.LayoutParams(MATCH, WRAP));
            if (descs != null && i < descs.length && descs[i] != null && descs[i].length() > 0) {
                TextView dt = Ui.sub(a, descs[i]);
                LinearLayout.LayoutParams dtp = new LinearLayout.LayoutParams(MATCH, WRAP);
                dtp.topMargin = Theme.dp(a, 3);
                dt.setLayoutParams(dtp);
                tcol.addView(dt);
            }
            r.addView(tcol);

            r.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    try { d.dismiss(); } catch (Throwable ignore) { }
                    if (cb != null) cb.pick(idx);
                }
            });
            body.addView(r);
        }
        Ui.showDark(d);
    }


    /** 예/아니오 확인창 */
    public static void confirm(Activity a, String titleTxt, String msg, String okLabel,
                               final Runnable onOk) {
        AlertDialog.Builder b = Ui.dialog(a, titleTxt);
        b.setMessage(msg);
        b.setPositiveButton((okLabel == null) ? "확인" : okLabel,
                new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface d, int w) {
                        if (onOk != null) onOk.run();
                    }
                });
        b.setNegativeButton("취소", null);
        Ui.showDark(b);
    }

    /** 긴 글을 읽기만 하는 창 (로그 전체보기 등) */
    public static void showText(Activity a, String titleTxt, String text, final Runnable onCopy) {
        LinearLayout body = col(a);
        TextView t = Ui.mono(a, (text == null || text.length() == 0) ? "(내용 없음)" : text);
        body.addView(t);
        AlertDialog.Builder b = Ui.dialog(a, titleTxt);
        ScrollView sc = new ScrollView(a);
        sc.setVerticalScrollBarEnabled(false);
        LinearLayout wrap = new LinearLayout(a);
        wrap.setOrientation(LinearLayout.VERTICAL);
        int ph = Theme.dp(a, 18);
        wrap.setPadding(ph, Theme.dp(a, 8), ph, Theme.dp(a, 8));
        wrap.addView(body);
        sc.addView(wrap, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        b.setView(sc);
        if (onCopy != null) {
            b.setPositiveButton("복사", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) { onCopy.run(); }
            });
        }
        b.setNegativeButton("닫기", null);
        Ui.showDark(b);
    }

    // ── 이미지 썸네일 ────────────────────────────────────────────────────────

    /** 가로 스크롤 썸네일 줄 */
    public static HorizontalScrollView thumbStrip(Context c, LinearLayout inner) {
        HorizontalScrollView h = new HorizontalScrollView(c);
        h.setHorizontalScrollBarEnabled(false);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(c, 10);
        h.setLayoutParams(lp);
        h.addView(inner, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT));
        return h;
    }

    /** 썸네일 한 칸 (번호 없는 옛 호출부용) */
    public static View thumb(Context c, String uri, final Runnable onRemove) {
        return thumb(c, uri, 0, onRemove);
    }

    /**
     * 썸네일 한 칸. 지우기는 오른쪽 위 ✕ 만 받는다 (칸 전체를 누르면 실수로 지워진다).
     * 못 읽는 URI 면 회색 칸에 "못 읽음".
     */
    public static View thumb(Context c, String uri, int no, final Runnable onRemove) {
        int side = Theme.dp(c, 72);
        FrameLayout box = new FrameLayout(c);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(side, side);
        lp.rightMargin = Theme.dp(c, 8);
        box.setLayoutParams(lp);
        box.setBackground(Theme.round(Theme.CARD2, Theme.R_MD, Theme.LINE2, 1, c));
        box.setClipToOutline(true);

        final ImageView iv = new ImageView(c);
        iv.setScaleType(ImageView.ScaleType.CENTER_CROP);
        box.addView(iv, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        final TextView state = new TextView(c);
        state.setTextSize(TypedValue.COMPLEX_UNIT_SP, 11f);
        state.setGravity(Gravity.CENTER);
        box.addView(state, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        Bitmap cached = cachedThumb(uri);
        if (cached != null) {
            iv.setImageBitmap(cached);
            state.setVisibility(View.GONE);
        } else {
            // 디코딩은 메인 스레드에서 하지 않는다 — 사진 5장이면 화면 조립이 눈에 보이게 멈춘다
            state.setText("불러오는 중");
            state.setTextColor(Theme.DIM);
            loadThumb(c, uri, iv, state);
        }

        final String label = (no > 0) ? ("첨부 이미지 " + no + "번째") : "첨부 이미지";
        box.setContentDescription(label);

        TextView x = new TextView(c);
        x.setText("✕");
        x.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        x.setTextColor(Theme.TEXT);
        x.setGravity(Gravity.CENTER);
        x.setBackground(Theme.pill(Theme.fade(Theme.BG, 0.85f), Theme.LINE2, c));
        x.setContentDescription(label + " 지우기");
        FrameLayout.LayoutParams xp = new FrameLayout.LayoutParams(Theme.dp(c, 32), Theme.dp(c, 32));
        xp.gravity = Gravity.TOP | Gravity.END;
        xp.topMargin = Theme.dp(c, 2);
        xp.rightMargin = Theme.dp(c, 2);
        x.setClickable(true);
        x.setFocusable(true);
        Ui.press(x);
        x.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { if (onRemove != null) onRemove.run(); }
        });
        box.addView(x, xp);

        // 칸 자체는 안 지운다 — 어디를 눌러야 지워지는지 알려주기만 한다
        box.setClickable(true);
        box.setFocusable(true);
        Ui.press(box);
        box.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { Ui.toast(v.getContext(), "오른쪽 상단 ✕ 를 선택하면 삭제됩니다"); }
        });
        return box;
    }

    /** 디코딩해둔 썸네일. 화면을 다시 그릴 때마다 또 읽지 않게 들고 있는다. */
    private static final java.util.HashMap<String, Bitmap> THUMBS = new java.util.HashMap<String, Bitmap>();
    private static final int THUMB_CACHE_MAX = 24;

    private static Bitmap cachedThumb(String uri) {
        if (uri == null) return null;
        synchronized (THUMBS) { return THUMBS.get(uri); }
    }

    private static void cacheThumb(String uri, Bitmap bm) {
        if (uri == null || bm == null) return;
        synchronized (THUMBS) {
            if (THUMBS.size() >= THUMB_CACHE_MAX) THUMBS.clear();   // 넘치면 통째로 비운다(단순하게)
            THUMBS.put(uri, bm);
        }
    }

    /** 사진 목록이 바뀌면 캐시도 버린다 (같은 URI 가 다른 사진이 되는 일은 없지만 메모리는 놓아준다) */
    public static void clearThumbCache() {
        synchronized (THUMBS) { THUMBS.clear(); }
    }

    private static void loadThumb(Context c, final String uri, final ImageView iv,
                                  final TextView state) {
        final Context app = (c == null) ? null : c.getApplicationContext();
        if (app == null) return;
        new Thread(new Runnable() {
            @Override public void run() {
                Bitmap bm;
                try {
                    bm = ImagePicker.thumb(app, uri, ImagePicker.THUMB_PX);
                } catch (Throwable t) {
                    bm = null;
                }
                final Bitmap out = bm;
                cacheThumb(uri, out);
                try {
                    new android.os.Handler(android.os.Looper.getMainLooper()).post(new Runnable() {
                        @Override public void run() {
                            if (out != null) {
                                iv.setImageBitmap(out);
                                state.setVisibility(View.GONE);
                            } else {
                                state.setText("읽기 실패");
                                state.setTextColor(Theme.RED);
                            }
                        }
                    });
                } catch (Throwable ignore) {
                    // 화면이 이미 사라진 경우 — 무해
                }
            }
        }, "thumb-decode").start();
    }

    // ── 잡동사니 ─────────────────────────────────────────────────────────────

    /** 클립보드에 넣는다 */
    public static void copy(Context c, String label, String text) {
        if (c == null || text == null) return;
        try {
            ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) { Ui.toast(c, "클립보드에 접근할 수 없습니다"); return; }
            cm.setPrimaryClip(ClipData.newPlainText((label == null) ? "" : label, text));
            Ui.toast(c, "복사 완료");
        } catch (Throwable t) {
            Log.add(c, "복사 실패: " + t);
            Ui.toast(c, "복사 실패");
        }
    }

    /** 클립보드에서 읽는다. 없으면 "". */
    public static String paste(Context c) {
        if (c == null) return "";
        try {
            ClipboardManager cm = (ClipboardManager) c.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) return "";
            ClipData d = cm.getPrimaryClip();
            if (d == null || d.getItemCount() == 0) return "";
            CharSequence cs = d.getItemAt(0).coerceToText(c);
            return (cs == null) ? "" : cs.toString();
        } catch (Throwable t) {
            Log.add(c, "붙여넣기 실패: " + t);
            return "";
        }
    }

    /** 브라우저로 주소 열기 */
    public static void openWeb(Context c, String url, String what) {
        if (c == null || url == null) return;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            Log.add(c, what + " 열기");
        } catch (Throwable t) {
            Log.add(c, what + " 열기 실패 (" + url + "): " + t);
            Ui.toast(c, "브라우저를 열 수 없습니다");
        }
    }

    /** 설정 화면 인텐트를 안전하게 띄운다. 못 열면 로그 + 토스트. */
    public static void openIntent(Context c, Intent i, String what) {
        if (c == null || i == null) return;
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Throwable t) {
            Log.add(c, what + " 화면 열기 실패: " + t);
            Ui.toast(c, what + " 화면을 열 수 없습니다. 설정에서 직접 이동하십시오.");
        }
    }

    /** "9/27(토) 21:05". 0 이하면 "없음". */
    public static String when(long ms) {
        if (ms <= 0) return "없음";
        try {
            return new SimpleDateFormat("M/d(E) HH:mm", Locale.KOREA).format(new Date(ms));
        } catch (Throwable t) {
            return "-";
        }
    }

    /** "2026-09-27". 0 이하면 "-". */
    public static String day(long ms) {
        if (ms <= 0) return "-";
        try {
            return new SimpleDateFormat("yyyy-MM-dd", Locale.KOREA).format(new Date(ms));
        } catch (Throwable t) {
            return "-";
        }
    }

    /** "9/27(토) 21:05 · 12분 뒤" 처럼 상대시간을 붙여준다 */
    public static String whenRel(long ms) {
        if (ms <= 0) return "예정 없음";
        long d = ms - System.currentTimeMillis();
        String rel;
        if (d <= 0) rel = "곧";
        else if (d < 60000L) rel = "1분 안";
        else if (d < 3600000L) rel = (d / 60000L) + "분 뒤";
        else if (d < 86400000L) rel = (d / 3600000L) + "시간 뒤";
        else rel = (d / 86400000L) + "일 뒤";
        return when(ms) + " · " + rel;
    }

    /** 여러 줄을 한 줄 미리보기로 (최대 n자) */
    public static String preview(String s, int n) {
        if (s == null) return "";
        String v = s.replace('\n', ' ').replace('\r', ' ').trim();
        while (v.contains("  ")) v = v.replace("  ", " ");
        if (v.length() <= n) return v;
        return v.substring(0, n) + "…";
    }

    /** 밀리초를 사람 말로 ("6시간", "90분", "3초") */
    public static String dur(long ms) {
        if (ms <= 0) return "없음";
        if (ms % 3600000L == 0) return (ms / 3600000L) + "시간";
        if (ms % 60000L == 0) return (ms / 60000L) + "분";
        if (ms >= 1000L) return (ms / 1000L) + "초";
        return ms + "ms";
    }

    /** 목록을 "가, 나, 다" 로. 비면 emptyText. */
    public static String join(List<String> l, String emptyText) {
        if (l == null || l.isEmpty()) return emptyText;
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < l.size(); i++) {
            if (i > 0) sb.append(", ");
            sb.append(l.get(i));
        }
        return sb.toString();
    }
}
