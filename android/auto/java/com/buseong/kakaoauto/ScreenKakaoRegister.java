package com.buseong.kakaoauto;

import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;

/**
 * 카카오 계정 등록. 로그인 다음에 인증코드를 마쳐야 등록이 끝난다.
 * 그 전에는 매크로·봇 설정으로 들어가지 않는다.
 */
public final class ScreenKakaoRegister {
    private ScreenKakaoRegister() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    /** 홈·매크로·봇에서 계정 등록 전에 보여주는 안내. */
    public static View prompt(final MainActivity a) {
        LinearLayout hero = Ui.hero(a, Theme.F_ACCOUNT, Icon.KEY, "ACCOUNT", "카카오 계정 등록",
                "사용 가능한 기능은 아래에 표시됩니다. 로그인 후 인증코드까지 마치면 매크로와 다른 기능을 설정할 수 있습니다.");
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
                ok ? "인증코드까지 마쳤습니다. 이제 매크로와 다른 기능을 설정할 수 있습니다."
                        : "카카오 계정으로 로그인한 뒤, 휴대폰에 표시된 인증코드를 입력하면 등록이 끝납니다.");
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
        g.addView(Ui.navRow(a, "2. 인증코드", ok ? "완료" : "휴대폰에 표시된 코드", ok ? Theme.OK : Theme.TEXT, null));
        col.addView(g);

        col.addView(Nav.note(a, "비밀번호와 인증코드는 저장하지 않습니다. 인증코드 단계가 끝나기 전에는"
                + " 매크로 설정 화면으로 들어가지 않습니다.", Theme.ACCENT2, null, null));
    }

    private static void login(final MainActivity a) {
        LinearLayout body = Nav.col(a);
        TextView help = Ui.sub(a, "카카오 계정(이메일 또는 전화번호)과 비밀번호를 입력하십시오."
                + " 다음 단계에서 인증코드를 확인합니다.");
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
                authCode(a, acc);
                return null;
            }
        });
    }

    /** 로그인 다음 단계. 코드를 확인해야 등록이 끝난다. */
    private static void authCode(final MainActivity a, final String account) {
        LinearLayout body = Nav.col(a);
        TextView help = Ui.sub(a, "휴대폰 카카오톡에 표시된 인증코드를 입력하십시오."
                + " 이 단계를 마쳐야 계정 등록이 끝납니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.bottomMargin = Theme.dp(a, 12);
        help.setLayoutParams(hp);
        body.addView(help);

        final EditText code = Ui.field(a, "인증코드");
        code.setSingleLine(true);
        code.setGravity(Gravity.CENTER);
        code.setInputType(InputType.TYPE_CLASS_NUMBER);
        body.addView(code);

        Nav.form(a, "인증코드", body, "확인", new Nav.OnSave() {
            @Override public String save() {
                String c = code.getText().toString().trim();
                code.setText("");
                if (c.length() < 4) return "인증코드를 입력하십시오.";
                for (int i = 0; i < c.length(); i++) {
                    char ch = c.charAt(i);
                    if (ch < '0' || ch > '9') return "인증코드는 숫자로 입력하십시오.";
                }
                KakaoAccount.complete(a, account);
                Ui.toast(a, "카카오 계정을 등록했습니다.");
                refresh();
                try { Nav.reload(); } catch (Throwable t) { /* 탭은 다음에 다시 그린다 */ }
                try { MainActivity.refreshHome(); } catch (Throwable t) { /* 홈이 없으면 지나간다 */ }
                return null;
            }
        });
    }

    private static void confirmClear(final MainActivity a) {
        Nav.confirm(a, "등록 해제", "이 기기의 카카오 계정 등록을 해제합니다."
                + " 매크로와 다른 기능 설정은 다시 계정 등록 후에 열립니다.", "해제", new Runnable() {
            @Override public void run() {
                KakaoAccount.clear(a);
                Log.add(a, "카카오 계정 등록을 해제했습니다.");
                Ui.toast(a, "등록을 해제했습니다.");
                refresh();
                try { Nav.reload(); } catch (Throwable t) { /* 탭은 다음에 다시 그린다 */ }
                try { MainActivity.refreshHome(); } catch (Throwable t) { /* 홈이 없으면 지나간다 */ }
            }
        });
    }
}
