package com.buseong.kakaoauto;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.text.TextUtils;
import android.view.Gravity;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Locale;

/**
 * 앱 셸. 하단 탭바 4개 + 홈(대시보드). 앱을 열면 바로 탭 화면이다.
 *
 * 홈은 여기 안에 있다 (별도 파일 안 만든다). 탭 전환·화면 조립은 Nav 가 맡는다.
 */
public final class MainActivity extends Activity {

    /** 매크로 화면의 사진 고르기 결과를 받는 요청 코드 */
    public static final int REQ_IMAGES = 9101;
    private static final int REQ_NOTI_PERM = 9102;

    private static final String K_SENT_DAY = "ui_sent_day";
    private static final String K_SENT_N = "ui_sent_n";

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private FrameLayout root;
    private FrameLayout content;
    private View bar;

    /** 셸(탭바)을 이미 만들었나 (onResume 에서 통째 재빌드 여부를 가린다) */
    private boolean shellBuilt = false;

    // 홈 화면 갱신용
    private static WeakReference<MainActivity> HOME_ACT;
    private static WeakReference<LinearLayout> HOME_BODY;

    // ── 액티비티 수명 ─────────────────────────────────────────────────────────

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        try {
            root = new FrameLayout(this);
            root.setBackgroundColor(Theme.BG);
            setContentView(root, new FrameLayout.LayoutParams(MATCH, MATCH));
            askNotificationPermission();
        } catch (Throwable t) {
            Log.add(this, "앱 화면 구성에 실패했습니다: " + t);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        try {
            // 권한 설정 화면 등에서 돌아왔을 때 값이 안 바뀐 것처럼 보이면 안 된다 → 매번 다시 그린다.
            // 셸이 이미 있으면 제자리 갱신만 한다 (통째로 다시 만들면 스크롤이 맨 위로 튄다).
            if (!shellBuilt) renderShell();
            else Nav.reload();
        } catch (Throwable t) {
            Log.add(this, "화면 갱신에 실패했습니다: " + t);
        }
    }

    /**
     * 뒤로가기 키는 서브화면 스택이 먼저 먹는다 (대상 방 → 계정 설정 처럼 중첩돼 있어도
     * 한 장씩 닫힌다). 스택이 비어 있을 때만 앱이 닫힌다.
     */
    @Override public void onBackPressed() {
        try {
            if (Nav.pop()) return;
        } catch (Throwable t) {
            Log.add(this, "뒤로가기 처리 실패: " + t);
        }
        super.onBackPressed();
    }

    @Override protected void onDestroy() {
        shellBuilt = false;
        Nav.detach();
        HOME_ACT = null;
        HOME_BODY = null;
        super.onDestroy();
    }

    @Override protected void onActivityResult(int req, int res, Intent data) {
        super.onActivityResult(req, res, data);
        if (req == REQ_IMAGES) {
            try {
                ScreenMacro.onImagesPicked(this, res, data);
            } catch (Throwable t) {
                Log.add(this, "이미지 선택 결과 처리에 실패했습니다: " + t);
            }
        }
    }

    // ── 셸: 탭 ───────────────────────────────────────────────────────────────

    /** 전체 화면(탭바 + 현재 탭)을 다시 만든다 */
    public void renderShell() {
        if (root == null || isFinishing()) return;
        shellBuilt = true;

        root.removeAllViews();
        content = new FrameLayout(this);
        root.addView(content, new FrameLayout.LayoutParams(MATCH, MATCH));

        int keep = Nav.current();
        bar = Nav.buildBar(this, content);
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(MATCH, WRAP);
        bp.gravity = Gravity.BOTTOM;
        root.addView(bar, bp);

        Nav.go(keep);
    }

    // ── 홈 ──────────────────────────────────────────────────────────────────
    //  홈은 "지금 상태" 와 "다음에 할 일" 만 보여준다 (UI_V3 3장). 설정은 여기서 하지 않는다.
    //  카드 순서: 상태(토글) → 실패 경고 → 준비 항목 → 기능 → 최근 활동.

    /** 홈 화면 */
    public static View buildHome(MainActivity a) {
        LinearLayout col = Ui.screen(a);
        HOME_ACT = new WeakReference<MainActivity>(a);
        HOME_BODY = new WeakReference<LinearLayout>(col);
        fillHome(a, col);
        return Ui.scroll(a, col);
    }

