package com.buseong.kakaoauto;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.PowerManager;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * 앱 셸.
 *  - 인증 안 됐으면 잠금화면(키 입력)만 보여준다.
 *  - 인증됐으면 하단 탭바 4개 + 홈(대시보드).
 *
 * 홈은 여기 안에 있다 (별도 파일 안 만든다). 탭 전환·화면 조립은 Nav 가 맡는다.
 */
public final class MainActivity extends Activity {

    /** 매크로 화면의 사진 고르기 결과를 받는 요청 코드 */
    public static final int REQ_IMAGES = 9101;
    private static final int REQ_NOTI_PERM = 9102;

    /** 하트비트는 앱에 들어올 때마다 때리지 말고 10분에 한 번만 */
    private static final long HB_MIN_MS = 10 * 60 * 1000L;

    private static final String K_HB_AT = "ui_hb_at";
    private static final String K_ACTIVATED_AT = "ui_activated_at";
    private static final String K_SENT_DAY = "ui_sent_day";
    private static final String K_SENT_N = "ui_sent_n";

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private FrameLayout root;
    private FrameLayout content;
    private View bar;

    /** 지금 붙어 있는 셸이 인증 상태로 만들어진 것인가 (onResume 에서 통째 재빌드 여부를 가린다) */
    private boolean shellBuilt = false;
    private boolean shellLicensed = false;

    /** 잠금화면에서 입력 중이던 키 (앱을 잠깐 벗어나도 날아가지 않게 들고 있는다) */
    private String keyDraft = "";

