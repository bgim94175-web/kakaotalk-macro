package com.buseong.kakaoauto;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.PowerManager;
import android.text.TextUtils;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

/**
 * 내정보 탭 — <b>목록만</b> 있는 화면 (UI_V3 8장).
 *
 * 예전에는 여러 카드와 아코디언 3개가 한 장에 쌓여 있었다.
 * 아코디언은 접혀 있으면 안에 뭐가 있는지 모르고, 펼치면 옆 카드와 섞여서 경계가 사라진다.
 * 그래서 이 화면은 「제목 · 지금 값 · ›」 행만 남기고 상세는 전부 {@link Nav#push} 서브화면으로 내보냈다.
 *
 * 섹션은 3개다 — 이 기기 / 카카오톡 / 기록. 아코디언은 쓰지 않는다.
 * 문의에 필요한 정보는 「활동 로그」와 「이미지 전송 진단」의 [복사] 로 충분하다.
 *
 * 값 요약 색 규칙: 손댈 게 없으면 ACCENT·TEXT, 조치가 필요하면 AMBER, 꺼진 건 DIM.
 */
public final class ScreenAccount {
    private ScreenAccount() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    // ── 서브화면 판 관리 ────────────────────────────────────────────────────
    //  서브화면 안에서 값을 바꾸면(로그 삭제 등) 지금 열려 있는 화면 전부를
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

        col.addView(Nav.gap(a, 6));

        // ── 이 기기 ──
        col.addView(Ui.sectionHeader(a, null, "이 기기"));
        LinearLayout dev = Ui.group(a);
        dev.addView(Ui.navRow(a, "기기 정보", Device.deviceName(), Theme.TEXT, new Runnable() {
            @Override public void run() { Nav.push(a, "기기 정보", sub(a, DEVICE)); }
        }));
        col.addView(dev);

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

    }

    /** 매크로 탭의 「진단 기록」 행도 이 화면으로 온다 (입구를 한 곳으로 모은다) */
    static View diagScreen(MainActivity a) {
        return sub(a, DIAG);
    }

    // ── 값 요약 ─────────────────────────────────────────────────────────────

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

    // ── 서브화면: 기기 정보 ─────────────────────────────────────────────────

    private static final Filler DEVICE = new Filler() {
        @Override public void fill(final MainActivity a, LinearLayout col) {
            LinearLayout dev = Ui.card(a);
            dev.addView(Ui.kv(a, "기기명", Device.deviceName()));
            dev.addView(Ui.kv(a, "안드로이드", androidVer()));
            dev.addView(Ui.kv(a, "앱 버전", Device.appVersionName(a) + " (" + Device.appVersion(a) + ")"));
            col.addView(dev);
        }
    };

    /** "15 (SDK 35)" — 손님은 SDK 번호를 모른다. 문의 때 쓸 값은 안드로이드 버전이다. */
    private static String androidVer() {
        String rel = android.os.Build.VERSION.RELEASE;
        if (rel == null || rel.trim().length() == 0) rel = "확인 불가";
        return rel + " (SDK " + android.os.Build.VERSION.SDK_INT + ")";
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
        TextView nt = Ui.rowTitle(a, p.name);
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
                    + "아래 [복사] 로 기록을 고객지원에 전달하면 원인 확인이 가능합니다. "
                    + "기록에는 대화방·상대 이름과 버튼 글자가 들어가며, 대화 내용은 글자 수만 기록됩니다. "
                    + "기록은 이 기기에만 보관되고, [복사] 를 실행할 때만 밖으로 나갑니다.");
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

            // [보기] 는 없앴다 — 원문은 카카오톡 내부 뷰 id·좌표가 적힌 개발자용 자료이고
            // 손님이 읽고 할 수 있는 일이 없다. 위 카드의 요약과 [복사] 로 충분하다.
            TextView copy = Ui.btn(a, "복사", false);
            copy.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
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
                                    // 매크로 탭의 「진단 기록」 행도 이 화면으로 오므로 같이 갱신한다
                                    ScreenMacro.refresh();
                                    MacroDetail.refresh();
                                }
                            });
                }
            });
            btns.addView(clear);
            col.addView(btns);
        }
    };

}
