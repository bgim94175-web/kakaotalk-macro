package com.buseong.kakaoauto;

import android.app.AlertDialog;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.buseong.kakaoauto.engine.Engine;
import com.buseong.kakaoauto.engine.EngineException;
import com.buseong.kakaoauto.engine.KakaoEngine;

import java.lang.ref.WeakReference;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 카카오 계정 등록. 로그인 다음에 카카오톡 확인이 끝나야 등록이 끝난다.
 * 그 전에는 매크로·봇 설정으로 들어가지 않는다.
 *
 * 인증코드는 앱이 보여주고, 고객이 그 코드를 카카오톡에 입력한다.
 * 라이브러리({@code requestPasscode})가 돌려준 값을 그대로 표시하고,
 * {@code registerDevice} 가 확인 완료를 알릴 때까지 기다린다. 이 화면에 코드를 받지 않는다.
 */
public final class ScreenKakaoRegister {
    private ScreenKakaoRegister() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;
    private static final Handler H = new Handler(Looper.getMainLooper());
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    /** 홈·매크로·봇에서 계정 등록 전에 보여주는 안내. */
    public static View prompt(final MainActivity a) {
        LinearLayout hero = Ui.hero(a, Theme.F_ACCOUNT, Icon.KEY, "ACCOUNT", "카카오 계정 등록",
                "사용 가능한 기능은 아래에 표시됩니다. 로그인 후 앱에 표시된 인증코드를 카카오톡에 입력하면 매크로와 다른 기능을 설정할 수 있습니다.");
        hero.addView(Ui.heroRule(a, Theme.F_ACCOUNT));
        int keep = Theme.accent();
        Theme.setAccent(Theme.F_ACCOUNT);
        hero.addView(Nav.wideBtn(a, "계정 등록", true, new Runnable() {
            @Override public void run() { open(a); }
        }));
        Theme.setAccent(keep);
        return hero;
    }

    public static void open(MainActivity a) {
        if (a == null) return;
        Nav.push(a, "카카오 계정 등록", build(a));
    }

