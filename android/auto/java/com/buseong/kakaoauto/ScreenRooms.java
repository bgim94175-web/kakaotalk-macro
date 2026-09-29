package com.buseong.kakaoauto;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.buseong.kakaoauto.engine.Engine;
import com.buseong.kakaoauto.engine.EngineException;
import com.buseong.kakaoauto.engine.KakaoEngine;
import com.buseong.kakaoauto.engine.RoomKind;
import com.buseong.kakaoauto.engine.RoomLinks;

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
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 방 관리 화면 (UI_V3 5장). 매크로 탭의 `보낼 방 ›` 에서 Nav.push 로 열린다.
 *
 * 등록한 카카오 계정의 LOCO 대화방을 세 목록으로 나눠 보여 준다.
 * 오픈채팅방, 일반 채팅방, 오픈프로필로 온 갠톡. 칸을 바꿔도 선택은 유지된다.
 * 체크하면 그 방 번호로 연결하고 보낼 방에 넣는다. 발송은 그 세션으로만 한다.
 */
public final class ScreenRooms {
    private ScreenRooms() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private static final long DAY = 86400000L;

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;
    private static WeakReference<View> SNACK;

    private static final Handler H = new Handler(Looper.getMainLooper());
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    /** 0 오픈채팅방, 1 일반 채팅방, 2 오픈프로필로 온 갠톡. 화면을 다시 그려도 유지한다. */
    private static int TAB = 1;
    private static final String[] TAB_KIND = {
            RoomKind.OPEN_ROOM, RoomKind.NORMAL, RoomKind.OPEN_DM
    };
    private static final String[] TAB_LABEL = {
            "오픈채팅방", "일반 채팅방", "오픈프로필로 온 갠톡"
    };

