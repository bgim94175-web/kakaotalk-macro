package com.buseong.kakaoadmin;

import android.app.Activity;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONObject;

/**
 * 관리자앱 셸.
 *  1) 비밀번호 로그인 화면 (서버주소 + 비번 + 저장 체크)
 *  2) 통과하면 상단 통계 요약 바 + 하단 탭 4개 (키 · 주문 · 기록 · 설정)
 *
 * 화면(Screen)들은 각자 자기 뷰를 만들고 reload() 로 서버에서 다시 읽는다.
 * 401 이 오면 어느 화면에서든 kicked(r) 로 로그인 화면으로 돌아온다.
 */
public final class MainActivity extends Activity {

    /** 탭 하나가 지켜야 할 계약 */
    public interface Screen {
        /** 화면 뷰 (한 번 만들고 캐시해라) */
        View view();
        /** 서버에서 다시 읽어 그린다 */
        void reload();
    }

    private static final String[] TABS = { "키", "주문", "기록", "설정" };
    private static final int[] TAB_GLYPHS = { Icon.KEY, Icon.RECEIPT, Icon.SHIELD, Icon.GEAR };
    private static final int[] TAB_COLORS = { Theme.F_KEYS, Theme.F_ORDERS, Theme.F_AUDIT, Theme.F_SETTINGS };

    private FrameLayout root;
    private FrameLayout content;
    private LinearLayout statsRow;
    private LinearLayout tabBar;

    private final Screen[] screens = new Screen[4];
    private final boolean[] loaded = new boolean[4];
    private int tab = 0;

    /** 마지막으로 읽은 /admin/stats 응답 (설정 화면이 상세를 보여줄 때 쓴다) */
    private JSONObject stats = null;
    private boolean statsBusy = false;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        App.install(this);

        root = new FrameLayout(this);
        root.setBackgroundColor(Theme.BG);
        root.setLayoutParams(new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);

        if (Api.hasPassword(this)) showShell();
        else showLogin(null);