    public static View build(MainActivity a) {
        ACT = new WeakReference<MainActivity>(a);
        LinearLayout col = Ui.screen(a);
        BODY = new WeakReference<LinearLayout>(col);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "카카오 계정 등록 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (a == null || col == null || a.isFinishing() || !col.isAttachedToWindow()) return;
        try {
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "카카오 계정 등록 화면 갱신에 실패했습니다: " + t);
        }
    }

    private static void fill(final MainActivity a, LinearLayout col) {
        boolean ok = KakaoAccount.ready(a);
        String id = KakaoAccount.accountId(a);
        LinearLayout hero = Ui.hero(a, Theme.F_ACCOUNT, Icon.KEY, "ACCOUNT", "카카오 계정 등록",
                ok ? "카카오톡에서 인증코드 확인이 끝났습니다. 이제 매크로와 다른 기능을 설정할 수 있습니다."
                        : "카카오 계정으로 로그인한 뒤, 앱에 표시된 인증코드를 카카오톡에 입력하면 등록이 끝납니다.");
        hero.addView(Ui.heroRule(a, Theme.F_ACCOUNT));
        LinearLayout stats = Ui.row(a);
        stats.setPadding(0, Theme.dp(a, 10), 0, 0);
        stats.addView(Ui.stat(a, "상태", ok ? "등록됨" : "등록 필요", ok ? Theme.OK : Theme.AMBER));
        stats.addView(Ui.stat(a, "계정", (ok && id.length() > 0) ? id : "—", Theme.TEXT));
        hero.addView(stats);
        int keep = Theme.accent();
        Theme.setAccent(Theme.F_ACCOUNT);
        if (!ok) {
            hero.addView(Nav.wideBtn(a, "로그인", true, new Runnable() {
                @Override public void run() { login(a); }
            }));
        } else {
            hero.addView(Nav.wideBtn(a, "등록 해제", false, new Runnable() {
                @Override public void run() { confirmClear(a); }
            }));
        }
        Theme.setAccent(keep);
        col.addView(hero);

        col.addView(Ui.sectionHeader(a, null, "순서"));
        LinearLayout g = Ui.group(a);
        g.addView(Ui.navRow(a, "1. 로그인", ok ? "완료" : "계정과 비밀번호", ok ? Theme.OK : Theme.TEXT, null));
        g.addView(Ui.navRow(a, "2. 인증코드", ok ? "완료" : "카카오톡에 입력", ok ? Theme.OK : Theme.TEXT, null));
        col.addView(g);

        col.addView(Nav.note(a, "비밀번호는 저장하지 않습니다. 카카오톡에서 코드 확인이 끝나기 전에는"
                + " 매크로 설정 화면으로 들어가지 않습니다.", Theme.ACCENT2, null, null));
    }

    private static void login(final MainActivity a) {
        LinearLayout body = Nav.col(a);
        TextView help = Ui.sub(a, "카카오 계정(이메일 또는 전화번호)과 비밀번호를 입력하십시오."
                + " 다음 화면에 인증코드가 표시됩니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.bottomMargin = Theme.dp(a, 12);
        help.setLayoutParams(hp);
        body.addView(help);

        final EditText id = Ui.field(a, "카카오 계정");
        id.setSingleLine(true);
        id.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        id.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        body.addView(id);

        final EditText pw = Ui.field(a, "비밀번호");
        pw.setSingleLine(true);
        pw.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        pw.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(MATCH, WRAP);
        pp.topMargin = Theme.dp(a, 10);
        pw.setLayoutParams(pp);
        body.addView(pw);

        Nav.form(a, "카카오 로그인", body, "다음", new Nav.OnSave() {
            @Override public String save() {
                String acc = id.getText().toString().trim();
                String pass = pw.getText().toString();
                pw.setText("");
                if (acc.length() == 0) return "카카오 계정을 입력하십시오.";
                if (pass.length() == 0) return "비밀번호를 입력하십시오.";
                begin(a, acc, pass, false);
                return null;
            }
        });
    }

    private static void begin(final MainActivity a, final String acc, final String pass, final boolean force) {
        final AlertDialog wait = progress(a, "카카오 서버에 연결하는 중입니다…");
        IO.execute(new Runnable() {
            @Override public void run() {
                KakaoEngine.LoginStep step = null;
                String err = null;
                try {
                    step = Engine.get(a).beginLogin(acc, pass, force);
                } catch (EngineException e) {
                    err = e.userText();
                } catch (Throwable t) {
                    err = String.valueOf(t);
                }
                final KakaoEngine.LoginStep got = step;
                final String why = err;
                H.post(new Runnable() {
                    @Override public void run() {
                        dismiss(wait);
                        if (a.isFinishing()) return;
                        if (got == null) { fail(a, "연결하지 못했습니다", why); return; }
                        if (got.kind == KakaoEngine.LoginStep.Kind.SLOT_OCCUPIED) {
                            Nav.confirm(a, "태블릿 로그인 사용 중",
                                    "이 계정은 다른 태블릿에 로그인되어 있습니다. 계속하면 그 기기의 카카오톡이 로그아웃됩니다.",
                                    "계속", new Runnable() {
                                        @Override public void run() { begin(a, acc, pass, true); }
                                    });
                            return;
                        }
                        onStep(a, acc, got);
                    }
                });
            }
        });
    }

    private static void onStep(final MainActivity a, final String account, KakaoEngine.LoginStep s) {
        switch (s.kind) {
            case OK:
                finishRegistered(a, account);
                return;
            case CONFIRM_ON_PHONE:
                if (s.passcode == null || s.passcode.length() == 0) {
                    fail(a, "인증코드를 받지 못했습니다", "카카오 서버가 표시할 코드를 주지 않았습니다. 다시 로그인하십시오.");
                    return;
                }
                showCode(a, account, s);
                return;
            case BAD_CREDENTIALS:
                fail(a, "로그인하지 못했습니다", "카카오 계정 또는 비밀번호가 일치하지 않습니다.");
                return;
            case EXPIRED:
                fail(a, "확인 시간 초과", "인증코드가 만료되었습니다. 처음부터 다시 로그인하십시오.");
                return;
            default:
                String why = (s == null || s.message == null) ? "" : s.message.trim();
                if (why.length() == 0) why = "카카오 서버가 실패 원인을 주지 않았습니다.";
                fail(a, "로그인하지 못했습니다", why);
        }
    }

    /**
     * 라이브러리가 돌려준 인증코드를 보여 주고, 카카오톡 확인이 끝날 때까지 기다린다.
     * 입력칸은 없다.
     */
    private static void showCode(final MainActivity a, final String account, final KakaoEngine.LoginStep first) {
        final boolean[] gone = { false };
        final boolean[] done = { false };
        final TextView[] timer = new TextView[1];
        View screen = codeContent(a, first.passcode, first.remainingSeconds, timer, new Runnable() {
            @Override public void run() { cancelWait(a, first.pendingId, gone); }
        });
        screen.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            @Override public void onViewAttachedToWindow(View v) { }
            @Override public void onViewDetachedFromWindow(View v) {
                if (done[0] || gone[0]) return;
                gone[0] = true;
                Engine.get(a).cancelLogin(first.pendingId);
            }
        });
        Nav.push(a, "인증코드", screen);

        final TextView left = timer[0];
        final long until = System.currentTimeMillis()
                + ((first.remainingSeconds > 0) ? first.remainingSeconds * 1000L : 0L);
        final Runnable tick = new Runnable() {
            @Override public void run() {
                if (gone[0] || done[0] || left == null) return;
                long s = Math.max(0L, (until - System.currentTimeMillis()) / 1000L);
                left.setText("유효 시간 " + (s / 60) + "분 " + (s % 60) + "초");
                H.postDelayed(this, 1000L);
            }
        };
        if (first.remainingSeconds > 0 && left != null) H.post(tick);

        IO.execute(new Runnable() {
            @Override public void run() {
                KakaoEngine.LoginStep s = null;
                String err = null;
                while (!gone[0]) {
                    try {
                        s = Engine.get(a).awaitPhoneConfirm(first.pendingId);
                    } catch (EngineException e) {
                        err = e.userText();
                        break;
                    } catch (Throwable t) {
                        err = String.valueOf(t);
                        break;
                    }
                    if (s == null || s.kind != KakaoEngine.LoginStep.Kind.WAITING) break;
                }
                if (gone[0]) return;
                final KakaoEngine.LoginStep got = s;
                final String why = err;
                H.post(new Runnable() {
                    @Override public void run() {
                        if (gone[0]) return;
                        done[0] = true;
                        gone[0] = true;
                        if (Nav.inSub()) Nav.pop();
                        if (a.isFinishing()) return;
                        if (got != null && got.kind == KakaoEngine.LoginStep.Kind.OK) {
                            finishRegistered(a, account);
                            return;
                        }
                        if (got == null) { fail(a, "등록하지 못했습니다", why); return; }
                        onStep(a, account, got);
                    }
                });
            }
        });
    }

    /**
     * 인증코드 화면 본문. {@code passcode} 는 라이브러리가 돌려준 값이다. 입력칸은 없다.
     * {@code timerOut[0]} 에 남은 시간 글을 넣는다.
     */
    private static View codeContent(final MainActivity a, String passcode, int remainingSeconds,
                                    TextView[] timerOut, final Runnable onCancel) {
        LinearLayout col = Ui.screen(a);
        LinearLayout hero = Ui.hero(a, Theme.F_ACCOUNT, Icon.KEY, "CODE", "인증코드",
                "아래 코드를 카카오톡의 기기 연결 요청에 입력하십시오. 확인이 끝나면 등록이 완료됩니다.");
        hero.addView(Ui.heroRule(a, Theme.F_ACCOUNT));
        col.addView(hero);

        LinearLayout card = Ui.card(a);
        TextView code = new TextView(a);
        code.setText(spaced(passcode));
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        code.setTextSize(TypedValue.COMPLEX_UNIT_SP, 32f);
        code.setTextColor(Theme.TEXT);
        code.setGravity(Gravity.CENTER);
        code.setTextIsSelectable(true);
        code.setLetterSpacing(0.08f);
        card.addView(code, new LinearLayout.LayoutParams(MATCH, WRAP));

        TextView left = Ui.sub(a, remainingText(remainingSeconds));
        left.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(a, 12);
        left.setLayoutParams(lp);
        card.addView(left);
        if (timerOut != null && timerOut.length > 0) timerOut[0] = left;
        col.addView(card);

        col.addView(Nav.note(a, "이 화면에는 코드를 입력하지 않습니다. 카카오톡에서 확인이 끝나면 이 화면이 닫힙니다.",
                Theme.ACCENT2, null, null));

        TextView status = Ui.sub(a, "카카오톡 확인을 기다리는 중입니다.");
        status.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(MATCH, WRAP);
        sp.topMargin = Theme.dp(a, 8);
        sp.bottomMargin = Theme.dp(a, 4);
        status.setLayoutParams(sp);
        col.addView(status);
        col.addView(Nav.wideBtn(a, "취소", false, onCancel));
        return Ui.scroll(a, col);
    }

    private static void cancelWait(MainActivity a, String pendingId, boolean[] gone) {
        if (gone[0]) return;
        gone[0] = true;
        Engine.get(a).cancelLogin(pendingId);
        if (Nav.inSub()) Nav.pop();
    }

    private static void finishRegistered(MainActivity a, String account) {
        if (!com.buseong.kakaoauto.engine.Engine.ready(a)) {
            String err = "";
            try { err = com.buseong.kakaoauto.engine.Engine.get(a).status().lastError; } catch (Throwable ignore) { }
            if (err == null || err.trim().length() == 0) {
                err = "카카오 세션이 저장되지 않았습니다. 다시 로그인하십시오.";
            }
            fail(a, "등록하지 못했습니다", err);
            return;
        }
        KakaoAccount.complete(a, account);
        try { com.buseong.kakaoauto.engine.LocoInbox.ensure(a); } catch (Throwable ignore) { }
        Ui.toast(a, "카카오 계정을 등록했습니다.");
        refresh();
        try { Nav.reload(); } catch (Throwable t) { /* 탭은 다음에 다시 그린다 */ }
        try { MainActivity.refreshHome(); } catch (Throwable t) { /* 홈이 없으면 지나간다 */ }
    }

    private static String remainingText(int seconds) {
        if (seconds <= 0) return "카카오톡 확인을 기다리는 중입니다.";
        return "유효 시간 " + (seconds / 60) + "분 " + (seconds % 60) + "초";
    }

    private static String spaced(String code) {
        if (code == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < code.length(); i++) {
            if (i > 0) sb.append(' ');
            sb.append(code.charAt(i));
        }
        return sb.toString();
    }

    private static void confirmClear(final MainActivity a) {
        Nav.confirm(a, "등록 해제", "이 기기의 카카오 계정 등록을 해제합니다."
                + " 매크로와 다른 기능 설정은 다시 계정 등록 후에 열립니다.", "해제", new Runnable() {
            @Override public void run() {
                try { Engine.get(a).unlink(); } catch (Throwable t) {
                    Log.add(a, "카카오 연결 해제에 실패했습니다: " + t);
                }
                KakaoAccount.clear(a);
                try { com.buseong.kakaoauto.engine.LocoInbox.ensure(a); } catch (Throwable ignore) { }
                Log.add(a, "카카오 계정 등록을 해제했습니다.");
                Ui.toast(a, "등록을 해제했습니다.");
                refresh();
                try { Nav.reload(); } catch (Throwable t) { /* 탭은 다음에 다시 그린다 */ }
                try { MainActivity.refreshHome(); } catch (Throwable t) { /* 홈이 없으면 지나간다 */ }
            }
        });
    }

    private static AlertDialog progress(MainActivity a, String msg) {
        return Ui.showDark(Ui.dialog(a, "잠시 기다려 주십시오").setMessage(msg).setCancelable(false));
    }

    private static void dismiss(AlertDialog d) {
        try { if (d != null && d.isShowing()) d.dismiss(); } catch (Throwable ignore) { }
    }

    private static void fail(MainActivity a, String title, String why) {
        String msg = (why == null || why.trim().length() == 0) ? "원인을 확인하지 못했습니다." : why;
        Ui.showDark(Ui.dialog(a, title).setMessage(msg).setPositiveButton("확인", null));
    }
}
