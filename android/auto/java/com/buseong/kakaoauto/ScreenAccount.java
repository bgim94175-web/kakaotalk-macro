package com.buseong.kakaoauto;

import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.PowerManager;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

/**
 * 내정보 탭 — <b>목록만</b> 있는 화면 (UI_V3 8장).
 *
 * 예전에는 라이선스 카드 + 기능 카드 + 기기 카드 + 아코디언 3개가 한 장에 쌓여 있었다.
 * 아코디언은 접혀 있으면 안에 뭐가 있는지 모르고, 펼치면 옆 카드와 섞여서 경계가 사라진다.
 * 그래서 이 화면은 「제목 · 지금 값 · ›」 행만 남기고 상세는 전부 {@link Nav#push} 서브화면으로 내보냈다.
 *
 * 섹션은 4개다 — 라이선스 / 카카오톡 / 기록 / 고급.
 * <b>아코디언은 '고급' 한 곳에서만</b> 쓴다 (UI_V3 10장이 허용한 유일한 예외).
 *
 * 값 요약 색 규칙: 손댈 게 없으면 ACCENT·TEXT, 조치가 필요하면 AMBER, 꺼진 건 DIM.
 */
public final class ScreenAccount {
    private ScreenAccount() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    /** 새로고침 버튼 라벨 (진행 중에는 "확인 중…" 으로 바뀐다) */
    private static final String REFRESH_LABEL = "기능 새로고침";

    /** '고급' 아코디언 펼침 상태 (화면을 다시 그려도 기억한다) */
    private static final int F_ADV = 1;
    private static int openBits = 0;

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    // ── 서브화면 판 관리 ────────────────────────────────────────────────────
    //  서브화면 안에서 값을 바꾸면(로그 삭제·로그아웃·기능 새로고침) 지금 열려 있는 화면 전부를
    //  제자리에서 다시 그려야 한다. 그래서 화면마다 "다시 채우는 방법" 을 들고 있는다.

    /** 화면 본문을 채우는 방법 */
    private interface Filler { void fill(MainActivity a, LinearLayout col); }

    private static final class Pane {
        final WeakReference<LinearLayout> body;
        final Filler fill;

        Pane(LinearLayout body, Filler fill) {
            this.body = new WeakReference<LinearLayout>(body);
            this.fill = fill;
        }
    }

    private static final ArrayList<Pane> PANES = new ArrayList<Pane>();

