package com.buseong.kakaoauto;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.net.Uri;

/**
 * 기능 게이트. 발송·봇 실행 경로는 전부 여기 한 곳만 통과한다.
 * 곳곳에 검사를 흩뿌리면 우회 지점만 늘어난다.
 *
 * 쓰는 법:
 *   if (!Gate.check(activity, Features.MACRO)) return;   // 꺼져있으면 구매 유도창이 뜨고 false
 */
public final class Gate {
    private Gate() {}

    /** 기능이 켜져 있으면 true. 아니면 안내창을 띄우고 false. */
    public static boolean check(Activity a, String feature) {
        if (a == null || feature == null) return false;

        boolean ok;
        try {
            ok = License.allowed(a, feature);
        } catch (Throwable t) {
            Log.add(a, "라이선스 확인 중 오류가 발생했습니다: " + t);
            ok = false;
        }
        if (ok) return true;

        License.State s = null;
        try {
            s = License.state(a);
        } catch (Throwable t) {
            s = null;
        }

        if (s != null && s.locked) { lockedDialog(a, s); return false; }
        if (s == null || !s.licensed) { needLicenseDialog(a, s, feature); return false; }
        buyDialog(a, feature, s);
        return false;
    }

    /** 구매 페이지를 브라우저로 연다 (featureCard 의 onBuy 로 그대로 써라) */
    public static void openBuy(Context c, String feature) {
        if (c == null) return;
        openUrl(c, Features.buyUrl(c, feature), "구매 페이지");
    }

    /** 키 조회 / 기기 초기화 요청 페이지 */
    public static void openMy(Context c) {
        if (c == null) return;
        openUrl(c, Features.myUrl(c), "키 조회 페이지");
    }

    // ── 안내창 ────────────────────────────────────────────────────────────────

    /** 해당 기능만 안 산 경우 */
    private static void buyDialog(final Activity a, final String feature, License.State s) {
        boolean everBought = false;
        if (s != null && s.features != null) {
            License.Feat f = s.features.get(feature);
            if (f != null && f.expiresAt > 0) everBought = true;
        }

        String name = Features.label(feature);
        String title = everBought ? (name + " 사용 기간 만료") : (name + " 별도 구매 필요");
        String msg = Features.descLong(feature) + "\n\n"
                + (everBought
                    ? "기간을 연장하면 즉시 다시 사용할 수 있습니다.\n"
                    : "이 기능만 단독으로 구매할 수 있습니다.\n")
                + "결제 후 아래 [지금 확인] 을 누르면 활성화됩니다. 다른 탭으로 이동할 필요는 없습니다.";

        AlertDialog.Builder b = Ui.dialog(a, title);
        b.setMessage(msg);
        b.setPositiveButton(everBought ? "연장하기" : "구매하기", new DialogInterface.OnClickListener() {
            @Override public void onClick(DialogInterface d, int w) { openBuy(a, feature); }
        });
        b.setNeutralButton("지금 확인", new DialogInterface.OnClickListener() {
            @Override public void onClick(DialogInterface d, int w) { refreshNow(a, feature); }
        });
        b.setNegativeButton("닫기", null);
        Ui.showDark(b);
        Log.add(a, name + " 실행을 차단했습니다. (미구매 기능)");
    }

    /** 키 자체가 없거나 인증이 안 된 경우 */
    private static void needLicenseDialog(final Activity a, License.State s, final String feature) {
        String why = null;
        if (s != null && s.reason != null && s.reason.length() > 0) {
            try { why = License.reasonUserKr(s.reason); } catch (Throwable t) { why = null; }
        }
        String msg = ((why == null || why.length() == 0) ? "라이선스 인증이 완료되지 않았습니다." : why)
                + "\n\n내정보 탭에서 라이선스 키를 등록하면 사용할 수 있습니다. 키가 없으면 구매 페이지에서 구매하십시오.";

        AlertDialog.Builder b = Ui.dialog(a, "라이선스 인증 필요");
        b.setMessage(msg);
        b.setPositiveButton("구매하기", new DialogInterface.OnClickListener() {
            @Override public void onClick(DialogInterface d, int w) { openBuy(a, feature); }
        });
        b.setNegativeButton("닫기", null);
        Ui.showDark(b);
        Log.add(a, "라이선스가 없어 실행을 차단했습니다. (" + Features.label(feature) + ")");
    }

