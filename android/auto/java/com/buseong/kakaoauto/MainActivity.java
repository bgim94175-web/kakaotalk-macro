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
    private static final String HOME_REFRESH = "구매 내역 새로고침";

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
        final LinearLayout col = Ui.screen(this);
        col.setPadding(Theme.dp(this, 20), Theme.dp(this, 28), Theme.dp(this, 20), Theme.dp(this, 40));

        col.addView(Ui.title(this, "카톡 오토"));
        TextView lead = Ui.sub(this, "라이선스 키 1개당 기기 1대만 등록됩니다.\n키를 입력하고 인증하면 사용할 수 있습니다.");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(this, 6);
        lp.bottomMargin = Theme.dp(this, 18);
        lead.setLayoutParams(lp);
        col.addView(lead);

        boolean locked = (s != null) && s.locked;
        if (locked) {
            String why = "";
            try { why = License.reasonUserKr(s.reason); } catch (Throwable t) { why = ""; }
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

            TextView big = Ui.headline(this, why);
            big.setTextColor(Theme.RED);
            box.addView(big, new LinearLayout.LayoutParams(MATCH, WRAP));

            TextView sm = Ui.sub(this, "동일한 키가 다른 기기에서 인증되면 먼저 사용한 기기가 잠금 처리됩니다.\n"
                    + "현재 기기를 계속 사용하려면 아래에서 다시 인증하십시오.");
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
            Nav.errText(err, License.reasonUserKr(s.reason));
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
                            Nav.errText(err, License.reasonUserKr(reason));
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
        // 기기 ID 는 인증 전 화면에 올리지 않는다 — 인증된 손님은 내정보 > 라이선스 키에서 본다.
        dev.addView(Ui.kv(this, "기기명", Device.deviceName()));
        col.addView(dev);

        col.addView(Nav.note(this, "라이선스 키는 최초 인증한 기기에 등록됩니다.\n"
                + "기기를 변경한 경우 관리자에게 기기 초기화를 요청하면 새 기기에서 다시 인증할 수 있습니다.",
                Theme.ACCENT2, "초기화 요청", new Runnable() {
                    @Override public void run() { Gate.openMy(MainActivity.this); }
                }));

        col.addView(Nav.note(this, "라이선스 키가 없는 경우 구매가 필요합니다.\n"
                + "매크로 · 대화방 관리봇 · 미니게임봇을 개별로 구매할 수 있습니다.",
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
     * 저장이 평문 Prefs 인 이유는 {@link SendGuard} 설명 참고 — 라이선스 인증이 풀려
     * 설정을 못 읽는 상태에서도 정지는 유지돼야 한다.
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
     * (UI_V3 3장). 미구매 상태에서는 토글 대신 상태 한 줄 + 구매 내역 재조회만 남긴다
     * (구매 버튼은 아래 「기능」 카드 하나로 모은다 — 같은 버튼을 두 번 두지 않는다).
     */
    private static LinearLayout statusCard(final MainActivity a) {
        final Settings s = Settings.load(a);
        LinearLayout card = Ui.card(a);

        if (!License.allowed(a, Features.MACRO)) {
            LinearLayout head = Ui.row(a);
            TextView t = Ui.h2(a, "자동발송");
            t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
            head.addView(t);
            head.addView(Ui.chip(a, "미구매", Theme.DIM));
            card.addView(head);
            card.addView(Ui.divider(a));

            // 구매 버튼은 아래 「기능」 카드에 이미 있다 → 여기서는 결제 직후 재조회만 남긴다
            TextView off = Ui.sub(a, "매크로 미구매 상태입니다. 구매 후 발송이 가능합니다.");
            card.addView(off);

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
            return card;
        }

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
        final boolean macroOn = License.allowed(a, Features.MACRO);

        boolean noti = false;
        try { noti = KakaoListener.connected(a); } catch (Throwable t) { noti = false; }
        final boolean notiOk = noti;
        final boolean battOk = ignoringBattery(a);

        // v4: 메시지는 전역 → 계정 → 방 순으로 해석된다. 전역이 비어 있어도 계정/방 덮어쓰기로
        //     실제 발송될 방(hasSendableRoom)이 있으면 '발송 메시지'는 준비된 것으로 본다.
        final boolean hasRooms = !s.macro.roomRefs().isEmpty();
        final boolean globalMsg = s.macro.message != null && s.macro.message.trim().length() > 0;
        final boolean msgOk = !macroOn || globalMsg || (hasRooms && hasSendableRoom(s));
        final boolean roomOk = !macroOn || hasRooms;

        // 이미지 첨부를 쓸 때만 접근성·오버레이를 묻는다 (텍스트 발송에는 필요 없다)
        final boolean imgUse = macroOn && !Settings.IMG_NEVER.equals(s.macro.sendImages);
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
        License.State st = License.state(a);
        col.addView(Ui.sectionHeader(a, null, "기능"));

        // 매크로는 주력 기능이라 카드로 크게 (UI_V3 3장)
        Ui.State fs = featState(a, Features.MACRO);
        long exp = 0L;
        License.Feat f = (st == null || st.features == null) ? null : st.features.get(Features.MACRO);
        if (f != null) exp = f.expiresAt;
        col.addView(Ui.featureCard(a, Features.label(Features.MACRO),
                Features.desc(Features.MACRO), fs, exp,
                new Runnable() {
                    @Override public void run() { Gate.openBuy(a, Features.MACRO); }
                },
                (fs == Ui.State.OFF) ? null : new Runnable() {
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

    /** 봇 한 행. 미구매면 값 대신 [구매] 버튼을 붙인다. */
    private static void botRow(final MainActivity a, LinearLayout g, final String feat,
                              String name, String value, int color) {
        if (!License.allowed(a, feat)) {
            LinearLayout r = Nav.actionRow(a, name, "미구매", "구매", new Runnable() {
                @Override public void run() { Gate.openBuy(a, feat); }
            });
            int ph = Theme.dp(a, 16);
            r.setPadding(ph, Theme.dp(a, 10), ph, Theme.dp(a, 10));
            r.setMinimumHeight(Theme.dp(a, 56));
            g.addView(r);
            return;
        }
        String v = value;
        int c = color;
        if (License.expiringSoon(a, feat)) {
            v = v + " · D-" + License.daysLeft(a, feat);
            c = Theme.AMBER;
        }
        final String fv = v;
        int glyph = Features.MINIGAME.equals(feat) ? Ui.GLYPH_MINIGAME : Ui.GLYPH_ROOMBOT;
        int accent = Features.MINIGAME.equals(feat) ? Theme.FEAT_MINIGAME : Theme.FEAT_ROOMBOT;
        g.addView(Ui.navRow(a, glyph, accent, name, fv, c, new Runnable() {
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

}
