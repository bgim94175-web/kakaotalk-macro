package com.buseong.kakaoauto;

import android.content.Context;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

/**
 * 카카오톡 계정 화면 (UI_V3 6장). 삼성 듀얼 메신저·직장 프로필처럼 한 폰에 카톡이 여러 개
 * 깔린 경우를 다룬다. 내정보 탭의 `카톡 계정 ›` 과 대상 방 화면에서 Nav.push 로 열린다.
 *
 * 계정 1개면 목록 대신 안내만 보여준다 — 고를 게 없는 화면에 체크박스를 두면 그게 곧 복잡도다.
 * 계정이 2개 이상이면 계정마다 카드 하나:
 *   - 체크박스 = 사용 여부 ({@code Settings.accounts}). 전부 해제는 막는다.
 *   - ✕ = 계정 기록 삭제 (감지된 대화방 캐시까지 정리). 확인창 필요.
 *   - `표시 이름 ›` = 이름 수정. 빈 값을 넣으면 자동 이름으로 복원된다.
 */
public final class ScreenAccounts {
    private ScreenAccounts() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private static final int ROW_H = 56;
    private static final int ROW_PH = 16;

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;
    private static WeakReference<View> SNACK;

    // ── 셸 ──────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        Theme.setAccent(Theme.F_ACCOUNT);
        LinearLayout col = Ui.screen(a);
        ACT = new WeakReference<MainActivity>(a);
        BODY = new WeakReference<LinearLayout>(col);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "카카오톡 계정 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (a == null || col == null || a.isFinishing()) return;
        int keep = Theme.accent();
        try {
            Theme.setAccent(Theme.F_ACCOUNT);
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "카카오톡 계정 목록 갱신에 실패했습니다: " + t);
        } finally {
            Theme.setAccent(keep);
        }
    }

    // ── 본문 ────────────────────────────────────────────────────────────────

    private static void fill(final MainActivity a, LinearLayout col) {
        final List<Accounts.Acc> list = Accounts.all(a);

        if (list.isEmpty()) {
            col.addView(Nav.note(a, "감지된 카카오톡 계정이 없습니다. 카카오톡 메시지를 1회 수신하면 "
                    + "자동으로 등록됩니다.", Theme.ACCENT2, null, null));
            return;
        }

        if (list.size() == 1) {
            single(a, col, list.get(0));
            return;
        }

        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "라이선스 인증 전에는 설정이 저장되지 않습니다. "
                    + "내정보 탭에서 인증을 완료하십시오.", Theme.AMBER, null, null));
        }

        final ArrayList<String> keys = new ArrayList<String>();
        for (int i = 0; i < list.size(); i++) keys.add(list.get(i).key);

        Settings s = Settings.load(a);
        int used = 0;
        for (int i = 0; i < keys.size(); i++) if (s.accountOn(keys.get(i))) used++;

        LinearLayout hero = Ui.hero(a, Theme.F_ACCOUNT, Icon.USERS, "KAKAOTALK ACCOUNTS", "카카오톡 계정",
                "이 기기에서 감지된 카카오톡 계정입니다. 체크한 계정만 발송·응답 대상이 됩니다.");
        hero.addView(Ui.heroRule(a, Theme.F_ACCOUNT));
        LinearLayout stats = Ui.row(a);
        stats.setPadding(0, Theme.dp(a, 10), 0, 0);
        stats.addView(Ui.stat(a, "감지 계정", list.size() + "개", Theme.TEXT));
        stats.addView(Ui.stat(a, "사용", used + "개", (used == 0) ? Theme.AMBER : Theme.TEXT));
        hero.addView(stats);
        col.addView(hero);

        col.addView(Ui.sectionHeader(a, null, "발송 대상 계정"));
        TextView lead = Ui.sub(a, "체크한 계정의 대화방만 발송·응답 대상이 됩니다. "
                + "계정 " + list.size() + "개 · 사용 " + used + "개");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.bottomMargin = Theme.dp(a, 10);
        lead.setLayoutParams(lp);
        col.addView(lead);

        for (int i = 0; i < list.size(); i++) {
            col.addView(card(a, list.get(i), keys));
        }

        TextView help = Ui.sub(a, "계정 이름은 카카오톡 프로필 이름을 따릅니다. "
                + "읽지 못한 경우 순번으로 표시되며 직접 수정할 수 있습니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.topMargin = Theme.dp(a, 10);
        help.setLayoutParams(hp);
        col.addView(help);
    }

    /** 계정이 1개뿐일 때 — 고를 게 없으니 안내와 이름 수정만 둔다 (UI_V3 6장) */
    private static void single(final MainActivity a, LinearLayout col, final Accounts.Acc ac) {
        col.addView(Nav.note(a, "카카오톡 계정 1개가 감지되었습니다. 듀얼 메신저 등으로 계정을 추가하면 "
                + "계정별로 방을 구분할 수 있습니다.", Theme.ACCENT2, null, null));

        col.addView(Ui.sectionHeader(a, null, "계정 정보"));
        LinearLayout g = Ui.group(a);
        g.addView(Ui.navRow(a, "표시 이름", ac.name, 0, new Runnable() {
            @Override public void run() { rename(a, ac); }
        }));
        g.addView(infoRow(a, "감지된 대화방", KakaoListener.roomCount(a, ac.key) + "개"));
        g.addView(infoRow(a, "마지막 감지", ScreenRooms.ago(ac.lastAt)));
        col.addView(g);
    }

    /** 계정 1개 = 카드 1장. 체크·삭제·이름 수정이 각각 다른 행이라 헷갈릴 일이 없다. */
    private static LinearLayout card(final MainActivity a, final Accounts.Acc ac,
                                     final ArrayList<String> keys) {
        LinearLayout g = Ui.group(a);

        boolean on = Settings.load(a).accountOn(ac.key);
        int rooms = KakaoListener.roomCount(a, ac.key);
        String sub = "대화방 " + rooms + "개 · "
                + ((ac.lastAt > 0) ? ("마지막 감지 " + ScreenRooms.ago(ac.lastAt)) : "감지 기록 없음");

        g.addView(Ui.checkRow(a, title(ac), sub, null, on, new Ui.OnToggle() {
            @Override public void on(boolean v) { setOn(a, keys, ac, v); }
        }, new Runnable() {
            @Override public void run() { forget(a, ac); }
        }));

        g.addView(Ui.navRow(a, "표시 이름", ac.name, 0, new Runnable() {
            @Override public void run() { rename(a, ac); }
        }));
        return g;
    }

    /** `업무 계정 (김부성)` — 카톡 프로필 이름이 표시 이름과 다를 때만 덧붙인다 */
    private static String title(Accounts.Acc ac) {
        if (ac.selfName == null || ac.selfName.length() == 0) return ac.name;
        if (ac.selfName.equals(ac.name)) return ac.name;
        return ac.name + " (" + ac.selfName + ")";
    }

    // ── 사용 여부 ───────────────────────────────────────────────────────────

    /**
     * 사용 여부 저장. 전부 켜진 상태는 빈 목록으로 저장한다 — 빈 목록이 곧 「모든 계정」이라
     * 나중에 계정이 하나 더 감지돼도 자동으로 포함된다.
     * 마지막 1개를 해제하려 하면 막는다 (전부 해제하면 발송이 전면 중단된다).
     */
    private static void setOn(final MainActivity a, ArrayList<String> keys,
                             Accounts.Acc ac, boolean on) {
        Settings s = Settings.load(a);
        ArrayList<String> next = new ArrayList<String>();
        for (int i = 0; i < keys.size(); i++) {
            String k = keys.get(i);
            boolean v = k.equals(ac.key) ? on : s.accountOn(k);
            if (v) next.add(k);
        }
        if (next.isEmpty()) {
            snack("대상 계정을 모두 해제할 수 없습니다. 최소 1개 계정을 사용 상태로 유지하십시오.",
                    null, null);
            refresh();
            return;
        }
        s.setAccounts((next.size() == keys.size()) ? new ArrayList<String>() : next);
        s.save(a);
        Log.add(a, "발송 대상 계정을 변경했습니다: 사용 " + next.size() + "개 / " + keys.size() + "개");
        Nav.reload();
    }

    // ── 이름 수정 ───────────────────────────────────────────────────────────

    private static void rename(final MainActivity a, final Accounts.Acc ac) {
        Nav.editText(a, "표시 이름", "계정 이름", ac.name, false,
                "최대 " + Accounts.NAME_MAX + "자. 비워 두면 카카오톡 프로필 이름 또는 순번으로 복원됩니다.",
                new Nav.OnText() {
                    @Override public String text(String value) {
                        String v = (value == null) ? "" : value.trim();
                        if (v.length() > Accounts.NAME_MAX) {
                            return "계정 이름은 최대 " + Accounts.NAME_MAX + "자까지 입력할 수 있습니다.";
                        }
                        Accounts.rename(a, ac.key, v);
                        refresh();
                        Nav.reload();
                        return null;
                    }
                });
    }

    // ── 계정 기록 삭제 ──────────────────────────────────────────────────────

    /**
     * 계정 기록 삭제. 그 계정으로 감지된 대화방·세션도 같이 정리된다({@link Accounts#forget}).
     * 대상 계정 목록에서도 빼야 한다 — 안 그러면 없는 계정만 대상으로 남아 발송이 전면 중단된다.
     */
    private static void forget(final MainActivity a, final Accounts.Acc ac) {
        final int rooms = KakaoListener.roomCount(a, ac.key);
        Nav.confirm(a, "계정 기록 삭제",
                "「" + ac.name + "」 계정 기록과 이 계정에서 감지된 대화방 " + rooms + "개를 삭제합니다. "
                        + "해당 계정의 알림이 다시 수신되면 새로 등록됩니다.",
                "삭제", new Runnable() {
                    @Override public void run() {
                        Settings s = Settings.load(a);
                        if (s.accounts != null && !s.accounts.isEmpty()) {
                            ArrayList<String> next = new ArrayList<String>();
                            for (int i = 0; i < s.accounts.size(); i++) {
                                String k = s.accounts.get(i);
                                if (k == null) continue;
                                if (k.trim().equals(ac.key)) continue;
                                next.add(k);
                            }
                            s.setAccounts(next);   // 비면 「모든 계정」으로 돌아간다
                            s.save(a);
                        }
                        try {
                            Accounts.forget(a, ac.key);
                        } catch (Throwable t) {
                            Log.add(a, "계정 기록 삭제 실패: " + t);
                            snack("계정 기록을 삭제하지 못했습니다. 다시 시도하십시오.", null, null);
                            return;
                        }
                        refresh();
                        Nav.reload();
                        snack("계정 기록을 삭제했습니다.", null, null);
                    }
                });
    }

    // ── 자잘한 것 ───────────────────────────────────────────────────────────

    /** 누를 수 없는 읽기 전용 행 (navRow 와 같은 높이·여백, `›` 만 없다) */
    private static LinearLayout infoRow(Context c, String title, String value) {
        LinearLayout r = Ui.row(c);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setMinimumHeight(Theme.dp(c, ROW_H));
        int ph = Theme.dp(c, ROW_PH);
        int pv = Theme.dp(c, 12);
        r.setPadding(ph, pv, ph, pv);
        r.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        TextView t = Ui.body(c, title);
        t.setTextColor(Theme.TEXT);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        r.addView(t);

        TextView v = Ui.sub(c, value);
        v.setGravity(Gravity.END);
        v.setSingleLine(true);
        v.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(WRAP, WRAP);
        vp.leftMargin = Theme.dp(c, 12);
        v.setLayoutParams(vp);
        r.addView(v);

        r.setContentDescription(title + ", " + value);
        return r;
    }

    /** 스낵바는 한 번에 하나만 */
    private static void snack(String msg, String action, Runnable onAction) {
        View old = (SNACK == null) ? null : SNACK.get();
        if (old instanceof Ui.Snack) {
            try { ((Ui.Snack) old).dismiss(); } catch (Throwable ignore) { /* 무해 */ }
        }
        View v = Nav.snack(msg, action, onAction);
        SNACK = (v == null) ? null : new WeakReference<View>(v);
    }
}