    /** 다른 기기에서 접속돼서 잠긴 경우 */
    private static void lockedDialog(final Activity a, License.State s) {
        String why = null;
        if (s != null && s.reason != null && s.reason.length() > 0) {
            try { why = License.reasonUserKr(s.reason); } catch (Throwable t) { why = null; }
        }
        String msg = ((why == null || why.length() == 0) ? "현재 기기가 잠금 처리되었습니다." : why)
                + "\n\n라이선스 키 1개당 기기 1대만 등록됩니다. 기기를 변경하거나 초기화한 경우 관리자에게 기기 초기화를 요청하십시오."
                + "\n초기화 후 내정보 탭에서 키를 다시 등록하면 잠금이 해제됩니다. 새로고침만으로는 해제되지 않습니다.";

        AlertDialog.Builder b = Ui.dialog(a, "기기 잠금");
        b.setMessage(msg);
        b.setPositiveButton("초기화 요청", new DialogInterface.OnClickListener() {
            @Override public void onClick(DialogInterface d, int w) { openMy(a); }
        });
        b.setNegativeButton("닫기", null);
        Ui.showDark(b);
        Log.add(a, "기기가 잠금 상태이므로 실행을 차단했습니다.");
    }

    /**
     * 다이얼로그 안에서 제자리 새로고침 (/entitlements). 결제하고 돌아온 사람을
     * 다른 탭으로 보내지 않는다 — 안내문도 이 흐름으로 맞춰뒀다.
     *
     * 콜백은 메인 스레드로 온다(License.post).
     * 끝나면 (1) 하트비트 주기를 다시 잡고 (잠긴 동안은 12시간 주기였다)
     * (2) 화면을 그 자리에서 다시 그린다 — 기능이 켜지면 카드·탭이 바로 바뀌어야 한다.
     */
    private static void refreshNow(final Activity a, final String feature) {
        if (a == null) return;
        final MainActivity main = (a instanceof MainActivity) ? (MainActivity) a : null;
        final boolean wasShellOk = (main != null) && Nav.shellOk(main);

        Ui.toast(a, "결제 및 기능 상태를 확인하고 있습니다.");
        License.refresh(a, new License.Cb() {
            @Override public void done(boolean ok, String reason) {
                // 잠금이 풀렸을 수 있다 → 잠금용 긴 주기를 정상 주기로 되돌린다
                try { Scheduler.ensureHeartbeat(a); } catch (Throwable t) {
                    Log.add(a, "라이선스 확인 주기를 재설정하지 못했습니다: " + t);
                }

                if (!ok) {
                    String why = null;
                    try { why = License.reasonUserKr(reason); } catch (Throwable t) { why = null; }
                    Ui.toast(a, "상태를 확인하지 못했습니다." + ((why == null || why.length() == 0) ? "" : " (" + why + ")"));
                } else {
                    boolean on = true;
                    if (feature != null) {
                        try { on = License.allowed(a, feature); } catch (Throwable t) { on = false; }
                    }
                    if (feature == null) {
                        Ui.toast(a, "상태를 갱신했습니다.");
                    } else if (on) {
                        Ui.toast(a, Features.label(feature) + " 사용이 활성화되었습니다. 다시 실행하십시오.");
                    } else {
                        Ui.toast(a, "아직 활성화되지 않았습니다. 입금 확인까지 1~2분이 소요될 수 있습니다.");
                    }
                }

                if (main != null) Nav.redraw(main, wasShellOk);
            }
        });
    }

    private static void openUrl(Context c, String url, String what) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            Log.add(c, what + " 을(를) 열었습니다.");
        } catch (Throwable t) {
            Ui.toast(c, "브라우저를 열지 못했습니다. 주소를 직접 입력하여 접속하십시오.");
            Log.add(c, what + " 열기 실패 (" + url + "): " + t);
        }
    }
}
