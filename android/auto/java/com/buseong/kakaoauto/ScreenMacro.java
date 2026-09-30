package com.buseong.kakaoauto;

import android.content.Intent;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * 매크로 탭 — <b>목록만</b> 있는 화면 (UI_V3 4장).
 *
 * 예전에는 이 한 장에 설정 행 25개 + 아코디언 7개가 쌓여 있었다. 접혀 있으면 안에 뭐가 있는지 모르고,
 * 펼치면 옆 카드와 섞여서 경계가 사라진다 — 사용자가 "뭘 어떻게 설정해야 할지 모르겠다" 고 한 원인이다.
 * 그래서 이 화면은 상단 토글 카드 + 「제목 · 지금 값 · ›」 행만 남기고,
 * 실제 설정은 전부 {@link MacroDetail} 의 전용 서브화면으로 내보냈다.
 *
 * 값 요약 규칙(UI_V3 4장): 미설정은 AMBER 로 `설정 필요`, 꺼진 기능은 DIM, 켜진 기능은 TEXT.
 * 색만 봐도 지금 손을 대야 하는 행이 어디인지 판단된다.
 *
 * 이미지 전송 실패 기록 보기는 홈·내정보 탭도 같이 쓰므로 이 클래스에 남겨둔다.
 */
public final class ScreenMacro {
    private ScreenMacro() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    /** 잠금 카드의 새로고침 버튼 라벨 (진행 중에는 "확인 중…" 으로 바뀐다) */
    private static final String LOCK_REFRESH = "구매 내역 새로고침";

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    // ── 셸 ──────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        // 화면을 보는 것만으로는 모달을 띄우지 않는다 — 잠금 카드(fillLocked)가 같은 안내를 한다.
        // Gate.check 는 실제로 발송을 시도할 때만 부른다.
        LinearLayout col = Ui.screen(a);
        ACT = new WeakReference<MainActivity>(a);
        BODY = new WeakReference<LinearLayout>(col);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "매크로 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 탭 본문을 제자리에서 다시 그린다 (서브화면에서 값을 바꾼 뒤 요약을 맞추는 용도) */
    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (a == null || col == null || a.isFinishing()) return;
        int keep = Theme.accent();
        try {
            Theme.setAccent(Nav.tabColor(Nav.MACRO));
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "매크로 화면 갱신에 실패했습니다: " + t);
        } finally {
            Theme.setAccent(keep);
        }
    }

    private static void fill(final MainActivity a, LinearLayout col) {
        final int fc = Theme.F_MACRO;
        col.addView(Ui.pageHead(a, "AUTO SEND", "매크로",
                "발송 내용 · 보낼 방 · 발송 쿨타임 · 랜덤 쿨타임 · 이미지", fc));

        if (!License.allowed(a, Features.MACRO)) {
            fillLocked(a, col);
            return;
        }
        if (!KakaoAccount.ready(a)) {
            col.addView(Nav.note(a, "등록한 계정으로 보내는 발송은 카카오 계정 등록 후에 됩니다. "
                    + "알림 답장은 알림에서 감지한 계정과 방으로 보내며, 인증코드 등록은 하지 않습니다.",
                    Theme.ACCENT2, null, null));
        }
        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "설정키가 없어 설정을 저장할 수 없습니다."
                    + " 내정보 탭에서 라이선스를 다시 인증하십시오.", Theme.RED, "내정보 열기",
                    new Runnable() { @Override public void run() { Nav.go(Nav.ACCOUNT); } }));
        }

        final Settings s = Settings.load(a);

        // 예약 발송의 이미지 전송은 아무도 안 보고 있을 때 실패한다 → 설정 블록 위에 1회만 띄운다
        View warn = imgFailNote(a);
        if (warn != null) col.addView(warn);

        String msg = msgSummary(s);
        block(a, col, "발송 내용", Ui.navRow(a, Icon.BUBBLE, fc, "발송 내용",
                (msg == null) ? "설정 필요" : msg, (msg == null) ? Theme.AMBER : Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "발송 내용", MacroDetail.message(a)); }
                }));

        String rooms = roomSummary(a, s);
        block(a, col, "보낼 방", Ui.navRow(a, Icon.ROOMS, Theme.F_ROOMS, "보낼 방",
                (rooms == null) ? "설정 필요" : rooms, (rooms == null) ? Theme.AMBER : Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "보낼 방", ScreenRooms.build(a)); }
                }));

        block(a, col, "발송 쿨타임", Ui.navRow(a, Icon.CLOCK, fc, "발송 쿨타임", s.macro.baseText(),
                Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "발송 쿨타임", MacroDetail.cycle(a)); }
                }));

        block(a, col, "랜덤 쿨타임", Ui.navRow(a, Icon.CLOCK, fc, "랜덤 쿨타임", s.macro.randomText(),
                Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "랜덤 쿨타임", MacroDetail.random(a)); }
                }));

        boolean imgOn = s.macro.images.size() > 0;
        boolean imgFail = (lastFail(a) != null);
        block(a, col, "이미지", Ui.navRow(a, Icon.IMAGE, fc, "이미지", imageSummary(a, s),
                imgFail ? Theme.AMBER : (imgOn ? Theme.TEXT : Theme.DIM), new Runnable() {
                    @Override public void run() { Nav.push(a, "이미지", MacroDetail.image(a)); }
                }));

        block(a, col, "최소 신규 메시지", Ui.navRow(a, Icon.BUBBLE, fc, "최소 신규 메시지",
                s.macro.minMessages + "개", Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "최소 신규 메시지", MacroDetail.minMessages(a)); }
                }));

        String phone = KakaoListener.phoneNamesLine(a);
        boolean phoneKnown = phone.length() > 0;
        block(a, col, "폰 카카오톡 계정", accountLine(a, "알림 답장 계정",
                phoneKnown ? (phone + " · 감지됨") : "아직 없음", phoneKnown ? Theme.TEXT : Theme.DIM));
        if (phoneKnown) {
            col.addView(Nav.note(a, "알림에서 자동으로 감지한 계정입니다. "
                    + "알림 답장은 그 방이 속한 계정으로 나갑니다. "
                    + "등록한 카카오 계정과는 별개입니다.", Theme.ACCENT2, null, null));
        }

        block(a, col, "알림 답장", Ui.navRowSwitch(a, "알림 답장으로 보내기",
                "켜면 글은 카카오톡 알림 답장으로 보냅니다. 끄면 등록한 계정으로 보냅니다. "
                        + "답장할 알림이 없거나 카카오 메시지 번호가 없으면 보낸 것으로 세지 않습니다.",
                s.macro.notifyReply, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        s.macro.notifyReply = v;
                        apply(a, s);
                        Log.add(a, v ? "알림 답장으로 보내기를 켰습니다." : "알림 답장으로 보내기를 껐습니다.");
                        refresh();
                    }
                }));

        col.addView(Nav.note(a, "방별 쿨타임은 보낼 방에서 그 방을 엽니다."
                + " 지정하지 않은 방은 발송 쿨타임을 사용합니다."
                + " 경쟁사 저격과 갠톡 자동응답은 홈의 기능에 있습니다.", Theme.ACCENT2, null, null));

        // ── 즉시 발송 ──
        final TextView send = Ui.btn(a, "즉시 발송", true);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(MATCH, WRAP);
        sp.topMargin = Theme.dp(a, 10);
        send.setLayoutParams(sp);
        send.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { sendNow(a, s, send); }
        });
        col.addView(send);
    }

    /**
     * 알림에서 읽은 이 폰의 카카오톡 이름. 누르면 이동하지 않는다.
     * 등록한 카카오 계정 줄과 구분되도록 제목에 폰을 붙인다.
     */
    private static LinearLayout accountLine(MainActivity a, String title, String value, int color) {
        LinearLayout r = Ui.row(a);
        r.setGravity(Gravity.CENTER_VERTICAL);
        r.setMinimumHeight(Theme.dp(a, 56));
        int ph = Theme.dp(a, 16);
        r.setPadding(ph, Theme.dp(a, 12), ph, Theme.dp(a, 12));
        r.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        TextView t = Ui.body(a, title);
        t.setTextColor(Theme.TEXT);
        t.setSingleLine(true);
        t.setEllipsize(TextUtils.TruncateAt.END);
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        r.addView(t);

        TextView v = Ui.sub(a, value);
        v.setTextColor(color);
        v.setGravity(Gravity.END);
        v.setSingleLine(true);
        v.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(WRAP, WRAP);
        vp.leftMargin = Theme.dp(a, 12);
        v.setLayoutParams(vp);
        r.addView(v);
        r.setContentDescription(title + ", " + value);
        return r;
    }

    /** 기능 하나 = 제목 하나 + 행 하나. 여러 설정을 한 목록에 섞지 않는다. */
    private static void block(MainActivity a, LinearLayout col, String title, View row) {
        col.addView(Ui.sectionHeader(a, null, title));
        LinearLayout g = Ui.group(a);
        g.addView(row);
        col.addView(g);
    }

    /** 미구매 상태. 기능 설명 + 구매 + 구매 내역 재조회만 남긴다. */
    private static void fillLocked(final MainActivity a, LinearLayout col) {
        col.addView(Ui.featureCard(a, Theme.F_MACRO, Icon.SEND, Features.label(Features.MACRO),
                Features.descLong(Features.MACRO), Ui.State.OFF, 0L, new Runnable() {
                    @Override public void run() { Gate.openBuy(a, Features.MACRO); }
                }, null));

        // 결제 직후 아직 안 켜진 경우 — 탭을 옮기지 않고 이 자리에서 /entitlements 를 다시 조회한다
        final TextView again = Ui.btn(a, LOCK_REFRESH, false);
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(MATCH, WRAP);
        ap.topMargin = Theme.dp(a, 4);
        again.setLayoutParams(ap);
        again.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Nav.refreshFeature(a, again, Features.MACRO, LOCK_REFRESH);
            }
        });
        col.addView(again);
        TextView note = Ui.sub(a, "결제 후 활성화까지 시간이 소요될 수 있습니다."
                + " 활성화되지 않으면 위 버튼으로 구매 내역을 다시 조회하십시오.");
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(MATCH, WRAP);
        np.topMargin = Theme.dp(a, 10);
        note.setLayoutParams(np);
        col.addView(note);
    }

    // ── 자동발송 머리 카드 ──────────────────────────────────────────────────

    /** 자동발송 토글 + 다음 발송 · 보낼 방. 홈도 같은 카드를 쓴다. */
    static LinearLayout autoCard(final MainActivity a, final Settings s) {
        final int fc = Theme.F_MACRO;
        int keep = Theme.accent();
        Theme.setAccent(fc);
        try {
            LinearLayout hero = Ui.hero(a, fc, Icon.SEND, "AUTO SEND", "매크로",
                    "등록한 카카오 계정으로 발송합니다. 켜짐과 꺼짐은 이 화면에서 바꿉니다.");
            hero.addView(Ui.heroRule(a, fc));

            final TextView status = Ui.sub(a, statusText(a, s));
            status.setTextColor(statusColor(a, s));

            hero.addView(Ui.switchRow(a, s.macro.enabled ? "매크로 켜짐" : "매크로 꺼짐", null,
                    s.macro.enabled, new Ui.OnToggle() {
                        @Override public void on(boolean v) {
                            s.macro.enabled = v;
                            apply(a, s);
                            Log.add(a, v ? "자동발송을 사용으로 변경했습니다." : "자동발송을 미사용으로 변경했습니다.");
                            refresh();
                            MainActivity.refreshHome();
                        }
                    }));

            LinearLayout stats = Ui.row(a);
            stats.setPadding(0, Theme.dp(a, 12), 0, Theme.dp(a, 4));
            long at = nextAtSafe(a, s);
            boolean live = s.macro.enabled && at > 0 && statusColor(a, s) == Theme.SUB;
            stats.addView(Ui.stat(a, "다음 발송", live ? hm(at) : "—", live ? fc : Theme.DIM));
            int rn = s.macro.roomRefs().size();
            stats.addView(Ui.stat(a, "보낼 방", rn + "개", (rn == 0) ? Theme.AMBER : Theme.TEXT));
            hero.addView(stats);

            LinearLayout.LayoutParams stp = new LinearLayout.LayoutParams(MATCH, WRAP);
            stp.topMargin = Theme.dp(a, 10);
            status.setLayoutParams(stp);
            hero.addView(status);
            return hero;
        } finally {
            Theme.setAccent(keep);
        }
    }

    private static long nextAtSafe(MainActivity a, Settings s) {
        try {
            return Scheduler.nextAt(a);
        } catch (Throwable t) {
            return s.macro.nextAt;
        }
    }

    /** 머리 카드 아래 한 줄. 켜짐이면 `다음 발송 21:34 · 주기 요약`. */
    private static String statusText(MainActivity a, Settings s) {
        if (!s.macro.enabled) return "자동발송이 꺼져 있습니다.";
        if (s.macro.roomRefs().isEmpty()) return "보낼 방 미설정 · 발송 보류";
        if (s.macro.message == null || s.macro.message.trim().length() == 0) {
            return "메시지 미설정 · 발송 보류";
        }
        long at = nextAtSafe(a, s);
        String next = (at > 0) ? hm(at) : "예정 없음";
        return "다음 발송 " + next + " · " + cycleSummary(s);
    }

    private static int statusColor(MainActivity a, Settings s) {
        if (!s.macro.enabled) return Theme.DIM;
        if (s.macro.roomRefs().isEmpty()) return Theme.AMBER;
        if (s.macro.message == null || s.macro.message.trim().length() == 0) return Theme.AMBER;
        return Theme.SUB;
    }

    // ── 값 요약 (UI_V3 4장) ─────────────────────────────────────────────────

    /** 메시지 첫 줄 20자. 비어 있으면 null (호출한 쪽에서 `설정 필요` 로 그린다). */
    private static String msgSummary(Settings s) {
        String m = s.macro.message;
        if (m == null || m.trim().length() == 0) return null;
        int nl = m.indexOf('\n');
        String line = ((nl < 0) ? m : m.substring(0, nl)).trim();
        if (line.length() == 0) return Nav.preview(m, 20);
        if (line.length() > 20) return line.substring(0, 20) + "…";
        return (nl < 0) ? line : (line + "…");
    }

    /** `3개` · 계정이 2개 이상이면 `3개 · 부계정 1개 포함`. 0개면 null. */
    static String roomSummary(MainActivity a, Settings s) {
        List<RoomRef> rooms = s.macro.roomRefs();
        if (rooms.isEmpty()) return null;
        int subAcc = 0;
        for (int i = 0; i < rooms.size(); i++) {
            if (!rooms.get(i).isDefault()) subAcc++;
        }
        String v = rooms.size() + "개";
        if (Accounts.multi(a) && subAcc > 0) v = v + " · 부계정 " + subAcc + "개 포함";
        return v;
    }

    static String cycleSummary(Settings s) {
        String base = s.macro.baseText();
        if (s.macro.randomMin > 0) base = base + " · 랜덤 " + s.macro.randomMin + "분";
        int custom = 0;
        java.util.List<RoomRef> rooms = s.macro.roomRefs();
        for (int i = 0; i < rooms.size(); i++) {
            if (s.macro.cooldownMin(rooms.get(i)) > 0) custom++;
        }
        if (custom > 0) return base + " · " + custom + "개 지정";
        return base;
    }

    /**
     * `이미지 미선택` / `3장 · 매번` / `3장 · 3회마다` / `3장 · 수동 전송만`.
     * 전송 실패 기록이 남아 있으면 앞에 ⚠ 를 붙인다 — 상세로 들어갈 이유를 값에서 알려준다.
     */
    static String imageSummary(MainActivity a, Settings s) {
        String base;
        int n = s.macro.images.size();
        if (n == 0) {
            base = "이미지 미선택";
        } else {
            base = n + "장 · " + imgModeKr(s.macro.sendImages);
        }
        Scheduler.ImageFail fail = lastFail(a);
        if (fail == null) return base;
        return "⚠ " + base;
    }

    static String trigSummary(Settings s) {
        if (s.triggers.isEmpty()) return "미사용";
        int on = 0;
        for (int i = 0; i < s.triggers.size(); i++) {
            if (s.triggers.get(i).enabled) on++;
        }
        if (on == 0) return s.triggers.size() + "개 · 전체 미사용";
        return on + "개 사용";
    }

    static String replySummary(Settings s) {
        Settings.AutoReplyCfg r = s.autoreply;
        if (!r.enabled) return "미사용";
        return "사용 · " + scopeKr(r.scope);
    }

    static String scopeKr(String scope) {
        if (Settings.SCOPE_UNKNOWN.equals(scope)) return "미등록 상대만";
        if (Settings.SCOPE_EXCEPT.equals(scope)) return "특정 대화방 제외";
        return "모든 1:1";
    }

    static String imgModeKr(String mode) {
        if (Settings.IMG_EVERY.equals(mode)) return "매번";
        if (Settings.IMG_EVERY_N.equals(mode)) return "N회마다";
        if (Settings.IMG_MANUAL.equals(mode)) return "수동 전송만";
        return "매번";
    }

    // ── 즉시 발송 ───────────────────────────────────────────────────────────

    private static void sendNow(final MainActivity a, final Settings s, final TextView btn) {
        if (!License.allowed(a, Features.MACRO)) { Gate.check(a, Features.MACRO); return; }

        final List<RoomRef> rooms = targets(a, s);
        if (rooms.isEmpty()) {
            if (!s.macro.roomRefs().isEmpty()) {
                Ui.toast(a, "방이 모두 미사용 계정에 속합니다. 내정보 탭에서 대상 계정을 확인하십시오.");
            } else {
                Ui.toast(a, "보낼 방을 먼저 설정하십시오.");
            }
            return;
        }
        final String msg = s.macro.message;
        if (msg == null || msg.trim().length() == 0) {
            Ui.toast(a, "발송 메시지를 먼저 입력하십시오.");
            return;
        }

        doSendNow(a, s, btn, rooms, msg);
    }

    /** 방 중 사용 계정에 속한 것만 (Scheduler 와 같은 규칙) */
    private static List<RoomRef> targets(MainActivity a, Settings s) {
        ArrayList<RoomRef> out = new ArrayList<RoomRef>();
        List<RoomRef> all = s.macro.roomRefs();
        for (int i = 0; i < all.size(); i++) {
            RoomRef r = all.get(i);
            if (r == null || !r.valid()) continue;
            if (!s.accountOn(r.acc)) continue;
            out.add(r);
        }
        return out;
    }

    private static void doSendNow(final MainActivity a, final Settings s, final TextView btn,
                                 final List<RoomRef> rooms, final String msg) {
        Nav.busy(btn, true, "발송 중…", "즉시 발송");
        new Thread(new Runnable() {
            @Override public void run() {
                int ok = 0;
                StringBuilder failed = new StringBuilder();
                for (int i = 0; i < rooms.size(); i++) {
                    RoomRef room = rooms.get(i);
                    String label = room.label(a);
                    boolean sent = false;
                    try {
                        if (s.macro.notifyReply) {
                            sent = com.buseong.kakaoauto.engine.EngineSend.sendMacroText(a, room, msg, true);
                        } else if (!com.buseong.kakaoauto.engine.EngineSend.handles(a, room)) {
                            Log.add(a, "「" + label + "」 " + com.buseong.kakaoauto.engine.EngineSend.unavailableReason(a, room));
                        } else {
                            sent = com.buseong.kakaoauto.engine.EngineSend.sendText(a, room, msg);
                        }
                    } catch (Throwable t) {
                        Log.add(a, "즉시 발송 중 오류가 발생했습니다. (" + label + ") " + t);
                    }
                    if (sent) {
                        ok++;
                    } else {
                        if (failed.length() > 0) failed.append(", ");
                        failed.append(label);
                    }
                }
                if (ok > 0) MainActivity.countSent(a, ok);
                Log.add(a, "즉시 발송 · 성공 " + ok + "건"
                        + ((failed.length() > 0) ? (" / 실패: " + failed) : ""));
                final int done = ok;
                final boolean partial = failed.length() > 0;
                a.runOnUiThread(new Runnable() {
                    @Override public void run() {
                        Nav.busy(btn, false, "발송 중…", "즉시 발송");
                        if (done == 0) {
                            Ui.toast(a, "발송에 실패했습니다. 활동 로그를 확인하십시오.");
                        } else if (partial) {
                            Ui.toast(a, done + "건 발송했습니다. 일부 대화방은 실패했습니다.");
                        } else {
                            Ui.toast(a, done + "건 발송했습니다.");
                        }
                        refresh();
                    }
                });
            }
        }, "macro-send-now").start();
    }

    // ── 이미지 선택 결과 (MainActivity.onActivityResult 에서 넘어온다) ──────

    public static void onImagesPicked(MainActivity a, int res, Intent data) {
        if (a == null) return;
        if (res != android.app.Activity.RESULT_OK) {
            Log.add(a, "이미지 선택을 취소했습니다.");
            return;
        }
        Settings s = Settings.load(a);
        int space = Settings.MAX_IMAGES - s.macro.images.size();
        if (space <= 0) {
            Ui.toast(a, "이미지는 최대 " + Settings.MAX_IMAGES + "장까지 첨부됩니다.");
            return;
        }
        List<String> got;
        try {
            got = ImagePicker.onResult(a, data, space);
        } catch (Throwable t) {
            Log.add(a, "이미지 선택 결과를 읽지 못했습니다: " + t);
            Ui.toast(a, "이미지를 읽지 못했습니다.");
            return;
        }
        if (got == null || got.isEmpty()) {
            Ui.toast(a, "선택된 이미지가 없습니다.");
            return;
        }
        int added = 0;
        for (int i = 0; i < got.size(); i++) {
            if (s.macro.addImage(got.get(i))) added++;
        }
        apply(a, s);
        Log.add(a, "첨부 이미지 " + added + "장을 추가했습니다. (총 " + s.macro.images.size() + "장)");
        if (added < got.size()) {
            Ui.toast(a, "이미지는 최대 " + Settings.MAX_IMAGES + "장까지 첨부됩니다.");
        }
        refresh();
        MacroDetail.refresh();
    }

    // ── 이미지 전송 실패 경고 ───────────────────────────────────────────────

    /**
     * 이미지 전송이 마지막에 실패했으면 경고 박스를 돌려준다. 기록이 없으면 null.
     * 홈 화면·내정보 화면도 같은 박스를 쓴다 (null 이면 addView 하지 마라).
     */
    public static View imgFailNote(final MainActivity a) {
        Scheduler.ImageFail fail = lastFail(a);
        if (fail == null) return null;

        String room = (fail.room.length() == 0) ? "대화방 미확인" : Nav.preview(fail.room, 14);
        String txt = "⚠ 이미지 전송에 실패했습니다.\n"
                + dayTime(fail.at) + " · " + room + " — " + Nav.preview(fail.why, 70) + "\n"
                + "텍스트 발송은 정상 동작합니다.";
        return Nav.note(a, txt, Theme.RED, "기록 보기", new Runnable() {
            @Override public void run() { showFail(a); }
        });
    }

    private static Scheduler.ImageFail lastFail(MainActivity a) {
        try {
            return Scheduler.lastImageFail(a);
        } catch (Throwable t) {
            return null;
        }
    }

    // ── 이미지 전송 기록 ────────────────────────────────────────────────────

    /** 마지막 이미지 전송 실패 기록 (복사 가능). 전송 방식과 무관하게 Scheduler 기록만 보여준다. */
    static void showFail(final MainActivity a) {
        final String all = failText(a);
        Nav.showText(a, "이미지 전송 기록", all, new Runnable() {
            @Override public void run() { Nav.copy(a, "이미지 전송 기록", all); }
        });
    }

    static String failText(MainActivity a) {
        Scheduler.ImageFail fail = lastFail(a);
        if (fail == null) {
            return "■ 마지막 이미지 전송 실패: 기록 없음\n"
                 + "  실패 이력이 없거나, 마지막 전송이 성공하여 기록이 삭제된 상태입니다.\n";
        }
        return "■ 마지막 이미지 전송 실패\n"
             + "  시각: " + ago(fail.at) + "\n"
             + "  대화방: " + (fail.room.length() == 0 ? "미확인" : fail.room) + "\n"
             + "  사유: " + fail.why + "\n";
    }

    static boolean hasFail(MainActivity a) { return lastFail(a) != null; }

    // ── 지난 시각 표기 ──────────────────────────────────────────────────────
    //  Nav.whenRel 은 "12분 뒤" 처럼 미래용이다. 과거 시각을 넣으면 전부 "곧" 이 나와서
    //  일주일 전 덤프가 방금 것처럼 보인다. 그래서 과거 표기는 여기서 따로 만든다.
    //  내정보 화면도 같은 표기를 써야 해서 패키지 안에 열어둔다.

    /** "9/27(토) 21:05 · 12분 전" */
    static String ago(long at) {
        if (at <= 0) return "기록 없음";
        return Nav.when(at) + " · " + agoShort(at);
    }

    /** "12분 전" (미래면 "시각 오류") */
    static String agoShort(long at) {
        if (at <= 0) return "기록 없음";
        long d = System.currentTimeMillis() - at;
        if (d < -60000L) return "시각 오류";
        if (d < 60000L) return "방금";
        if (d < 3600000L) return (d / 60000L) + "분 전";
        if (d < 86400000L) return (d / 3600000L) + "시간 전";
        return (d / 86400000L) + "일 전";
    }

    /** "오늘 21:30" · "어제 21:30" · "9/26 21:30" */
    static String dayTime(long at) {
        if (at <= 0) return "시각 미확인";
        try {
            int diff = dayDiff(at, System.currentTimeMillis());
            String hm = hm(at);
            if (diff == 0) return "오늘 " + hm;
            if (diff == 1) return "어제 " + hm;
            return new SimpleDateFormat("M/d HH:mm", Locale.KOREA).format(new Date(at));
        } catch (Throwable t) {
            return Nav.when(at);
        }
    }

    /** "21:34" */
    static String hm(long at) {
        if (at <= 0) return "-";
        try {
            return new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date(at));
        } catch (Throwable t) {
            return "-";
        }
    }

    /** 자정 기준으로 며칠 전인지 (미래면 음수) */
    private static int dayDiff(long then, long now) {
        return (int) ((midnight(now) - midnight(then)) / 86400000L);
    }

    private static long midnight(long ms) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(ms);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    // ── 저장 ────────────────────────────────────────────────────────────────

    /**
     * 설정 저장 + 알람 갱신. 값이 바뀌면 무조건 여기를 거친다. (서브화면도 이걸 쓴다)
     *
     * Scheduler 쪽 계약: 매크로가 켜져 있고 기능도 살아있을 때만 ensureScheduled 를 부르고,
     * 아니면 cancel 을 부른다.
     */
    static void apply(MainActivity a, Settings s) {
        // Settings.save 는 설정키가 없으면 예외 없이 조용히 넘어간다 → 여기서 먼저 막고 알려준다
        if (!Settings.canSave(a)) {
            Log.add(a, "설정키가 없어 설정을 저장하지 못했습니다.");
            Ui.toast(a, "설정을 저장하지 못했습니다. 내정보 탭에서 라이선스를 인증하십시오.");
            return;
        }
        try {
            s.save(a);
        } catch (Throwable t) {
            Log.add(a, "설정 저장에 실패했습니다: " + t);
            Ui.toast(a, "설정을 저장하지 못했습니다.");
            return;
        }
        try {
            if (s.macro.enabled && License.allowed(a, Features.MACRO)) Scheduler.ensureScheduled(a);
            else Scheduler.cancel(a);
        } catch (Throwable t) {
            Log.add(a, "발송 예약을 갱신하지 못했습니다: " + t);
        }
    }
}
