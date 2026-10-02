package com.buseong.kakaoauto;

import android.content.Intent;
import android.os.Handler;
import android.os.Looper;
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
 * 진단(사진 전송 실패 기록·화면 기록) 관련 도구는 내정보 탭도 같이 쓰므로 이 클래스에 남겨둔다.
 */
public final class ScreenMacro {
    private ScreenMacro() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    /** 화면 기록이 이보다 오래됐으면 "지난 기록" 이라고 못을 박는다 */
    private static final long DUMP_STALE_MS = 3 * 60 * 1000L;

    /** dumpSection 에 넘기는 "이번 시도가 아니다" 센티넬 (0 은 "직전 기록 없음" 이라 못 쓴다) */
    private static final long NO_ATTEMPT = -1L;

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
        try {
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "매크로 화면 갱신에 실패했습니다: " + t);
        }
    }

    private static void fill(final MainActivity a, LinearLayout col) {
        col.addView(Ui.title(a, "매크로"));

        if (!License.allowed(a, Features.MACRO)) {
            fillLocked(a, col);
            return;
        }
        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "설정키가 없어 설정을 저장할 수 없습니다."
                    + " 내정보 탭에서 라이선스를 다시 인증하십시오.", Theme.RED, "내정보 열기",
                    new Runnable() { @Override public void run() { Nav.go(Nav.ACCOUNT); } }));
        }

        final Settings s = Settings.load(a);

        col.addView(Nav.gap(a, 6));
        col.addView(autoCard(a, s));

        // 예약 발송의 이미지 전송은 아무도 안 보고 있을 때 실패한다 → 토글 카드 바로 아래 1회만 띄운다
        View warn = imgFailNote(a);
        if (warn != null) col.addView(warn);

        // ── 발송 내용 ──
        col.addView(Ui.sectionHeader(a, null, "발송 내용"));
        LinearLayout content = Ui.group(a);

        String msg = msgSummary(s);
        content.addView(Ui.navRow(a, "메시지", (msg == null) ? "설정 필요" : msg,
                (msg == null) ? Theme.AMBER : Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "메시지", MacroDetail.message(a)); }
                }));

        String rooms = roomSummary(a, s);
        content.addView(Ui.navRow(a, "대상 대화방", (rooms == null) ? "설정 필요" : rooms,
                (rooms == null) ? Theme.AMBER : Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "대상 대화방", ScreenRooms.build(a)); }
                }));

        content.addView(Ui.navRow(a, "쿨타임", cycleSummary(s), Theme.TEXT, new Runnable() {
            @Override public void run() { Nav.push(a, "쿨타임", MacroDetail.cycle(a)); }
        }));
        col.addView(content);

        // ── 부가 기능 ──
        col.addView(Ui.sectionHeader(a, null, "부가 기능"));
        LinearLayout extra = Ui.group(a);

        boolean imgOn = !Settings.IMG_NEVER.equals(s.macro.sendImages);
        boolean imgFail = (lastFail(a) != null);
        extra.addView(Ui.navRow(a, "이미지 첨부", imageSummary(a, s),
                imgFail ? Theme.AMBER : (imgOn ? Theme.TEXT : Theme.DIM), new Runnable() {
                    @Override public void run() { Nav.push(a, "이미지 첨부", MacroDetail.image(a)); }
                }));

        int trigOn = 0;
        for (int i = 0; i < s.triggers.size(); i++) {
            if (s.triggers.get(i).enabled) trigOn++;
        }
        final int trigOnN = trigOn;
        extra.addView(Ui.navRow(a, "메시지 추적", trigSummary(s), (trigOnN > 0) ? Theme.TEXT : Theme.DIM,
                new Runnable() {
                    @Override public void run() { Nav.push(a, "메시지 추적", MacroDetail.triggers(a)); }
                }));

        extra.addView(Ui.navRow(a, "개인 대화 자동응답", replySummary(s),
                s.autoreply.enabled ? Theme.TEXT : Theme.DIM, new Runnable() {
                    @Override public void run() {
                        Nav.push(a, "개인 대화 자동응답", MacroDetail.autoReply(a));
                    }
                }));
        col.addView(extra);

        // ── 제한 ──
        col.addView(Ui.sectionHeader(a, null, "제한"));
        LinearLayout limit = Ui.group(a);
        boolean quietOn = !"없음".equals(quietKr(s));
        limit.addView(Ui.navRow(a, "발송 제한", limitSummary(s),
                quietOn ? Theme.TEXT : Theme.DIM, new Runnable() {
            @Override public void run() { Nav.push(a, "발송 제한", MacroDetail.limits(a)); }
        }));
        col.addView(limit);

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

    /** 미구매 상태. 기능 설명 + 구매 + 구매 내역 재조회만 남긴다. */
    private static void fillLocked(final MainActivity a, LinearLayout col) {
        col.addView(Nav.gap(a, 6));
        col.addView(Ui.featureCard(a, Features.label(Features.MACRO),
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
        col.addView(Ui.sub(a, "결제 후 활성화까지 시간이 소요될 수 있습니다."
                + " 활성화되지 않으면 위 버튼으로 구매 내역을 다시 조회하십시오."));
    }

    // ── 자동발송 토글 카드 ──────────────────────────────────────────────────

    private static LinearLayout autoCard(final MainActivity a, final Settings s) {
        LinearLayout card = Ui.card(a);

        final TextView status = Ui.sub(a, statusText(a, s));
        status.setTextColor(statusColor(a, s));

        card.addView(Ui.switchRow(a, "자동발송",
                "카카오톡 알림 답장으로 발송합니다. 대상 대화방의 알림이 1회 이상 수신되어야 발송이 가능합니다.",
                s.macro.enabled, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        s.macro.enabled = v;
                        apply(a, s);
                        status.setText(statusText(a, s));
                        status.setTextColor(statusColor(a, s));
                        Log.add(a, v ? "자동발송을 사용으로 변경했습니다." : "자동발송을 미사용으로 변경했습니다.");
                    }
                }));
        card.addView(Ui.divider(a));
        card.addView(status);
        return card;
    }

    /** 토글 카드 아래 한 줄. 켜짐이면 `다음 발송 21:34 · 금일 8회`. */
    private static String statusText(MainActivity a, Settings s) {
        if (!s.macro.enabled) return "미사용";
        if (s.macro.roomRefs().isEmpty()) return "대상 대화방 미설정 · 발송 보류";
        if (s.macro.message == null || s.macro.message.trim().length() == 0) {
            return "메시지 미설정 · 발송 보류";
        }
        long at;
        try {
            at = Scheduler.nextAt(a);
        } catch (Throwable t) {
            at = s.macro.nextAt;
        }
        String next = (at > 0) ? hm(at) : "예정 없음";
        return "다음 발송 " + next + " · 금일 " + MainActivity.sentToday(a) + "회";
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

    /** 전역 기본 쿨타임 요약 (방·계정 덮어쓰기와 무관하게 기본값 기준). `20~40분마다` */
    static String cycleSummary(Settings s) {
        return s.macro.cooldownMinMin + "~" + s.macro.cooldownMaxMin + "분마다";
    }

    /**
     * `안 보냄` / `3장 · 매번` / `3장 · 3회마다` / `3장 · 수동 전송만`.
     * 전송 실패 기록이 남아 있으면 앞에 ⚠ 를 붙인다 — 상세로 들어갈 이유를 값에서 알려준다.
     */
    static String imageSummary(MainActivity a, Settings s) {
        String base;
        int n = s.macro.images.size();
        if (Settings.IMG_NEVER.equals(s.macro.sendImages)) {
            base = "안 보냄";
        } else if (n == 0) {
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

    static String limitSummary(Settings s) {
        String q = quietKr(s);
        if ("없음".equals(q)) return "미설정";
        return q + " 중지";
    }

    static String quietKr(Settings s) {
        if (Settings.hhmm(s.macro.quietFrom) < 0 || Settings.hhmm(s.macro.quietTo) < 0) return "없음";
        return s.macro.quietFrom + "~" + s.macro.quietTo;
    }

    static String scopeKr(String scope) {
        if (Settings.SCOPE_UNKNOWN.equals(scope)) return "저장 안 된 상대만";
        if (Settings.SCOPE_EXCEPT.equals(scope)) return "특정 대화방 제외";
        return "모든 1:1 대화";
    }

    static String imgModeKr(String mode) {
        if (Settings.IMG_EVERY.equals(mode)) return "매번";
        if (Settings.IMG_EVERY_N.equals(mode)) return "정해진 횟수마다";
        if (Settings.IMG_MANUAL.equals(mode)) return "수동 전송만";
        return "안 보냄";
    }

    // ── 즉시 발송 ───────────────────────────────────────────────────────────

    private static void sendNow(final MainActivity a, final Settings s, final TextView btn) {
        if (!License.allowed(a, Features.MACRO)) { Gate.check(a, Features.MACRO); return; }

        final List<RoomRef> rooms = targets(a, s);
        if (rooms.isEmpty()) {
            if (!s.macro.roomRefs().isEmpty()) {
                Ui.toast(a, "대상 대화방이 모두 미사용 계정에 속합니다. 내정보 탭에서 대상 계정을 확인하십시오.");
            } else {
                Ui.toast(a, "대상 대화방을 먼저 설정하십시오.");
            }
            return;
        }
        final String msg = s.macro.message;
        if (msg == null || msg.trim().length() == 0) {
            Ui.toast(a, "발송 메시지를 먼저 입력하십시오.");
            return;
        }

        // 자동발송이 지키는 규칙(방해금지·1일 한도)을 수동 발송도 먼저 확인한다.
        // 넘길 수는 있지만 사용자가 의식적으로 넘기게 만든다.
        String why = blockedWhy(a, s);
        if (why != null) {
            final String w = why;
            Nav.confirm(a, "발송 제한 상태", w + "\n자동발송은 이 조건에서 발송하지 않습니다."
                    + " 즉시 발송을 진행하시겠습니까?", "발송", new Runnable() {
                @Override public void run() {
                    Log.add(a, "발송 제한 상태에서 즉시 발송을 실행했습니다. (" + w + ")");
                    doSendNow(a, s, btn, rooms, msg);
                }
            });
            return;
        }
        doSendNow(a, s, btn, rooms, msg);
    }

    /** 대상 대화방 중 사용 계정에 속한 것만 (Scheduler 와 같은 규칙) */
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

    /** 지금 보내면 자동발송 규칙에 걸리는 이유. 안 걸리면 null. */
    private static String blockedWhy(MainActivity a, Settings s) {
        try {
            if (s.macro.inQuiet(System.currentTimeMillis())) {
                return "현재 방해금지 시간입니다. (" + quietKr(s) + ")";
            }
        } catch (Throwable t) {
            return null;
        }
        return null;
    }

    private static void doSendNow(final MainActivity a, final Settings s, final TextView btn,
                                 final List<RoomRef> rooms, final String msg) {
        // 전송 루프를 메인 스레드에서 돌리면 '발송 중…' 라벨이 그려질 프레임이 없고,
        // 대상 대화방이 많으면 전송 시간만큼 UI 가 멈춘다. 백그라운드로 보내고 결과만 메인에서 갱신한다.
        Nav.busy(btn, true, "발송 중…", "즉시 발송");
        final Handler main = new Handler(Looper.getMainLooper());
        new Thread(new Runnable() {
            @Override public void run() {
                int okN = 0;
                final StringBuilder failed = new StringBuilder();
                for (int i = 0; i < rooms.size(); i++) {
                    RoomRef room = rooms.get(i);
                    String label = room.label(a);
                    boolean sent = false;
                    try {
                        sent = KakaoListener.sendTo(a, room, msg);
                    } catch (Throwable t) {
                        Log.add(a, "즉시 발송 중 오류가 발생했습니다. (" + label + ") " + t);
                    }
                    if (sent) {
                        okN++;
                    } else {
                        if (failed.length() > 0) failed.append(", ");
                        failed.append(label);
                    }
                }
                final int ok = okN;
                main.post(new Runnable() {
                    @Override public void run() {
                        if (a.isFinishing()) return;
                        if (ok > 0) MainActivity.countSent(a, ok);
                        Log.add(a, "즉시 발송 · 성공 " + ok + "건"
                                + ((failed.length() > 0) ? (" / 실패: " + failed) : ""));
                        Nav.busy(btn, false, "발송 중…", "즉시 발송");
                        if (ok == 0) {
                            Ui.toast(a, "발송에 실패했습니다. 활동 로그를 확인하십시오.");
                        } else if (failed.length() > 0) {
                            Ui.toast(a, ok + "건 발송했습니다. 일부 대화방은 실패했습니다.");
                        } else {
                            Ui.toast(a, ok + "건 발송했습니다.");
                        }
                        refresh();
                    }
                });
            }
        }, "send-now").start();
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
        return Nav.note(a, txt, Theme.RED, "진단 보기", new Runnable() {
            @Override public void run() { showDiag(a); }
        });
    }

    private static Scheduler.ImageFail lastFail(MainActivity a) {
        try {
            return Scheduler.lastImageFail(a);
        } catch (Throwable t) {
            return null;
        }
    }

    // ── 이미지 전송 진단 ────────────────────────────────────────────────────

    /**
     * 첫 번째 대상 대화방으로 실제로 한 번 전송해 보고, 끝나면 결과 + 화면 기록을 보여준다.
     * 실패 시점의 카카오톡 화면 구성이 가장 중요한 정보라서 그대로 복사할 수 있게 한다.
     */
    static void runDiag(final MainActivity a, final Settings s, final TextView btn) {
        if (!License.allowed(a, Features.MACRO)) { Gate.check(a, Features.MACRO); return; }

        List<RoomRef> rooms = targets(a, s);
        if (rooms.isEmpty()) {
            Nav.confirm(a, "대상 대화방 없음",
                    "진단은 실제 전송을 1회 수행합니다. 대상 대화방을 1개 이상 설정하십시오.",
                    "확인", null);
            return;
        }
        if (s.macro.images.isEmpty()) {
            Nav.confirm(a, "이미지 없음",
                    "진단은 실제 전송을 1회 수행합니다. 이미지를 1장 이상 선택하십시오.",
                    "확인", null);
            return;
        }

        boolean accOn;
        try { accOn = ImageSender.accessibilityOn(a); } catch (Throwable t) { accOn = false; }
        if (!accOn) {
            Nav.confirm(a, "접근성 권한 필요",
                    "진단은 카카오톡 화면을 읽어야 하므로 접근성 권한이 필요합니다.",
                    "권한 설정", new Runnable() {
                        @Override public void run() { ImageSender.openSettings(a); }
                    });
            return;
        }

        final RoomRef room = rooms.get(0);
        final String label = room.label(a);
        final List<String> uris = new ArrayList<String>(s.macro.images);
        Nav.confirm(a, "전송 진단 실행",
                "「" + label + "」 에 이미지 " + uris.size() + "장을 실제로 전송합니다."
                        + " 성공 시 실제 전송되며, 실패 시 카카오톡 화면 구성이 기록됩니다.\n"
                        + "전송 중 카카오톡 공유 화면이 표시됩니다.",
                "진단 시작", new Runnable() {
            @Override public void run() {
                final String idle = "전송 진단";
                // ★ 시작 전 화면 기록 시각을 잡아둔다. 이게 있어야 끝난 뒤에
                //   "이번에 새로 남은 기록" 과 "지난 기록" 을 구별할 수 있다.
                final long dumpBefore = dumpAtSafe(a);
                Nav.busy(btn, true, "진단 중…", idle);
                Log.add(a, "이미지 전송 진단을 시작했습니다. (" + label + ")");
                try {
                    // ★ RoomRef 를 그대로 넘긴다. key() 를 넘기면 계정 구분자가 붙은 문자열이
                    //   카톡 화면 매칭에 쓰여 어떤 텍스트와도 일치하지 않는다.
                    ImageSender.sendWithResult(a, room, uris, new ImageSender.Done() {
                        @Override public void done(boolean ok, String detail) {
                            Nav.busy(btn, false, "진단 중…", idle);
                            diagResult(a, room, ok, detail, dumpBefore);
                        }
                    });
                } catch (Throwable t) {
                    Nav.busy(btn, false, "진단 중…", idle);
                    Scheduler.noteImageFail(a, label, "진단을 시작하지 못했습니다. " + t);
                    Log.add(a, "이미지 전송 진단을 시작하지 못했습니다: " + t);
                    Ui.toast(a, "진단을 시작하지 못했습니다.");
                    refresh();
                    MacroDetail.refresh();
                }
            }
        });
    }

    /**
     * 진단 결과 + 화면 기록을 한 창에 보여준다 (복사 가능 · 스크롤 됨).
     *
     * @param dumpBefore 진단을 시작하기 <b>전</b>의 화면 기록 시각 (기록이 없었으면 0).
     *        이보다 새 기록이 생겼을 때만 "이번 시도의 화면" 이라고 말한다.
     *        지난 덤프를 이번 실패 화면인 것처럼 보여주는 게 제일 나쁜 거짓말이다.
     */
    private static void diagResult(final MainActivity a, RoomRef room, boolean ok, String detail,
                                   long dumpBefore) {
        String label = room.label(a);
        // 결과를 기록에 반영한다 — 성공이면 지우고, 실패면 남긴다
        if (ok) Scheduler.clearImageFail(a, label);
        else Scheduler.noteImageFail(a, label, detail);

        StringBuilder sb = new StringBuilder(2048);
        sb.append(ok ? "■ 결과: 성공 (카카오톡에서 실제 전송 여부를 확인하십시오)" : "■ 결과: 실패").append('\n');
        sb.append("■ 대화방: ").append(label).append('\n');
        sb.append("■ 상세: ").append((detail == null || detail.length() == 0) ? "없음" : detail).append('\n');
        sb.append("■ 접근성: ").append(ImageSender.accessibilityOn(a) ? "허용" : "비허용")
                .append(" · 다른 앱 위에 표시: ").append(ImageSender.overlayOn(a) ? "허용" : "비허용").append('\n');
        sb.append('\n');
        sb.append(dumpSection(a, dumpBefore));

        final String all = sb.toString();
        Nav.showText(a, ok ? "진단 결과 · 성공" : "진단 결과 · 실패", all, new Runnable() {
            @Override public void run() { Nav.copy(a, "이미지 전송 진단", all); }
        });
        refresh();
        MacroDetail.refresh();
    }

    /**
     * 저장된 진단(마지막 실패 기록 + 화면 기록) 보기.
     * 이건 "이번 시도" 라는 개념이 없으니 <b>언제 남은 기록인지</b>를 맨 위에 박는다.
     */
    static void showDiag(final MainActivity a) {
        final String all = diagText(a);
        long at = dumpAtSafe(a);
        Nav.showText(a, "이미지 전송 진단 (" + ((at > 0) ? (agoShort(at) + " 기록") : "화면 기록 없음") + ")",
                all, new Runnable() {
                    @Override public void run() { Nav.copy(a, "이미지 전송 진단", all); }
                });
    }

    /** showDiag 가 보여주는 본문. 내정보 화면의 [복사] 도 같은 글을 쓴다. */
    static String diagText(MainActivity a) {
        StringBuilder sb = new StringBuilder(2048);
        Scheduler.ImageFail fail = lastFail(a);
        if (fail == null) {
            sb.append("■ 마지막 이미지 전송 실패: 기록 없음\n")
              .append("  실패 이력이 없거나, 마지막 전송이 성공하여 기록이 삭제된 상태입니다.\n\n");
        } else {
            sb.append("■ 마지막 이미지 전송 실패\n")
              .append("  시각: ").append(ago(fail.at)).append('\n')
              .append("  대화방: ").append(fail.room.length() == 0 ? "미확인" : fail.room).append('\n')
              .append("  사유: ").append(fail.why).append("\n\n");
        }
        // -1 = "이번 시도" 라는 개념이 없다 (그냥 저장된 걸 보는 중)
        sb.append(dumpSection(a, NO_ATTEMPT));
        return sb.toString();
    }

    /**
     * 화면 기록 부분을 글로 만든다.
     *
     * @param dumpBefore {@link #NO_ATTEMPT} 이면 "이번 시도" 를 주장하지 않고 언제 것인지만 밝힌다.
     *        0 이상이면 "시도 직전의 기록 시각" 이라는 뜻이고, 그보다 새 기록일 때만
     *        "이번 시도" 라고 말한다. 아니면 "이번엔 기록이 안 남았다" 고 못을 박는다.
     *        (0 도 유효한 값이다 — "전에는 기록이 아예 없었다" 는 뜻이라 새 기록이면 이번 것이다)
     */
    private static String dumpSection(MainActivity a, long dumpBefore) {
        long at = dumpAtSafe(a);
        String dump;
        try { dump = KakaoAccessibility.lastDump(a); } catch (Throwable t) { dump = ""; }
        if (dump == null) dump = "";

        StringBuilder sb = new StringBuilder(1024);
        boolean have = at > 0 && dump.length() > 0;
        boolean attempt = dumpBefore >= 0;
        boolean fresh = have && attempt && at > dumpBefore;

        if (attempt && !fresh) {
            sb.append("■ 이번 시도의 화면 기록: 없음\n")
              .append("  카카오톡 공유 화면에 도달하지 못했거나, 접근성 서비스가 화면을 읽기 전에 종료되었습니다.\n");
            if (have) {
                sb.append("  ※ 아래는 ").append(agoShort(at))
                  .append(" 에 남은 지난 기록이며 이번 시도와 무관합니다.\n\n")
                  .append(dump).append('\n');
            } else {
                sb.append("  저장된 화면 기록도 없습니다.\n");
            }
            return sb.toString();
        }

        if (!have) {
            sb.append("■ 화면 기록: 없음\n")
              .append("  화면 기록은 전송 실패 시에만 저장됩니다. 실패 이력이 없거나,\n")
              .append("  접근성 권한이 비활성 상태여서 화면을 읽지 못한 상태일 수 있습니다.\n");
            return sb.toString();
        }

        if (fresh) {
            sb.append("■ 화면 기록 (이번 시도) — ").append(ago(at)).append('\n');
        } else {
            sb.append("■ 화면 기록 — ").append(ago(at)).append('\n');
            if (System.currentTimeMillis() - at > DUMP_STALE_MS) {
                sb.append("  ※ ").append(agoShort(at))
                  .append(" 에 기록된 내용이며 현재 화면이 아닙니다.\n");
            }
        }
        sb.append('\n').append(dump).append('\n');
        return sb.toString();
    }

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

    /** 화면 기록 시각. 접근성 쪽에서 예외가 나도 UI 가 죽지 않게 감싼다. */
    static long dumpAtSafe(MainActivity a) {
        try {
            long at = KakaoAccessibility.lastDumpAt(a);
            return (at < 0) ? 0L : at;
        } catch (Throwable t) {
            return 0L;
        }
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