    /** 홈을 제자리에서 다시 채운다 */
    public static void refreshHome() {
        MainActivity a = (HOME_ACT == null) ? null : HOME_ACT.get();
        LinearLayout col = (HOME_BODY == null) ? null : HOME_BODY.get();
        if (a == null || col == null || a.isFinishing()) return;
        try {
            col.removeAllViews();
            fillHome(a, col);
        } catch (Throwable t) {
            Log.add(a, "홈 화면 갱신에 실패했습니다: " + t);
        }
    }

    private static void fillHome(final MainActivity a, LinearLayout col) {
        col.addView(Ui.title(a, "홈"));

        // 전체 정지 중이면 그 사실이 가장 먼저 보여야 한다 — 아래 설정이 왜 동작하지 않는지가
        // 여기서 설명된다. 해제도 이 자리에서 바로 한다.
        if (SendGuard.stopped(a)) {
            col.addView(Nav.note(a, "전체 정지 중입니다. 자동발송·메시지 추적·자동응답·봇의 "
                    + "모든 발송이 멈춰 있습니다.", Theme.RED, "정지 해제", new Runnable() {
                        @Override public void run() {
                            SendGuard.setStopped(a, false);
                            refreshHome();
                        }
                    }));
        }

        TextView who = Ui.sub(a, Device.deviceName() + " · " + activeSummary(a));
        LinearLayout.LayoutParams wp = new LinearLayout.LayoutParams(MATCH, WRAP);
        wp.topMargin = Theme.dp(a, 4);
        wp.bottomMargin = Theme.dp(a, 14);
        who.setLayoutParams(wp);
        col.addView(who);

        col.addView(statusCard(a));

        // 예약 발송의 이미지 전송 실패는 아무도 보고 있지 않을 때 일어난다 → 상태 카드 바로 아래 1회만
        View warn = null;
        try {
            warn = ScreenMacro.imgFailNote(a);
        } catch (Throwable t) {
            warn = null;
        }
        if (warn != null) col.addView(warn);

        // 대화방 이름이 바뀌면 발송이 조용히 끊긴다 → 홈에서 바로 알린다
        int stale = 0;
        try { stale = ScreenRooms.staleCount(a); } catch (Throwable t) { stale = 0; }
        if (stale > 0) {
            final int n = stale;
            col.addView(Nav.note(a, "발송 대상 " + n + "개 대화방에서 최근 카카오톡 메시지가 "
                    + "확인되지 않았습니다. 대화방 이름이 변경되면 발송이 중단됩니다.",
                    Theme.AMBER, "확인", new Runnable() {
                        @Override public void run() {
                            Nav.push(a, "이름 변경 확인", ScreenRooms.renameScreen(a));
                        }
                    }));
        }

        col.addView(stopCard(a));

        fillReady(a, col);
        fillFeatures(a, col);

        col.addView(Ui.sectionHeader(a, null, "최근 활동"));
        col.addView(logCard(a));
    }