    /** 홈 상태 카드의 새로고침 버튼 라벨 */
    private static final String HOME_REFRESH = "구매했는데 안 켜졌어 (새로고침)";

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
            Log.add(this, "앱 화면을 만들다 오류가 났어: " + t);
        }
    }

    @Override protected void onResume() {
        super.onResume();
        try {
            // 구매 페이지에서 돌아왔을 때 값이 안 바뀐 것처럼 보이면 안 된다 → 매번 다시 그린다.
            // 단, 라이선스 셸(잠금화면 ↔ 탭)이 그대로면 제자리 갱신만 한다
            // (통째로 다시 만들면 입력 중이던 키가 날아가고 스크롤이 맨 위로 튄다).
            if (!shellBuilt || Nav.shellOk(this) != shellLicensed) renderShell();
            else Nav.reload();
            maybeHeartbeat();       // 서버 확인은 10분에 한 번만 (여기 쓰로틀은 그대로)
        } catch (Throwable t) {
            Log.add(this, "화면을 다시 그리다 오류가 났어: " + t);
        }
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
                Log.add(this, "사진 선택 결과를 처리하다 오류가 났어: " + t);
            }
        }
    }

    // ── 셸: 잠금화면 ↔ 탭 ────────────────────────────────────────────────────

    /** 라이선스 상태를 보고 전체 화면을 다시 만든다 */
    public void renderShell() {
        if (root == null || isFinishing()) return;
        License.State s;
        try {
            s = License.state(this);
        } catch (Throwable t) {
            Log.add(this, "라이선스 상태를 못 읽었어: " + t);
            s = null;
        }
        boolean ok = (s != null) && s.licensed && !s.locked;
        shellBuilt = true;
        shellLicensed = ok;

        root.removeAllViews();
        if (!ok) {
            Nav.detach();
            HOME_BODY = null;
            bar = null;
            content = null;
            root.addView(buildLock(s), new FrameLayout.LayoutParams(MATCH, MATCH));
            return;
        }

        content = new FrameLayout(this);
        root.addView(content, new FrameLayout.LayoutParams(MATCH, MATCH));

        int keep = Nav.current();
        bar = Nav.buildBar(this, content);
        FrameLayout.LayoutParams bp = new FrameLayout.LayoutParams(MATCH, WRAP);
        bp.gravity = Gravity.BOTTOM;
        root.addView(bar, bp);

        Nav.go(keep);
    }

    // ── 잠금화면 ─────────────────────────────────────────────────────────────

    private View buildLock(License.State s) {
        final LinearLayout col = Ui.screen(this);
        col.setPadding(Theme.dp(this, 20), Theme.dp(this, 28), Theme.dp(this, 20), Theme.dp(this, 40));

        col.addView(Ui.title(this, "카톡 오토"));
        TextView lead = Ui.sub(this, "키 1개는 기기 1대에서만 쓸 수 있어.\n키를 넣고 인증하면 바로 시작해.");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(this, 6);
        lp.bottomMargin = Theme.dp(this, 18);
        lead.setLayoutParams(lp);
        col.addView(lead);

        boolean locked = (s != null) && s.locked;
        if (locked) {
            String why = "";
            try { why = License.reasonKr(s.reason); } catch (Throwable t) { why = ""; }
            if (why == null || why.length() == 0) why = "이 기기는 잠겼어";
            LinearLayout box = new LinearLayout(this);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setBackground(Theme.round(Theme.fade(Theme.RED, 0.12f), Theme.R_LG,
                    Theme.fade(Theme.RED, 0.30f), 1, this));
            int p = Theme.dp(this, 16);
            box.setPadding(p, p, p, p);
            LinearLayout.LayoutParams bxp = new LinearLayout.LayoutParams(MATCH, WRAP);
            bxp.bottomMargin = Theme.dp(this, 14);
            box.setLayoutParams(bxp);

            TextView big = new TextView(this);
            big.setText(why);
            big.setTextSize(TypedValue.COMPLEX_UNIT_SP, 18f);
            big.setTextColor(Theme.RED);
            big.setTypeface(Typeface.DEFAULT_BOLD);
            big.setLineSpacing(0, 1.35f);
            box.addView(big, new LinearLayout.LayoutParams(MATCH, WRAP));

            TextView sm = Ui.sub(this, "같은 키가 다른 기기에서 쓰이면 먼저 쓰던 기기가 잠겨.\n"
                    + "이 기기를 계속 쓸 거면 아래에서 다시 인증해줘.");
            LinearLayout.LayoutParams smp = new LinearLayout.LayoutParams(MATCH, WRAP);
            smp.topMargin = Theme.dp(this, 8);
            sm.setLayoutParams(smp);
            box.addView(sm);
            col.addView(box);
        }

        // 키 입력 카드
        LinearLayout card = Ui.card(this);
        card.addView(Ui.label(this, "라이선스 키"));

        LinearLayout inRow = Ui.row(this);
        LinearLayout.LayoutParams irp = new LinearLayout.LayoutParams(MATCH, WRAP);
        irp.topMargin = Theme.dp(this, 8);
        inRow.setLayoutParams(irp);

        final EditText keyField = Ui.field(this, "KAKA-XXXX-XXXX-XXXX");
        keyField.setSingleLine(true);
        keyField.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        keyField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS
                | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS);
        keyField.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        String pre = (s == null) ? "" : s.key;
        if (pre == null || pre.length() == 0) pre = keyDraft;    // 손으로 입력하던 값 복원
        if (pre != null && pre.length() > 0) keyField.setText(pre);
        keyField.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence c, int a1, int b1, int c1) { }
            @Override public void onTextChanged(CharSequence c, int a1, int b1, int c1) { }
            @Override public void afterTextChanged(android.text.Editable e) {
                keyDraft = (e == null) ? "" : e.toString();
            }
        });
        inRow.addView(keyField);

        TextView pasteBtn = Ui.btn(this, "붙여넣기", false);
        pasteBtn.setPadding(Theme.dp(this, 12), Theme.dp(this, 14), Theme.dp(this, 12), Theme.dp(this, 14));
        LinearLayout.LayoutParams pbp = new LinearLayout.LayoutParams(WRAP, WRAP);
        pbp.leftMargin = Theme.dp(this, 8);
        pasteBtn.setLayoutParams(pbp);
        pasteBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String t = License.normKey(Nav.paste(v.getContext()));
                if (t.length() == 0) { Ui.toast(v.getContext(), "클립보드가 비어있어"); return; }
                keyField.setText(t);
                try { keyField.setSelection(t.length()); } catch (Throwable ignore) { }
            }
        });
        inRow.addView(pasteBtn);
        card.addView(inRow);

        final TextView err = Nav.errLine(this);
        card.addView(err);
        if (s != null && !locked && s.reason != null && s.reason.length() > 0
                && !"no_license".equals(s.reason)) {
            Nav.errText(err, License.reasonKr(s.reason));
        }

        final TextView go = Ui.btn(this, "인증하기", true);
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(MATCH, WRAP);
        gp.topMargin = Theme.dp(this, 14);
        go.setLayoutParams(gp);
        go.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                final String k = License.normKey(keyField.getText().toString());
                Nav.errClear(err);
                if (k.length() < 8) {
                    Nav.errText(err, "키를 정확히 넣어줘 (예: KAKA-XXXX-XXXX-XXXX)");
                    return;
                }
                Nav.busy(go, true, "확인 중…", locked ? "다시 인증하기" : "인증하기");
                License.activate(MainActivity.this, k, new License.Cb() {
                    @Override public void done(boolean ok, String reason) {
                        Nav.busy(go, false, "확인 중…", locked ? "다시 인증하기" : "인증하기");
                        if (isFinishing()) return;
                        if (!ok) {
                            Nav.errText(err, License.reasonKr(reason));
                            return;
                        }
                        afterActivated();
                    }
                });
            }
        });
        if (locked) go.setText("다시 인증하기");
        card.addView(go);
        col.addView(card);

        // 기기 정보 카드
        LinearLayout dev = Ui.card(this);
        dev.addView(Ui.label(this, "이 기기"));
        dev.addView(Ui.kv(this, "기기명", Device.deviceName()));
        dev.addView(Ui.kv(this, "기기 ID", shortId(Device.deviceId(this))));
        col.addView(dev);

        col.addView(Nav.note(this, "기기를 바꿨거나 초기화했어?\n"
                + "키는 처음 인증한 기기에 묶여 있어. 관리자에게 기기 초기화를 요청하면 새 기기에서 다시 인증할 수 있어.",
                Theme.ACCENT2, "초기화 요청하기", new Runnable() {
                    @Override public void run() { Gate.openMy(MainActivity.this); }
                }));

        col.addView(Nav.note(this, "아직 키가 없어?\n"
                + "매크로 · 방 관리봇 · 미니게임봇 을 필요한 것만 따로 살 수 있어.",
                Theme.ACCENT, "구매하기", new Runnable() {
                    @Override public void run() { Gate.openBuy(MainActivity.this, Features.MACRO); }
                }));

        TextView ver = Ui.sub(this, "버전 " + Device.appVersionName(this)
                + " (" + Device.appVersion(this) + ")");
        ver.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(MATCH, WRAP);
        vp.topMargin = Theme.dp(this, 20);
        ver.setLayoutParams(vp);
        col.addView(ver);

        return Ui.scroll(this, col);
    }

    /** 인증 성공 직후 처리: 설정키 확보 → 설정 이관 → 알람 복구 → 탭 화면으로 */
    private void afterActivated() {
        try {
            Settings.afterLicense(this);
        } catch (Throwable t) {
            Log.add(this, "설정 이관에 실패했어: " + t);
        }
        if (Prefs.getLong(this, K_ACTIVATED_AT, 0L) <= 0) {
            Prefs.putLong(this, K_ACTIVATED_AT, System.currentTimeMillis());
        }
        Prefs.putLong(this, K_HB_AT, System.currentTimeMillis());
        try {
            if (Settings.macro(this).enabled && License.allowed(this, Features.MACRO)) {
                Scheduler.ensureScheduled(this);
            }
        } catch (Throwable t) {
            Log.add(this, "발송 예약을 되살리지 못했어: " + t);
        }
        keyDraft = "";
        Ui.toast(this, "인증 완료");
        renderShell();
    }

    // ── 홈 ──────────────────────────────────────────────────────────────────

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
            Log.add(a, "홈을 갱신하다 오류가 났어: " + t);
        }
    }

    private static void fillHome(final MainActivity a, LinearLayout col) {
        col.addView(Ui.title(a, greeting()));

        License.State st = License.state(a);
        TextView who = Ui.sub(a, Device.deviceName() + " · " + activeSummary(a));
        LinearLayout.LayoutParams wp = new LinearLayout.LayoutParams(MATCH, WRAP);
        wp.topMargin = Theme.dp(a, 4);
        wp.bottomMargin = Theme.dp(a, 16);
        who.setLayoutParams(wp);
        col.addView(who);

        col.addView(statusCard(a));

        col.addView(Ui.sectionHeader(a, "내 기능", "구독 상태"));
        for (int i = 0; i < Features.ALL.length; i++) {
            final String id = Features.ALL[i];
            Ui.State fs = featState(a, id);
            long exp = 0L;
            License.Feat f = (st.features == null) ? null : st.features.get(id);
            if (f != null) exp = f.expiresAt;
            final int tab = Features.MACRO.equals(id) ? Nav.MACRO : Nav.BOT;
            col.addView(Ui.featureCard(a, Features.label(id), Features.desc(id), fs, exp,
                    new Runnable() {
                        @Override public void run() { Gate.openBuy(a, id); }
                    },
                    (fs == Ui.State.OFF) ? null : new Runnable() {
                        @Override public void run() { Nav.go(tab); }
                    }));
        }

        View perm = permCard(a);
        if (perm != null) {
            col.addView(Ui.sectionHeader(a, "점검", "권한이 더 필요해"));
            col.addView(perm);
        }

        col.addView(Ui.sectionHeader(a, "기록", "최근 활동"));
        col.addView(logCard(a));
    }

    /** 상태 요약 카드: 매크로 on/off · 다음 발송 · 오늘 발송 수 */
    private static LinearLayout statusCard(final MainActivity a) {
        LinearLayout card = Ui.card(a);

        Settings.Macro m = Settings.macro(a);
        boolean allowed = License.allowed(a, Features.MACRO);
        boolean on = allowed && m.enabled;

        LinearLayout head = Ui.row(a);
        TextView t = Ui.h2(a, "자동발송");
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        head.addView(t);
        head.addView(Ui.chip(a, on ? "켜짐" : "꺼짐", on ? Theme.ACCENT : Theme.DIM));
        card.addView(head);

        long next = 0L;
        try {
            next = on ? Scheduler.nextAt(a) : 0L;
        } catch (Throwable e) {
            next = 0L;
        }
        card.addView(Ui.kv(a, "다음 발송", on ? Nav.whenRel(next) : "예정 없음"));
        card.addView(Ui.kv(a, "오늘 발송", sentToday(a) + "건"));
        card.addView(Ui.kv(a, "대상 방", m.rooms.size() + "개"));
        if (m.images != null && !m.images.isEmpty()) {
            card.addView(Ui.kv(a, "첨부 사진", m.images.size() + "장 · " + imgModeKr(m.sendImages)));
        }

        if (!allowed) {
            card.addView(Nav.note(a, "매크로 기능이 꺼져 있어서 발송이 안 돼.", Theme.AMBER, "구매하기",
                    new Runnable() {
                        @Override public void run() { Gate.openBuy(a, Features.MACRO); }
                    }));
            final TextView again = Ui.btn(a, HOME_REFRESH, false);
            LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(MATCH, WRAP);
            ap.topMargin = Theme.dp(a, 12);
            again.setLayoutParams(ap);
            again.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    Nav.refreshFeature(a, again, Features.MACRO, HOME_REFRESH);
                }
            });
            card.addView(again);
        } else {
            card.addView(Nav.wideBtn(a, "매크로 설정 열기", false, new Runnable() {
                @Override public void run() { Nav.go(Nav.MACRO); }
            }));
        }
        return card;
    }

    /**
     * 권한 점검 카드. 전부 켜져 있으면 null 을 돌려준다 → 홈에서 카드 자체가 사라져서 화면이 깔끔해진다.
     */
    private static View permCard(final MainActivity a) {
        final boolean noti = KakaoListener.connected(a);
        final boolean batt = ignoringBattery(a);
        boolean acc = false;
        try { acc = ImageSender.accessibilityOn(a); } catch (Throwable t) { acc = false; }
        final boolean accOn = acc;
        boolean ov = false;
        try { ov = ImageSender.overlayOn(a); } catch (Throwable t) { ov = false; }
        final boolean ovOn = ov;

        if (noti && batt && accOn && ovOn) return null;

        LinearLayout card = Ui.card(a);
        card.addView(permRow(a, "알림 접근", "카톡 알림을 읽어서 방을 찾고 답장으로 보낸다. 이게 없으면 아무것도 못 보내.",
                noti, new Runnable() {
                    @Override public void run() {
                        Nav.openIntent(a, new Intent(
                                android.provider.Settings.ACTION_NOTIFICATION_LISTENER_SETTINGS), "알림 접근 설정");
                        Ui.toast(a, "목록에서 「카톡 오토 · 알림 읽기」를 켜줘");
                    }
                }));
        card.addView(Ui.divider(a));
        card.addView(permRow(a, "배터리 최적화 제외", "절전 모드에서 알람이 끊기지 않게 예외로 등록해줘.",
                batt, new Runnable() {
                    @Override public void run() { requestBattery(a); }
                }));
        card.addView(Ui.divider(a));
        card.addView(permRow(a, "접근성 (사진 전송)", "사진 첨부 발송에만 필요해. 텍스트만 보낼 거면 안 켜도 돼.",
                accOn, new Runnable() {
                    @Override public void run() { ImageSender.openSettings(a); }
                }));
        card.addView(Ui.divider(a));
        card.addView(permRow(a, "다른 앱 위에 표시 (사진 전송)",
                "이게 없으면 화면이 꺼진 동안 카톡 공유창이 안 떠서 예약 발송 때 사진이 안 나가.",
                ovOn, new Runnable() {
                    @Override public void run() { ImageSender.openOverlaySettings(a); }
                }));
        return card;
    }

    private static LinearLayout permRow(Context c, String name, String desc, boolean ok,
                                        final Runnable fix) {
        LinearLayout box = new LinearLayout(c);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));

        LinearLayout top = Ui.row(c);
        TextView nt = new TextView(c);
        nt.setText(name);
        nt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        nt.setTextColor(Theme.TEXT);
        nt.setTypeface(Typeface.DEFAULT_BOLD);
        nt.setIncludeFontPadding(false);
        nt.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        top.addView(nt);
        top.addView(Ui.chip(c, ok ? "켜짐" : "꺼짐", ok ? Theme.ACCENT : Theme.RED));
        box.addView(top);

        LinearLayout bot = Ui.row(c);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
        bp.topMargin = Theme.dp(c, 6);
        bot.setLayoutParams(bp);
        TextView dt = Ui.sub(c, desc);
        dt.setMaxLines(3);
        dt.setEllipsize(TextUtils.TruncateAt.END);
        dt.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        bot.addView(dt);

        TextView b = Ui.btn(c, "설정", false);
        b.setPadding(Theme.dp(c, 14), Theme.dp(c, 12), Theme.dp(c, 14), Theme.dp(c, 12));
        LinearLayout.LayoutParams bbp = new LinearLayout.LayoutParams(WRAP, WRAP);
        bbp.leftMargin = Theme.dp(c, 12);
        b.setLayoutParams(bbp);
        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { if (fix != null) fix.run(); }
        });
        bot.addView(b);
        box.addView(bot);
        return box;
    }

    /** 최근 로그 6줄 미리보기 */
    private static LinearLayout logCard(final MainActivity a) {
        LinearLayout card = Ui.card(a);

        LinearLayout head = Ui.row(a);
        TextView t = Ui.h2(a, "최근 활동");
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        head.addView(t);
        TextView all = Ui.btn(a, "전체보기", false);
        all.setPadding(Theme.dp(a, 14), Theme.dp(a, 12), Theme.dp(a, 14), Theme.dp(a, 12));
        all.setLayoutParams(new LinearLayout.LayoutParams(WRAP, WRAP));
        all.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { Nav.go(Nav.ACCOUNT); }
        });
        head.addView(all);
        card.addView(head);

        String dump = Log.dump(a);
        if (dump == null || dump.length() == 0) {
            TextView e = Ui.sub(a, "아직 기록이 없어. 발송이 일어나면 여기에 쌓인다.");
            LinearLayout.LayoutParams ep = new LinearLayout.LayoutParams(MATCH, WRAP);
            ep.topMargin = Theme.dp(a, 10);
            e.setLayoutParams(ep);
            card.addView(e);
            return card;
        }
        String[] lines = dump.split("\n");
        int n = Math.min(6, lines.length);
        for (int i = 0; i < n; i++) {
            TextView lv = new TextView(a);
            lv.setText(lines[i]);
            lv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
            lv.setTextColor((i == 0) ? Theme.SUB : Theme.DIM);
            lv.setSingleLine(true);
            lv.setEllipsize(TextUtils.TruncateAt.END);
            lv.setIncludeFontPadding(false);
            LinearLayout.LayoutParams lvp = new LinearLayout.LayoutParams(MATCH, WRAP);
            lvp.topMargin = Theme.dp(a, (i == 0) ? 12 : 7);
            lv.setLayoutParams(lvp);
            card.addView(lv);
        }
        return card;
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
            Log.add(c, "발송 수를 기록하지 못했어: " + t);
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

    /** 이 기기에 키를 처음 등록한 시각 (0 이면 모름) */
    public static long activatedAt(Context c) {
        return (c == null) ? 0L : Prefs.getLong(c, K_ACTIVATED_AT, 0L);
    }

    private static String dayKey(long ms) {
        try {
            return new SimpleDateFormat("yyyyMMdd", Locale.KOREA).format(new Date(ms));
        } catch (Throwable t) {
            return "00000000";
        }
    }

    // ── 하트비트 ─────────────────────────────────────────────────────────────

    private void maybeHeartbeat() {
        License.State s;
        try {
            s = License.state(this);
        } catch (Throwable t) {
            return;
        }
        if (s.key == null || s.key.length() == 0) return;

        long now = System.currentTimeMillis();
        long last = Prefs.getLong(this, K_HB_AT, 0L);
        // 시계를 앞으로 돌려놨다가 되돌린 경우(now < last)는 그냥 한 번 때린다
        if (now >= last && now - last < HB_MIN_MS) return;
        Prefs.putLong(this, K_HB_AT, now);

        final boolean wasOk = s.licensed && !s.locked;
        License.heartbeat(this, new License.Cb() {
            @Override public void done(boolean ok, String reason) {
                if (isFinishing()) return;
                if (!ok && reason != null && reason.length() > 0) {
                    Log.add(MainActivity.this, "라이선스 확인 실패: " + License.reasonKr(reason));
                }
                License.State now2;
                try {
                    now2 = License.state(MainActivity.this);
                } catch (Throwable t) {
                    return;
                }
                boolean nowOk = now2.licensed && !now2.locked;
                if (nowOk != wasOk) renderShell();
                else Nav.reload();
            }
        });
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
            Log.add(this, "알림 권한을 요청하지 못했어: " + t);
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
            Log.add(c, "배터리 최적화 제외 창을 못 열었어: " + t);
            Nav.openIntent(c, new Intent(
                    android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS),
                    "배터리 최적화");
        }
    }

    /** 기능 카드 상태: 켜짐 / 만료임박(7일) / 꺼짐 */
    static Ui.State featState(Context c, String id) {
        if (!License.allowed(c, id)) return Ui.State.OFF;
        return License.expiringSoon(c, id) ? Ui.State.EXPIRING : Ui.State.ON;
    }

    private static String activeSummary(Context c) {
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (int i = 0; i < Features.ALL.length; i++) {
            if (!License.allowed(c, Features.ALL[i])) continue;
            if (n > 0) sb.append(" · ");
            sb.append(Features.label(Features.ALL[i]));
            n++;
        }
        if (n == 0) return "사용 중인 기능 없음";
        return sb.toString();
    }

    private static String imgModeKr(String mode) {
        if (Settings.IMG_EVERY.equals(mode)) return "매번";
        if (Settings.IMG_EVERY_N.equals(mode)) return "N번마다";
        if (Settings.IMG_MANUAL.equals(mode)) return "수동만";
        return "안 보냄";
    }

    private static String greeting() {
        int h;
        try {
            h = Calendar.getInstance().get(Calendar.HOUR_OF_DAY);
        } catch (Throwable t) {
            h = 12;
        }
        if (h >= 5 && h < 11) return "좋은 아침이야";
        if (h >= 11 && h < 17) return "좋은 오후야";
        if (h >= 17 && h < 22) return "좋은 저녁이야";
        return "오늘도 고생했어";
    }

    private static String shortId(String id) {
        if (id == null || id.length() == 0) return "-";
        if (id.length() <= 10) return id;
        return id.substring(0, 6) + "…" + id.substring(id.length() - 4);
    }
}