    /** 이번에 받은 카카오 대화방 목록. null 이면 아직 없다. */
    private static List<KakaoEngine.KakaoRoom> LOADED;
    /** 목록을 못 받았을 때의 라이브러리 오류. 없으면 null. */
    private static String LOAD_ERR;
    private static boolean inflight = false;
    private static int loadGen = 0;

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
        /** LOCO 목록의 방. 목록에 없는 선택 방이면 null. */
        KakaoEngine.KakaoRoom room;
    }

    // ── 셸 ──────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        Theme.setAccent(Theme.F_ROOMS);
        LOADED = null;
        LOAD_ERR = null;
        loadGen++;
        inflight = false;
        LinearLayout col = Ui.screen(a);
        ACT = new WeakReference<MainActivity>(a);
        BODY = new WeakReference<LinearLayout>(col);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "방 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 목록을 제자리에서 다시 채운다 (삭제·추가·초기화 후) */
    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (a == null || col == null || a.isFinishing()) return;
        int keep = Theme.accent();
        try {
            Theme.setAccent(Theme.F_ROOMS);
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "방 목록 갱신에 실패했습니다: " + t);
        } finally {
            Theme.setAccent(keep);
        }
    }

    // ── 본문 ────────────────────────────────────────────────────────────────

    private static void fill(final MainActivity a, LinearLayout col) {
        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "라이선스 인증 전에는 설정이 저장되지 않습니다. "
                    + "내정보 탭에서 인증을 완료하십시오.", Theme.AMBER, null, null));
        }

        final boolean ready = KakaoAccount.ready(a) && Engine.ready(a);
        if (ready && LOADED == null && LOAD_ERR == null && !inflight) startLoad(a);

        final List<Row> rows = rows(a);
        int listed = 0;
        int selected = 0;
        for (int i = 0; i < rows.size(); i++) {
            if (rows.get(i).detected) listed++;
            if (rows.get(i).selected) selected++;
        }

        LinearLayout hero = Ui.hero(a, Theme.F_ROOMS, Icon.ROOMS, "TARGET ROOMS", "보낼 방",
                "등록한 카카오 계정의 대화방입니다. 알림 미리보기 없이도 모두 고를 수 있습니다.");
        hero.addView(Ui.heroRule(a, Theme.F_ROOMS));
        LinearLayout stats = Ui.row(a);
        stats.setPadding(0, Theme.dp(a, 10), 0, 0);
        stats.addView(Ui.stat(a, "선택", selected + "개", (selected == 0) ? Theme.AMBER : Theme.TEXT));
        stats.addView(Ui.stat(a, "대화방", listed + "개", Theme.TEXT));
        hero.addView(stats);
        col.addView(hero);

        if (!ready) {
            col.addView(Nav.note(a, "카카오 계정을 등록하고 인증을 마치면 그 계정의 대화방을 모두 불러옵니다.",
                    Theme.AMBER, null, null));
        } else if (inflight && LOADED == null) {
            col.addView(Nav.note(a, "대화방 목록을 불러오는 중입니다.", Theme.ACCENT2, null, null));
        } else if (LOAD_ERR != null && (LOADED == null || LOADED.isEmpty())) {
            col.addView(Nav.note(a, "대화방 목록을 불러오지 못했습니다. " + LOAD_ERR,
                    Theme.AMBER, null, null));
        } else {
            if (LOAD_ERR != null) {
                col.addView(Nav.note(a, "목록을 다시 불러오지 못했습니다. 이전에 받은 목록을 보여 줍니다. " + LOAD_ERR,
                        Theme.AMBER, null, null));
            }
            int[] counts = kindCounts(rows);
            col.addView(kindTabs(a, counts));
            List<Row> visible = ofKind(rows, TAB_KIND[TAB]);
            col.addView(Ui.sectionHeader(a, null, TAB_LABEL[TAB] + " " + counts[TAB] + "개"));
            if (visible.isEmpty()) {
                col.addView(emptyLine(a, "이 종류에 대화방이 없습니다."));
            } else {
                col.addView(section(a, visible));
            }
            List<Row> missing = orphans(rows);
            if (!missing.isEmpty()) {
                col.addView(Ui.sectionHeader(a, null, "목록에 없는 선택"));
                col.addView(section(a, missing));
            }
        }

        if (ready) {
            TextView reload = Nav.wideBtn(a, "목록 다시 불러오기", false, new Runnable() {
                @Override public void run() { reload(a); }
            });
            col.addView(reload);
        }

        TextView add = Nav.wideBtn(a, "이름으로 찾기", false, new Runnable() {
            @Override public void run() { addDialog(a); }
        });
        col.addView(add);

        TextView help = Ui.sub(a, "목록은 등록한 카카오 계정의 대화방입니다. "
                + "알림을 받은 적 없는 방도 선택할 수 있습니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.topMargin = Theme.dp(a, 10);
        help.setLayoutParams(hp);
        col.addView(help);
    }

    /** 방 한 계정 분량을 카드 하나로 */
    private static LinearLayout section(final MainActivity a, List<Row> list) {
        LinearLayout g = Ui.group(a);
        if (list.isEmpty()) {
            TextView t = Ui.sub(a, "대화방이 없습니다.");
            int ph = Theme.dp(a, 16);
            t.setPadding(ph, Theme.dp(a, 18), ph, Theme.dp(a, 18));
            t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
            g.addView(t);
            return g;
        }
        for (int i = 0; i < list.size(); i++) {
            final Row r = list.get(i);
            String[] badges = r.groupKnown
                    ? new String[] { r.group ? "단체" : "1:1" }
                    : null;
            g.addView(Ui.checkRow(a, r.ref.name, r.detected ? ago(r.lastAt) : "이 목록에 없음",
                    badges, r.selected, new Ui.OnToggle() {
                        @Override public void on(boolean v) {
                            select(a, r, v);
                            Nav.reload();
                        }
                    }, null));
        }
        return g;
    }

    /** 세 목록. 칸의 숫자는 그 종류에 있는 대화방 수다. */
    private static View kindTabs(final MainActivity a, int[] counts) {
        LinearLayout g = Ui.group(a);
        for (int i = 0; i < TAB_KIND.length; i++) g.addView(kindTab(a, i, counts[i]));
        return g;
    }

    private static View kindTab(final MainActivity a, final int index, int count) {
        final boolean on = TAB == index;
        LinearLayout row = Ui.row(a);
        int ph = Theme.dp(a, 16);
        row.setPadding(ph, Theme.dp(a, 14), ph, Theme.dp(a, 14));
        if (on) row.setBackgroundColor(Theme.fade(Theme.PRIMARY, 0.10f));
        row.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (TAB == index) return;
                TAB = index;
                refresh();
            }
        });
        TextView name = Ui.body(a, TAB_LABEL[index]);
        name.setTextColor(on ? Theme.PRIMARY : Theme.TEXT);
        name.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        TextView n = Ui.h2(a, String.valueOf(count));
        n.setTextColor(on ? Theme.PRIMARY : Theme.TEXT);
        row.addView(name);
        row.addView(n);
        return row;
    }

    private static int[] kindCounts(List<Row> rows) {
        int[] counts = new int[TAB_KIND.length];
        for (int i = 0; i < rows.size(); i++) {
            Row r = rows.get(i);
            if (!r.detected || r.room == null) continue;
            for (int k = 0; k < TAB_KIND.length; k++) {
                if (TAB_KIND[k].equals(r.room.listKind)) counts[k]++;
            }
        }
        return counts;
    }

    /** 지금 칸에 해당하는 감지 방만. 다른 종류는 넣지 않는다. */
    private static List<Row> ofKind(List<Row> rows, String kind) {
        ArrayList<Row> out = new ArrayList<Row>();
        for (int i = 0; i < rows.size(); i++) {
            Row r = rows.get(i);
            if (!r.detected || r.room == null) continue;
            if (kind.equals(r.room.listKind)) out.add(r);
        }
        sort(out);
        return out;
    }

    /** 목록에서 빠졌지만 선택으로 남은 방. 어느 칸에도 섞지 않는다. */
    private static List<Row> orphans(List<Row> rows) {
        ArrayList<Row> out = new ArrayList<Row>();
        for (int i = 0; i < rows.size(); i++) {
            if (!rows.get(i).detected) out.add(rows.get(i));
        }
        return out;
    }

    private static LinearLayout emptyLine(MainActivity a, String text) {
        LinearLayout g = Ui.group(a);
        TextView t = Ui.sub(a, text);
        int ph = Theme.dp(a, 16);
        t.setPadding(ph, Theme.dp(a, 18), ph, Theme.dp(a, 18));
        t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        g.addView(t);
        return g;
    }

    /** `본계정 · 선택 2개` */
    private static String header(Context c, String acc, List<Row> mine) {
        int sel = 0;
        for (int i = 0; i < mine.size(); i++) if (mine.get(i).selected) sel++;
        String name = Accounts.nameOf(c, acc);
        return name + " · 선택 " + sel + "개";
    }

    // ── 목록 만들기 ─────────────────────────────────────────────────────────

    /**
     * 등록 계정의 LOCO 대화방 전체 + 목록에 없는 선택 방.
     * 선택된 방은 목록에서 빠져도 보여 준다. 안 보이면 해제할 방법이 없다.
     */
    private static List<Row> rows(Context c) {
        LinkedHashMap<String, Row> map = new LinkedHashMap<String, Row>();
        List<KakaoEngine.KakaoRoom> src = LOADED;
        if (src != null) bindSelected(c, src);
        Settings settings = Settings.load(c);
        if (src != null) {
            for (int i = 0; i < src.size(); i++) {
                KakaoEngine.KakaoRoom k = src.get(i);
                if (k == null || !realChatId(k.chatId)) continue;
                RoomRef ref = refFor(c, k);
                if (ref == null || !ref.valid()) continue;
                if (PENDING.containsKey(ref.key())) continue;
                Row r = new Row();
                r.ref = ref;
                r.detected = true;
                r.groupKnown = !"unknown".equals(k.kind);
                r.group = k.isGroup();
                r.lastAt = k.lastAt;
                r.selected = settings.macro.coversRoom(ref);
                r.room = k;
                map.put(k.chatId, r);
            }
        }
        List<RoomRef> sel = settings.macro.roomRefs();
        for (int i = 0; i < sel.size(); i++) {
            RoomRef ref = sel.get(i);
            if (ref == null || !ref.valid()) continue;
            if (PENDING.containsKey(ref.key())) continue;
            if (listed(map, ref)) continue;
            Row n = new Row();
            n.ref = ref;
            n.selected = true;
            map.put("sel:" + ref.key(), n);
        }
        return new ArrayList<Row>(map.values());
    }

    private static boolean listed(Map<String, Row> map, RoomRef ref) {
        for (Row r : map.values()) {
            if (r.ref != null && r.ref.equals(ref)) return true;
        }
        return false;
    }

    /** 이름으로 딱 하나 맞는 선택 방은 방 번호에 연결한다. 발송이 그 방으로 간다. */
    private static void bindSelected(Context c, List<KakaoEngine.KakaoRoom> list) {
        if (!Prefs.secReady(c)) return;
        List<RoomRef> sel = Settings.load(c).macro.roomRefs();
        for (int i = 0; i < sel.size(); i++) {
            RoomRef ref = sel.get(i);
            if (ref == null || !ref.valid() || RoomLinks.get(c, ref) != null) continue;
            KakaoEngine.KakaoRoom hit = null;
            int n = 0;
            for (int j = 0; j < list.size(); j++) {
                KakaoEngine.KakaoRoom k = list.get(j);
                if (k == null || !sameName(ref.name, k)) continue;
                if (RoomLinks.refFor(c, k.chatId) != null) continue;
                hit = k;
                n++;
            }
            if (n == 1) RoomLinks.put(c, ref, hit);
        }
    }

    private static RoomRef refFor(Context c, KakaoEngine.KakaoRoom k) {
        RoomRef linked = RoomLinks.refFor(c, k.chatId);
        if (linked != null && linked.valid()) return linked;
        return uniqueRef(c, k);
    }

    /** 같은 이름이 이미 다른 방 번호에 연결되어 있으면 번호를 붙여 구분한다. */
    private static RoomRef uniqueRef(Context c, KakaoEngine.KakaoRoom k) {
        String base = k.name();
        RoomRef ref = RoomRef.of(base);
        RoomLinks.Link have = RoomLinks.get(c, ref);
        if (have == null || k.chatId.equals(have.chatId)) return ref;
        String tail = k.chatId.length() > 4 ? k.chatId.substring(k.chatId.length() - 4) : k.chatId;
        RoomRef alt = RoomRef.of(base + " · " + tail);
        RoomLinks.Link altHave = RoomLinks.get(c, alt);
        if (altHave == null || k.chatId.equals(altHave.chatId)) return alt;
        return RoomRef.of(base + " · " + k.chatId);
    }

    private static boolean sameName(String want, KakaoEngine.KakaoRoom k) {
        String n = norm(want);
        if (n.length() == 0) return false;
        if (n.equals(norm(k.name()))) return true;
        if (k.title.trim().length() > 0 && n.equals(norm(k.title))) return true;
        return k.displayName.trim().length() > 0 && n.equals(norm(k.displayName));
    }

    private static String norm(String s) {
        if (s == null) return "";
        return s.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    private static boolean realChatId(String id) {
        if (id == null || id.length() == 0 || id.charAt(0) == '0') return false;
        for (int i = 0; i < id.length(); i++) {
            char ch = id.charAt(i);
            if (ch < '0' || ch > '9') return false;
        }
        return true;
    }

    private static List<Row> sortCopy(List<Row> rows) {
        ArrayList<Row> out = new ArrayList<Row>(rows);
        sort(out);
        return out;
    }

    private static void startLoad(final MainActivity a) {
        if (a == null || !KakaoAccount.ready(a) || !Engine.ready(a)) return;
        final int gen = ++loadGen;
        inflight = true;
        IO.execute(new Runnable() {
            @Override public void run() {
                List<KakaoEngine.KakaoRoom> list = null;
                String err = null;
                try {
                    list = Engine.get(a).rooms(true);
                } catch (EngineException e) {
                    err = e.userText();
                } catch (Throwable t) {
                    err = String.valueOf(t);
                }
                final List<KakaoEngine.KakaoRoom> got = list;
                final String why = err;
                H.post(new Runnable() {
                    @Override public void run() {
                        if (gen != loadGen) return;
                        inflight = false;
                        if (got != null) {
                            LOADED = got;
                            LOAD_ERR = null;
                        } else {
                            LOAD_ERR = (why == null || why.trim().length() == 0)
                                    ? "카카오 서버가 실패 원인을 주지 않았습니다." : why;
                        }
                        refresh();
                    }
                });
            }
        });
    }

    private static void reload(MainActivity a) {
        LOADED = null;
        LOAD_ERR = null;
        loadGen++;
        inflight = false;
        startLoad(a);
        refresh();
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

    /** 체크하면 그 카카오 방 번호로 연결한 뒤 보낼 방에 넣는다. */
    private static void select(Context c, Row row, boolean on) {
        if (c == null || row == null || row.ref == null) return;
        if (on && row.room != null) {
            RoomRef ref = refFor(c, row.room);
            if (ref == null || !ref.valid()) return;
            if (RoomLinks.get(c, ref) == null && !RoomLinks.put(c, ref, row.room)) {
                snack("저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.", null, null);
                refresh();
                return;
            }
            select(c, ref, true);
            return;
        }
        select(c, row.ref, on);
    }

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
                "감지된 대화방 기록을 전부 삭제합니다. 선택된 방은 유지됩니다. "
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
                        refresh();
                        Nav.reload();
                        snack("감지 목록을 초기화했습니다.", null, null);
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

    /** 불러온 목록에서 이름이 같은 방을 찾아 선택한다. 알림은 보지 않는다. */
    private static void addDialog(final MainActivity a) {
        if (LOADED == null || LOADED.isEmpty()) {
            snack("대화방 목록을 먼저 불러오십시오.", null, null);
            return;
        }
        LinearLayout body = Nav.col(a);
        TextView help = Ui.sub(a, "등록한 계정의 대화방 이름과 같으면 그 방을 선택합니다. "
                + "알림을 받은 적이 없어도 됩니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.bottomMargin = Theme.dp(a, 10);
        help.setLayoutParams(hp);
        body.addView(help);

        final EditText f = Ui.field(a, "대화방 이름");
        f.setSingleLine(true);
        f.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        body.addView(f);

        Nav.form(a, "이름으로 찾기", body, "선택", new Nav.OnSave() {
            @Override public String save() {
                String name = f.getText().toString();
                if (name == null || name.trim().length() == 0) return "대화방 이름을 입력하십시오.";
                KakaoEngine.KakaoRoom hit = null;
                int n = 0;
                List<KakaoEngine.KakaoRoom> src = LOADED;
                if (src == null) return "대화방 목록이 없습니다. 목록을 다시 불러오십시오.";
                for (int i = 0; i < src.size(); i++) {
                    KakaoEngine.KakaoRoom k = src.get(i);
                    if (k != null && sameName(name, k)) { hit = k; n++; }
                }
                if (n == 0) return "이 계정의 대화방 목록에 없는 이름입니다.";
                if (n > 1) return "같은 이름의 대화방이 여러 개입니다. 목록에서 선택하십시오.";
                List<Row> now = rows(a);
                for (int i = 0; i < now.size(); i++) {
                    Row r = now.get(i);
                    if (r.room != null && hit.chatId.equals(r.room.chatId)) {
                        select(a, r, true);
                        Log.add(a, "대화방을 선택했습니다: " + r.ref.label(a));
                        refresh();
                        Nav.reload();
                        return null;
                    }
                }
                return "목록에서 그 대화방을 찾지 못했습니다.";
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
