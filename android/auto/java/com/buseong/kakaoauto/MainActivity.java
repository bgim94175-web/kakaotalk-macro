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
import java.util.Date;
import java.util.Locale;

/**
 * 앱 셸.
 *  - 인증 안 됐으면 잠금화면(키 입력)만 보여준다.
 *  - 인증됐으면 하단 탭바 4개 + 홈(대시보드). 첫 인증 직후에는 시작 설정(Setup)을 한 번 띄운다.
 *
 * 홈은 여기 안에 있다 (별도 파일 안 만든다). 탭 전환·화면 조립은 Nav 가 맡는다.
 */
public final class MainActivity extends Activity {

    /** 매크로 화면의 사진 고르기 결과를 받는 요청 코드 */
    public static final int REQ_IMAGES = 9101;

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
        } catch (Throwable t) {
            Log.add(this, "앱 화면 구성에 실패했습니다: " + t);
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

    @Override public void onRequestPermissionsResult(int req, String[] perms, int[] res) {
        super.onRequestPermissionsResult(req, perms, res);
        if (req == Setup.REQ_POST_NOTI) {
            try { Nav.reload(); } catch (Throwable t) { Log.add(this, "화면 갱신에 실패했습니다: " + t); }
        }
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

    // ── 셸: 잠금화면 ↔ 탭 ────────────────────────────────────────────────────

    /** 라이선스 상태를 보고 전체 화면을 다시 만든다 */
    public void renderShell() {
        if (root == null || isFinishing()) return;
        License.State s;
        try {
            s = License.state(this);
        } catch (Throwable t) {
            Log.add(this, "라이선스 상태를 읽지 못했습니다: " + t);
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
        Theme.setAccent(Theme.GOLD);
        final LinearLayout col = Ui.screen(this);
        col.setPadding(Theme.dp(this, 22), Theme.dp(this, 40), Theme.dp(this, 22), Theme.dp(this, 40));

        // ── 브랜드 머리 ──
        LinearLayout brand = new LinearLayout(this);
        brand.setOrientation(LinearLayout.VERTICAL);
        brand.setGravity(Gravity.CENTER_HORIZONTAL);
        brand.addView(monogram(this, 76));
        TextView eb = Ui.eyebrow(this, "KAKAO AUTO · BUSINESS", Theme.GOLD);
        eb.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams ebp = new LinearLayout.LayoutParams(WRAP, WRAP);
        ebp.topMargin = Theme.dp(this, 18);
        brand.addView(eb, ebp);
        TextView name = Ui.title(this, "카톡 오토");
        name.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f);
        name.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(WRAP, WRAP);
        np.topMargin = Theme.dp(this, 6);
        brand.addView(name, np);
        TextView lead = Ui.sub(this, "카카오톡 대화방 운영을 위한 백그라운드 자동화");
        lead.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(WRAP, WRAP);
        lp.topMargin = Theme.dp(this, 6);
        brand.addView(lead, lp);
        col.addView(brand, new LinearLayout.LayoutParams(MATCH, WRAP));

        // ── 기능 3종 (기능마다 색이 다르다) ──
        LinearLayout feats = Ui.row(this);
        LinearLayout.LayoutParams fp = new LinearLayout.LayoutParams(MATCH, WRAP);
        fp.topMargin = Theme.dp(this, 24);
        fp.bottomMargin = Theme.dp(this, 22);
        feats.setLayoutParams(fp);
        for (int i = 0; i < Features.ALL.length; i++) {
            String id = Features.ALL[i];
            LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, WRAP, 1f);
            if (i > 0) cp.leftMargin = Theme.dp(this, 8);
            feats.addView(featChip(this, Features.color(id), Features.icon(id), shortName(id)), cp);
        }
        col.addView(feats);

        boolean locked = (s != null) && s.locked;
        if (locked) {
            String why = "";
            try { why = License.reasonKr(s.reason); } catch (Throwable t) { why = ""; }
            if (why == null || why.length() == 0) why = "현재 기기가 잠금 처리되었습니다";
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

            TextView sm = Ui.sub(this, "동일한 키가 다른 기기에서 인증되면 먼저 사용한 기기가 잠금 처리됩니다.\n"
                    + "현재 기기를 계속 사용하려면 아래에서 다시 인증하십시오.");
            LinearLayout.LayoutParams smp = new LinearLayout.LayoutParams(MATCH, WRAP);
            smp.topMargin = Theme.dp(this, 8);
            sm.setLayoutParams(smp);
            box.addView(sm);
            col.addView(box);
        }

        // ── 키 입력 카드 ──
        LinearLayout card = Ui.hero(this, Theme.GOLD, Icon.KEY, "LICENSE", "라이선스 인증",
                "라이선스 키 1개당 기기 1대가 등록됩니다.");

        LinearLayout inRow = Ui.row(this);
        LinearLayout.LayoutParams irp = new LinearLayout.LayoutParams(MATCH, WRAP);
        irp.topMargin = Theme.dp(this, 16);
        inRow.setLayoutParams(irp);

        final EditText keyField = Ui.field(this, "KAKA-XXXX-XXXX-XXXX");
        keyField.setSingleLine(true);
        keyField.setTypeface(Typeface.MONOSPACE);
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
                if (t.length() == 0) { Ui.toast(v.getContext(), "클립보드가 비어 있습니다."); return; }
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
                    Nav.errText(err, "라이선스 키를 정확히 입력하십시오. (예: KAKA-XXXX-XXXX-XXXX)");
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

        // ── 시작 순서 ──
        col.addView(Ui.sectionHeader(this, null, "시작 순서"));
        LinearLayout steps = Ui.card(this);
        steps.addView(introStep(this, 1, "라이선스 인증", "구매 시 발급된 키를 입력합니다.", false));
        steps.addView(introStep(this, 2, "권한 설정", "알림 접근 · 배터리 최적화 제외를 안내에 따라 허용합니다.", true));
        steps.addView(introStep(this, 3, "기능 설정", "메시지와 대상 대화방을 정하면 백그라운드에서 동작합니다.", true));
        col.addView(steps);

        // ── 이 기기 · 도움 ──
        col.addView(Ui.sectionHeader(this, null, "이 기기"));
        LinearLayout dev = Ui.card(this);
        dev.addView(Ui.kv(this, "기기명", Device.deviceName()));
        dev.addView(Ui.kv(this, "기기 ID", shortId(Device.deviceId(this))));
        col.addView(dev);

        LinearLayout help = Ui.group(this);
        help.addView(Ui.navRow(this, Icon.GEAR, Theme.ACCENT2, "기기 초기화 요청", "기기 변경 시", Theme.SUB,
                new Runnable() {
                    @Override public void run() { Gate.openMy(MainActivity.this); }
                }));
        help.addView(Ui.navRow(this, Icon.COIN, Theme.GOLD, "라이선스 구매", "기능별 구매", Theme.SUB,
                new Runnable() {
                    @Override public void run() { Gate.openBuy(MainActivity.this, Features.MACRO); }
                }));
        col.addView(help);

        TextView ver = Ui.sub(this, "버전 " + Device.appVersionName(this)
                + " (" + Device.appVersion(this) + ")");
        ver.setTextColor(Theme.DIM);
        ver.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(MATCH, WRAP);
        vp.topMargin = Theme.dp(this, 20);
        ver.setLayoutParams(vp);
        col.addView(ver);

        return Ui.scroll(this, col);
    }

    /** 골드 테두리 원 안의 세리프 K */
    static View monogram(Context c, int sizeDp) {
        FrameLayout f = new FrameLayout(c);
        f.setBackground(Theme.ring(Theme.fade(Theme.GOLD, 0.10f), Theme.fade(Theme.GOLD, 0.55f), c));
        TextView k = new TextView(c);
        k.setText("K");
        k.setTypeface(Theme.serif());
        k.setTextSize(TypedValue.COMPLEX_UNIT_SP, sizeDp * 0.42f);
        k.setTextColor(Theme.GOLD_HI);
        k.setGravity(Gravity.CENTER);
        k.setIncludeFontPadding(false);
        f.addView(k, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT));
        int n = Theme.dp(c, sizeDp);
        f.setLayoutParams(new LinearLayout.LayoutParams(n, n));
        f.setContentDescription("카톡 오토");
        return f;
    }

    private static View featChip(Context c, int color, int glyph, String label) {
        LinearLayout l = new LinearLayout(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setGravity(Gravity.CENTER_HORIZONTAL);
        l.setBackground(Theme.sheen(Theme.fade(color, 0.12f), Theme.fade(color, 0.03f), Theme.R_LG,
                Theme.fade(color, 0.26f), c));
        int p = Theme.dp(c, 12);
        l.setPadding(p, Theme.dp(c, 14), p, Theme.dp(c, 12));
        View ic = Ui.icon(c, glyph, color, 22);
        l.addView(ic);
        TextView t = new TextView(c);
        t.setText(label);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        t.setTextColor(Theme.TEXT);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setGravity(Gravity.CENTER);
        t.setIncludeFontPadding(false);
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(WRAP, WRAP);
        tp.topMargin = Theme.dp(c, 8);
        l.addView(t, tp);
        return l;
    }

    private static String shortName(String id) {
        if (Features.MACRO.equals(id)) return "자동발송";
        if (Features.ROOMBOT.equals(id)) return "관리봇";
        if (Features.MINIGAME.equals(id)) return "미니게임";
        return Features.label(id);
    }

    private static View introStep(Context c, int no, String title, String desc, boolean gap) {
        LinearLayout r = new LinearLayout(c);
        r.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        if (gap) lp.topMargin = Theme.dp(c, 14);
        r.setLayoutParams(lp);
        TextView n = new TextView(c);
        n.setText(String.valueOf(no));
        n.setTypeface(Theme.serif());
        n.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        n.setTextColor(Theme.GOLD);
        n.setGravity(Gravity.CENTER);
        n.setIncludeFontPadding(false);
        n.setBackground(Theme.ring(0x00000000, Theme.fade(Theme.GOLD, 0.5f), c));
        LinearLayout.LayoutParams nlp = new LinearLayout.LayoutParams(Theme.dp(c, 26), Theme.dp(c, 26));
        nlp.rightMargin = Theme.dp(c, 12);
        r.addView(n, nlp);
        LinearLayout txt = new LinearLayout(c);
        txt.setOrientation(LinearLayout.VERTICAL);
        txt.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        TextView t = new TextView(c);
        t.setText(title);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        t.setTextColor(Theme.TEXT);
        t.setTypeface(Typeface.DEFAULT_BOLD);
        t.setIncludeFontPadding(false);
        txt.addView(t);
        TextView d = Ui.sub(c, desc);
        LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
        dp.topMargin = Theme.dp(c, 4);
        d.setLayoutParams(dp);
        txt.addView(d);
        r.addView(txt);
        return r;
    }

    /** 인증 성공 직후 처리: 설정키 확보 → 설정 이관 → 알람 복구 → 탭 화면으로 */
    private void afterActivated() {
        try {
            Settings.afterLicense(this);
        } catch (Throwable t) {
            Log.add(this, "설정 이관에 실패했습니다: " + t);
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
            Log.add(this, "발송 예약 복구에 실패했습니다: " + t);
        }
        keyDraft = "";
        Ui.toast(this, "인증 완료");
        renderShell();
        try {
            Setup.maybeFirstRun(this);
        } catch (Throwable t) {
            Log.add(this, "시작 설정 화면을 열지 못했습니다: " + t);
        }
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
        int keep = Theme.accent();
        try {
            Theme.setAccent(Nav.tabColor(Nav.HOME));
            col.removeAllViews();
            fillHome(a, col);
        } catch (Throwable t) {
            Log.add(a, "홈 화면 갱신에 실패했습니다: " + t);
        } finally {
            Theme.setAccent(keep);
        }
    }

    private static void fillHome(final MainActivity a, LinearLayout col) {
        // ── 브랜드 머리 ──
        LinearLayout head = Ui.row(a);
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.topMargin = Theme.dp(a, 10);
        hp.bottomMargin = Theme.dp(a, 18);
        head.setLayoutParams(hp);
        LinearLayout ht = new LinearLayout(a);
        ht.setOrientation(LinearLayout.VERTICAL);
        ht.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        ht.addView(Ui.eyebrow(a, "KAKAO AUTO", Theme.GOLD));
        TextView title = Ui.title(a, greeting());
        LinearLayout.LayoutParams tp = new LinearLayout.LayoutParams(MATCH, WRAP);
        tp.topMargin = Theme.dp(a, 6);
        title.setLayoutParams(tp);
        ht.addView(title);
        TextView who = Ui.sub(a, Device.deviceName() + " · " + activeSummary(a));
        who.setSingleLine(true);
        who.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams wp = new LinearLayout.LayoutParams(MATCH, WRAP);
        wp.topMargin = Theme.dp(a, 4);
        who.setLayoutParams(wp);
        ht.addView(who);
        head.addView(ht);
        View mono = monogram(a, 44);
        LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(Theme.dp(a, 44), Theme.dp(a, 44));
        mp.leftMargin = Theme.dp(a, 12);
        head.addView(mono, mp);
        col.addView(head);

        // ── 시작 설정 (필수 단계가 남아 있을 때만) ──
        View setup = setupCard(a);
        if (setup != null) col.addView(setup);

        // ── 자동발송 ──
        if (License.allowed(a, Features.MACRO)) {
            col.addView(ScreenMacro.autoCard(a, Settings.load(a)));
        }

        // 예약 발송의 이미지 전송 실패는 아무도 보고 있지 않을 때 일어난다 → 머리 카드 바로 아래 1회만
        View warn = null;
        try {
            warn = ScreenMacro.imgFailNote(a);
        } catch (Throwable t) {
            warn = null;
        }
        if (warn != null) col.addView(warn);

        fillFeatures(a, col);

        col.addView(Ui.sectionHeader(a, null, "최근 활동"));
        col.addView(logCard(a));
    }

    private static String greeting() {
        int h = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
        if (h < 5) return "편안한 밤입니다";
        if (h < 12) return "좋은 아침입니다";
        if (h < 18) return "좋은 오후입니다";
        return "편안한 저녁입니다";
    }

    // ── 1. 시작 설정 카드 ───────────────────────────────────────────────────

    private static View setupCard(final MainActivity a) {
        int missing;
        int[] pr;
        try {
            missing = Setup.missingRequired(a);
            pr = Setup.progress(a);
        } catch (Throwable t) {
            return null;
        }
        if (missing == 0) return null;
        LinearLayout card = Ui.hero(a, Theme.GOLD, Icon.LOCK, "SETUP", "시작 설정",
                "필수 항목 " + missing + "건이 남아 있습니다. 완료 전에는 백그라운드 동작이 보장되지 않습니다.");
        LinearLayout row = Ui.row(a);
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(MATCH, WRAP);
        rp.topMargin = Theme.dp(a, 14);
        row.setLayoutParams(rp);
        View bar = Ui.progress(a, pr[0], pr[1], Theme.GOLD);
        bar.setLayoutParams(new LinearLayout.LayoutParams(0, Theme.dp(a, 4), 1f));
        row.addView(bar);
        TextView n = Ui.sub(a, pr[0] + " / " + pr[1]);
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(WRAP, WRAP);
        np.leftMargin = Theme.dp(a, 12);
        n.setLayoutParams(np);
        row.addView(n);
        card.addView(row);
        int keep = Theme.accent();
        Theme.setAccent(Theme.GOLD);
        card.addView(Nav.wideBtn(a, "이어서 설정", true, new Runnable() {
            @Override public void run() { Setup.open(a); }
        }));
        Theme.setAccent(keep);
        return card;
    }

    // ── 2. 기능 ─────────────────────────────────────────────────────────────
    //  기능마다 색·아이콘이 다르다 (매크로 사파이어 · 추적 자수정 · 자동응답 아쿠아 · 관리봇 제이드 · 게임 로즈).

    private static void fillFeatures(final MainActivity a, LinearLayout col) {
        License.State st = License.state(a);
        col.addView(Ui.sectionHeader(a, null, "기능"));

        if (!License.allowed(a, Features.MACRO)) {
            long exp = 0L;
            License.Feat f = (st == null || st.features == null) ? null : st.features.get(Features.MACRO);
            if (f != null) exp = f.expiresAt;
            col.addView(Ui.featureCard(a, Theme.F_MACRO, Icon.SEND, Features.label(Features.MACRO),
                    Features.desc(Features.MACRO), Ui.State.OFF, exp,
                    new Runnable() {
                        @Override public void run() { Gate.openBuy(a, Features.MACRO); }
                    }, null));
        }

        LinearLayout g = Ui.group(a);
        if (License.allowed(a, Features.MACRO)) {
            Settings s = Settings.load(a);
            String macroV = "대상 " + s.macro.roomRefs().size() + "개 · " + ScreenMacro.cycleSummary(s);
            String chip = License.expiringSoon(a, Features.MACRO) ? ("D-" + License.daysLeft(a, Features.MACRO)) : null;
            g.addView(Ui.fnRow(a, Theme.F_MACRO, Icon.SEND, Features.label(Features.MACRO), macroV,
                    Theme.SUB, chip, new Runnable() {
                        @Override public void run() { Nav.go(Nav.MACRO); }
                    }));
            int trigOn = 0;
            for (int i = 0; i < s.triggers.size(); i++) if (s.triggers.get(i).enabled) trigOn++;
            g.addView(Ui.fnRow(a, Theme.F_TRIGGER, Icon.BOLT, "메시지 추적", ScreenMacro.trigSummary(s),
                    (trigOn > 0) ? Theme.SUB : Theme.DIM, null, new Runnable() {
                        @Override public void run() { Nav.push(a, "메시지 추적", MacroDetail.triggers(a)); }
                    }));
            g.addView(Ui.fnRow(a, Theme.F_REPLY, Icon.REPLY, "개인 대화 자동응답", ScreenMacro.replySummary(s),
                    s.autoreply.enabled ? Theme.SUB : Theme.DIM, null, new Runnable() {
                        @Override public void run() { Nav.push(a, "개인 대화 자동응답", MacroDetail.autoReply(a)); }
                    }));
        }
        botRow(a, g, Features.ROOMBOT, ScreenBot.NAME_ROOMBOT,
                ScreenBot.roomBotValue(a), ScreenBot.roomBotColor(a));
        botRow(a, g, Features.MINIGAME, ScreenBot.NAME_MINIGAME,
                ScreenBot.miniGameValue(a), ScreenBot.miniGameColor(a));
        col.addView(g);
    }

    /** 봇 한 행. 미구매면 `미구매` 칩 + 누르면 구매 안내. */
    private static void botRow(final MainActivity a, LinearLayout g, final String feat,
                              String name, String value, int color) {
        int fc = Features.color(feat);
        int glyph = Features.icon(feat);
        if (!License.allowed(a, feat)) {
            g.addView(Ui.fnRow(a, fc, glyph, name, "미구매 · 기능 안내 보기", Theme.DIM, "구매",
                    new Runnable() {
                        @Override public void run() { Gate.openBuy(a, feat); }
                    }));
            return;
        }
        String chip = License.expiringSoon(a, feat) ? ("D-" + License.daysLeft(a, feat)) : null;
        g.addView(Ui.fnRow(a, fc, glyph, name, value, (color == Theme.TEXT) ? Theme.SUB : color, chip,
                new Runnable() {
                    @Override public void run() { Nav.go(Nav.BOT); }
                }));
    }

    // ── 3. 최근 활동 ────────────────────────────────────────────────────────

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
                LinearLayout lr = Ui.row(a);
                LinearLayout.LayoutParams lrp = new LinearLayout.LayoutParams(MATCH, WRAP);
                lrp.topMargin = Theme.dp(a, (i == 0) ? 0 : 10);
                lr.setLayoutParams(lrp);
                View dot = new View(a);
                dot.setBackground(Theme.circle((i == 0) ? Theme.GOLD : Theme.LINE2, a));
                LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(Theme.dp(a, 5), Theme.dp(a, 5));
                dp.rightMargin = Theme.dp(a, 10);
                lr.addView(dot, dp);
                TextView lv = new TextView(a);
                lv.setText(all[i]);
                lv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
                lv.setTextColor((i == 0) ? Theme.SUB : Theme.DIM);
                lv.setSingleLine(true);
                lv.setEllipsize(TextUtils.TruncateAt.END);
                lv.setIncludeFontPadding(false);
                lv.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
                lr.addView(lv);
                lines.addView(lr);
            }
        }
        g.addView(lines);

        g.addView(Ui.navRow(a, Icon.LIST, Theme.SUB, "전체 로그", null, 0, new Runnable() {
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

    private static String shortId(String id) {
        if (id == null || id.length() == 0) return "-";
        if (id.length() <= 10) return id;
        return id.substring(0, 6) + "…" + id.substring(id.length() - 4);
    }
}