    /**
     * 전체 정지 — 모든 자동 발송을 한 번에 멈춘다.
     *
     * 「자동발송」 토글과 다른 점: 그 토글은 매크로만 끈다. 메시지 추적·자동응답·관리봇·
     * 미니게임봇은 계속 돈다. 잘못된 대화방으로 메시지가 나가고 있을 때 손님이 필요한 것은
     * "전부 멈춤" 이다. 그래서 별도 버튼으로 두고, 끈 상태는 앱을 다시 켜도 유지된다.
     *
     * 저장이 평문 Prefs 인 이유는 {@link SendGuard} 설명 참고 — 설정을 못 읽는 상태에서도
     * 정지는 유지돼야 한다.
     */
    private static LinearLayout stopCard(final MainActivity a) {
        LinearLayout card = Ui.card(a);
        final boolean off = SendGuard.stopped(a);

        LinearLayout head = Ui.row(a);
        TextView t = Ui.h2(a, "전체 정지");
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        head.addView(t);
        head.addView(Ui.chip(a, off ? "정지 중" : "동작 중", off ? Theme.RED : Theme.ACCENT));
        card.addView(head);
        card.addView(Ui.divider(a));

        card.addView(Ui.sub(a, off
                ? "모든 자동 발송이 멈춰 있습니다. 해제하면 기존 설정대로 다시 동작합니다."
                : "자동발송·메시지 추적·자동응답·봇의 모든 발송을 한 번에 멈춥니다. "
                        + "잘못된 대화방으로 메시지가 나가고 있을 때 사용하십시오."));

        final TextView btn = Ui.btn(a, off ? "정지 해제" : "전체 정지", false);
        if (!off) btn.setTextColor(Theme.RED);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
        bp.topMargin = Theme.dp(a, 12);
        btn.setLayoutParams(bp);
        btn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (off) {
                    SendGuard.setStopped(a, false);
                    refreshHome();
                    return;
                }
                Nav.confirm(a, "전체 정지",
                        "모든 자동 발송을 즉시 멈춥니다.\n\n"
                                + "자동발송·메시지 추적·자동응답·대화방 관리봇·미니게임봇이 모두 "
                                + "멈추고, 예약된 발송과 대기 중인 사진 전송도 취소됩니다.\n"
                                + "설정은 지워지지 않으며, 해제하면 그대로 다시 동작합니다.",
                        "전체 정지", new Runnable() {
                            @Override public void run() {
                                SendGuard.setStopped(a, true);
                                Ui.toast(a, "전체 정지했습니다.");
                                refreshHome();
                            }
                        });
            }
        });
        card.addView(btn);
        return card;
    }

    // ── 1. 상태 카드 ────────────────────────────────────────────────────────

    /**
     * 자동발송 토글 + 상태 한 줄. 매크로를 켜고 끄는 일이 가장 잦으니 홈에서 직접 조작한다
     * (UI_V3 3장).
     */
    private static LinearLayout statusCard(final MainActivity a) {
        final Settings s = Settings.load(a);
        LinearLayout card = Ui.card(a);

        final TextView status = Ui.sub(a, homeStatus(a, s));
        status.setTextColor(homeStatusColor(a, s));

        card.addView(Ui.switchRow(a, "자동발송", "지정한 주기로 대상 대화방에 메시지를 발송합니다",
                s.macro.enabled, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        s.macro.enabled = v;
                        ScreenMacro.apply(a, s);
                        status.setText(homeStatus(a, s));
                        status.setTextColor(homeStatusColor(a, s));
                        Log.add(a, v ? "자동발송을 사용으로 변경했습니다."
                                : "자동발송을 미사용으로 변경했습니다.");
                        refreshHome();
                    }
                }));
        card.addView(Ui.divider(a));
        card.addView(status);
        return card;
    }

    /** 켜짐이면 `다음 발송 21:34 (12분 후) · 금일 8회 발송`, 꺼짐이면 `미사용` */
    private static String homeStatus(MainActivity a, Settings s) {
        if (!s.macro.enabled) return "미사용";
        // 원인만 적으면 손님은 어디를 고쳐야 하는지 알 수 없다 → 갈 곳을 함께 적는다
        if (s.macro.roomRefs().isEmpty()) return "매크로 탭에서 대상 대화방을 먼저 선택하십시오";
        if (activeRoomCount(s) == 0) return "대상 대화방이 모두 미사용 · 매크로 탭에서 사용으로 변경하십시오";
        if (!hasSendableRoom(s)) return "매크로 탭에서 발송 메시지를 먼저 입력하십시오";
        // v4: 전역 단일 nextAt 이 아니라 대상 방들 중 가장 이른 방별 nextAt 을 보여준다.
        long at = earliestRoomNextAt(s);
        String next = (at > 0) ? (ScreenMacro.hm(at) + " " + after(at)) : "대기";
        return "다음 발송 " + next + " · 금일 " + sentToday(a) + "회 발송";
    }

    private static int homeStatusColor(MainActivity a, Settings s) {
        if (!s.macro.enabled) return Theme.DIM;
        if (s.macro.roomRefs().isEmpty()) return Theme.AMBER;
        if (activeRoomCount(s) == 0) return Theme.AMBER;
        if (!hasSendableRoom(s)) return Theme.AMBER;
        return Theme.SUB;
    }

    // ── 방별 상태 요약 (v4: 전역 → 계정 → 방 해상도 반영) ─────────────────────
    //  홈은 상태만 읽는다 — 저장/스케줄을 건드리지 않으려고 Settings 의 read-only 공개
    //  메서드(roomActive·roomNextAt·effMessage)만 쓴다.

    /** 지금 매크로 대상(roomActive)인 대화방 수 */
    private static int activeRoomCount(Settings s) {
        int n = 0;
        for (RoomRef r : s.macro.roomRefs()) {
            if (r != null && s.roomActive(r)) n++;
        }
        return n;
    }

    /** 활성 대화방 중 유효 메시지(effMessage)가 비어 있지 않아 실제로 발송될 방이 하나라도 있나 */
    private static boolean hasSendableRoom(Settings s) {
        for (RoomRef r : s.macro.roomRefs()) {
            if (r == null || !s.roomActive(r)) continue;
            String m = s.effMessage(r);
            if (m != null && m.trim().length() > 0) return true;
        }
        return false;
    }

    /** 활성 대화방들의 방별 nextAt 중 가장 이른 시각. 아직 잡힌 방이 없으면 0. */
    private static long earliestRoomNextAt(Settings s) {
        long earliest = 0L;
        for (RoomRef r : s.macro.roomRefs()) {
            if (r == null || !s.roomActive(r)) continue;
            long at = s.roomNextAt(r);
            if (at <= 0L) continue;
            if (earliest == 0L || at < earliest) earliest = at;
        }
        return earliest;
    }

    /** "(12분 후)" */
    private static String after(long at) {
        long d = at - System.currentTimeMillis();
        if (d <= 0) return "(대기 중)";
        if (d < 60000L) return "(1분 내)";
        if (d < 3600000L) return "(" + (d / 60000L) + "분 후)";
        if (d < 86400000L) return "(" + (d / 3600000L) + "시간 후)";
        return "(" + (d / 86400000L) + "일 후)";
    }

    // ── 2. 준비 항목 ────────────────────────────────────────────────────────
    //  "뭘 설정해야 하는지 모르겠다" 에 대한 직접적인 답이다. 미완료가 하나도 없으면
    //  카드도 머리글도 만들지 않는다 (UI_V3 3장) — 다 끝낸 화면에 잔소리를 남기지 않는다.

    private static void fillReady(final MainActivity a, LinearLayout col) {
        final Settings s = Settings.load(a);

        boolean noti = false;
        try { noti = KakaoListener.connected(a); } catch (Throwable t) { noti = false; }
        final boolean notiOk = noti;
        final boolean battOk = ignoringBattery(a);

        // v4: 메시지는 전역 → 계정 → 방 순으로 해석된다. 전역이 비어 있어도 계정/방 덮어쓰기로
        //     실제 발송될 방(hasSendableRoom)이 있으면 '발송 메시지'는 준비된 것으로 본다.
        final boolean hasRooms = !s.macro.roomRefs().isEmpty();
        final boolean globalMsg = s.macro.message != null && s.macro.message.trim().length() > 0;
        final boolean msgOk = globalMsg || (hasRooms && hasSendableRoom(s));
        final boolean roomOk = hasRooms;

        // 이미지 첨부를 쓸 때만 접근성·오버레이를 묻는다 (텍스트 발송에는 필요 없다)
        final boolean imgUse = !Settings.IMG_NEVER.equals(s.macro.sendImages);
        boolean acc = true;
        boolean ov = true;
        if (imgUse) {
            try { acc = ImageSender.accessibilityOn(a); } catch (Throwable t) { acc = false; }
            try { ov = ImageSender.overlayOn(a); } catch (Throwable t) { ov = false; }
        }
        final boolean accOk = acc;
        final boolean ovOk = ov;

        int todo = 0;
        if (!notiOk) todo++;
        if (!battOk) todo++;
        if (!msgOk) todo++;
        if (!roomOk) todo++;
        if (!accOk) todo++;
        if (!ovOk) todo++;
        if (todo == 0) return;

        col.addView(Ui.sectionHeader(a, null, "준비 항목 " + todo + "건"));
        LinearLayout card = Ui.card(a);
        boolean first = true;

        if (!notiOk) {
            first = readyRow(a, card, first, "알림 접근 권한",
                    "카카오톡 알림을 읽어 대화방을 확인하고 답장으로 발송합니다. 미허용 시 발송이 불가합니다.",
                    new Runnable() {
                        @Override public void run() {
                            Nav.openIntent(a, new Intent(android.provider.Settings
                                    .ACTION_NOTIFICATION_LISTENER_SETTINGS), "알림 접근 설정");
                            Ui.toast(a, "목록에서 「카톡 오토 · 알림 읽기」를 허용하십시오.");
                        }
                    });
        }
        if (!battOk) {
            first = readyRow(a, card, first, "배터리 최적화 제외",
                    "절전 상태에서 예약 발송 알람이 중단되지 않도록 제외 항목으로 등록합니다.",
                    new Runnable() {
                        @Override public void run() { requestBattery(a); }
                    });
        }
        if (!msgOk) {
            first = readyRow(a, card, first, "발송 메시지",
                    "발송할 내용이 설정되지 않았습니다.",
                    new Runnable() {
                        @Override public void run() {
                            Nav.push(a, "메시지", MacroDetail.message(a));
                        }
                    });
        }
        if (!roomOk) {
            first = readyRow(a, card, first, "대상 대화방",
                    "발송할 대화방이 선택되지 않았습니다.",
                    new Runnable() {
                        @Override public void run() {
                            Nav.push(a, "대상 대화방", ScreenRooms.build(a));
                        }
                    });
        }
        if (!accOk) {
            first = readyRow(a, card, first, "접근성 권한",
                    "이미지 첨부 발송에만 필요합니다. 텍스트 발송은 영향받지 않습니다.",
                    new Runnable() {
                        @Override public void run() { ImageSender.openSettings(a); }
                    });
        }
        if (!ovOk) {
            first = readyRow(a, card, first, "다른 앱 위에 표시",
                    "화면이 꺼진 상태에서 카카오톡 공유 화면을 띄우기 위해 필요합니다.",
                    new Runnable() {
                        @Override public void run() { ImageSender.openOverlaySettings(a); }
                    });
        }
        col.addView(card);
    }

    /** 준비 항목 한 줄: `항목명 + 사유 + [설정]`. 다음 행부터는 위에 구분선을 넣는다. */
    private static boolean readyRow(MainActivity a, LinearLayout card, boolean first,
                                    String name, String why, Runnable fix) {
        if (!first) card.addView(Ui.divider(a));
        card.addView(Nav.actionRow(a, name, why, "설정", fix));
        return false;
    }

    // ── 3. 기능 ─────────────────────────────────────────────────────────────

    private static void fillFeatures(final MainActivity a, LinearLayout col) {
        col.addView(Ui.sectionHeader(a, null, "기능"));

        // 매크로는 주력 기능이라 카드로 크게 (UI_V3 3장)
        boolean macroEnabled = false;
        try { macroEnabled = Settings.macro(a).enabled; } catch (Throwable t) { macroEnabled = false; }
        col.addView(Ui.featureCard(a, Features.label(Features.MACRO),
                Features.desc(Features.MACRO),
                macroEnabled ? "사용" : "미사용", macroEnabled ? Theme.ACCENT : Theme.DIM,
                new Runnable() {
                    @Override public void run() { Nav.go(Nav.MACRO); }
                }));

        // 봇 2종은 1행씩
        LinearLayout g = Ui.group(a);
        botRow(a, g, Features.ROOMBOT, ScreenBot.NAME_ROOMBOT,
                ScreenBot.roomBotValue(a), ScreenBot.roomBotColor(a));
        botRow(a, g, Features.MINIGAME, ScreenBot.NAME_MINIGAME,
                ScreenBot.miniGameValue(a), ScreenBot.miniGameColor(a));
        col.addView(g);
    }

    /** 봇 한 행 */
    private static void botRow(final MainActivity a, LinearLayout g, final String feat,
                              String name, String value, int color) {
        int glyph = Features.MINIGAME.equals(feat) ? Ui.GLYPH_MINIGAME : Ui.GLYPH_ROOMBOT;
        int accent = Features.MINIGAME.equals(feat) ? Theme.FEAT_MINIGAME : Theme.FEAT_ROOMBOT;
        g.addView(Ui.navRow(a, glyph, accent, name, value, color, new Runnable() {
            @Override public void run() { Nav.go(Nav.BOT); }
        }));
    }

    // ── 4. 최근 활동 ────────────────────────────────────────────────────────

    /** 최근 기록 4행 + `전체 로그 ›` */
    private static LinearLayout logCard(final MainActivity a) {
        LinearLayout g = Ui.group(a);

        LinearLayout lines = new LinearLayout(a);
        lines.setOrientation(LinearLayout.VERTICAL);
        int ph = Theme.dp(a, 16);
        lines.setPadding(ph, Theme.dp(a, 14), ph, Theme.dp(a, 14));
        lines.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        String dump = Log.dump(a);
        if (dump == null || dump.length() == 0) {
            lines.addView(Ui.sub(a, "기록이 없습니다. 발송이 실행되면 여기에 기록됩니다."));
        } else {
            String[] all = dump.split("\n");
            int n = Math.min(4, all.length);
            for (int i = 0; i < n; i++) {
                TextView lv = Ui.micro(a, all[i], (i == 0) ? Theme.SUB : Theme.DIM);
                lv.setSingleLine(true);
                lv.setEllipsize(TextUtils.TruncateAt.END);
                LinearLayout.LayoutParams lvp = new LinearLayout.LayoutParams(MATCH, WRAP);
                lvp.topMargin = Theme.dp(a, (i == 0) ? 0 : 8);
                lv.setLayoutParams(lvp);
                lines.addView(lv);
            }
        }
        g.addView(lines);

        g.addView(Ui.navRow(a, "전체 로그", null, 0, new Runnable() {
            @Override public void run() { Nav.go(Nav.ACCOUNT); }
        }));
        return g;
    }

    // ── 오늘 발송 수 (평문 Prefs · 민감정보 아님) ─────────────────────────────

    /**
     * 발송 1건(또는 n건)을 기록한다. 발송 경로(Scheduler·수동 발송)에서 불러주면 홈의 "오늘 발송"이 올라간다.
     * 날짜가 바뀌면 자동으로 0부터 다시 센다.
     */
    public static synchronized void countSent(Context c, int n) {
        if (c == null || n <= 0) return;
        try {
            String today = dayKey(System.currentTimeMillis());
            String saved = Prefs.getStr(c, K_SENT_DAY, "");
            int cur = today.equals(saved) ? Prefs.getInt(c, K_SENT_N, 0) : 0;
            Prefs.putStr(c, K_SENT_DAY, today);
            Prefs.putInt(c, K_SENT_N, cur + n);
        } catch (Throwable t) {
            Log.add(c, "발송 수 기록에 실패했습니다: " + t);
        }
    }

    /** 오늘 보낸 건수 */
    public static synchronized int sentToday(Context c) {
        if (c == null) return 0;
        try {
            String today = dayKey(System.currentTimeMillis());
            if (!today.equals(Prefs.getStr(c, K_SENT_DAY, ""))) return 0;
            return Prefs.getInt(c, K_SENT_N, 0);
        } catch (Throwable t) {
            return 0;
        }
    }

    private static String dayKey(long ms) {
        try {
            return new SimpleDateFormat("yyyyMMdd", Locale.KOREA).format(new Date(ms));
        } catch (Throwable t) {
            return "00000000";
        }
    }

    // ── 자잘한 것 ────────────────────────────────────────────────────────────

    private void askNotificationPermission() {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            if (checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    != android.content.pm.PackageManager.PERMISSION_GRANTED) {
                requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, REQ_NOTI_PERM);
            }
        } catch (Throwable t) {
            Log.add(this, "알림 권한 요청에 실패했습니다: " + t);
        }
    }

    private static boolean ignoringBattery(Context c) {
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
        } catch (Throwable t) {
            return false;
        }
    }

    private static void requestBattery(Context c) {
        Intent i = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
        i.setData(Uri.parse("package:" + c.getPackageName()));
        try {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
        } catch (Throwable t) {
            Log.add(c, "배터리 최적화 제외 화면을 열지 못했습니다: " + t);
            Nav.openIntent(c, new Intent(
                    android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                    "배터리 최적화");
        }
    }

    private static String activeSummary(Context c) {
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (int i = 0; i < Features.ALL.length; i++) {
            if (!featureOn(c, Features.ALL[i])) continue;
            if (n > 0) sb.append(" · ");
            sb.append(Features.label(Features.ALL[i]));
            n++;
        }
        if (n == 0) return "사용 중인 기능 없음";
        return sb.toString();
    }

    /** 그 기능을 설정에서 켜 두었나 (홈 요약 한 줄용) */
    private static boolean featureOn(Context c, String id) {
        try {
            if (Features.MACRO.equals(id)) return Settings.macro(c).enabled;
            if (Features.ROOMBOT.equals(id)) return Settings.roombot(c).enabled;
            if (Features.MINIGAME.equals(id)) return Settings.minigame(c).enabled;
        } catch (Throwable t) {
            return false;
        }
        return false;
    }

}
