package com.buseong.kakaoauto;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
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
 *   - 체크하면 즉시 저장. 확인 버튼 없음.
 *   - ✕ 는 감지 목록에서 1건 삭제 (멤버 이름이 방으로 잘못 들어간 항목 정리) + 5초 실행 취소
 *   - [직접 입력 추가] 는 아직 감지 안 된 방을 손으로 넣는다
 *   - [감지 목록 초기화] 는 감지 캐시만 비우고 선택된 방은 남긴다
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
        final boolean multi = (accCount >= 2) || (accs.size() >= 2);

        int detected = 0;
        int selected = 0;
        for (int i = 0; i < rows.size(); i++) {
            if (rows.get(i).detected) detected++;
            if (rows.get(i).selected) selected++;
        }

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

        if (rows.isEmpty()) {
            col.addView(Nav.note(a, "감지된 대화방이 없습니다. 카카오톡 메시지를 1회 수신하면 "
                    + "자동으로 등록되며, 직접 입력하여 추가할 수도 있습니다.", Theme.ACCENT2, null, null));
        } else if (!multi) {
            LinearLayout sh = Ui.sectionHeader(a, null, "선택 " + selected + "개 · 감지 " + detected + "개");
            rememberHeader(SINGLE_KEY, sh);
            col.addView(sh);
            addRooms(a, col, rows);
        } else {
            for (int i = 0; i < accs.size(); i++) {
                String acc = accs.get(i);
                List<Row> mine = filter(rows, acc);
                LinearLayout sh = Ui.sectionHeader(a, null, header(a, acc, mine));
                rememberHeader(acc, sh);
                col.addView(sh);
                addRooms(a, col, mine);
            }
        }

        TextView add = Nav.wideBtn(a, "직접 입력 추가", false, new Runnable() {
            @Override public void run() { addDialog(a); }
        });
        col.addView(add);

        TextView clear = Nav.wideBtn(a, "감지 목록 초기화", false, new Runnable() {
            @Override public void run() { clearDialog(a); }
        });
        clear.setTextColor(Theme.RED);
        col.addView(clear);

        TextView help = Ui.sub(a, "감지 목록 초기화는 감지된 대화방 기록만 비웁니다. "
                + "선택된 대상 대화방은 유지됩니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.topMargin = Theme.dp(a, 10);
        help.setLayoutParams(hp);
        col.addView(help);
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
        g.addView(Ui.checkRow(a, r.ref.name, r.detected ? ago(r.lastAt) : "미감지",
                badges, r.selected, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        select(a, r.ref, v);
                        // 전체 refresh 는 selected-first 정렬로 행이 튀므로 헤더 수치만 갱신한다.
                        updateHeaders(a);
                        Nav.reload();
                    }
                }, del));

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

    /** 저장된 방 cfg 를 생성 없이 읽는다 (없으면 null = 상위 기본값 따름) */
    private static Settings.RoomCfg storedCfg(Settings s, RoomRef ref) {
        if (s == null || ref == null || s.macro.roomCfgs == null) return null;
        return s.macro.roomCfgs.get(ref.key());
    }

    /** 이 방에 덮어쓰기(또는 끄기)가 하나라도 걸려 있나 */
    private static boolean hasOverride(Settings.RoomCfg rc) {
        return rc != null && (!rc.enabled || rc.hasMsg || rc.hasCd || rc.hasMin);
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
                    + "아래에서 메시지를 덮어쓰거나 전역 기본 메시지를 설정하십시오.", Theme.AMBER, null, null));
        } else {
            col.addView(Nav.note(a, "현재 이 대화방은 " + cdMin + "~" + cdMax
                    + "분 주기로 발송되며, 최소 신규 메시지는 " + mm + "개입니다.\n"
                    + "발송 메시지: " + Nav.preview(eff, 40), Theme.ACCENT2, null, null));
        }

        // ── 덮어쓰기 ──
        col.addView(Ui.sectionHeader(a, null, "덮어쓰기"));
        LinearLayout g = Ui.group(a);

        g.addView(Ui.navRowSwitch(a, "메시지 덮어쓰기", rc.hasMsg ? null : "끄면 상위 기본값을 따릅니다.",
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

        g.addView(Ui.navRowSwitch(a, "쿨타임 덮어쓰기", rc.hasCd ? null : "끄면 상위 기본값을 따릅니다.",
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

        g.addView(Ui.navRowSwitch(a, "최소 신규 메시지 덮어쓰기",
                rc.hasMin ? null : "끄면 상위 기본값을 따릅니다.", rc.hasMin, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        rc.hasMin = v;
                        persistRoom(a, s, null);
                    }
                }));
        if (rc.hasMin) {
            g.addView(Ui.navRow(a, "최소 신규 메시지", rc.minMessages + "개", Theme.TEXT, new Runnable() {
                @Override public void run() { editRoomMin(a, s, ref, rc); }
            }));
        }
        col.addView(g);

        col.addView(Nav.note(a, "덮어쓰기를 끄면 계정 기본값 또는 전역 기본값을 따릅니다. "
                + "우선순위는 대화방 › 계정 › 전역 순입니다.", Theme.ACCENT2, null, null));
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
        final Nav.NumField mm = new Nav.NumField("최소 신규 메시지 수", "1", 0, 999, rc.minMessages);
        Nav.editNums(a, "최소 신규 메시지",
                "마지막 발송 이후 상대 메시지가 이 수량 이상 누적된 경우에만 발송합니다. 0은 항상 발송입니다.",
                new Nav.NumField[] { mm }, new Nav.OnNums() {
                    @Override public String ok() {
                        rc.minMessages = mm.value;
                        if (!s.save(a)) {
                            return "저장하지 못했습니다. 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.";
                        }
                        Log.add(a, "「" + ref.label(a) + "」 대화방 최소 신규 메시지를 "
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