        if (App.crashUnseen(this)) {
            App.markCrashSeen(this);
            final String crash = App.lastCrash(this);
            Ui.confirm(this, "이전 실행에서 비정상 종료 발생",
                    "마지막 크래시: " + Ui.fmtFull(App.lastCrashAt(this))
                            + "\n상세 내용을 확인하여 개발자에게 전달하십시오. [설정] 탭에서 다시 확인할 수 있습니다.",
                    "상세 보기", false, new Runnable() {
                        @Override public void run() { Ui.showText(MainActivity.this, "마지막 크래시", crash); }
                    });
        }
    }

    @Override protected void onResume() {
        super.onResume();
        if (content != null && Api.hasPassword(this)) refreshStats();
    }

    // ── 로그인 ────────────────────────────────────────────────────────────────

    /** msg 가 있으면 빨간 안내로 먼저 보여준다 */
    public void showLogin(String msg) {
        content = null;
        statsRow = null;
        tabBar = null;
        for (int i = 0; i < screens.length; i++) { screens[i] = null; loaded[i] = false; }
        tab = 0;

        Theme.setAccent(Theme.PRIMARY);

        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setGravity(Gravity.CENTER_VERTICAL);
        body.setPadding(Theme.dp(this, 16), Theme.dp(this, 24), Theme.dp(this, 16), Theme.dp(this, 24));
        body.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout brand = new LinearLayout(this);
        brand.setOrientation(LinearLayout.VERTICAL);
        TextView t = Ui.title(this, "관리자 로그인");
        brand.addView(t);
        TextView lead = Ui.sub(this, "라이선스 키 · 주문 · 보안 기록을 관리합니다.");
        LinearLayout.LayoutParams lp0 = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp0.topMargin = Theme.dp(this, 4);
        lp0.bottomMargin = Theme.dp(this, 16);
        brand.addView(lead, lp0);
        body.addView(brand, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout card = Ui.card(this);

        if (msg != null && msg.length() > 0) {
            TextView warn = Ui.body(this, msg);
            warn.setTextColor(Theme.RED);
            warn.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13f);
            warn.setBackground(Theme.round(Theme.fade(Theme.RED, 0.10f), Theme.R_SM,
                    Theme.fade(Theme.RED, 0.30f), 1, this));
            int wp = Theme.dp(this, 12);
            warn.setPadding(wp, wp, wp, wp);
            LinearLayout.LayoutParams wl = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            wl.bottomMargin = Theme.dp(this, 14);
            warn.setLayoutParams(wl);
            card.addView(warn);
        }

        card.addView(Ui.label(this, "서버 주소"));
        final EditText base = Ui.lineField(this, Api.DEFAULT_BASE);
        base.setText(Api.base(this));
        base.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        mt(base, 7);
        card.addView(base);

        TextView gap1 = Ui.label(this, "관리자 비밀번호");
        mt(gap1, 16);
        card.addView(gap1);
        final EditText pw = Ui.pwField(this, "ADMIN_PASSWORD 환경변수 값");
        mt(pw, 7);
        card.addView(pw);

        final View remember = Ui.switchRow(this, "비밀번호 저장",
                "현재 기기에만 저장됩니다. 공용 기기에서는 비활성화하십시오.", Api.remember(this), null);
        mt(remember, 6);
        card.addView(remember);

        final TextView go = Ui.btn(this, "로그인", true);
        mt(go, 6);
        card.addView(go);
        go.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String b = base.getText() == null ? "" : base.getText().toString().trim();
                String p = pw.getText() == null ? "" : pw.getText().toString();
                if (p.length() == 0) { Ui.toast(MainActivity.this, "비밀번호를 입력하십시오"); return; }
                go.setEnabled(false);
                go.setText("확인 중…");
                Api.signIn(MainActivity.this, b, p, Ui.isOn(remember));
                Api.stats(MainActivity.this, new Api.Cb() {
                    @Override public void done(Api.Result r) {
                        go.setEnabled(true);
                        go.setText("로그인");
                        if (r.ok) {
                            stats = r.json;
                            App.log(MainActivity.this, "관리자 로그인 성공 (" + Api.base(MainActivity.this) + ")");
                            showShell();
                            return;
                        }
                        // 실패한 비번을 저장해두면 다음 실행에서 또 자동으로 실패한다
                        if (r.unauthorized) Api.signOut(MainActivity.this);
                        showLogin(r.error);
                    }
                });
            }
        });

        body.addView(card);

        LinearLayout foot = Ui.card(this);
        foot.setBackground(Theme.round(Theme.BG2, Theme.R_LG, Theme.LINE, 1, this));
        foot.addView(Ui.cardHead(this, Icon.LOCK, Theme.GOLD, "접속 안내"));
        TextView ft = Ui.sub(this, "비밀번호는 서버(Render)의 ADMIN_PASSWORD 환경변수 값입니다.\n"
                + "서버가 절전 상태인 경우 최초 요청에 20초 이상 소요될 수 있습니다. 응답이 없으면 다시 시도하십시오.");
        mt(ft, 10);
        foot.addView(ft);
        body.addView(foot);

        ScrollView sc = new ScrollView(this);
        sc.setFillViewport(true);
        sc.setVerticalScrollBarEnabled(false);
        sc.addView(body, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT));

        root.removeAllViews();
        root.addView(sc, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
    }

    // ── 셸 (통계바 + 탭) ──────────────────────────────────────────────────────

    private void showShell() {
        LinearLayout shell = new LinearLayout(this);
        shell.setOrientation(LinearLayout.VERTICAL);
        shell.setBackgroundColor(Theme.BG);

        shell.addView(buildHeader());

        content = new FrameLayout(this);
        content.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));
        shell.addView(content);

        tabBar = buildTabBar();
        shell.addView(tabBar);

        root.removeAllViews();
        root.addView(shell, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        screens[0] = new ScreenKeys(this);
        screens[1] = new ScreenOrders(this);
        screens[2] = new ScreenAudit(this);
        screens[3] = new ScreenSettings(this);

        goTab(0);
        refreshStats();
    }

    private LinearLayout buildHeader() {
        LinearLayout head = new LinearLayout(this);
        head.setOrientation(LinearLayout.VERTICAL);
        head.setBackgroundColor(Theme.BG);
        head.setPadding(Theme.dp(this, 20), Theme.dp(this, 16), Theme.dp(this, 20), Theme.dp(this, 6));
        head.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout top = Ui.row(this);

        LinearLayout nameCol = new LinearLayout(this);
        nameCol.setOrientation(LinearLayout.VERTICAL);
        nameCol.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView name = new TextView(this);
        name.setText("관리자");
        name.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 18f);
        name.setTextColor(Theme.TEXT);
        name.setTypeface(android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.BOLD));
        name.setIncludeFontPadding(false);
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        np.topMargin = Theme.dp(this, 4);
        nameCol.addView(name, np);
        top.addView(nameCol);

        TextView refresh = Ui.btnSm(this, "새로고침", Theme.PRIMARY, false);
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        refresh.setLayoutParams(rp);
        refresh.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { reloadCurrent(); refreshStats(); }
        });
        top.addView(refresh);
        head.addView(top);

        statsRow = Ui.row(this);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        sp.topMargin = Theme.dp(this, 14);
        statsRow.setLayoutParams(sp);
        paintStats();
        head.addView(statsRow);

        return head;
    }

    private LinearLayout buildTabBar() {
        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(Theme.BG2);
        bar.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        LinearLayout wrap = new LinearLayout(this);
        wrap.setOrientation(LinearLayout.VERTICAL);
        wrap.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        View line = new View(this);
        line.setBackgroundColor(Theme.LINE);
        line.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, Math.max(1, Theme.dp(this, 1))));
        wrap.addView(line);

        LinearLayout items = new LinearLayout(this);
        items.setOrientation(LinearLayout.HORIZONTAL);
        items.setPadding(Theme.dp(this, 8), Theme.dp(this, 4), Theme.dp(this, 8), Theme.dp(this, 6));
        items.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));
        for (int i = 0; i < TABS.length; i++) {
            final int idx = i;
            LinearLayout b = Ui.tabButton(this, TAB_GLYPHS[i], TABS[i], TAB_COLORS[i], i == tab);
            b.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { goTab(idx); }
            });
            items.addView(b);
        }
        wrap.addView(items);
        bar.addView(wrap);
        return bar;
    }

    private void paintTabBar() {
        if (tabBar == null || tabBar.getChildCount() == 0) return;
        View wrap = tabBar.getChildAt(0);
        if (!(wrap instanceof LinearLayout) || ((LinearLayout) wrap).getChildCount() < 2) return;
        View itemsV = ((LinearLayout) wrap).getChildAt(1);
        if (!(itemsV instanceof LinearLayout)) return;
        LinearLayout items = (LinearLayout) itemsV;
        for (int i = 0; i < items.getChildCount() && i < TABS.length; i++) {
            Ui.paintTab(items.getChildAt(i), TAB_COLORS[i], i == tab);
        }
    }

    /** 탭 이동. 처음 들어가는 탭이면 자동으로 reload() 한다. */
    public void goTab(int i) {
        if (i < 0 || i >= screens.length || content == null) return;
        tab = i;
        Theme.setAccent(TAB_COLORS[i]);
        paintTabBar();
        Screen s = screens[i];
        if (s == null) return;
        content.removeAllViews();
        View v = null;
        try {
            v = s.view();
        } catch (Throwable t) {
            App.log(this, TABS[i] + " 화면 생성에 실패했습니다: " + t);
        }
        if (v == null) {
            content.addView(Ui.emptyBox(this, "화면을 열지 못했습니다. [설정] → 앱 로그를 확인하십시오."),
                    new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                            FrameLayout.LayoutParams.WRAP_CONTENT));
            return;
        }
        content.addView(v, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        if (!loaded[i]) {
            loaded[i] = true;
            reloadCurrent();
        }
    }

    /** 지금 보고 있는 탭을 다시 읽는다 */
    public void reloadCurrent() {
        if (tab < 0 || tab >= screens.length) return;
        Screen s = screens[tab];
        if (s == null) return;
        Theme.setAccent(TAB_COLORS[tab]);
        try { s.reload(); }
        catch (Throwable t) { App.log(this, TABS[tab] + " 새로고침 실패: " + t); }
    }

    /** 다른 탭을 "다음에 열 때 다시 읽어라" 로 표시한다 (키 발급 → 주문 목록이 낡는 경우) */
    public void invalidate(int i) {
        if (i >= 0 && i < loaded.length) loaded[i] = false;
    }

    // ── 통계 요약 바 ──────────────────────────────────────────────────────────

    /** 마지막으로 읽은 /admin/stats (없으면 null) */
    public JSONObject statsJson() { return stats; }

    /** /admin/stats 다시 읽고 상단 바를 갱신한다 */
    public void refreshStats() {
        if (statsBusy || content == null) return;
        statsBusy = true;
        Api.stats(this, new Api.Cb() {
            @Override public void done(Api.Result r) {
                statsBusy = false;
                if (r.ok) {
                    stats = r.json;
                    paintStats();
                    return;
                }
                if (kicked(r)) return;
                // 통계는 부가정보라 화면을 막지 않는다. 대신 로그에 남는다(Api 가 이미 남겼다).
                paintStats();
            }
        });
    }

    private void paintStats() {
        if (statsRow == null) return;
        statsRow.removeAllViews();
        JSONObject s = stats;
        String total    = (s == null) ? "–" : Ui.num(s.optLong("total", 0));
        String active   = (s == null) ? "–" : Ui.num(s.optLong("active", 0));
        String expiring = (s == null) ? "–" : Ui.num(s.optLong("expiring_7d", 0));
        long pendingN   = (s == null) ? 0 : s.optLong("pending_orders", 0);
        String pending  = (s == null) ? "–" : Ui.num(pendingN);

        LinearLayout t1 = Ui.statTile(this, Icon.KEY, "총 키", total, Theme.GOLD_HI);
        LinearLayout t2 = Ui.statTile(this, Icon.CHECK, "활성", active, Theme.ACCENT);
        LinearLayout t3 = Ui.statTile(this, Icon.CLOCK, "7일내 만료", expiring, Theme.AMBER);
        LinearLayout t4 = Ui.statTile(this, Icon.RECEIPT, "대기 주문", pending, pendingN > 0 ? Theme.F_ORDERS : Theme.SUB);

        tileGoes(t1, 0); tileGoes(t2, 0); tileGoes(t3, 0); tileGoes(t4, 1);

        // 마지막 타일은 오른쪽 여백 없이
        LinearLayout.LayoutParams lp = (LinearLayout.LayoutParams) t4.getLayoutParams();
        lp.rightMargin = 0;
        t4.setLayoutParams(lp);

        statsRow.addView(t1); statsRow.addView(t2); statsRow.addView(t3); statsRow.addView(t4);
    }

    private void tileGoes(View tile, final int toTab) {
        tile.setClickable(true);
        Ui.press(tile);
        tile.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { goTab(toTab); }
        });
    }

    // ── 공통 ──────────────────────────────────────────────────────────────────

    /**
     * 401 이면 로그인 화면으로 돌려보내고 true. 화면들은 결과 처리 첫 줄에서 이걸 불러라.
     */
    public boolean kicked(Api.Result r) {
        if (r == null || !r.unauthorized) return false;
        Api.signOut(this);
        App.log(this, "비밀번호 불일치로 로그아웃 처리됨");
        showLogin("비밀번호가 일치하지 않습니다. 다시 입력하십시오.");
        return true;
    }

    /** 실패를 사용자에게 보여준다 (토스트 + 로그) */
    public void fail(String what, Api.Result r) {
        String msg = (r == null || r.error == null) ? "알 수 없는 오류" : r.error;
        Ui.toast(this, what + " 실패 — " + msg);
        App.log(this, what + " 실패: " + msg);
    }

    @Override public void onBackPressed() {
        if (content != null && tab != 0) { goTab(0); return; }
        super.onBackPressed();
    }

    private void mt(View v, int dp) {
        LinearLayout.LayoutParams lp = (v.getLayoutParams() instanceof LinearLayout.LayoutParams)
                ? (LinearLayout.LayoutParams) v.getLayoutParams()
                : new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Theme.dp(this, dp);
        v.setLayoutParams(lp);
    }
}
