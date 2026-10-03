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
        try {
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "카카오톡 계정 목록 갱신에 실패했습니다: " + t);
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
        // 복제 앱으로 로그인한 카톡은 구조적으로 감지할 수 없다. 여기가 사장이
        // "왜 두 번째 계정이 안 보이지" 를 확인하러 오는 자리이므로 그 사실을 적는다.
        col.addView(Nav.note(a, "계정이 추가되지 않는 경우: 휴대폰 설정의 「듀얼 메신저」"
                + "(삼성) 또는 「듀얼 앱」(샤오미 등) 으로 추가한 카카오톡만 인식됩니다.\n"
                + "「다중계정」 같은 복제 앱으로 로그인한 카카오톡은 인식되지 않으며 발송도 "
                + "되지 않습니다. 그 앱들은 카카오톡을 자기 앱 안에서 돌려서, 알림이 "
                + "카카오톡이 아닌 그 앱 이름으로 올라오기 때문입니다.",
                Theme.ACCENT2, null, null));
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.topMargin = Theme.dp(a, 10);
        help.setLayoutParams(hp);
        col.addView(help);

        // 중복 발송 방지 — 두 계정이 같은 대화방에 들어가 있을 때의 간격(텀)
        col.addView(Ui.sectionHeader(a, null, "중복 발송 방지"));
        final Settings gs = Settings.load(a);
        long sec = gs.crossAccountGapMs / 1000L;
        String gapVal = (gs.crossAccountGapMs <= 0) ? "사용 안 함" : (sec + "초");
        LinearLayout gg = Ui.group(a);
        gg.addView(Ui.navRow(a, "계정 간 발송 간격", gapVal, 0, new Runnable() {
            @Override public void run() { editGap(a); }
        }));
        col.addView(gg);
        // 문구가 실제 동작과 달랐다("건너뜁니다"). 지금 동작을 그대로 적는다.
        col.addView(Nav.note(a, "두 계정이 같은 대화방에 들어가 있을 때, 한 계정이 보낸 뒤 "
                + "이 시간이 지나야 다른 계정이 보냅니다. 건너뛰지 않고 둘 다 보내되 "
                + "동시에 올라가지 않게 합니다.\n"
                + "자동발송은 이 시간 뒤에 다시 보내고, 봇과 메시지 추적은 한 계정만 답합니다"
                + "(같은 명령에 두 번 답하면 도배가 됩니다).\n"
                + "대화방 이름으로 판단하므로, 이름만 같고 실제로는 다른 대화방이면 "
                + "그 방도 이 시간만큼 늦게 발송됩니다. 0으로 두면 끕니다.",
                Theme.ACCENT2, null, null));

        // 간격이 쿨타임보다 길면 발송이 계속 뒤로 밀린다 — 눈에 보이게 알린다.
        int cdMin = gs.macro.cooldownMinMin;
        if (gs.crossAccountGapMs > 0L && gs.crossAccountGapMs >= cdMin * 60000L) {
            col.addView(Nav.note(a, "간격(" + (gs.crossAccountGapMs / 1000L) + "초)이 최소 쿨타임("
                    + cdMin + "분)보다 길거나 같습니다. 이 상태에서는 두 번째 계정의 발송이 "
                    + "계속 뒤로 밀릴 수 있습니다. 간격을 쿨타임보다 짧게 설정하십시오.",
                    Theme.AMBER, null, null));
        }
    }

    private static void editGap(final MainActivity a) {
        final Settings s = Settings.load(a);
        final Nav.NumField f = new Nav.NumField("간격 (초)", "60", 0, 3600,
                (int) (s.crossAccountGapMs / 1000L));
        Nav.editNums(a, "계정 간 발송 간격",
                "0으로 두면 끕니다. 대화방 이름이 같을 때만 적용되며, 최소 쿨타임보다 짧게 "
                        + "설정하십시오.",
                new Nav.NumField[] { f }, new Nav.OnNums() {
                    @Override public String ok() {
                        s.crossAccountGapMs = (long) f.value * 1000L;
                        if (!s.save(a)) {
                            return "저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.";
                        }
                        Log.add(a, "계정 간 발송 간격을 " + f.value + "초로 변경했습니다.");
                        Nav.reload();
                        return null;
                    }
                });
    }

    /** 계정이 1개뿐일 때 — 고를 게 없으니 안내와 이름 수정만 둔다 (UI_V3 6장) */
    private static void single(final MainActivity a, LinearLayout col, final Accounts.Acc ac) {
        col.addView(Nav.note(a, "카카오톡 계정 1개가 감지되었습니다. 듀얼 메신저 등으로 계정을 추가하면 "
                + "계정별로 대상 대화방을 구분할 수 있습니다.", Theme.ACCENT2, null, null));

        col.addView(Ui.sectionHeader(a, null, "계정 정보"));
        LinearLayout g = Ui.group(a);
        g.addView(Ui.navRow(a, "표시 이름", ac.name, 0, new Runnable() {
            @Override public void run() { rename(a, ac); }
        }));
        g.addView(infoRow(a, "감지된 대화방", KakaoListener.roomCount(a, ac.key) + "개"));
        g.addView(infoRow(a, "마지막 감지", ScreenRooms.ago(ac.lastAt)));
        col.addView(g);

        // 계정이 1개뿐이어도 매크로 기본값은 편집할 수 있다 (이 계정의 기본값이 곧 전체 기본).
        col.addView(Ui.sectionHeader(a, null, "매크로"));
        LinearLayout gm = Ui.group(a);
        gm.addView(macroRow(a, ac.key));
        col.addView(gm);
        col.addView(Nav.note(a, "메시지·쿨타임·새 메시지 최소 개수를 이 계정 기준으로 개별 지정할 수 있습니다. "
                + "설정하지 않으면 전체 기본값을 따릅니다.", Theme.ACCENT2, null, null));
    }

    /** 계정 카드·정보 화면에 공통으로 붙는 「매크로 기본값 ›」 행 */
    private static LinearLayout macroRow(final MainActivity a, final String accKey) {
        Settings s = Settings.load(a);
        Settings.AccountCfg stored = (s.macro.accountCfgs == null)
                ? null : s.macro.accountCfgs.get(accKey);
        String val;
        int color;
        if (stored != null && !stored.on) {
            val = "매크로 꺼짐";
            color = Theme.DIM;
        } else if (accHasOverride(stored)) {
            val = "개별 설정";
            color = Theme.TEXT;
        } else {
            val = "설정 안 함";
            color = Theme.DIM;
        }
        return Ui.navRow(a, "매크로 기본값", val, color, new Runnable() {
            @Override public void run() {
                Nav.push(a, "계정 매크로 기본값", accountEditor(a, accKey));
            }
        });
    }

    /** 이 계정에 덮어쓰기(또는 끄기)가 하나라도 걸려 있나 */
    private static boolean accHasOverride(Settings.AccountCfg ac) {
        return ac != null && (!ac.on || ac.hasMsg || ac.hasCd || ac.hasMin);
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
        g.addView(macroRow(a, ac.key));
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
        // rename()·forget() 와 동일하게 이 화면도 다시 그려 상단 요약·카드 소계를 갱신한다.
        // (Nav.reload() 는 ScreenAccount 만 갱신하고 이 복수형 화면은 건드리지 않는다)
        refresh();
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
                            // 이 계정의 매크로 기본값(AccountCfg)과 소속 방 덮어쓰기(RoomCfg)도 정리한다.
                            Settings gs = Settings.load(a);
                            if (gs.macro.accountCfgs != null) gs.macro.accountCfgs.remove(ac.key);
                            if (gs.macro.roomCfgs != null) {
                                java.util.Iterator<String> it = gs.macro.roomCfgs.keySet().iterator();
                                while (it.hasNext()) {
                                    if (RoomRef.parse(it.next()).acc.equals(ac.key)) it.remove();
                                }
                            }
                            gs.save(a);
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

    // ── 계정 매크로 기본값 편집 (서브화면) ───────────────────────────────────
    //  매크로 기본값 › 에서 Nav.push 로 열린다. 값은 고치는 즉시 저장된다.
    //  계정값은 방별 덮어쓰기와 전역 기본값 사이에 있다 (우선순위: 대화방 › 계정 › 전역).

    private static WeakReference<LinearLayout> EDIT_BODY;
    private static String EDIT_KEY;

    private static View accountEditor(final MainActivity a, final String accKey) {
        LinearLayout col = Ui.screen(a);
        EDIT_BODY = new WeakReference<LinearLayout>(col);
        EDIT_KEY = accKey;
        try {
            fillEditor(a, col, accKey);
        } catch (Throwable t) {
            Log.add(a, "계정 매크로 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    private static void refreshEditor() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (EDIT_BODY == null) ? null : EDIT_BODY.get();
        String key = EDIT_KEY;
        if (a == null || col == null || key == null || a.isFinishing()
                || !col.isAttachedToWindow()) return;
        try {
            col.removeAllViews();
            fillEditor(a, col, key);
        } catch (Throwable t) {
            Log.add(a, "계정 매크로 화면 갱신에 실패했습니다: " + t);
        }
    }

    private static void fillEditor(final MainActivity a, LinearLayout col, final String accKey) {
        final Settings s = Settings.load(a);
        final Settings.AccountCfg ac = s.accCfg(accKey);   // 편집용 get-or-create
        final String accName = Accounts.nameOf(a, accKey);

        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "라이선스 인증 전에는 설정이 저장되지 않습니다. "
                    + "내정보 탭에서 인증을 완료하십시오.", Theme.AMBER, null, null));
        }

        // ── 이 계정 매크로 on/off ──
        col.addView(Ui.sectionHeader(a, null, "계정 매크로"));
        LinearLayout g0 = Ui.group(a);
        g0.addView(Ui.navRowSwitch(a, "이 계정 발송", "끄면 이 계정의 모든 대화방에 자동발송하지 않습니다.",
                ac.on, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        ac.on = v;
                        persistAcc(a, s, "「" + accName + "」 계정 매크로를 "
                                + (v ? "사용으로" : "미사용으로") + " 변경했습니다.");
                    }
                }));
        col.addView(g0);

        // ── 이 계정의 유효 기본값 안내 (전역값 대비) ──
        String msg = ac.hasMsg ? ac.message : s.macro.message;
        boolean willSend = (msg != null && msg.trim().length() > 0);
        int cdMin = ac.hasCd ? ac.cdMinMin : s.macro.cooldownMinMin;
        int cdMax = ac.hasCd ? ac.cdMaxMin : s.macro.cooldownMaxMin;
        int mm = ac.hasMin ? ac.minMessages : s.macro.minMessages;
        if (!ac.on) {
            col.addView(Nav.note(a, "이 계정 매크로가 꺼져 있어 자동발송 대상에서 제외됩니다.",
                    Theme.AMBER, null, null));
        } else if (!willSend) {
            col.addView(Nav.note(a, "유효 발송 메시지가 비어 있어 이 계정에는 발송되지 않습니다. "
                    + "아래에서 이 항목만 개별 지정하거나, 전체 기본 메시지를 설정하십시오.", Theme.AMBER, null, null));
        } else {
            col.addView(Nav.note(a, "이 계정의 대화방은 기본적으로 " + cdMin + "~" + cdMax
                    + "분 주기로 발송되며, 새 메시지 최소 개수는 " + mm + "개입니다.\n"
                    + "발송 메시지: " + Nav.preview(msg, 40), Theme.ACCENT2, null, null));
        }

        // ── 덮어쓰기 ──
        col.addView(Ui.sectionHeader(a, null, "개별 설정"));
        LinearLayout g = Ui.group(a);

        g.addView(Ui.navRowSwitch(a, "메시지 개별 설정", ac.hasMsg ? null : "끄면 전체 기본값을 따릅니다.",
                ac.hasMsg, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        ac.hasMsg = v;
                        persistAcc(a, s, null);
                    }
                }));
        if (ac.hasMsg) {
            boolean empty = (ac.message == null || ac.message.trim().length() == 0);
            g.addView(Ui.navRow(a, "메시지 편집", empty ? "설정 필요" : Nav.preview(ac.message, 18),
                    empty ? Theme.AMBER : Theme.TEXT, new Runnable() {
                        @Override public void run() { editAccMessage(a, s, accName, ac); }
                    }));
        }

        g.addView(Ui.navRowSwitch(a, "쿨타임 개별 설정", ac.hasCd ? null : "끄면 전체 기본값을 따릅니다.",
                ac.hasCd, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        ac.hasCd = v;
                        persistAcc(a, s, null);
                    }
                }));
        if (ac.hasCd) {
            g.addView(Ui.navRow(a, "쿨타임", ac.cdMinMin + "~" + ac.cdMaxMin + "분", Theme.TEXT,
                    new Runnable() {
                        @Override public void run() { editAccCd(a, s, accName, ac); }
                    }));
        }

        g.addView(Ui.navRowSwitch(a, "새 메시지 최소 개수 개별 설정",
                ac.hasMin ? null : "끄면 전체 기본값을 따릅니다.", ac.hasMin, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        ac.hasMin = v;
                        persistAcc(a, s, null);
                    }
                }));
        if (ac.hasMin) {
            g.addView(Ui.navRow(a, "새 메시지 최소 개수", ac.minMessages + "개", Theme.TEXT, new Runnable() {
                @Override public void run() { editAccMin(a, s, accName, ac); }
            }));
        }
        col.addView(g);

        col.addView(Nav.note(a, "개별 설정을 끄면 전체 기본값을 따릅니다. "
                + "대화방별 설정이 있으면 그 값이 계정 기본값보다 우선합니다.", Theme.ACCENT2, null, null));
    }

    /** 계정 설정을 저장하고 편집 화면·계정 목록·매크로 탭 요약을 갱신한다 */
    private static void persistAcc(final MainActivity a, Settings s, String log) {
        if (!s.save(a)) {
            snack("저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.", null, null);
            return;
        }
        if (log != null && log.length() > 0) Log.add(a, log);
        refreshEditor();
        refresh();
        Nav.reload();
    }

    private static void editAccMessage(final MainActivity a, final Settings s, final String accName,
                                       final Settings.AccountCfg ac) {
        Nav.editText(a, "계정 메시지", "발송할 내용을 입력하십시오", ac.message, true,
                "이 계정 기준으로 적용되는 메시지입니다. 최대 2000자.", new Nav.OnText() {
                    @Override public String text(String value) {
                        if (value == null || value.trim().length() == 0) {
                            return "발송 메시지를 입력하십시오.";
                        }
                        if (value.length() > 2000) return "2000자 이하로 입력하십시오.";
                        ac.message = value;
                        if (!s.save(a)) {
                            return "저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.";
                        }
                        Log.add(a, "「" + accName + "」 계정 메시지를 변경했습니다.");
                        refreshEditor();
                        refresh();
                        Nav.reload();
                        return null;
                    }
                });
    }

    private static void editAccCd(final MainActivity a, final Settings s, final String accName,
                                  final Settings.AccountCfg ac) {
        final Nav.NumField lo = new Nav.NumField("최소 쿨타임 (분)", "20", 1, 1440, ac.cdMinMin);
        final Nav.NumField hi = new Nav.NumField("최대 쿨타임 (분)", "40", 1, 1440, ac.cdMaxMin);
        Nav.editNums(a, "쿨타임", "최소~최대 사이의 임의 시각에 발송됩니다.",
                new Nav.NumField[] { lo, hi }, new Nav.OnNums() {
                    @Override public String ok() {
                        if (lo.value > hi.value) {
                            Nav.errText(hi.err, "최대 쿨타임은 최소 쿨타임 이상으로 입력하십시오");
                            return "";
                        }
                        ac.cdMinMin = lo.value;
                        ac.cdMaxMin = hi.value;
                        if (!s.save(a)) {
                            return "저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.";
                        }
                        Log.add(a, "「" + accName + "」 계정 쿨타임을 "
                                + lo.value + "~" + hi.value + "분으로 변경했습니다.");
                        refreshEditor();
                        refresh();
                        Nav.reload();
                        return null;
                    }
                });
    }

    private static void editAccMin(final MainActivity a, final Settings s, final String accName,
                                   final Settings.AccountCfg ac) {
        final Nav.NumField mm = new Nav.NumField("새 메시지 최소 개수", "1", 0, 999, ac.minMessages);
        Nav.editNums(a, "새 메시지 최소 개수",
                "마지막 발송 이후 상대 메시지가 이 수량 이상 누적된 경우에만 발송합니다. 0은 항상 발송입니다.",
                new Nav.NumField[] { mm }, new Nav.OnNums() {
                    @Override public String ok() {
                        ac.minMessages = mm.value;
                        if (!s.save(a)) {
                            return "저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.";
                        }
                        Log.add(a, "「" + accName + "」 계정 새 메시지 최소 개수를 "
                                + mm.value + "개로 변경했습니다.");
                        refreshEditor();
                        refresh();
                        Nav.reload();
                        return null;
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
