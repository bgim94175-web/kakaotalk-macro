package com.buseong.kakaoauto;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 대상 대화방 관리 화면 (UI_V3 5장). 매크로 탭의 `대상 방 ›` 에서 Nav.push 로 열린다.
 *
 * 한 화면에서 선택·삭제·추가를 다 한다:
 *   - 계정별 섹션 → 그 계정의 대화방을 체크박스 목록으로 (계정 1개면 머리글 숨김)
 *   - 체크하면 즉시 저장. 단체방은 확인창 없이 바로 켜지고 스낵바로 되돌릴 수 있다.
 *     (1:1 개인 대화방과 아직 종류를 모르는 방만 확인창을 띄운다 — 사고가 나는 쪽이 그쪽이다)
 *   - 방이 많으면 위에 이름 검색칸과 「단체방 전체 선택」 이 생긴다
 *   - ✕ 는 감지 목록에서 1건 삭제 (멤버 이름이 방으로 잘못 들어간 항목 정리) + 5초 실행 취소
 *   - [직접 입력 추가] 는 아직 감지 안 된 방을 손으로 넣는다
 *   - [초기화] 서브화면에 세 가지가 있다 — 감지 목록만 / 개별 설정 전체 / 방 목록 전체.
 *     보호 대화방과 전체 정지는 어떤 초기화로도 해제되지 않는다.
 *
 * 삭제를 5초 미루는 이유 — KakaoListener 에는 감지 캐시에 방을 다시 넣는 공개 API 가 없다.
 * 그래서 ✕ 를 누르면 화면에서만 먼저 감추고(PENDING), 스낵바가 사라질 때 실제로 지운다.
 * 실행 취소를 누르면 예약을 취소하니까 캐시가 그대로 살아있다. 화면을 나가도 예약은 남는다.
 */
public final class ScreenRooms {
    private ScreenRooms() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private static final long DAY = 86400000L;

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;
    private static WeakReference<View> SNACK;

    /** 섹션 헤더 TextView 참조 (키 = 계정키, 단일 계정은 SINGLE_KEY). 토글 시 수치만 갱신한다. */
    private static final String SINGLE_KEY = "\u0000single";
    private static final LinkedHashMap<String, TextView> HEADERS =
            new LinkedHashMap<String, TextView>();

    private static final Handler H = new Handler(Looper.getMainLooper());

    /** 목록 부분만 담는 칸 (검색어가 바뀔 때 여기만 다시 그린다) */
    private static WeakReference<LinearLayout> LIST;
    /** 이름 검색어. 화면을 새로 열 때 비운다. */
    private static String QUERY = "";

    /** ✕ 를 눌렀지만 아직 실제로 지우지 않은 방 (키 = RoomRef.key()) */
    private static final LinkedHashMap<String, Pending> PENDING =
            new LinkedHashMap<String, Pending>();

    /** 삭제 예약 1건 */
    private static final class Pending {
        RoomRef ref;
        boolean wasSelected;
        Runnable commit;
    }

    /** 화면에 한 줄로 뿌릴 방 (감지된 방 + 선택만 남은 방을 합친 결과) */
    private static final class Row {
        RoomRef ref;
        boolean detected;
        boolean groupKnown;
        boolean group;
        boolean selected;
        long lastAt;
    }