    /** 서브화면 한 장을 만든다 */
    private static View sub(MainActivity a, Filler f) {
        prune();
        LinearLayout col = Ui.screen(a);
        PANES.add(new Pane(col, f));
        try {
            f.fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "내정보 상세 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 화면에서 떼어진 판을 버린다 (뒤로 나간 화면이 계속 쌓이지 않게) */
    private static void prune() {
        for (int i = PANES.size() - 1; i >= 0; i--) {
            LinearLayout col = PANES.get(i).body.get();
            if (col == null || !col.isAttachedToWindow()) PANES.remove(i);
        }
    }

    // ── 셸 ──────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        LinearLayout col = Ui.screen(a);
        ACT = new WeakReference<MainActivity>(a);
        BODY = new WeakReference<LinearLayout>(col);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "내정보 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 탭 본문과 열려 있는 서브화면을 모두 제자리에서 다시 그린다 */
    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        if (a == null || a.isFinishing()) { PANES.clear(); return; }

        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (col != null) {
            try {
                col.removeAllViews();
                fill(a, col);
            } catch (Throwable t) {
                Log.add(a, "내정보 화면 갱신에 실패했습니다: " + t);
            }
        }
        for (int i = PANES.size() - 1; i >= 0; i--) {
            Pane p = PANES.get(i);
            LinearLayout body = p.body.get();
            if (body == null || !body.isAttachedToWindow()) { PANES.remove(i); continue; }
            try {
                body.removeAllViews();
                p.fill.fill(a, body);
            } catch (Throwable t) {
                Log.add(a, "내정보 상세 화면 갱신에 실패했습니다: " + t);
            }
        }
    }

    // ── 목록 (UI_V3 8장) ────────────────────────────────────────────────────

    private static void fill(final MainActivity a, LinearLayout col) {
        col.addView(Ui.title(a, "내정보"));

        // 조용히 실패한 이미지 전송은 문제를 확인하러 오는 이 화면에서도 한 번 알린다
        View imgWarn = ScreenMacro.imgFailNote(a);
        if (imgWarn != null) col.addView(imgWarn);

        final License.State st = License.state(a);
        final boolean ok = st.licensed && !st.locked;
        if (!ok) {
            String why = License.reasonKr(st.reason);
            col.addView(Nav.note(a, (why.length() == 0 ? "라이선스가 인증되지 않았습니다." : why)
                    + "\n재인증이 필요한 경우 라이선스 키 화면에서 로그아웃 후 키를 다시 입력하십시오.",
                    Theme.RED, "라이선스 키 열기", new Runnable() {
                        @Override public void run() { pushLicense(a); }
                    }));
        }

        col.addView(Nav.gap(a, 6));

        // ── 라이선스 ──
        col.addView(Ui.sectionHeader(a, null, "라이선스"));
        LinearLayout lic = Ui.group(a);
        lic.addView(Ui.navRow(a, "라이선스 키", keyValue(st), ok ? Theme.TEXT : Theme.RED,
                new Runnable() {
                    @Override public void run() { pushLicense(a); }
                }));
        lic.addView(Ui.navRow(a, "이용 기능", featValue(a, st), featColor(a),
                new Runnable() {
                    @Override public void run() { Nav.push(a, "이용 기능", sub(a, FEATURES)); }
                }));
        col.addView(lic);

        // ── 카카오톡 ──
        col.addView(Ui.sectionHeader(a, null, "카카오톡"));
        LinearLayout kakao = Ui.group(a);
        int accN = Accounts.count(a);
        kakao.addView(Ui.navRow(a, "카카오톡 계정", accValue(a, accN),
                (accN == 0) ? Theme.DIM : Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "카카오톡 계정", ScreenAccounts.build(a)); }
                }));
        int need = permMissing(a);
        kakao.addView(Ui.navRow(a, "권한", (need == 0) ? "모두 허용됨" : (need + "개 필요"),
                (need == 0) ? Theme.ACCENT : Theme.AMBER, new Runnable() {
                    @Override public void run() { Nav.push(a, "권한", sub(a, PERMS)); }
                }));
        col.addView(kakao);

        // ── 기록 ──
        col.addView(Ui.sectionHeader(a, null, "기록"));
        LinearLayout rec = Ui.group(a);
        final int lines = Log.count(a);
        rec.addView(Ui.navRow(a, "활동 로그", (lines > 0) ? (lines + "줄") : "기록 없음",
                (lines > 0) ? Theme.TEXT : Theme.DIM, new Runnable() {
                    @Override public void run() { Nav.push(a, "활동 로그", sub(a, LOG)); }
                }));
        rec.addView(Ui.navRow(a, "이미지 전송 진단", diagValue(a), diagColor(a), new Runnable() {
            @Override public void run() { Nav.push(a, "이미지 전송 진단", sub(a, DIAG)); }
        }));
        col.addView(rec);

        // ── 고급 (아코디언 허용 구역) ──
        col.addView(Nav.gap(a, 6));
        col.addView(Nav.foldGroup(a, advFold(a)));
    }

    private static void pushLicense(MainActivity a) {
        Nav.push(a, "라이선스 키", sub(a, LICENSE));
    }

    // ── 값 요약 ─────────────────────────────────────────────────────────────

    private static String keyValue(License.State st) {
        if (st.locked) return "잠김";
        if (st.key == null || st.key.trim().length() == 0) return "미등록";
        if (!st.licensed) return "미인증";
        return maskKey(st.key);
    }

    private static String maskKey(String key) {
        if (key == null || key.length() == 0) return "미등록";
        String k = key.trim();
        if (k.length() <= 8) return k;
        int tail = 4;
        StringBuilder sb = new StringBuilder();
        sb.append(k, 0, 4);
        for (int i = 4; i < k.length() - tail; i++) {
            char ch = k.charAt(i);
            sb.append(ch == '-' ? '-' : '•');
        }
        sb.append(k.substring(k.length() - tail));
        return sb.toString();
    }

    /** 기능 이름 짧은 판 (행 값은 폭이 좁다) */
    private static String shortLabel(String id) {
        if (Features.MACRO.equals(id)) return "매크로";
        if (Features.ROOMBOT.equals(id)) return "방관리봇";
        if (Features.MINIGAME.equals(id)) return "미니게임봇";
        return "기능";
    }

    private static long expOf(License.State st, String id) {
        if (st == null || st.features == null) return 0L;
        License.Feat f = st.features.get(id);
        return (f == null) ? 0L : f.expiresAt;
    }

    /** `매크로 D-23` · 2개 이상이면 `매크로 D-23 외 1개` · 없으면 `미사용` */
    private static String featValue(MainActivity a, License.State st) {
        int on = 0;
        String pick = null;
        long pickKey = Long.MAX_VALUE;
        for (int i = 0; i < Features.ALL.length; i++) {
            String id = Features.ALL[i];
            if (MainActivity.featState(a, id) == Ui.State.OFF) continue;
            on++;
            long exp = expOf(st, id);
            long k = (exp > 0) ? exp : (Long.MAX_VALUE - 1);
            if (pick == null || k < pickKey) { pick = id; pickKey = k; }
        }
        if (on == 0 || pick == null) return "미사용";
        long exp = expOf(st, pick);
        String head = shortLabel(pick) + ((exp > 0) ? (" D-" + Ui.daysLeft(exp)) : " 사용 중");
        return (on == 1) ? head : (head + " 외 " + (on - 1) + "개");
    }

    private static int featColor(MainActivity a) {
        int on = 0;
        boolean soon = false;
        for (int i = 0; i < Features.ALL.length; i++) {
            Ui.State fs = MainActivity.featState(a, Features.ALL[i]);
            if (fs == Ui.State.OFF) continue;
            on++;
            if (fs == Ui.State.EXPIRING) soon = true;
        }
        if (on == 0) return Theme.DIM;
        return soon ? Theme.AMBER : Theme.TEXT;
    }

    /** `2개 · 1개 사용` (계정이 1개면 개수만) */
    private static String accValue(MainActivity a, int n) {
        if (n <= 0) return "감지 없음";
        if (n == 1) return "1개";
        List<Accounts.Acc> list = Accounts.all(a);
        Settings s = Settings.load(a);
        int used = 0;
        for (int i = 0; i < list.size(); i++) {
            if (s.accountOn(list.get(i).key)) used++;
        }
        return n + "개 · " + used + "개 사용";
    }

    private static Scheduler.ImageFail lastFail(MainActivity a) {
        try {
            return Scheduler.lastImageFail(a);
        } catch (Throwable t) {
            return null;
        }
    }

    private static String diagValue(MainActivity a) {
        Scheduler.ImageFail fail = lastFail(a);
        if (fail != null) return "실패 기록 · " + ScreenMacro.agoShort(fail.at);
        long at = ScreenMacro.dumpAtSafe(a);
        if (at > 0) return "화면 기록 1건";
        return "기록 없음";
    }

    private static int diagColor(MainActivity a) {
        if (lastFail(a) != null) return Theme.AMBER;
        return (ScreenMacro.dumpAtSafe(a) > 0) ? Theme.TEXT : Theme.DIM;
    }

    // ── 서브화면: 라이선스 키 ───────────────────────────────────────────────

    private static final Filler LICENSE = new Filler() {
        @Override public void fill(final MainActivity a, LinearLayout col) {
            final License.State st = License.state(a);
            final boolean ok = st.licensed && !st.locked;

            LinearLayout card = Ui.card(a);

            LinearLayout head = Ui.row(a);
            TextView t = Ui.h2(a, "인증 상태");
            t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
            head.addView(t);
            head.addView(Ui.chip(a, ok ? "인증됨" : (st.locked ? "잠김" : "미인증"),
                    ok ? Theme.ACCENT : Theme.RED));
            card.addView(head);

            final String key = (st.key == null) ? "" : st.key.trim();
            TextView keyView = Ui.mono(a, (key.length() == 0) ? "등록된 키가 없습니다." : key);
            LinearLayout.LayoutParams kp = new LinearLayout.LayoutParams(MATCH, WRAP);
            kp.topMargin = Theme.dp(a, 12);
            keyView.setLayoutParams(kp);
            card.addView(keyView);

            card.addView(Nav.wideBtn(a, "키 복사", false, new Runnable() {
                @Override public void run() {
                    if (key.length() == 0) { Ui.toast(a, "복사할 키가 없습니다."); return; }
                    Nav.copy(a, "라이선스 키", key);
                }
            }));

            if (ok) {
                card.addView(Ui.divider(a));
                card.addView(Ui.kv(a, "마지막 확인", Nav.when(st.lastOk)));
                card.addView(Ui.kv(a, "오프라인 허용", Nav.dur(st.graceMs)));
                if (st.expiresAt > 0) card.addView(Ui.kv(a, "키 만료", Nav.day(st.expiresAt)));
            } else {
                String why = License.reasonKr(st.reason);
                card.addView(Nav.note(a, (why.length() == 0 ? "라이선스가 인증되지 않았습니다." : why)
                        + "\n로그아웃 후 키를 다시 입력하면 재인증이 진행됩니다.", Theme.RED, null, null));
            }
            col.addView(card);

            // ── 기기 정보 ──
            col.addView(Ui.sectionHeader(a, null, "기기 정보"));
            LinearLayout dev = Ui.card(a);
            dev.addView(Ui.kv(a, "기기명", Device.deviceName()));
            dev.addView(Ui.kv(a, "기기 ID", shortId(st.deviceId)));
            long at = MainActivity.activatedAt(a);
            dev.addView(Ui.kv(a, "등록일", (at > 0) ? Nav.day(at) : "기록 없음"));
            dev.addView(Ui.kv(a, "안드로이드", "SDK " + android.os.Build.VERSION.SDK_INT));
            dev.addView(Nav.note(a, "라이선스 키 1개당 기기 1대만 등록됩니다.\n"
                    + "기기를 변경하거나 초기화한 경우 관리자에게 기기 초기화를 요청하십시오.",
                    Theme.ACCENT2, "기기 초기화 요청", new Runnable() {
                        @Override public void run() { Gate.openMy(a); }
                    }));
            col.addView(dev);

            final String devId = (st.deviceId == null) ? "" : st.deviceId;
            col.addView(Nav.wideBtn(a, "기기 ID 복사", false, new Runnable() {
                @Override public void run() {
                    if (devId.length() == 0) { Ui.toast(a, "복사할 기기 ID가 없습니다."); return; }
                    Nav.copy(a, "기기 ID", devId);
                }
            }));

            // ── 로그아웃 ──
            TextView out = Ui.btn(a, "로그아웃", false);
            out.setTextColor(Theme.RED);
            LinearLayout.LayoutParams op = new LinearLayout.LayoutParams(MATCH, WRAP);
            op.topMargin = Theme.dp(a, 20);
            out.setLayoutParams(op);
            out.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    Nav.confirm(a, "로그아웃",
                            "이 기기에서 라이선스를 해제합니다. 저장된 설정(대화방·메시지·추적 규칙)도 함께 삭제됩니다. "
                                    + "설정은 라이선스 키로 암호화되어 있어 키 없이는 복호화되지 않습니다.\n\n"
                                    + "기기 등록 정보는 서버에 유지되므로 동일 기기에서 동일 키로 재인증이 가능합니다.",
                            "로그아웃", new Runnable() {
                                @Override public void run() {
                                    try {
                                        Scheduler.cancel(a);
                                    } catch (Throwable t) {
                                        Log.add(a, "발송 예약 해제에 실패했습니다: " + t);
                                    }
                                    License.signOut(a);
                                    Ui.toast(a, "로그아웃되었습니다.");
                                    PANES.clear();
                                    a.renderShell();
                                }
                            });
                }
            });
            col.addView(out);
        }
    };

    private static String shortId(String id) {
        if (id == null || id.length() == 0) return "-";
        if (id.length() <= 10) return id;
        return id.substring(0, 6) + "…" + id.substring(id.length() - 4);
    }

    // ── 서브화면: 이용 기능 ─────────────────────────────────────────────────

    private static final Filler FEATURES = new Filler() {
        @Override public void fill(final MainActivity a, LinearLayout col) {
            final License.State st = License.state(a);

            TextView lead = Ui.sub(a, "기능별로 만료일이 별도로 적용됩니다. "
                    + "구매 직후 반영되지 않으면 기능 새로고침을 실행하십시오.");
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
            lp.bottomMargin = Theme.dp(a, 10);
            lead.setLayoutParams(lp);
            col.addView(lead);

            LinearLayout card = Ui.card(a);
            for (int i = 0; i < Features.ALL.length; i++) {
                final String id = Features.ALL[i];
                if (i > 0) card.addView(Ui.divider(a));
                card.addView(featureRow(a, id, MainActivity.featState(a, id), expOf(st, id)));
            }
            col.addView(card);

            final TextView again = Ui.btn(a, REFRESH_LABEL, true);
            LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(MATCH, WRAP);
            ap.topMargin = Theme.dp(a, 16);
            again.setLayoutParams(ap);
            again.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    Nav.refreshFeature(a, again, null, REFRESH_LABEL);
                }
            });
            col.addView(again);

            col.addView(Nav.wideBtn(a, "구매 · 연장", false, new Runnable() {
                @Override public void run() { Gate.openBuy(a, Features.MACRO); }
            }));
        }
    };

    private static LinearLayout featureRow(final MainActivity a, final String id,
                                           Ui.State fs, final long expiresAt) {
        LinearLayout row = Ui.row(a);
        row.setMinimumHeight(Theme.dp(a, 48));

        LinearLayout left = new LinearLayout(a);
        left.setOrientation(LinearLayout.VERTICAL);
        left.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));

        LinearLayout head = Ui.row(a);
        TextView nm = Ui.h2(a, Features.label(id));
        nm.setLayoutParams(new LinearLayout.LayoutParams(WRAP, WRAP));
        head.addView(nm);
        TextView chip = Ui.chip(a, stateKr(fs), stateColor(fs));
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(WRAP, WRAP);
        cp.leftMargin = Theme.dp(a, 8);
        chip.setLayoutParams(cp);
        head.addView(chip);
        left.addView(head);

        TextView desc = Ui.sub(a, expiryDesc(fs, expiresAt));
        desc.setMaxLines(2);
        desc.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
        dp.topMargin = Theme.dp(a, 3);
        desc.setLayoutParams(dp);
        left.addView(desc);
        row.addView(left);

        TextView b = Ui.btn(a, (fs == Ui.State.OFF) ? "구매" : "연장", false);
        b.setPadding(Theme.dp(a, 14), Theme.dp(a, 12), Theme.dp(a, 14), Theme.dp(a, 12));
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(WRAP, WRAP);
        bp.leftMargin = Theme.dp(a, 12);
        b.setLayoutParams(bp);
        b.setContentDescription(Features.label(id) + " " + ((fs == Ui.State.OFF) ? "구매" : "연장"));
        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { Gate.openBuy(a, id); }
        });
        row.addView(b);
        return row;
    }

    private static String stateKr(Ui.State fs) {
        if (fs == Ui.State.ON) return "사용 중";
        if (fs == Ui.State.EXPIRING) return "만료 임박";
        return "미구매";
    }

    private static int stateColor(Ui.State fs) {
        if (fs == Ui.State.ON) return Theme.ACCENT;
        if (fs == Ui.State.EXPIRING) return Theme.AMBER;
        return Theme.DIM;
    }

    private static String expiryDesc(Ui.State fs, long expiresAt) {
        if (fs == Ui.State.OFF) {
            if (expiresAt > 0) return "만료됨 · " + Nav.day(expiresAt);
            return "미구매 상태입니다.";
        }
        if (expiresAt <= 0) return "만료일 정보 없음";
        return Nav.day(expiresAt) + " 까지 · " + Ui.daysLeft(expiresAt) + "일 남음";
    }

    // ── 서브화면: 권한 ──────────────────────────────────────────────────────

    /** 점검 대상 권한 한 건 */
    private static final class Perm {
        final String name;
        final String desc;
        final boolean ok;
        final Runnable fix;

        Perm(String name, String desc, boolean ok, Runnable fix) {
            this.name = name;
            this.desc = desc;
            this.ok = ok;
            this.fix = fix;
        }
    }

    private static ArrayList<Perm> perms(final MainActivity a) {
        boolean noti;
        try { noti = KakaoListener.connected(a); } catch (Throwable t) { noti = false; }
        boolean acc;
        try { acc = ImageSender.accessibilityOn(a); } catch (Throwable t) { acc = false; }
        boolean ov;
        try { ov = ImageSender.overlayOn(a); } catch (Throwable t) { ov = false; }

        ArrayList<Perm> l = new ArrayList<Perm>(4);
        l.add(new Perm("알림 접근",
                "카카오톡 알림을 읽어 대화방을 식별하고 알림 답장으로 발송합니다. 비활성 시 발송이 불가합니다.",
                noti, new Runnable() {
                    @Override public void run() {
                        Nav.openIntent(a, new Intent(
                                android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS),
                                "알림 접근 설정");
                        Ui.toast(a, "목록에서 「카톡 오토 · 알림 읽기」를 허용하십시오.");
                    }
                }));
        l.add(new Perm("배터리 최적화 제외",
                "절전 상태에서 예약 발송 알람이 중단되지 않도록 예외로 등록합니다.",
                ignoringBattery(a), new Runnable() {
                    @Override public void run() { requestBattery(a); }
                }));
        l.add(new Perm("접근성",
                "이미지 첨부 발송에만 사용됩니다. 텍스트 발송에는 영향이 없습니다.",
                acc, new Runnable() {
                    @Override public void run() { ImageSender.openSettings(a); }
                }));
        l.add(new Perm("다른 앱 위에 표시",
                "화면이 꺼진 상태에서 카카오톡 공유 화면을 표시하기 위해 필요합니다. "
                        + "비활성 시 예약 발송의 이미지 전송이 실패합니다.",
                ov, new Runnable() {
                    @Override public void run() { ImageSender.openOverlaySettings(a); }
                }));
        return l;
    }

    private static int permMissing(MainActivity a) {
        ArrayList<Perm> l = perms(a);
        int n = 0;
        for (int i = 0; i < l.size(); i++) if (!l.get(i).ok) n++;
        return n;
    }

    private static final Filler PERMS = new Filler() {
        @Override public void fill(final MainActivity a, LinearLayout col) {
            ArrayList<Perm> l = perms(a);
            int need = 0;
            for (int i = 0; i < l.size(); i++) if (!l.get(i).ok) need++;

            TextView lead = Ui.sub(a, (need == 0)
                    ? "필요한 권한이 모두 허용되어 있습니다."
                    : "허용되지 않은 권한이 " + need + "개 있습니다. 각 항목의 권한 설정을 실행하십시오.");
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
            lp.bottomMargin = Theme.dp(a, 10);
            lead.setLayoutParams(lp);
            col.addView(lead);

            LinearLayout card = Ui.card(a);
            for (int i = 0; i < l.size(); i++) {
                if (i > 0) card.addView(Ui.divider(a));
                card.addView(permRow(a, l.get(i)));
            }
            col.addView(card);

            col.addView(Nav.note(a, "권한 설정 후 이 화면으로 돌아오면 상태가 자동으로 갱신됩니다.",
                    Theme.ACCENT2, "상태 다시 확인", new Runnable() {
                        @Override public void run() { refresh(); }
                    }));
        }
    };

    private static LinearLayout permRow(final MainActivity a, final Perm p) {
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        LinearLayout top = Ui.row(a);
        TextView nt = new TextView(a);
        nt.setText(p.name);
        nt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        nt.setTextColor(Theme.TEXT);
        nt.setTypeface(Typeface.DEFAULT_BOLD);
        nt.setIncludeFontPadding(false);
        nt.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        top.addView(nt);
        top.addView(Ui.chip(a, p.ok ? "허용" : "필요", p.ok ? Theme.ACCENT : Theme.AMBER));
        box.addView(top);

        LinearLayout bot = Ui.row(a);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
        bp.topMargin = Theme.dp(a, 6);
        bot.setLayoutParams(bp);

        TextView dt = Ui.sub(a, p.desc);
        dt.setMaxLines(3);
        dt.setEllipsize(TextUtils.TruncateAt.END);
        dt.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        bot.addView(dt);

        TextView b = Ui.btn(a, p.ok ? "확인" : "권한 설정", false);
        b.setPadding(Theme.dp(a, 14), Theme.dp(a, 12), Theme.dp(a, 14), Theme.dp(a, 12));
        LinearLayout.LayoutParams bbp = new LinearLayout.LayoutParams(WRAP, WRAP);
        bbp.leftMargin = Theme.dp(a, 12);
        b.setLayoutParams(bbp);
        b.setContentDescription(p.name + " 권한 설정");
        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (p.fix != null) p.fix.run();
            }
        });
        bot.addView(b);
        box.addView(bot);
        return box;
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
            Log.add(c, "배터리 최적화 제외 창을 열지 못했습니다: " + t);
            Nav.openIntent(c, new Intent(
                    android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                    "배터리 최적화");
        }
    }

    // ── 서브화면: 활동 로그 ─────────────────────────────────────────────────

    private static final Filler LOG = new Filler() {
        @Override public void fill(final MainActivity a, LinearLayout col) {
            final int n = Log.count(a);

            TextView lead = Ui.sub(a, "최근 200줄을 보관합니다. 현재 " + n + "줄.");
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
            lp.bottomMargin = Theme.dp(a, 10);
            lead.setLayoutParams(lp);
            col.addView(lead);

            String dump = Log.dump(a);
            col.addView(Ui.mono(a, (dump == null || dump.length() == 0) ? "기록 없음" : dump));

            LinearLayout btns = Ui.row(a);
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
            bp.topMargin = Theme.dp(a, 14);
            btns.setLayoutParams(bp);

            TextView copy = Ui.btn(a, "복사", false);
            copy.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
            copy.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { Nav.copy(a, "활동 로그", Log.dump(a)); }
            });
            btns.addView(copy);

            TextView clear = Ui.btn(a, "삭제", false);
            clear.setTextColor(Theme.RED);
            LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, WRAP, 1f);
            cp.leftMargin = Theme.dp(a, 10);
            clear.setLayoutParams(cp);
            if (n == 0) clear.setAlpha(0.55f);
            clear.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    if (Log.count(a) == 0) { Ui.toast(a, "삭제할 기록이 없습니다."); return; }
                    Nav.confirm(a, "활동 로그 삭제",
                            "보관된 " + Log.count(a) + "줄을 삭제합니다. 복구할 수 없습니다.",
                            "삭제", new Runnable() {
                                @Override public void run() {
                                    Log.clear(a);
                                    Ui.toast(a, "활동 로그를 삭제했습니다.");
                                    refresh();
                                }
                            });
                }
            });
            btns.addView(clear);
            col.addView(btns);
        }
    };

    // ── 서브화면: 이미지 전송 진단 ──────────────────────────────────────────

    private static final Filler DIAG = new Filler() {
        @Override public void fill(final MainActivity a, LinearLayout col) {
            final long at = ScreenMacro.dumpAtSafe(a);
            final Scheduler.ImageFail fail = lastFail(a);
            final boolean hasAny = (at > 0) || (fail != null);

            TextView lead = Ui.sub(a, "이미지 전송이 실패한 시점의 카카오톡 화면 구성을 보관합니다. "
                    + "기록을 개발자에게 전달하면 원인 추정 없이 조치가 가능합니다. "
                    + "보관 대상은 화면에 표시된 글자와 버튼 이름이며, 대화 내용은 수집하지 않습니다.");
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
            lp.bottomMargin = Theme.dp(a, 10);
            lead.setLayoutParams(lp);
            col.addView(lead);

            LinearLayout card = Ui.card(a);
            card.addView(Ui.kv(a, "마지막 실패", (fail == null) ? "없음" : ScreenMacro.ago(fail.at)));
            if (fail != null) {
                card.addView(Ui.kv(a, "대상 대화방",
                        (fail.room.length() == 0) ? "미확인" : Nav.preview(fail.room, 16)));
                card.addView(Ui.kv(a, "사유", Nav.preview(fail.why, 40)));
            }
            card.addView(Ui.kv(a, "화면 기록", (at > 0) ? ScreenMacro.ago(at) : "없음"));
            col.addView(card);

            LinearLayout btns = Ui.row(a);
            LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
            bp.topMargin = Theme.dp(a, 14);
            btns.setLayoutParams(bp);

            TextView view = Ui.btn(a, "보기", false);
            view.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
            view.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { ScreenMacro.showDiag(a); }
            });
            btns.addView(view);

            TextView copy = Ui.btn(a, "복사", false);
            LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, WRAP, 1f);
            cp.leftMargin = Theme.dp(a, 10);
            copy.setLayoutParams(cp);
            copy.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    Nav.copy(a, "이미지 전송 진단", ScreenMacro.diagText(a));
                }
            });
            btns.addView(copy);

            TextView clear = Ui.btn(a, "삭제", false);
            clear.setTextColor(Theme.RED);
            LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(0, WRAP, 1f);
            dp.leftMargin = Theme.dp(a, 10);
            clear.setLayoutParams(dp);
            if (!hasAny) clear.setAlpha(0.55f);
            clear.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    if (!hasAny) { Ui.toast(a, "삭제할 기록이 없습니다."); return; }
                    Nav.confirm(a, "진단 기록 삭제",
                            "보관된 카카오톡 화면 기록과 마지막 실패 기록을 삭제합니다. 복구할 수 없습니다.\n"
                                    + "전달 전이라면 복사를 먼저 실행하십시오.",
                            "삭제", new Runnable() {
                                @Override public void run() {
                                    try {
                                        KakaoAccessibility.clearDump(a);
                                    } catch (Throwable t) {
                                        Log.add(a, "화면 기록 삭제에 실패했습니다: " + t);
                                    }
                                    Scheduler.clearImageFail(a);
                                    Log.add(a, "이미지 전송 진단 기록을 삭제했습니다.");
                                    Ui.toast(a, "진단 기록을 삭제했습니다.");
                                    refresh();
                                }
                            });
                }
            });
            btns.addView(clear);
            col.addView(btns);
        }
    };

    // ── 고급 (아코디언 · UI_V3 10장이 허용한 유일한 예외) ───────────────────

    private static Nav.Fold advFold(final MainActivity a) {
        final Nav.Fold f = Nav.fold(a, "고급", "서버 주소 · 앱 정보 · 최근 오류",
                (openBits & F_ADV) != 0);
        f.onToggle(new Ui.OnToggle() {
            @Override public void on(boolean v) {
                if (v) openBits |= F_ADV;
                else openBits &= ~F_ADV;
            }
        });

        f.body.addView(Ui.sub(a, "관리자 안내가 있는 경우에만 변경하십시오."));

        f.body.addView(Nav.actionRow(a, "서버 주소", License.server(a), "변경", new Runnable() {
            @Override public void run() { editServer(a); }
        }));
        f.body.addView(Ui.divider(a));

        f.body.addView(Nav.actionRow(a, "앱 버전",
                Device.appVersionName(a) + " (" + Device.appVersion(a) + ")", null, null));
        f.body.addView(Ui.divider(a));

        String sig = Device.appSigSha256(a);
        final String full = (sig == null) ? "" : sig;
        String shown = (full.length() < 12) ? "확인 불가" : full.substring(0, 12);
        f.body.addView(Nav.actionRow(a, "서명 SHA-256", shown,
                (full.length() == 0) ? null : "복사", new Runnable() {
                    @Override public void run() { Nav.copy(a, "앱 서명 SHA-256", full); }
                }));
        f.body.addView(Ui.divider(a));

        final String err = lastError(a);
        f.body.addView(Nav.actionRow(a, "최근 오류", (err.length() == 0) ? "없음" : Nav.preview(err, 70),
                (err.length() == 0) ? null : "복사", new Runnable() {
                    @Override public void run() { Nav.copy(a, "최근 오류", err); }
                }));

        String tamper = Device.tamperFlags(a);
        if (tamper != null && tamper.length() > 0) {
            f.body.addView(Nav.note(a, "⚠ 변조 지표가 감지되었습니다: " + tamper + "\n"
                    + "정식 APK가 아니거나 개발자 모드일 수 있습니다. 인증이 거부될 수 있습니다.",
                    Theme.AMBER, null, null));
        }
        return f;
    }

    /** 활동 로그에서 가장 최근의 실패·오류 한 줄을 뽑는다. 없으면 "" */
    private static String lastError(MainActivity a) {
        String dump = Log.dump(a);
        if (dump == null || dump.length() == 0) return "";
        String[] lines = dump.split("\n");
        for (int i = 0; i < lines.length; i++) {
            String s = lines[i];
            if (s == null) continue;
            if (s.contains("실패") || s.contains("오류") || s.contains("거부")
                    || s.contains("차단") || s.contains("잠금")) {
                return s.trim();
            }
        }
        return "";
    }

    private static void editServer(final MainActivity a) {
        LinearLayout body = Nav.col(a);
        body.addView(Ui.sub(a, "비워서 저장하면 기본 주소로 복원됩니다.\n기본값: " + License.SERVER));

        TextView lb = Ui.label(a, "서버 주소");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(a, 14);
        lp.bottomMargin = Theme.dp(a, 6);
        lb.setLayoutParams(lp);
        body.addView(lb);

        final EditText f = Ui.field(a, License.SERVER);
        f.setSingleLine(true);
        f.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        f.setText(License.server(a));
        body.addView(f);
        final TextView err = Nav.errLine(a);
        body.addView(err);

        Nav.form(a, "서버 주소", body, "저장", new Nav.OnSave() {
            @Override public String save() {
                Nav.errClear(err);
                String v = f.getText().toString().trim();
                if (v.length() > 0 && !v.startsWith("http://") && !v.startsWith("https://")) {
                    Nav.errText(err, "http:// 또는 https:// 로 시작해야 합니다.");
                    return "";
                }
                License.setServer(a, v);
                Log.add(a, "서버 주소를 변경했습니다.");
                refresh();
                return null;
            }
        });
    }
}