    // ── 셸 ──────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        LinearLayout col = Ui.screen(a);
        ACT = new WeakReference<MainActivity>(a);
        BODY = new WeakReference<LinearLayout>(col);
        QUERY = "";
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "대상 대화방 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 목록을 제자리에서 다시 채운다 (삭제·추가·초기화 후) */
    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (a == null || col == null || a.isFinishing()) return;
        try {
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "대상 대화방 목록 갱신에 실패했습니다: " + t);
        }
    }

    // ── 본문 ────────────────────────────────────────────────────────────────

    private static void fill(final MainActivity a, LinearLayout col) {
        HEADERS.clear();
        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "라이선스 인증 전에는 설정이 저장되지 않습니다. "
                    + "내정보 탭에서 인증을 완료하십시오.", Theme.AMBER, null, null));
        }

        final List<Row> rows = rows(a);
        final List<String> accs = accounts(a, rows);
        final int accCount = Accounts.count(a);

        // 계정이 2개 이상이면 계정 화면으로 가는 길을 맨 위에 둔다 (UI_V3 5장)
        if (accCount >= 2) {
            LinearLayout top = Ui.group(a);
            top.addView(Ui.navRow(a, "카카오톡 계정",
                    accCount + "개 감지 · " + usedAccounts(a, accs) + "개 사용", 0,
                    new Runnable() {
                        @Override public void run() {
                            Nav.push(a, "카카오톡 계정", ScreenAccounts.build(a));
                        }
                    }));
            col.addView(top);
        }

        // 이름이 바뀐 대화방 안내 — 선택돼 있는데 감지가 끊긴 방이 있으면 맨 위에서 알린다.
        View rn = renameNote(a, rows);
        if (rn != null) col.addView(rn);

        if (rows.isEmpty()) {
            LIST = null;
            col.addView(Nav.note(a, "감지된 대화방이 없습니다. 카카오톡 메시지를 1회 수신하면 "
                    + "자동으로 등록되며, 직접 입력하여 추가할 수도 있습니다.", Theme.ACCENT2, null, null));
        } else {
            View tools = toolsCard(a, rows);
            if (tools != null) col.addView(tools);

            LinearLayout list = new LinearLayout(a);
            list.setOrientation(LinearLayout.VERTICAL);
            list.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            LIST = new WeakReference<LinearLayout>(list);
            col.addView(list);
            relist(a);
        }

        // 방 공지 — 각 대화방에 방장·부방장이 올려 둔 공지사항을 한곳에서 본다
        final int noticeN = RoomNotice.count(a);
        LinearLayout gnot = Ui.group(a);
        gnot.addView(Ui.navRow(a, "방 공지",
                (noticeN == 0) ? "없음" : noticeN + "개 대화방",
                (noticeN == 0) ? Theme.DIM : Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "방 공지", noticeListScreen(a)); }
                }));
        col.addView(gnot);

        TextView add = Nav.wideBtn(a, "직접 입력 추가", false, new Runnable() {
            @Override public void run() { addDialog(a); }
        });
        col.addView(add);

        // 초기화는 종류가 셋이다. 빨간 버튼을 셋 쌓으면 실수로 누르기 쉬우므로
        // 전용 화면으로 모으고, 각 항목이 무엇을 지우는지 그 자리에서 보여준다.
        col.addView(Nav.wideBtn(a, "초기화", false, new Runnable() {
            @Override public void run() { Nav.push(a, "초기화", resetScreen(a)); }
        }));

        TextView help = Ui.sub(a, "감지 목록 초기화는 감지된 대화방 기록만 비웁니다. "
                + "선택된 대상 대화방은 유지됩니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.topMargin = Theme.dp(a, 10);
        help.setLayoutParams(hp);
        col.addView(help);
    }

    // ── 목록 부분 · 검색 · 빠른 선택 ─────────────────────────────────────────
    //
    // 손님 의견: "방 선택이 불편하다". 재어 보니 방 20개를 고르는 데 확인창까지 42번을
    // 눌러야 했다. 원인이 넷이었고 넷 다 여기서 고친다 —
    //   (1) 단체방까지 확인창을 띄웠다      → 단체방은 바로 켜고 스낵바로 되돌린다
    //   (2) 여러 개를 한 번에 고를 길이 없었다 → 「단체방 전체 선택」
    //   (3) 이름으로 찾을 길이 없었다        → 이름 검색칸
    //   (4) 하나 켤 때마다 목록이 다시 정렬돼 줄이 튀었다 → 목록만, 그것도 필요할 때만 그린다

    /**
     * 목록 부분만 다시 그린다.
     *
     * 화면 전체({@link #refresh})를 다시 그리지 않는 이유가 둘이다 —
     * (1) 검색어를 한 글자 칠 때마다 전체를 그리면 입력칸이 포커스를 잃어 글자가 끊긴다.
     * (2) 선택을 켤 때 전체를 그리면 '선택된 것 먼저' 정렬로 방금 누른 줄이 위로 튄다.
     */
    private static void relist(final MainActivity a) {
        LinearLayout list = (LIST == null) ? null : LIST.get();
        // ★ 붙어 있는지(isAttachedToWindow)는 보지 않는다 — fill() 이 화면을 조립하는
        //   도중에도 여기를 부르기 때문이다. 그때는 아직 붙어 있지 않다.
        if (list == null || a == null || a.isFinishing()) return;
        list.removeAllViews();
        HEADERS.clear();

        List<Row> all = rows(a);
        List<Row> shown = applyQuery(all);

        if (shown.isEmpty()) {
            LinearLayout g = Ui.group(a);
            TextView t = Ui.sub(a, "「" + QUERY + "」 이(가) 이름에 들어간 대화방이 없습니다.");
            int ph = Theme.dp(a, 16);
            t.setPadding(ph, Theme.dp(a, 18), ph, Theme.dp(a, 18));
            t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            g.addView(t);
            list.addView(g);
            return;
        }

        List<String> accs = accounts(a, all);
        boolean multi = (Accounts.count(a) >= 2) || (accs.size() >= 2);

        if (!multi) {
            int detected = 0;
            int selected = 0;
            for (int i = 0; i < all.size(); i++) {
                if (all.get(i).detected) detected++;
                if (all.get(i).selected) selected++;
            }
            LinearLayout sh = Ui.sectionHeader(a, null,
                    "선택 " + selected + "개 · 감지 " + detected + "개");
            rememberHeader(SINGLE_KEY, sh);
            list.addView(sh);
            addRooms(a, list, shown);
        } else {
            for (int i = 0; i < accs.size(); i++) {
                String acc = accs.get(i);
                List<Row> mine = filter(shown, acc);
                // 검색 중에 결과가 없는 계정은 머리글까지 숨긴다 (빈 칸만 쌓이면 더 헷갈린다)
                if (mine.isEmpty() && QUERY.length() > 0) continue;
                LinearLayout sh = Ui.sectionHeader(a, null, header(a, acc, filter(all, acc)));
                rememberHeader(acc, sh);
                list.addView(sh);
                addRooms(a, list, mine);
            }
        }
    }

    /** 검색어에 맞는 방만 (검색어가 없으면 그대로) */
    private static List<Row> applyQuery(List<Row> in) {
        if (QUERY.length() == 0) return in;
        String q = loose(QUERY);
        if (q.length() == 0) return in;
        ArrayList<Row> out = new ArrayList<Row>();
        for (int i = 0; i < in.size(); i++) {
            Row r = in.get(i);
            if (loose(r.ref.name).contains(q)) out.add(r);
        }
        return out;
    }

    /** 공백·대소문자를 무시한 비교용 글자 (검색에만 쓴다 — 발송 대상 판정에는 쓰지 않는다) */
    private static String loose(String s) {
        if (s == null) return "";
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (Character.isWhitespace(ch)) continue;
            b.append(Character.toLowerCase(ch));
        }
        return b.toString();
    }

    /**
     * 이름 검색 + 빠른 선택 카드. 방이 적으면 아무것도 만들지 않는다 —
     * 방 3개짜리 화면에 검색칸이 있으면 그게 더 불편하다.
     */
    private static View toolsCard(final MainActivity a, List<Row> rows) {
        int bulk = bulkTargets(a, rows).size();
        int selected = 0;
        for (int i = 0; i < rows.size(); i++) if (rows.get(i).selected) selected++;

        boolean wantSearch = rows.size() >= 8;
        boolean wantBulk = bulk >= 2;
        boolean wantClear = selected >= 2;
        if (!wantSearch && !wantBulk && !wantClear) {
            QUERY = "";
            return null;
        }

        LinearLayout g = Ui.group(a);
        boolean first = true;

        if (wantSearch) {
            LinearLayout box = new LinearLayout(a);
            box.setOrientation(LinearLayout.VERTICAL);
            int ph = Theme.dp(a, 16);
            box.setPadding(ph, Theme.dp(a, 12), ph, Theme.dp(a, 12));
            box.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

            final EditText f = Ui.field(a, "대화방 이름 검색");
            f.setSingleLine(true);
            f.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
            f.setText(QUERY);
            f.setSelection(QUERY.length());
            f.addTextChangedListener(new TextWatcher() {
                @Override public void beforeTextChanged(CharSequence s, int st, int c, int af) { }
                @Override public void onTextChanged(CharSequence s, int st, int b, int c) { }
                @Override public void afterTextChanged(Editable e) {
                    final String v = (e == null) ? "" : e.toString();
                    // 한 글자마다 바로 그리면 한글 조합 중에 깜빡인다 → 조금 모아서 그린다
                    H.removeCallbacks(SEARCH);
                    SEARCH_TEXT = v;
                    H.postDelayed(SEARCH, 180L);
                }
            });
            box.addView(f);
            g.addView(box);
            first = false;
        }

        if (wantBulk) {
            if (!first) g.addView(Ui.divider(a));
            g.addView(Ui.navRow(a, "단체방 전체 선택", "한 번에 켜기", Theme.ACCENT,
                    new Runnable() {
                        @Override public void run() { bulkSelect(a); }
                    }));
            first = false;
        }

        if (wantClear) {
            if (!first) g.addView(Ui.divider(a));
            g.addView(Ui.navRow(a, "선택 전체 해제", null, Theme.DIM,
                    new Runnable() {
                        @Override public void run() { bulkClear(a); }
                    }));
        }
        return g;
    }

    /** 검색어가 멈춘 뒤 목록만 다시 그린다 */
    private static String SEARCH_TEXT = "";
    private static final Runnable SEARCH = new Runnable() {
        @Override public void run() {
            MainActivity a = (ACT == null) ? null : ACT.get();
            if (a == null || a.isFinishing()) return;
            if (SEARCH_TEXT.equals(QUERY)) return;
            QUERY = SEARCH_TEXT;
            relist(a);
        }
    };

    /**
     * 「단체방 전체 선택」 의 대상.
     *
     * 아래는 제외한다 — 전부 '한 번에 켜면 사고가 나는' 것들이다.
     *   · 1:1 개인 대화방, 아직 종류를 모르는 방 (한 사람에게 광고가 반복 발송된다)
     *   · 보호 대화방 (어떤 기능으로도 발송하지 않기로 지정한 방)
     *   · 이미 선택된 방
     * 검색 중이면 <b>화면에 보이는 방</b>만 대상이다 — 안 보이는 방이 켜지면 안 된다.
     */
    private static List<RoomRef> bulkTargets(Context c, List<Row> rows) {
        ArrayList<RoomRef> out = new ArrayList<RoomRef>();
        List<Row> shown = applyQuery(rows);
        for (int i = 0; i < shown.size(); i++) {
            Row r = shown.get(i);
            if (r.selected) continue;
            if (!r.groupKnown || !r.group) continue;
            if (SendGuard.isProtected(c, r.ref.name)) continue;
            out.add(r.ref);
        }
        return out;
    }

    private static void bulkSelect(final MainActivity a) {
        final List<RoomRef> targets = bulkTargets(a, rows(a));
        if (targets.isEmpty()) {
            Nav.snack("새로 켤 단체방이 없습니다.", null, null);
            return;
        }
        StringBuilder names = new StringBuilder();
        for (int i = 0; i < targets.size() && i < 6; i++) {
            names.append("\n· ").append(targets.get(i).name);
        }
        if (targets.size() > 6) names.append("\n· 그 외 ").append(targets.size() - 6).append("개");

        Nav.confirm(a, "단체방 " + targets.size() + "개 선택",
                "아래 단체방을 발송 대상으로 사용합니다. 설정한 주기에 따라 메시지가 자동 "
                        + "발송됩니다." + names
                        + "\n\n1:1 개인 대화방과 보호 대화방은 포함되지 않습니다.",
                targets.size() + "개 사용", new Runnable() {
                    @Override public void run() {
                        int n = selectMany(a, targets, true);
                        Nav.snack(n + "개를 발송 대상으로 켰습니다.", null, null);
                        refresh();
                    }
                });
    }

    private static void bulkClear(final MainActivity a) {
        final List<RoomRef> cur = new ArrayList<RoomRef>(Settings.load(a).macro.roomRefs());
        if (cur.isEmpty()) {
            Nav.snack("선택된 대화방이 없습니다.", null, null);
            return;
        }
        Nav.confirm(a, "선택 전체 해제",
                cur.size() + "개 대화방의 발송 대상 선택을 모두 해제합니다.\n\n"
                        + "그 대화방들의 개별 설정도 함께 지워집니다. 감지 목록과 보호 대화방은 "
                        + "그대로 유지됩니다.",
                "전체 해제", new Runnable() {
                    @Override public void run() {
                        int n = selectMany(a, cur, false);
                        Log.add(a, "발송 대상 선택을 전체 해제했습니다 (" + n + "개).");
                        Nav.snack(n + "개 선택을 해제했습니다.", null, null);
                        refresh();
                    }
                });
    }

    /**
     * 여러 방의 선택을 한 번에 바꾸고 <b>한 번만</b> 저장한다.
     * {@link #select} 를 N 번 부르면 N 번 저장돼 느리고, 중간에 실패하면 절반만 반영된다.
     *
     * @return 실제로 바뀐 개수
     */
    private static int selectMany(Context c, List<RoomRef> refs, boolean on) {
        if (c == null || refs == null || refs.isEmpty()) return 0;
        Settings s = Settings.load(c);
        List<RoomRef> cur = s.macro.roomRefs();
        int n = 0;
        for (int i = 0; i < refs.size(); i++) {
            RoomRef ref = refs.get(i);
            if (ref == null || !ref.valid()) continue;
            boolean has = false;
            for (int k = 0; k < cur.size(); k++) {
                if (ref.equals(cur.get(k))) { has = true; break; }
            }
            if (has == on) continue;
            if (on) {
                cur.add(ref);
            } else {
                for (int k = cur.size() - 1; k >= 0; k--) {
                    if (ref.equals(cur.get(k))) cur.remove(k);
                }
                // select() 와 같은 규칙 — 해제한 방의 개별 설정·타이머도 정리한다
                if (s.macro.roomCfgs != null) s.macro.roomCfgs.remove(ref.key());
            }
            n++;
        }
        if (n == 0) return 0;
        s.macro.setRoomRefs(cur);
        if (!s.save(c)) {
            Nav.snack("저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.", null, null);
            return 0;
        }
        return n;
    }

    /**
     * 방 목록을 카드로 쌓는다. 방 하나당 카드 하나다 (선택 체크행 + `대화방별 설정 ›` 행).
     * 행을 통째로 한 카드에 섞지 않는 이유 — 체크행과 설정행을 한 묶음으로 보여 주려면
     * 방마다 카드가 분리돼야 구분선이 엉키지 않는다 (MacroDetail 의 규칙 카드와 같은 형태).
     */
    private static void addRooms(final MainActivity a, LinearLayout col, List<Row> list) {
        if (list.isEmpty()) {
            LinearLayout g = Ui.group(a);
            TextView t = Ui.sub(a, "감지된 대화방이 없습니다.");
            int ph = Theme.dp(a, 16);
            t.setPadding(ph, Theme.dp(a, 18), ph, Theme.dp(a, 18));
            t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            g.addView(t);
            col.addView(g);
            return;
        }
        for (int i = 0; i < list.size(); i++) {
            col.addView(roomCard(a, list.get(i)));
        }
    }

    // ── 보호 대화방 ─────────────────────────────────────────────────────────

    private static WeakReference<LinearLayout> PROT_BODY;

    /**
     * 보호 대화방 화면.
     *
     * 여기 올린 대화방은 자동발송·메시지 추적·자동응답·봇을 포함해 <b>어떤 기능으로도</b>
     * 발송되지 않는다. 대화방이 다시 감지되어도 발송 대상이 될 수 없다.
     *
     * 이름으로 직접 추가할 수 있게 둔 이유: 사고가 난 대화방을 감지 목록에서 이미 지웠을 때
     * 목록에서 고를 수가 없다. 그 경우가 가장 급한 경우다.
     */
    static View protectedScreen(final MainActivity a) {
        LinearLayout col = Ui.screen(a);
        PROT_BODY = new WeakReference<LinearLayout>(col);
        fillProtected(a, col);
        return Ui.scroll(a, col);
    }

    private static void refreshProtected() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (PROT_BODY == null) ? null : PROT_BODY.get();
        if (a == null || col == null || a.isFinishing() || !col.isAttachedToWindow()) return;
        try {
            col.removeAllViews();
            fillProtected(a, col);
        } catch (Throwable t) {
            Log.add(a, "보호 대화방 화면 갱신에 실패했습니다: " + t);
        }
    }

    private static void fillProtected(final MainActivity a, LinearLayout col) {
        col.addView(Ui.sub(a, "여기 등록한 대화방에는 자동발송·메시지 추적·자동응답·봇을 포함해 "
                + "어떤 기능으로도 메시지가 발송되지 않습니다. 대화방이 다시 감지되어도 "
                + "발송 대상이 되지 않습니다."));

        final List<String> list = SendGuard.protectedRooms(a);

        col.addView(Ui.sectionHeader(a, null, "등록된 대화방"));
        if (list.isEmpty()) {
            col.addView(Nav.note(a, "등록된 보호 대화방이 없습니다.", Theme.DIM, null, null));
        } else {
            LinearLayout g = Ui.group(a);
            for (int i = 0; i < list.size(); i++) {
                final String name = list.get(i);
                g.addView(Nav.actionRow(a, name, null, "해제", new Runnable() {
                    @Override public void run() {
                        Nav.confirm(a, "보호 해제",
                                "「" + name + "」 의 보호를 해제합니다.\n"
                                        + "발송 대상으로 선택하면 다시 자동 발송됩니다.",
                                "해제", new Runnable() {
                                    @Override public void run() {
                                        SendGuard.unprotect(a, name);
                                        refreshProtected();
                                        refresh();
                                    }
                                });
                    }
                }));
            }
            col.addView(g);
        }

        col.addView(Ui.sectionHeader(a, null, "추가"));
        LinearLayout g2 = Ui.group(a);
        g2.addView(Ui.navRow(a, "감지된 대화방에서 선택", null, 0, new Runnable() {
            @Override public void run() { pickToProtect(a); }
        }));
        g2.addView(Ui.navRow(a, "이름으로 직접 추가", null, 0, new Runnable() {
            @Override public void run() { typeToProtect(a); }
        }));
        col.addView(g2);

        col.addView(Nav.note(a, "대화방 이름은 카카오톡에 표시되는 이름과 같아야 합니다. "
                + "계정이 여러 개인 경우 같은 이름의 대화방은 모든 계정에서 함께 차단됩니다.",
                Theme.ACCENT2, null, null));
    }

    private static void pickToProtect(final MainActivity a) {
        final List<KakaoListener.RoomInfo> known = KakaoListener.knownRooms(a);
        final ArrayList<String> names = new ArrayList<String>();
        final ArrayList<String> descs = new ArrayList<String>();
        for (int i = 0; i < known.size(); i++) {
            KakaoListener.RoomInfo info = known.get(i);
            if (info == null || info.ref == null) continue;
            String nm = info.ref.name;
            if (SendGuard.isProtected(a, nm)) continue;
            if (names.contains(nm)) continue;
            names.add(nm);
            descs.add((info.group ? "단체방" : "1:1 개인 대화")
                    + ((info.lastAt > 0) ? (" · " + ago(info.lastAt)) : ""));
        }
        if (names.isEmpty()) {
            Ui.toast(a, "추가할 대화방이 없습니다. 이름으로 직접 추가하십시오.");
            return;
        }
        Nav.choose(a, "보호할 대화방",
                names.toArray(new String[0]), descs.toArray(new String[0]), -1,
                new Nav.OnPick() {
                    @Override public void pick(int i) {
                        if (i < 0 || i >= names.size()) return;
                        doProtect(a, names.get(i));
                    }
                });
    }

    private static void typeToProtect(final MainActivity a) {
        Nav.editText(a, "보호할 대화방", "카카오톡에 표시되는 이름", "", false,
                "카카오톡 대화방 목록에 보이는 이름을 그대로 입력하십시오. "
                        + "이름이 다르면 차단되지 않습니다.",
                new Nav.OnText() {
                    @Override public String text(String v) {
                        String nm = (v == null) ? "" : v.trim();
                        if (nm.length() == 0) return "대화방 이름을 입력하십시오.";
                        doProtect(a, nm);
                        return null;
                    }
                });
    }

    private static void doProtect(final MainActivity a, final String name) {
        Nav.confirm(a, "대화방 보호",
                "「" + name + "」 을(를) 보호합니다.\n\n"
                        + "자동발송·메시지 추적·자동응답·봇을 포함해 모든 자동 발송이 차단됩니다.",
                "보호", new Runnable() {
                    @Override public void run() {
                        if (!SendGuard.protect(a, name)) return;
                        // 발송 대상에 들어 있었다면 같이 빼둔다
                        try {
                            Settings s = Settings.load(a);
                            List<RoomRef> cur = s.macro.roomRefs();
                            for (int i = 0; i < cur.size(); i++) {
                                RoomRef rf = cur.get(i);
                                if (rf != null && SendGuard.isProtected(a, rf.name)) select(a, rf, false);
                            }
                        } catch (Throwable t) {
                            Log.add(a, "보호 대화방을 발송 대상에서 제외하지 못했습니다: " + t);
                        }
                        refreshProtected();
                        refresh();
                    }
                });
    }

    /** 방 한 칸 = 선택 체크행(삭제 포함) + 「대화방별 설정 ›」 행 */
    private static LinearLayout roomCard(final MainActivity a, final Row r) {
        LinearLayout g = Ui.group(a);
        String[] badges = r.groupKnown
                ? new String[] { r.group ? "단체" : "1:1" }
                : null;
        Runnable del = null;
        if (r.detected) {
            del = new Runnable() {
                @Override public void run() { delete(a, r.ref); }
            };
        }
        // 체크 줄의 뷰를 들고 있어야 취소할 때 그 줄만 되돌릴 수 있다 (목록 전체를 다시
        // 그리면 '선택된 것 먼저' 정렬로 방금 누른 줄이 위로 튄다).
        final View[] rowView = new View[1];
        View check = Ui.checkRow(a, r.ref.name, rowSub(a, r),
                badges, r.selected, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        if (!v) {
                            select(a, r.ref, false);
                            // 전체 refresh 는 selected-first 정렬로 행이 튀므로 헤더 수치만 갱신한다.
                            updateHeaders(a);
                            Nav.reload();
                            return;
                        }
                        turnOn(a, r, rowView[0]);
                    }
                }, del);
        rowView[0] = check;
        g.addView(check);

        // 방 공지 — 방장·부방장이 그 방에 올려 둔 공지사항. 저장된 것이 있을 때만 보여준다
        // (없는 방까지 줄을 만들면 목록이 두 배로 길어진다. 가져오기는 대화방 설정 안에 있다).
        RoomNotice.Entry nt = RoomNotice.get(a, r.ref);
        if (nt != null) {
            g.addView(Ui.navRow(a, "방 공지", nt.oneLine(), Theme.TEXT, new Runnable() {
                @Override public void run() {
                    Nav.push(a, "방 공지", noticeScreen(a, r.ref));
                }
            }));
        }

        // 방별 덮어쓰기 요약 — 맵을 직접 읽어 빈 cfg 가 생성되지 않게 한다 (저장 시 어차피 생략되지만 메모리도 깨끗이).
        Settings.RoomCfg rc = storedCfg(Settings.load(a), r.ref);
        String val;
        int color;
        if (rc != null && !rc.enabled) {
            val = "매크로 꺼짐";
            color = Theme.DIM;
        } else if (hasOverride(rc)) {
            val = "개별 설정";
            color = Theme.TEXT;
        } else {
            val = "기본값";
            color = Theme.DIM;
        }
        g.addView(Ui.navRow(a, "대화방별 설정", val, color, new Runnable() {
            @Override public void run() {
                Nav.push(a, "대화방 설정", roomEditor(a, r.ref));
            }
        }));
        return g;
    }

    // ── 이름이 바뀐 대화방 ──────────────────────────────────────────────────
    //
    // 대상 대화방은 '계정 + 그때의 이름' 으로 저장된다(RoomRef). 대화방 이름이 바뀌면
    // 새 알림은 새 이름으로 들어와 답장 통로가 새 키로 생기고, 저장된 옛 이름으로는
    // 아무것도 찾지 못한다 → 매 주기 "대화방 연결이 없습니다" 로 실패한다.
    // 그런데 그 실패가 활동 로그에만 묻혀서 사장은 발송이 끊긴 것을 모른다.
    //
    // 이름으로 자동 추적할 방법은 없다(알림에 고정된 방 번호가 없다). 추측으로 자동
    // 교체하면 엉뚱한 방으로 발송되는 사고가 난다. 그래서 <b>후보를 제시하고 사장이
    // 확인</b>하게 한다.

    /** 이 시간 동안 감지가 없으면 '끊겼다' 고 본다 */
    private static final long STALE_MS = 3L * 24 * 3600 * 1000L;
    /** 새로 감지된 방을 '최근' 으로 보는 기간 */
    private static final long FRESH_MS = 14L * 24 * 3600 * 1000L;

    /**
     * 발송 대상인데 최근 감지가 없는 방의 개수 (홈 경고에 쓴다).
     * 대화방 이름이 바뀌면 발송이 조용히 끊기므로, 목록을 열지 않아도 알 수 있어야 한다.
     */
    public static int staleCount(Context c) {
        try {
            return staleRows(rows(c)).size();
        } catch (Throwable t) {
            return 0;
        }
    }

    /** 선택돼 있는데 감지가 끊긴 방 */
    private static List<Row> staleRows(List<Row> rows) {
        ArrayList<Row> out = new ArrayList<Row>();
        long now = System.currentTimeMillis();
        for (int i = 0; i < rows.size(); i++) {
            Row r = rows.get(i);
            if (r == null || !r.selected) continue;
            if (!r.detected) { out.add(r); continue; }              // 아예 감지된 적 없음
            if (r.lastAt > 0 && now - r.lastAt > STALE_MS) out.add(r);
            }
        return out;
    }

    private static View renameNote(final MainActivity a, final List<Row> rows) {
        final List<Row> stale = staleRows(rows);
        if (stale.isEmpty()) return null;
        String names = "";
        for (int i = 0; i < stale.size() && i < 3; i++) {
            if (names.length() > 0) names += ", ";
            names += "「" + Nav.preview(stale.get(i).ref.name, 14) + "」";
        }
        if (stale.size() > 3) names += " 외 " + (stale.size() - 3) + "개";
        return Nav.note(a, "발송 대상 " + stale.size() + "개 대화방에서 최근 카카오톡 메시지가 "
                + "확인되지 않았습니다 (" + names + ").\n"
                + "대화방 이름이 변경되면 발송이 중단됩니다. 이름이 바뀐 경우 아래에서 "
                + "바꿔 주십시오.", Theme.AMBER, "이름 변경 확인", new Runnable() {
                    @Override public void run() { Nav.push(a, "이름 변경 확인", renameScreen(a)); }
                });
    }

    private static WeakReference<LinearLayout> RENAME_BODY;

    static View renameScreen(final MainActivity a) {
        LinearLayout col = Ui.screen(a);
        RENAME_BODY = new WeakReference<LinearLayout>(col);
        fillRename(a, col);
        return Ui.scroll(a, col);
    }

    private static void refreshRename() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (RENAME_BODY == null) ? null : RENAME_BODY.get();
        if (a == null || col == null || a.isFinishing() || !col.isAttachedToWindow()) return;
        try {
            col.removeAllViews();
            fillRename(a, col);
        } catch (Throwable t) {
            Log.add(a, "이름 변경 확인 화면 갱신에 실패했습니다: " + t);
        }
    }

    private static void fillRename(final MainActivity a, LinearLayout col) {
        col.addView(Ui.sub(a, "발송 대상인데 최근 메시지가 확인되지 않은 대화방입니다. "
                + "대화방 이름이 바뀌었으면 새 이름으로 바꿔 주십시오. 바꾸면 그 대화방의 "
                + "개별 설정과 발송 주기가 함께 옮겨집니다."));

        List<Row> rows = rows(a);
        final List<Row> stale = staleRows(rows);
        if (stale.isEmpty()) {
            col.addView(Nav.note(a, "확인이 필요한 대화방이 없습니다.", Theme.DIM, null, null));
            return;
        }

        long now = System.currentTimeMillis();
        for (int i = 0; i < stale.size(); i++) {
            final Row old = stale.get(i);

            // 같은 계정에서 최근 감지된 '선택 안 된' 방들이 새 이름 후보다
            final ArrayList<String> cand = new ArrayList<String>();
            final ArrayList<String> desc = new ArrayList<String>();
            for (int j = 0; j < rows.size(); j++) {
                Row r = rows.get(j);
                if (r == null || r.selected || !r.detected) continue;
                if (!r.ref.acc.equals(old.ref.acc)) continue;
                if (r.lastAt <= 0 || now - r.lastAt > FRESH_MS) continue;
                cand.add(r.ref.name);
                desc.add((r.groupKnown ? (r.group ? "단체방" : "1:1 개인 대화") : "확인 중")
                        + " · " + ago(r.lastAt));
            }

            col.addView(Ui.sectionHeader(a, null, Nav.preview(old.ref.name, 20)));
            LinearLayout g = Ui.group(a);
            g.addView(Ui.kv(a, "마지막 감지",
                    (old.lastAt > 0) ? ago(old.lastAt) : "감지된 적 없음"));
            if (cand.isEmpty()) {
                g.addView(Ui.kv(a, "새 이름 후보", "없음"));
                col.addView(g);
                col.addView(Ui.sub(a, "같은 계정에서 새로 감지된 대화방이 없습니다. "
                        + "그 대화방에서 카카오톡 메시지를 1회 받으면 후보가 나타납니다."));
                continue;
            }
            col.addView(g);
            LinearLayout g2 = Ui.group(a);
            g2.addView(Ui.navRow(a, "새 이름으로 바꾸기", cand.size() + "개 후보", Theme.ACCENT2,
                    new Runnable() {
                        @Override public void run() {
                            Nav.choose(a, "바뀐 이름 선택",
                                    cand.toArray(new String[0]), desc.toArray(new String[0]), -1,
                                    new Nav.OnPick() {
                                        @Override public void pick(int k) {
                                            if (k < 0 || k >= cand.size()) return;
                                            confirmRename(a, old.ref, cand.get(k));
                                        }
                                    });
                        }
                    }));
            col.addView(g2);
        }
    }

    private static void confirmRename(final MainActivity a, final RoomRef from, final String to) {
        Nav.confirm(a, "대화방 이름 변경",
                "「" + from.name + "」 을(를) 「" + to + "」 로 바꿉니다.\n\n"
                        + "같은 대화방인지 카카오톡에서 먼저 확인하십시오. 다른 대화방을 고르면 "
                        + "그 대화방으로 발송됩니다.",
                "바꾸기", new Runnable() {
                    @Override public void run() { applyRename(a, from, to); }
                });
    }

    /** 대상 목록·방별 설정·보호 지정을 새 이름으로 옮긴다 */
    private static void applyRename(MainActivity a, RoomRef from, String to) {
        RoomRef dst = RoomRef.of(from.acc, to);
        if (!dst.valid()) { Ui.toast(a, "새 이름이 올바르지 않습니다."); return; }
        Settings s = Settings.load(a);
        try {
            // 1) 방별 설정을 그대로 옮긴다 (쿨타임·메시지·1:1 허용·다음 발송 시각)
            if (s.macro.roomCfgs != null) {
                Settings.RoomCfg cfg = s.macro.roomCfgs.remove(from.key());
                if (cfg != null) s.macro.roomCfgs.put(dst.key(), cfg);
            }
            // 2) 대상 목록에서 옛 이름을 빼고 새 이름을 넣는다
            List<RoomRef> cur = s.macro.roomRefs();
            ArrayList<String> keys = new ArrayList<String>();
            for (int i = 0; i < cur.size(); i++) {
                RoomRef r = cur.get(i);
                if (r == null) continue;
                keys.add(r.key().equals(from.key()) ? dst.key() : r.key());
            }
            if (!keys.contains(dst.key())) keys.add(dst.key());
            s.macro.rooms.clear();
            s.macro.rooms.addAll(keys);
            if (!s.save(a)) { Ui.toast(a, "저장하지 못했습니다."); return; }
        } catch (Throwable t) {
            Log.add(a, "대화방 이름 변경에 실패했습니다: " + t);
            Ui.toast(a, "이름을 바꾸지 못했습니다.");
            return;
        }
        // 3) 보호 지정도 같이 옮긴다 (이름 기준이므로 옛 이름만 남으면 보호가 풀린다)
        if (SendGuard.isProtected(a, from.name)) {
            SendGuard.protect(a, to);
            SendGuard.unprotect(a, from.name);
        }
        Log.add(a, "대상 대화방 「" + from.name + "」 을(를) 「" + to + "」 로 변경했습니다. "
                + "개별 설정과 발송 주기를 함께 옮겼습니다.");
        Ui.toast(a, "이름을 바꿨습니다.");
        refreshRename();
        refresh();
        ScreenMacro.refresh();
    }

    /** 행 아래 보조 문구. 보호 중인 방은 그 사실을 먼저 알린다. */
    private static String rowSub(MainActivity a, Row r) {
        if (SendGuard.isProtected(a, r.ref.name)) return "보호 중 · 발송되지 않습니다";
        return r.detected ? ago(r.lastAt) : "미감지";
    }

    /**
     * 체크를 켰을 때.
     *
     * <b>단체방은 확인창 없이 바로 켜고</b> 스낵바의 [취소] 로 되돌린다. 방 20개를 고르려면
     * 확인창이 20번 떴는데, 단체방은 애초에 고르려고 들어온 대상이라 그 20번이 전부 헛걸음
     * 이었다(손님 의견: "방 선택이 불편하다"). 되돌릴 수 있으면 확인창의 목적인 실수 방지는
     * 그대로 남는다.
     *
     * 확인창을 그대로 두는 경우는 셋뿐이고, 셋 다 실제로 사고가 나는 쪽이다 —
     *   · 1:1 개인 대화방 — 한 사람에게 광고가 반복 발송된다 (신고·차단 대상)
     *   · 아직 단체/1:1 을 모르는 방 — 무엇이 될지 모른다
     *   · 보호 대화방 — 발송하지 않기로 지정한 방이다
     */
    private static void turnOn(final MainActivity a, final Row r, final View rowView) {
        if (SendGuard.isProtected(a, r.ref.name) || !r.groupKnown || !r.group) {
            confirmSelect(a, r, rowView);
            return;
        }
        select(a, r.ref, true);
        updateHeaders(a);
        Nav.snack("「" + r.ref.name + "」 을(를) 발송 대상으로 사용합니다.", "취소",
                new Runnable() {
                    @Override public void run() {
                        select(a, r.ref, false);
                        updateHeaders(a);
                        Ui.setChecked(rowView, false);
                        Nav.reload();
                    }
                });
    }

    /**
     * 대화방을 발송 대상으로 켤 때 확인을 받는다.
     *
     * 잘못 눌러서 켜지는 사고가 실제로 났다. 그래서 <b>이름과 단체/1:1 을 보여주고</b>
     * 손님이 확인해야 켜진다. 1:1 개인 대화방이면 경고를 한 단계 더 올리고, 확인을
     * 그 방의 1:1 발송 동의로 기록한다 ({@link Settings.RoomCfg#allowOneToOne}).
     * 동의가 없으면 {@link SendGuard} 가 발송을 막는다.
     */
    private static void confirmSelect(final MainActivity a, final Row r, final View rowView) {
        final Runnable revert = new Runnable() {
            @Override public void run() {
                if (rowView != null) Ui.setChecked(rowView, false);
                else refresh();
            }
        };

        if (SendGuard.isProtected(a, r.ref.name)) {
            Nav.confirm(a, "보호 대화방입니다",
                    "「" + r.ref.name + "」 은(는) 보호 대화방으로 지정되어 있어 발송 대상으로 사용할 수 없습니다.\n"
                            + "발송하려면 보호를 먼저 해제하십시오.",
                    "보호 해제", new Runnable() {
                        @Override public void run() {
                            SendGuard.unprotect(a, r.ref.name);
                            refresh();
                        }
                    }, revert);
            return;
        }

        final boolean oneToOne = !r.groupKnown || !r.group;
        String msg;
        String ok;
        if (!r.groupKnown) {
            msg = "「" + r.ref.name + "」 을(를) 발송 대상으로 사용합니다.\n\n"
                    + "이 대화방이 단체방인지 개인 대화인지 아직 확인되지 않았습니다. "
                    + "카카오톡 알림이 1회 수신되면 확인됩니다. 확인 전까지는 발송되지 않습니다.";
            ok = "사용";
        } else if (r.group) {
            // 지금은 turnOn 이 단체방을 여기로 보내지 않는다(확인창 없이 켠다). 남겨 두는
            // 이유: 다른 화면에서 confirmSelect 를 부르게 되는 날 단체방이 아무 안내도 없이
            // 켜지는 것보다, 쓰이지 않는 분기 하나가 남는 편이 낫다.
            msg = "「" + r.ref.name + "」(단체방)을 발송 대상으로 사용합니다.\n\n"
                    + "설정한 주기에 따라 이 대화방으로 메시지가 자동 발송됩니다.";
            ok = "사용";
        } else {
            msg = "「" + r.ref.name + "」 은(는) 1:1 개인 대화방입니다.\n\n"
                    + "이 대화방을 발송 대상으로 사용하면 상대 1명에게 설정한 메시지가 "
                    + "주기적으로 자동 발송됩니다. 광고 문구가 개인에게 반복 발송되면 "
                    + "신고 또는 차단 대상이 될 수 있습니다.\n\n"
                    + "그래도 사용하시겠습니까?";
            ok = "1:1 발송 사용";
        }

        Nav.confirm(a, "발송 대상 추가", msg, ok, new Runnable() {
            @Override public void run() {
                select(a, r.ref, true);
                if (oneToOne) allowOneToOne(a, r.ref);
                updateHeaders(a);
                Nav.reload();
            }
        }, revert);
    }

    /** 그 방의 1:1 발송 동의를 기록한다 */
    private static void allowOneToOne(MainActivity a, RoomRef ref) {
        Settings s = Settings.load(a);
        Settings.RoomCfg rc = s.roomCfg(ref);
        if (rc == null) return;
        rc.allowOneToOne = true;
        if (!s.save(a)) Log.add(a, "1:1 발송 허용을 저장하지 못했습니다.");
    }

    /** 저장된 방 cfg 를 생성 없이 읽는다 (없으면 null = 상위 기본값 따름) */
    private static Settings.RoomCfg storedCfg(Settings s, RoomRef ref) {
        if (s == null || ref == null || s.macro.roomCfgs == null) return null;
        return s.macro.roomCfgs.get(ref.key());
    }

    /** 이 방에 덮어쓰기(또는 끄기)가 하나라도 걸려 있나 */
    private static boolean hasOverride(Settings.RoomCfg rc) {
        return rc != null && (!rc.enabled || rc.hasMsg || rc.hasCd || rc.hasMin);
    }

    // ── 방 공지 모아보기 ─────────────────────────────────────────────────────

    private static WeakReference<LinearLayout> NLIST_BODY;

    static View noticeListScreen(final MainActivity a) {
        LinearLayout col = Ui.screen(a);
        NLIST_BODY = new WeakReference<LinearLayout>(col);
        try {
            fillNoticeList(a, col);
        } catch (Throwable t) {
            Log.add(a, "방 공지 목록 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    private static void refreshNoticeList() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (NLIST_BODY == null) ? null : NLIST_BODY.get();
        if (a == null || col == null || a.isFinishing() || !col.isAttachedToWindow()) return;
        try {
            col.removeAllViews();
            fillNoticeList(a, col);
        } catch (Throwable t) {
            Log.add(a, "방 공지 목록 갱신에 실패했습니다: " + t);
        }
    }

    private static void fillNoticeList(final MainActivity a, LinearLayout col) {
        col.addView(Ui.sub(a, "각 대화방에 방장·부방장이 올려 둔 공지사항입니다. "
                + "이 앱이 어느 대화방에도 발송하지 않습니다."));

        LinearLayout gs = Ui.group(a);
        gs.addView(Ui.navRowSwitch(a, "메시지로 자동 저장",
                "단체방에 올라온 공지를 알림으로 받았을 때 자동으로 저장합니다.",
                RoomNotice.autoOn(a), new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        RoomNotice.setAutoOn(a, v);
                        Log.add(a, "방 공지 자동 저장을 " + (v ? "사용" : "미사용") + "으로 변경했습니다.");
                    }
                }));
        col.addView(gs);

        List<RoomNotice.Entry> list = RoomNotice.all(a);
        col.addView(Ui.sectionHeader(a, null, "저장된 공지 " + list.size() + "개"));

        if (list.isEmpty()) {
            LinearLayout g = Ui.group(a);
            TextView none = Ui.sub(a, "저장된 공지가 없습니다. 대상 대화방 › 대화방별 설정 › "
                    + "공지 보기 에서 「지금 가져오기」 로 읽어올 수 있습니다.");
            int ph = Theme.dp(a, 16);
            none.setPadding(ph, Theme.dp(a, 16), ph, Theme.dp(a, 16));
            none.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            g.addView(none);
            col.addView(g);
            return;
        }

        LinearLayout g = Ui.group(a);
        for (int i = 0; i < list.size(); i++) {
            RoomNotice.Entry e = list.get(i);
            final RoomRef ref = RoomRef.parse(e.roomKey);
            if (ref == null || !ref.valid()) continue;
            if (i > 0) g.addView(Ui.divider(a));
            g.addView(Ui.navRow(a, ref.label(a), e.oneLine(), Theme.TEXT, new Runnable() {
                @Override public void run() { Nav.push(a, "방 공지", noticeScreen(a, ref)); }
            }));
        }
        col.addView(g);

        col.addView(Nav.wideBtn(a, "저장된 공지 전체 삭제", false, new Runnable() {
            @Override public void run() {
                Nav.confirm(a, "저장된 공지 전체 삭제",
                        "앱에 저장된 공지 " + RoomNotice.count(a) + "건을 모두 지웁니다.\n\n"
                                + "카카오톡의 공지는 그대로 있습니다. 다시 가져올 수 있습니다.",
                        "전체 삭제", new Runnable() {
                            @Override public void run() {
                                int n = RoomNotice.clear(a);
                                Log.add(a, "저장된 방 공지를 전체 삭제했습니다 (" + n + "건).");
                                Nav.snack(n + "건을 지웠습니다.", null, null);
                                refreshNoticeList();
                                refresh();
                            }
                        });
            }
        }));
    }

    // ── 방 공지 (서브화면) ───────────────────────────────────────────────────
    //
    // 보여주는 것은 <b>방장·부방장이 그 방에 올려 둔 공지사항</b>이다. 이 앱이 어디에도
    // 보내지 않는다. 방 관리봇의 「공지문」(사장이 적어 두고 명령으로 뿌리는 글)과는
    // 다른 것이라, 화면에서도 섞이지 않게 「방 공지」 라는 이름으로 분리해 둔다.
    //
    // 가져오는 방법과 각 방법의 한계는 {@link RoomNotice} 머리말에 적어 뒀다.

    private static WeakReference<LinearLayout> NOTICE_BODY;
    private static RoomRef NOTICE_REF;

    static View noticeScreen(final MainActivity a, final RoomRef ref) {
        LinearLayout col = Ui.screen(a);
        NOTICE_BODY = new WeakReference<LinearLayout>(col);
        NOTICE_REF = ref;
        try {
            fillNotice(a, col, ref);
        } catch (Throwable t) {
            Log.add(a, "방 공지 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    private static void refreshNotice() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (NOTICE_BODY == null) ? null : NOTICE_BODY.get();
        RoomRef ref = NOTICE_REF;
        if (a == null || col == null || ref == null || a.isFinishing()
                || !col.isAttachedToWindow()) return;
        try {
            col.removeAllViews();
            fillNotice(a, col, ref);
        } catch (Throwable t) {
            Log.add(a, "방 공지 화면 갱신에 실패했습니다: " + t);
        }
    }

    private static void fillNotice(final MainActivity a, LinearLayout col, final RoomRef ref) {
        final RoomNotice.Entry nt = RoomNotice.get(a, ref);

        col.addView(Ui.sectionHeader(a, null, ref.label(a)));

        LinearLayout g = Ui.group(a);
        if (nt == null) {
            TextView none = Ui.sub(a, "저장된 공지가 없습니다.\n\n"
                    + "카카오톡의 공지는 대화방 화면에 고정되는 내용이라 알림으로는 들어오지 "
                    + "않습니다. 아래 「지금 가져오기」 로 대화방을 열어 읽어올 수 있고, "
                    + "직접 입력할 수도 있습니다.");
            int ph = Theme.dp(a, 16);
            none.setPadding(ph, Theme.dp(a, 16), ph, Theme.dp(a, 16));
            none.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            g.addView(none);
        } else {
            TextView body = Ui.body(a, nt.text);
            body.setTextIsSelectable(true);
            int ph = Theme.dp(a, 16);
            body.setPadding(ph, Theme.dp(a, 16), ph, Theme.dp(a, 12));
            body.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            g.addView(body);
            g.addView(Ui.divider(a));
            g.addView(Ui.kv(a, "가져온 방법", nt.where()));
        }
        col.addView(g);

        // ── 가져오기 ──
        final TextView fetch = Nav.wideBtn(a, "지금 가져오기", nt == null, null);
        fetch.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { doFetchNotice(a, ref, fetch); }
        });
        col.addView(fetch);

        col.addView(Nav.wideBtn(a, (nt == null) ? "직접 입력" : "공지 수정", false, new Runnable() {
            @Override public void run() {
                Nav.editText(a, "방 공지", "공지 내용을 입력하십시오",
                        (nt == null) ? "" : nt.text, true,
                        "여기 적은 내용은 어느 대화방에도 발송되지 않습니다. 이 화면에서 보기 위한 "
                                + "기록입니다.",
                        new Nav.OnText() {
                            @Override public String text(String value) {
                                String val = (value == null) ? "" : value.trim();
                                if (val.length() > RoomNotice.MAX_LEN) {
                                    return RoomNotice.MAX_LEN + "자 이하로 입력하십시오.";
                                }
                                if (val.length() == 0) {
                                    RoomNotice.remove(a, ref);
                                } else {
                                    RoomNotice.put(a, ref, val, RoomNotice.SRC_TYPED);
                                }
                                refreshNotice();
                                return null;
                            }
                        });
            }
        }));

        if (nt != null) {
            col.addView(Nav.wideBtn(a, "공지 삭제", false, new Runnable() {
                @Override public void run() {
                    Nav.confirm(a, "공지 삭제",
                            "이 대화방에 저장된 공지를 지웁니다. 카카오톡의 공지는 그대로 있습니다.",
                            "삭제", new Runnable() {
                                @Override public void run() {
                                    RoomNotice.remove(a, ref);
                                    Nav.snack("공지를 지웠습니다.", null, null);
                                    refreshNotice();
                                }
                            });
                }
            }));
        }

        TextView help = Ui.sub(a, "「지금 가져오기」 는 카카오톡에서 이 대화방을 열어 공지 칸의 "
                + "글자만 읽습니다. 아무것도 누르거나 보내지 않습니다. 접근성 권한이 필요하며, "
                + "이 대화방의 카카오톡 알림을 1회 이상 받은 뒤부터 사용할 수 있습니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.topMargin = Theme.dp(a, 10);
        help.setLayoutParams(hp);
        col.addView(help);

        String dump = RoomNotice.dump(a);
        if (dump != null && dump.length() > 0) {
            col.addView(Ui.sectionHeader(a, null, "마지막 실패 기록"));
            LinearLayout gd = Ui.group(a);
            TextView d = Ui.mono(a, dump.length() > 4000 ? dump.substring(0, 4000) + "\n…" : dump);
            d.setTextIsSelectable(true);
            int ph = Theme.dp(a, 12);
            d.setPadding(ph, ph, ph, ph);
            d.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            gd.addView(d);
            col.addView(gd);
            col.addView(Ui.sub(a, "공지를 읽지 못했을 때 어느 단계에서 막혔는지 확인하는 기록입니다. "
                    + "카카오톡 화면 구성이 변경되면 이 기록이 필요합니다."));
        }
    }

    /** 「지금 가져오기」 — 누르는 동안 버튼을 잠그고, 끝나면 결과를 그 자리에 보여준다 */
    private static void doFetchNotice(final MainActivity a, final RoomRef ref, final TextView btn) {
        if (KakaoAccessibility.noticeBusy()) {
            Nav.snack("이미 공지를 읽고 있습니다.", null, null);
            return;
        }
        Nav.busy(btn, true, "가져오는 중…", "지금 가져오기");
        RoomNotice.fetch(a, ref, new RoomNotice.Result() {
            @Override public void done(final boolean ok, String text, final String why) {
                H.post(new Runnable() {
                    @Override public void run() {
                        Nav.busy(btn, false, "가져오는 중…", "지금 가져오기");
                        if (ok) {
                            Nav.snack("공지를 가져왔습니다.", null, null);
                            refreshNotice();
                            refresh();
                            return;
                        }
                        Nav.confirm(a, "공지를 가져오지 못했습니다",
                                (why == null) ? "원인을 확인하지 못했습니다." : why,
                                "확인", new Runnable() {
                                    @Override public void run() { refreshNotice(); }
                                });
                    }
                });
            }
        });
    }

    // ── 방별 덮어쓰기 편집 (서브화면) ─────────────────────────────────────────
    //  대화방별 설정 › 에서 Nav.push 로 열린다. 값은 고치는 즉시 저장된다.

    private static WeakReference<LinearLayout> EDIT_BODY;
    private static RoomRef EDIT_REF;

    /** 방 하나의 덮어쓰기 편집 화면을 만든다 */
    private static View roomEditor(final MainActivity a, final RoomRef ref) {
        LinearLayout col = Ui.screen(a);
        EDIT_BODY = new WeakReference<LinearLayout>(col);
        EDIT_REF = ref;
        try {
            fillEditor(a, col, ref);
        } catch (Throwable t) {
            Log.add(a, "대화방 설정 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 열려 있는 편집 화면을 제자리에서 다시 그린다 */
    private static void refreshEditor() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (EDIT_BODY == null) ? null : EDIT_BODY.get();
        RoomRef ref = EDIT_REF;
        if (a == null || col == null || ref == null || a.isFinishing()
                || !col.isAttachedToWindow()) return;
        try {
            col.removeAllViews();
            fillEditor(a, col, ref);
        } catch (Throwable t) {
            Log.add(a, "대화방 설정 화면 갱신에 실패했습니다: " + t);
        }
    }

    private static void fillEditor(final MainActivity a, LinearLayout col, final RoomRef ref) {
        final Settings s = Settings.load(a);
        final Settings.RoomCfg rc = s.roomCfg(ref);   // 편집용 get-or-create

        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "라이선스 인증 전에는 설정이 저장되지 않습니다. "
                    + "내정보 탭에서 인증을 완료하십시오.", Theme.AMBER, null, null));
        }

        final boolean prot = SendGuard.isProtected(a, ref.name);
        if (prot) {
            col.addView(Nav.note(a, "보호 대화방입니다. 아래 설정과 무관하게 이 대화방에는 "
                    + "어떤 기능으로도 자동 발송되지 않습니다.", Theme.ACCENT2, null, null));
        }

        // ── 방 공지 ──
        // 방장·부방장이 그 방에 올려 둔 공지사항이다. 발송과 무관하게 보여주기만 한다.
        col.addView(Ui.sectionHeader(a, null, "방 공지"));
        LinearLayout gn = Ui.group(a);
        RoomNotice.Entry nt = RoomNotice.get(a, ref);
        gn.addView(Ui.navRow(a, "공지 보기",
                (nt == null) ? "없음" : nt.oneLine(),
                (nt == null) ? Theme.DIM : Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "방 공지", noticeScreen(a, ref)); }
                }));
        col.addView(gn);

        // ── 이 대화방 매크로 on/off ──
        col.addView(Ui.sectionHeader(a, null, "대화방 매크로"));
        LinearLayout g0 = Ui.group(a);
        g0.addView(Ui.navRowSwitch(a, "이 대화방 발송", "끄면 이 대화방에는 자동발송하지 않습니다.",
                rc.enabled, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        rc.enabled = v;
                        persistRoom(a, s, "「" + ref.label(a) + "」 대화방 매크로를 "
                                + (v ? "사용으로" : "미사용으로") + " 변경했습니다.");
                    }
                }));
        // 보호 — 매크로뿐 아니라 추적·자동응답·봇까지 전부 막는다. 그래서 '이 대화방 발송'
        // 스위치와 따로 둔다. 실수로 켜질 수 있는 값이 아니어야 하므로 확인창을 거친다.
        g0.addView(Ui.navRowSwitch(a, "이 대화방 보호",
                prot ? "모든 기능의 자동 발송이 차단됩니다."
                     : "켜면 어떤 설정으로도 이 대화방에 발송되지 않습니다.",
                prot, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        if (v) {
                            Nav.confirm(a, "대화방 보호",
                                    "「" + ref.name + "」 을(를) 보호합니다.\n\n"
                                            + "자동발송·메시지 추적·자동응답·봇을 포함해 모든 자동 발송이 "
                                            + "차단됩니다. 대화방이 다시 감지되어도 발송 대상이 되지 않습니다.",
                                    "보호", new Runnable() {
                                        @Override public void run() {
                                            SendGuard.protect(a, ref.name);
                                            select(a, ref, false);   // 발송 대상에서도 빼둔다
                                            refreshEditor();
                                            refresh();
                                        }
                                    }, new Runnable() {
                                        @Override public void run() { refreshEditor(); }
                                    });
                        } else {
                            Nav.confirm(a, "보호 해제",
                                    "「" + ref.name + "」 의 보호를 해제합니다.\n"
                                            + "발송 대상으로 선택하면 다시 자동 발송됩니다.",
                                    "해제", new Runnable() {
                                        @Override public void run() {
                                            SendGuard.unprotect(a, ref.name);
                                            refreshEditor();
                                            refresh();
                                        }
                                    }, new Runnable() {
                                        @Override public void run() { refreshEditor(); }
                                    });
                        }
                    }
                }));
        if (KakaoListener.groupState(a, ref) == KakaoListener.GROUP_NO) {
            g0.addView(Ui.navRowSwitch(a, "1:1 발송 허용",
                    rc.allowOneToOne ? "이 개인 대화방으로 발송됩니다."
                                     : "개인 대화방이므로 발송하지 않습니다.",
                    rc.allowOneToOne, new Ui.OnToggle() {
                        @Override public void on(boolean v) {
                            if (!v) {
                                rc.allowOneToOne = false;
                                persistRoom(a, s, "「" + ref.label(a) + "」 1:1 발송을 차단했습니다.");
                                refreshEditor();
                                return;
                            }
                            Nav.confirm(a, "1:1 발송 허용",
                                    "「" + ref.name + "」 은(는) 1:1 개인 대화방입니다.\n\n"
                                            + "허용하면 상대 1명에게 설정한 메시지가 주기적으로 자동 "
                                            + "발송됩니다. 신고 또는 차단 대상이 될 수 있습니다.",
                                    "허용", new Runnable() {
                                        @Override public void run() {
                                            rc.allowOneToOne = true;
                                            persistRoom(a, s, "「" + ref.label(a) + "」 1:1 발송을 허용했습니다.");
                                            refreshEditor();
                                        }
                                    }, new Runnable() {
                                        @Override public void run() { refreshEditor(); }
                                    });
                        }
                    }));
        }
        col.addView(g0);

        // ── 현재 유효값 안내 ──
        String eff = s.effMessage(ref);
        boolean willSend = (eff != null && eff.trim().length() > 0);
        int cdMin = s.effCdMinMin(ref);
        int cdMax = s.effCdMaxMin(ref);
        int mm = s.effMinMessages(ref);
        if (!rc.enabled) {
            col.addView(Nav.note(a, "이 대화방 매크로가 꺼져 있어 자동발송 대상에서 제외됩니다.",
                    Theme.AMBER, null, null));
        } else if (!willSend) {
            col.addView(Nav.note(a, "유효 발송 메시지가 비어 있어 이 대화방에는 발송되지 않습니다. "
                    + "아래에서 이 항목만 개별 지정하거나, 전체 기본 메시지를 설정하십시오.", Theme.AMBER, null, null));
        } else {
            col.addView(Nav.note(a, "현재 이 대화방은 " + cdMin + "~" + cdMax
                    + "분 주기로 발송되며, 새 메시지 최소 개수는 " + mm + "개입니다.\n"
                    + "발송 메시지: " + Nav.preview(eff, 40), Theme.ACCENT2, null, null));
        }

        // ── 덮어쓰기 ──
        col.addView(Ui.sectionHeader(a, null, "개별 설정"));
        LinearLayout g = Ui.group(a);

        g.addView(Ui.navRowSwitch(a, "메시지 개별 설정", rc.hasMsg ? null : "끄면 상위 기본값을 따릅니다.",
                rc.hasMsg, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        rc.hasMsg = v;
                        persistRoom(a, s, null);
                    }
                }));
        if (rc.hasMsg) {
            boolean empty = (rc.message == null || rc.message.trim().length() == 0);
            g.addView(Ui.navRow(a, "메시지 편집", empty ? "설정 필요" : Nav.preview(rc.message, 18),
                    empty ? Theme.AMBER : Theme.TEXT, new Runnable() {
                        @Override public void run() { editRoomMessage(a, s, ref, rc); }
                    }));
        }

        g.addView(Ui.navRowSwitch(a, "쿨타임 개별 설정", rc.hasCd ? null : "끄면 상위 기본값을 따릅니다.",
                rc.hasCd, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        rc.hasCd = v;
                        persistRoom(a, s, null);
                    }
                }));
        if (rc.hasCd) {
            g.addView(Ui.navRow(a, "쿨타임", rc.cdMinMin + "~" + rc.cdMaxMin + "분", Theme.TEXT,
                    new Runnable() {
                        @Override public void run() { editRoomCd(a, s, ref, rc); }
                    }));
        }

        g.addView(Ui.navRowSwitch(a, "새 메시지 최소 개수 개별 설정",
                rc.hasMin ? null : "끄면 상위 기본값을 따릅니다.", rc.hasMin, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        rc.hasMin = v;
                        persistRoom(a, s, null);
                    }
                }));
        if (rc.hasMin) {
            g.addView(Ui.navRow(a, "새 메시지 최소 개수", rc.minMessages + "개", Theme.TEXT, new Runnable() {
                @Override public void run() { editRoomMin(a, s, ref, rc); }
            }));
        }
        col.addView(g);

        col.addView(Nav.note(a, "개별 설정을 끄면 계정 기본값 또는 전체 기본값을 따릅니다. "
                + "대화방 설정이 가장 먼저 쓰이고, 없으면 계정 설정, 그다음 전체 기본값이 쓰입니다.", Theme.ACCENT2, null, null));
    }

    /** 방 설정을 저장하고 편집 화면·목록·매크로 탭 요약을 갱신한다 */
    private static void persistRoom(final MainActivity a, Settings s, String log) {
        if (!s.save(a)) {
            Nav.snack("저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.", null, null);
            return;
        }
        if (log != null && log.length() > 0) Log.add(a, log);
        refreshEditor();
        refresh();
        Nav.reload();
    }

    private static void editRoomMessage(final MainActivity a, final Settings s, final RoomRef ref,
                                        final Settings.RoomCfg rc) {
        Nav.editText(a, "대화방 메시지", "발송할 내용을 입력하십시오", rc.message, true,
                "이 대화방에만 적용되는 메시지입니다. 최대 2000자.", new Nav.OnText() {
                    @Override public String text(String value) {
                        if (value == null || value.trim().length() == 0) {
                            return "발송 메시지를 입력하십시오.";
                        }
                        if (value.length() > 2000) return "2000자 이하로 입력하십시오.";
                        rc.message = value;
                        if (!s.save(a)) {
                            return "저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.";
                        }
                        Log.add(a, "「" + ref.label(a) + "」 대화방 메시지를 변경했습니다.");
                        refreshEditor();
                        refresh();
                        Nav.reload();
                        return null;
                    }
                });
    }

    private static void editRoomCd(final MainActivity a, final Settings s, final RoomRef ref,
                                   final Settings.RoomCfg rc) {
        final Nav.NumField lo = new Nav.NumField("최소 쿨타임 (분)", "20", 1, 1440, rc.cdMinMin);
        final Nav.NumField hi = new Nav.NumField("최대 쿨타임 (분)", "40", 1, 1440, rc.cdMaxMin);
        Nav.editNums(a, "쿨타임", "최소~최대 사이의 임의 시각에 발송됩니다.",
                new Nav.NumField[] { lo, hi }, new Nav.OnNums() {
                    @Override public String ok() {
                        if (lo.value > hi.value) {
                            Nav.errText(hi.err, "최대 쿨타임은 최소 쿨타임 이상으로 입력하십시오");
                            return "";
                        }
                        rc.cdMinMin = lo.value;
                        rc.cdMaxMin = hi.value;
                        if (!s.save(a)) {
                            return "저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.";
                        }
                        Log.add(a, "「" + ref.label(a) + "」 대화방 쿨타임을 "
                                + lo.value + "~" + hi.value + "분으로 변경했습니다.");
                        refreshEditor();
                        refresh();
                        Nav.reload();
                        return null;
                    }
                });
    }

    private static void editRoomMin(final MainActivity a, final Settings s, final RoomRef ref,
                                    final Settings.RoomCfg rc) {
        final Nav.NumField mm = new Nav.NumField("새 메시지 최소 개수", "1", 0, 200, rc.minMessages);
        Nav.editNums(a, "새 메시지 최소 개수",
                "마지막 발송 이후 상대 메시지가 이 수량 이상 누적된 경우에만 발송합니다. 0은 항상 발송입니다.",
                new Nav.NumField[] { mm }, new Nav.OnNums() {
                    @Override public String ok() {
                        rc.minMessages = mm.value;
                        if (!s.save(a)) {
                            return "저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.";
                        }
                        Log.add(a, "「" + ref.label(a) + "」 대화방 새 메시지 최소 개수를 "
                                + mm.value + "개로 변경했습니다.");
                        refreshEditor();
                        refresh();
                        Nav.reload();
                        return null;
                    }
                });
    }

    /** `본계정 · 선택 2개` */
    private static String header(Context c, String acc, List<Row> mine) {
        int sel = 0;
        for (int i = 0; i < mine.size(); i++) if (mine.get(i).selected) sel++;
        String name = Accounts.nameOf(c, acc);
        return name + " · 선택 " + sel + "개";
    }

    /** 섹션 헤더의 제목 TextView 를 기억해 둔다 (sectionHeader 의 첫 자식) */
    private static void rememberHeader(String key, LinearLayout sh) {
        if (sh == null || sh.getChildCount() == 0) return;
        View first = sh.getChildAt(0);
        if (first instanceof TextView) HEADERS.put(key, (TextView) first);
    }

    /**
     * 체크 토글 뒤 섹션 헤더의 '선택 N개' 수치만 다시 계산해 넣는다.
     * 전체 refresh() 는 selected-first 정렬로 행이 튀므로 쓰지 않는다.
     */
    private static void updateHeaders(MainActivity a) {
        if (HEADERS.isEmpty()) return;
        List<Row> rows = rows(a);
        int detected = 0;
        int selected = 0;
        for (int i = 0; i < rows.size(); i++) {
            if (rows.get(i).detected) detected++;
            if (rows.get(i).selected) selected++;
        }
        for (Map.Entry<String, TextView> e : HEADERS.entrySet()) {
            TextView tv = e.getValue();
            if (tv == null) continue;
            String k = e.getKey();
            if (SINGLE_KEY.equals(k)) {
                tv.setText("선택 " + selected + "개 · 감지 " + detected + "개");
            } else {
                tv.setText(header(a, k, filter(rows, k)));
            }
        }
    }

    // ── 목록 만들기 ─────────────────────────────────────────────────────────

    /**
     * 감지된 방 + 선택만 남은 방(직접 입력·초기화 이후)을 합친다.
     * 선택된 방은 감지 목록에 없어도 반드시 보여야 한다 — 안 보이면 해제할 방법이 없다.
     */
    private static List<Row> rows(Context c) {
        LinkedHashMap<String, Row> map = new LinkedHashMap<String, Row>();

        List<KakaoListener.RoomInfo> det = KakaoListener.knownRooms(c);
        for (int i = 0; i < det.size(); i++) {
            KakaoListener.RoomInfo ri = det.get(i);
            if (ri == null || ri.ref == null || !ri.ref.valid()) continue;
            String k = ri.ref.key();
            if (PENDING.containsKey(k)) continue;   // 삭제 예약된 방은 화면에서 이미 빠졌다
            Row r = new Row();
            r.ref = ri.ref;
            r.detected = true;
            r.groupKnown = true;
            r.group = ri.group;
            r.lastAt = ri.lastAt;
            map.put(k, r);
        }

        List<RoomRef> sel = Settings.load(c).macro.roomRefs();
        for (int i = 0; i < sel.size(); i++) {
            RoomRef ref = sel.get(i);
            if (ref == null || !ref.valid()) continue;
            String k = ref.key();
            if (PENDING.containsKey(k)) continue;
            Row r = map.get(k);
            if (r != null) { r.selected = true; continue; }
            Row n = new Row();
            n.ref = ref;
            n.selected = true;
            map.put(k, n);
        }
        return new ArrayList<Row>(map.values());
    }

    /** 계정 표시 순서: 등록된 계정 순번 → 목록에만 남은 계정 */
    private static List<String> accounts(Context c, List<Row> rows) {
        ArrayList<String> out = new ArrayList<String>();
        List<Accounts.Acc> regs = Accounts.all(c);
        for (int i = 0; i < regs.size(); i++) {
            if (!out.contains(regs.get(i).key)) out.add(regs.get(i).key);
        }
        for (int i = 0; i < rows.size(); i++) {
            String acc = rows.get(i).ref.acc;
            if (!out.contains(acc)) out.add(acc);
        }
        if (out.isEmpty()) out.add(RoomRef.DEFAULT_ACC);
        return out;
    }

    /** 그 계정의 방만. 정렬은 선택된 것 먼저, 그다음 최근 감지순. */
    private static List<Row> filter(List<Row> rows, String acc) {
        ArrayList<Row> out = new ArrayList<Row>();
        for (int i = 0; i < rows.size(); i++) {
            Row r = rows.get(i);
            if (r.ref.acc.equals(acc)) out.add(r);
        }
        sort(out);
        return out;
    }

    private static void sort(List<Row> list) {
        Collections.sort(list, new Comparator<Row>() {
            @Override public int compare(Row x, Row y) {
                if (x.selected != y.selected) return x.selected ? -1 : 1;
                if (x.lastAt != y.lastAt) return (x.lastAt > y.lastAt) ? -1 : 1;
                return x.ref.name.compareToIgnoreCase(y.ref.name);
            }
        });
    }

    private static int usedAccounts(Context c, List<String> accs) {
        Settings s = Settings.load(c);
        int n = 0;
        for (int i = 0; i < accs.size(); i++) if (s.accountOn(accs.get(i))) n++;
        return n;
    }

    // ── 선택 ────────────────────────────────────────────────────────────────

    /** 체크 즉시 저장. 확인 버튼은 없다 (UI_V3 5장). */
    private static void select(Context c, RoomRef ref, boolean on) {
        if (c == null || ref == null || !ref.valid()) return;
        Settings s = Settings.load(c);
        List<RoomRef> cur = s.macro.roomRefs();
        boolean has = false;
        for (int i = 0; i < cur.size(); i++) {
            if (ref.equals(cur.get(i))) { has = true; break; }
        }
        if (has == on) return;
        if (on) {
            cur.add(ref);
        } else {
            for (int i = cur.size() - 1; i >= 0; i--) {
                if (ref.equals(cur.get(i))) cur.remove(i);
            }
            // 선택 해제한 방의 덮어쓰기·타이머(RoomCfg)도 정리한다. 안 지우면 Settings 가 계속 커지고,
            // 나중에 다시 선택했을 때 과거 nextAt·옛 설정이 되살아난다. 재선택 시 기본값으로 시작한다.
            if (s.macro.roomCfgs != null) s.macro.roomCfgs.remove(ref.key());
        }
        s.macro.setRoomRefs(cur);
        if (!s.save(c)) {
            // 라이선스 인증 전에는 설정키가 없어 저장이 안 된다.
            // 예전에는 조용히 넘어가서 체크박스만 켜진 채로 남았다.
            Nav.snack("저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.", null, null);
        }
    }

    // ── 삭제 (+ 실행 취소) ──────────────────────────────────────────────────

    /**
     * 감지 목록에서 1건 삭제. 확인창 없이 바로 화면에서 빼고 5초 동안 실행 취소를 받는다.
     * 선택돼 있던 방이면 선택도 같이 풀고, 실행 취소 때 함께 되돌린다.
     */
    private static void delete(final MainActivity a, final RoomRef ref) {
        if (a == null || ref == null || !ref.valid()) return;
        final String key = ref.key();
        if (PENDING.containsKey(key)) return;

        final Context app = a.getApplicationContext();
        final Pending p = new Pending();
        p.ref = ref;
        p.wasSelected = Settings.load(a).macro.coversRoom(ref);
        p.commit = new Runnable() {
            @Override public void run() {
                PENDING.remove(key);
                try {
                    KakaoListener.forgetRoom(app, ref);
                } catch (Throwable t) {
                    Log.add(app, "감지 목록에서 대화방을 삭제하지 못했습니다: " + t);
                }
            }
        };
        if (p.wasSelected) select(a, ref, false);
        PENDING.put(key, p);
        H.postDelayed(p.commit, Ui.Snack.SHOW_MS);

        refresh();
        if (p.wasSelected) Nav.reload();

        snack("「" + ref.name + "」 대화방을 감지 목록에서 삭제했습니다.", "실행 취소", new Runnable() {
            @Override public void run() { undo(a, key); }
        });
    }

    private static void undo(MainActivity a, String key) {
        Pending p = PENDING.remove(key);
        if (p == null) return;          // 이미 반영됐다
        H.removeCallbacks(p.commit);
        if (p.wasSelected) {
            select(a, p.ref, true);
            Nav.reload();
        }
        refresh();
    }

    /** 감지 캐시 전체 비우기. 선택된 방은 건드리지 않는다 (UI_V3 5장). */
    private static void clearDialog(final MainActivity a) {
        Nav.confirm(a, "감지 목록 초기화",
                "감지된 대화방 기록을 전부 삭제합니다. 선택된 대상 대화방은 유지됩니다. "
                        + "이후 카카오톡 메시지를 수신하면 다시 등록됩니다.",
                "초기화", new Runnable() {
                    @Override public void run() {
                        try {
                            KakaoListener.clearRooms(a);
                        } catch (Throwable t) {
                            Log.add(a, "감지 목록 초기화 실패: " + t);
                            snack("감지 목록을 초기화하지 못했습니다. 다시 시도하십시오.", null, null);
                            return;
                        }
                        // 실제로 지워진 캐시를 다시 살릴 수 없으니 예약된 삭제도 같이 끝낸다
                        cancelPending();
                        Log.add(a, "감지된 대화방 목록을 초기화했습니다.");
                        refreshReset();
                        refresh();
                        Nav.reload();
                        snack("감지 목록을 초기화했습니다.", null, null);
                    }
                });
    }

    // ── 초기화 ──────────────────────────────────────────────────────────────
    //
    // 세 가지를 구분한다. 지우는 범위가 다르고, 되돌릴 수 없으므로 각 확인창에
    // '무엇이 몇 개 지워지는지' 와 '무엇이 남는지' 를 같이 적는다.
    //
    // ★ 보호 대화방과 전체 정지는 어떤 초기화로도 지우지 않는다. 초기화 한 번으로
    //   안전장치가 조용히 풀리면, 발송하면 안 되는 방으로 다시 나가는 사고가 난다.

    private static WeakReference<LinearLayout> RESET_BODY;

    static View resetScreen(final MainActivity a) {
        LinearLayout col = Ui.screen(a);
        RESET_BODY = new WeakReference<LinearLayout>(col);
        fillReset(a, col);
        return Ui.scroll(a, col);
    }

    private static void refreshReset() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (RESET_BODY == null) ? null : RESET_BODY.get();
        if (a == null || col == null || a.isFinishing() || !col.isAttachedToWindow()) return;
        try {
            col.removeAllViews();
            fillReset(a, col);
        } catch (Throwable t) {
            Log.add(a, "초기화 화면 갱신에 실패했습니다: " + t);
        }
    }

    /** 방별 개별 설정이 걸린 방 수 (끄기·메시지·쿨타임·새 메시지 개수·1:1 허용) */
    private static int cfgCount(Settings s) {
        if (s == null || s.macro.roomCfgs == null) return 0;
        int n = 0;
        Iterator<Settings.RoomCfg> it = s.macro.roomCfgs.values().iterator();
        while (it.hasNext()) {
            Settings.RoomCfg c = it.next();
            if (c == null) continue;
            if (!c.enabled || c.hasMsg || c.hasCd || c.hasMin || c.allowOneToOne) n++;
        }
        return n;
    }

    private static int accCfgCount(Settings s) {
        if (s == null || s.macro.accountCfgs == null) return 0;
        return s.macro.accountCfgs.size();
    }

    private static void fillReset(final MainActivity a, LinearLayout col) {
        final Settings s = Settings.load(a);
        int detected = KakaoListener.knownRooms(a).size();
        int selected = s.macro.roomRefs().size();
        final int cfgs = cfgCount(s);
        final int accs = accCfgCount(s);

        col.addView(Ui.sub(a, "되돌릴 수 없습니다. 지우는 범위를 확인하고 실행하십시오.\n"
                + "보호 대화방과 전체 정지는 어떤 초기화로도 해제되지 않습니다."));

        col.addView(Ui.sectionHeader(a, null, "현재 상태"));
        LinearLayout now = Ui.card(a);
        now.addView(Ui.kv(a, "감지된 대화방", detected + "개"));
        now.addView(Ui.kv(a, "발송 대상", selected + "개"));
        now.addView(Ui.kv(a, "대화방 개별 설정", cfgs + "개"));
        now.addView(Ui.kv(a, "계정 개별 설정", accs + "개"));
        now.addView(Ui.kv(a, "저장된 방 공지", RoomNotice.count(a) + "개"));
        now.addView(Ui.kv(a, "보호 대화방", SendGuard.protectedRooms(a).size() + "개 (유지)"));
        col.addView(now);

        col.addView(Ui.sectionHeader(a, null, "초기화"));
        LinearLayout g = Ui.group(a);

        g.addView(Ui.navRow(a, "감지 목록만 초기화", detected + "개", Theme.TEXT, new Runnable() {
            @Override public void run() { clearDialog(a); }
        }));

        g.addView(Ui.navRow(a, "개별 설정 전체 초기화", (cfgs + accs) + "개", Theme.TEXT,
                new Runnable() {
                    @Override public void run() { resetCfgsDialog(a, cfgs, accs); }
                }));

        g.addView(Ui.navRow(a, "방 목록 전체 초기화", "전부 삭제", Theme.RED, new Runnable() {
            @Override public void run() { resetAllDialog(a, detected, selected, cfgs); }
        }));
        col.addView(g);

        col.addView(Ui.sub(a, "「감지 목록만 초기화」 는 감지 기록만 지우고 발송 대상 선택은 "
                + "남깁니다. 메시지를 다시 받으면 목록에 다시 올라옵니다.\n"
                + "「개별 설정 전체 초기화」 는 대화방별·계정별로 따로 지정한 값을 모두 지워 "
                + "전체 기본값을 쓰게 합니다. 발송 대상 선택은 그대로입니다.\n"
                + "「방 목록 전체 초기화」 는 감지 기록·발송 대상 선택·대화방 개별 설정을 "
                + "모두 지웁니다. 대화방을 처음부터 다시 고르게 됩니다.\n"
                + "봇의 대상 대화방은 봇 탭에서 따로 관리하며 여기서 지워지지 않습니다."));
    }

    /** 개별 설정만 전부 삭제 — 대상 선택과 감지 목록은 그대로 */
    private static void resetCfgsDialog(final MainActivity a, final int cfgs, final int accs) {
        if (cfgs + accs == 0) { Ui.toast(a, "지정된 개별 설정이 없습니다."); return; }
        Nav.confirm(a, "개별 설정 전체 초기화",
                "대화방 개별 설정 " + cfgs + "개와 계정 개별 설정 " + accs + "개를 삭제합니다.\n\n"
                        + "모든 대화방이 전체 기본값(메시지·쿨타임·새 메시지 최소 개수)을 "
                        + "쓰게 됩니다. 발송 대상 선택과 감지 목록은 그대로 유지됩니다.\n"
                        + "1:1 발송을 허용해 둔 대화방은 허용이 해제되어 발송되지 않습니다.",
                "초기화", new Runnable() {
                    @Override public void run() {
                        Settings s = Settings.load(a);
                        try {
                            List<RoomRef> keep = s.macro.roomRefs();
                            if (s.macro.roomCfgs != null) s.macro.roomCfgs.clear();
                            if (s.macro.accountCfgs != null) s.macro.accountCfgs.clear();
                            // ★ 방별 '다음 발송 시각' 도 개별 설정에 들어 있다. 그냥 지우면
                            //   모든 대상 방이 '발송할 때가 됐다' 가 되어 다음 알람에 한꺼번에
                            //   나간다 — 방이 20개면 20건이 동시에 올라가는 도배가 된다.
                            //   그래서 각 방에 쿨타임 범위 안의 시각을 다시 흩어서 넣는다.
                            long base = System.currentTimeMillis();
                            for (int i = 0; i < keep.size(); i++) {
                                RoomRef rf = keep.get(i);
                                if (rf == null || !rf.valid()) continue;
                                s.setRoomNextAt(rf, s.macro.pickNextAt(base,
                                        s.effCdMinMin(rf), s.effCdMaxMin(rf)));
                            }
                            if (!s.save(a)) { Ui.toast(a, "저장하지 못했습니다."); return; }
                        } catch (Throwable t) {
                            Log.add(a, "개별 설정 초기화에 실패했습니다: " + t);
                            Ui.toast(a, "초기화하지 못했습니다.");
                            return;
                        }
                        Log.add(a, "개별 설정을 전체 초기화했습니다. (대화방 " + cfgs
                                + "개 · 계정 " + accs + "개) 모든 대화방이 전체 기본값을 사용하며, "
                                + "발송 시각은 쿨타임 범위로 다시 배분했습니다.");
                        try { Scheduler.ensureScheduled(a); } catch (Throwable ignore) { }
                        Ui.toast(a, "개별 설정을 초기화했습니다.");
                        refreshReset();
                        refresh();
                        ScreenMacro.refresh();
                    }
                });
    }

    /** 방 관련 전부 삭제 — 감지 목록 + 대상 선택 + 방별 개별 설정 */
    private static void resetAllDialog(final MainActivity a, final int detected,
                                       final int selected, final int cfgs) {
        Nav.confirm(a, "방 목록 전체 초기화",
                "감지된 대화방 " + detected + "개, 발송 대상 " + selected + "개, "
                        + "대화방 개별 설정 " + cfgs + "개, 저장된 방 공지 "
                        + RoomNotice.count(a) + "개를 모두 삭제합니다.\n\n"
                        + "발송 대상이 비면 자동발송이 중단됩니다. 대화방을 다시 선택해야 "
                        + "발송이 재개됩니다.\n"
                        + "보호 대화방과 전체 정지는 유지됩니다. 봇의 대상 대화방은 "
                        + "봇 탭에서 따로 관리하며 지워지지 않습니다.",
                "전체 초기화", new Runnable() {
                    @Override public void run() {
                        Settings s = Settings.load(a);
                        try {
                            s.macro.rooms.clear();
                            if (s.macro.roomCfgs != null) s.macro.roomCfgs.clear();
                            if (!s.save(a)) { Ui.toast(a, "저장하지 못했습니다."); return; }
                        } catch (Throwable t) {
                            Log.add(a, "방 목록 전체 초기화에 실패했습니다: " + t);
                            Ui.toast(a, "초기화하지 못했습니다.");
                            return;
                        }
                        try {
                            KakaoListener.clearRooms(a);
                        } catch (Throwable t) {
                            Log.add(a, "감지 목록을 비우지 못했습니다: " + t);
                        }
                        // 방 목록을 비우면 방마다 저장해 둔 공지도 가리킬 방이 없어진다
                        try {
                            RoomNotice.clear(a);
                        } catch (Throwable t) {
                            Log.add(a, "저장된 방 공지를 비우지 못했습니다: " + t);
                        }
                        cancelPending();
                        Log.add(a, "방 목록을 전체 초기화했습니다. (감지 " + detected
                                + "개 · 발송 대상 " + selected + "개 · 개별 설정 " + cfgs + "개) "
                                + "발송 대상이 없어 자동발송이 중단됩니다.");
                        // 대상이 비었으니 예약을 다시 계산한다 (과거 시각 알람이 남지 않게)
                        try { Scheduler.ensureScheduled(a); } catch (Throwable ignore) { }
                        Ui.toast(a, "방 목록을 전체 초기화했습니다.");
                        refreshReset();
                        refresh();
                        Nav.reload();
                        ScreenMacro.refresh();
                    }
                });
    }

    private static void cancelPending() {
        Iterator<Map.Entry<String, Pending>> it = PENDING.entrySet().iterator();
        while (it.hasNext()) {
            Pending p = it.next().getValue();
            if (p != null) H.removeCallbacks(p.commit);
        }
        PENDING.clear();
    }

    // ── 직접 입력 추가 ──────────────────────────────────────────────────────

    /** 감지 안 된 방을 손으로 넣는다. 계정이 2개 이상이면 계정도 고른다. */
    private static void addDialog(final MainActivity a) {
        final List<String> accs = accounts(a, rows(a));
        final boolean multi = (Accounts.count(a) >= 2) || (accs.size() >= 2);
        final String[] pick = { accs.isEmpty() ? RoomRef.DEFAULT_ACC : accs.get(0) };

        LinearLayout body = Nav.col(a);
        TextView help = Ui.sub(a, "카카오톡에 표시된 대화방 이름과 정확히 일치해야 발송됩니다. "
                + "발송에는 해당 대화방의 알림이 1회 이상 수신되어야 합니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.bottomMargin = Theme.dp(a, 10);
        help.setLayoutParams(hp);
        body.addView(help);

        final EditText f = Ui.field(a, "대화방 이름");
        f.setSingleLine(true);
        f.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        body.addView(f);

        if (multi) {
            LinearLayout row = Ui.row(a);
            LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(MATCH, WRAP);
            rp.topMargin = Theme.dp(a, 12);
            row.setLayoutParams(rp);

            TextView lab = Ui.sub(a, "계정");
            lab.setLayoutParams(new LinearLayout.LayoutParams(WRAP, WRAP));
            row.addView(lab);

            final TextView val = Ui.body(a, Accounts.nameOf(a, pick[0]));
            val.setGravity(Gravity.END);
            val.setSingleLine(true);
            LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(0, WRAP, 1f);
            vp.leftMargin = Theme.dp(a, 12);
            val.setLayoutParams(vp);
            row.addView(val);

            TextView change = Ui.btn(a, "변경", false);
            change.setPadding(Theme.dp(a, 14), Theme.dp(a, 12), Theme.dp(a, 14), Theme.dp(a, 12));
            LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(WRAP, WRAP);
            cp.leftMargin = Theme.dp(a, 12);
            change.setLayoutParams(cp);
            change.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    final String[] keys = accs.toArray(new String[accs.size()]);
                    String[] labels = new String[keys.length];
                    String[] descs = new String[keys.length];
                    int sel = 0;
                    for (int i = 0; i < keys.length; i++) {
                        labels[i] = Accounts.nameOf(a, keys[i]);
                        int n = KakaoListener.roomCount(a, keys[i]);
                        descs[i] = "대화방 " + n + "개 감지";
                        if (keys[i].equals(pick[0])) sel = i;
                    }
                    Nav.choose(a, "계정 선택", labels, descs, sel, new Nav.OnPick() {
                        @Override public void pick(int index) {
                            if (index < 0 || index >= keys.length) return;
                            pick[0] = keys[index];
                            val.setText(Accounts.nameOf(a, pick[0]));
                        }
                    });
                }
            });
            row.addView(change);
            body.addView(row);
        }

        Nav.form(a, "대화방 직접 입력", body, "추가", new Nav.OnSave() {
            @Override public String save() {
                RoomRef ref = RoomRef.of(pick[0], f.getText().toString());
                if (!ref.valid()) return "대화방 이름을 입력하십시오.";
                if (Settings.load(a).macro.coversRoom(ref)) {
                    return "이미 대상으로 선택된 대화방입니다.";
                }
                List<Row> now = rows(a);
                for (int i = 0; i < now.size(); i++) {
                    if (ref.equals(now.get(i).ref)) {
                        return "이미 감지 목록에 있는 대화방입니다. 목록에서 선택하십시오.";
                    }
                }
                select(a, ref, true);
                Log.add(a, "대상 대화방을 직접 추가했습니다: " + ref.label(a));
                refresh();
                Nav.reload();
                return null;
            }
        });
    }

    // ── 자잘한 것 ───────────────────────────────────────────────────────────

    /** 스낵바는 한 번에 하나만 (겹쳐서 쌓이면 읽을 수 없다) */
    private static void snack(String msg, String action, Runnable onAction) {
        View old = (SNACK == null) ? null : SNACK.get();
        if (old instanceof Ui.Snack) {
            try { ((Ui.Snack) old).dismiss(); } catch (Throwable ignore) { /* 무해 */ }
        }
        View v = Nav.snack(msg, action, onAction);
        SNACK = (v == null) ? null : new WeakReference<View>(v);
    }

    /**
     * 지난 시각 표기. `1분 이내` / `3분 전` / `5시간 전` / `어제 21:30` / `9/21 21:30`.
     * 0 이하면 `미감지` (구버전 저장값은 감지 시각이 없다).
     */
    static String ago(long ms) {
        if (ms <= 0) return "미감지";
        long now = System.currentTimeMillis();
        long d = now - ms;
        if (d < 0) d = 0;
        if (d < 60000L) return "1분 이내";
        if (d < 3600000L) return (d / 60000L) + "분 전";
        String today = fmt("yyyyMMdd", now);
        String then = fmt("yyyyMMdd", ms);
        if (today.equals(then)) return (d / 3600000L) + "시간 전";
        if (fmt("yyyyMMdd", now - DAY).equals(then)) return "어제 " + fmt("HH:mm", ms);
        return fmt("M/d HH:mm", ms);
    }

    private static String fmt(String pattern, long ms) {
        try {
            return new SimpleDateFormat(pattern, Locale.KOREA).format(new Date(ms));
        } catch (Throwable t) {
            return "-";
        }
    }
}
