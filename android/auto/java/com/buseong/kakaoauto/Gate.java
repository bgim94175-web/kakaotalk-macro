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
            Log.add(a, "라이선스 확인 중 오류가 났어: " + t);
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
        String title = everBought ? (name + " 기간이 끝났어") : (name + " 기능은 별도 구매가 필요해");
        String msg = Features.descLong(feature) + "\n\n"
                + (everBought
                    ? "연장하면 바로 다시 켜져. 결제 뒤엔 내정보 탭에서 [새로고침]을 눌러줘."
                    : "이 기능만 따로 살 수 있어. 결제 뒤엔 내정보 탭에서 [새로고침]을 눌러줘.");

        AlertDialog.Builder b = Ui.dialog(a, title);
        b.setMessage(msg);
        b.setPositiveButton(everBought ? "연장하기" : "구매하기", new DialogInterface.OnClickListener() {
            @Override public void onClick(DialogInterface d, int w) { openBuy(a, feature); }
        });
        b.setNegativeButton("닫기", null);
        Ui.showDark(b);
        Log.add(a, name + " 실행을 막았어 (구매 안 된 기능)");
    }

    /** 키 자체가 없거나 인증이 안 된 경우 */
    private static void needLicenseDialog(final Activity a, License.State s, final String feature) {
        String why = null;
        if (s != null && s.reason != null && s.reason.length() > 0) {
            try { why = License.reasonKr(s.reason); } catch (Throwable t) { why = null; }
        }
        String msg = ((why == null || why.length() == 0) ? "아직 라이선스 인증이 안 됐어." : why)
                + "\n\n내정보 탭에서 키를 등록하면 바로 쓸 수 있어. 키가 없으면 구매 페이지에서 살 수 있어.";

        AlertDialog.Builder b = Ui.dialog(a, "라이선스 인증이 필요해");
        b.setMessage(msg);
        b.setPositiveButton("구매하기", new DialogInterface.OnClickListener() {
            @Override public void onClick(DialogInterface d, int w) { openBuy(a, feature); }
        });
        b.setNegativeButton("닫기", null);
        Ui.showDark(b);
        Log.add(a, "라이선스가 없어서 실행을 막았어 (" + Features.label(feature) + ")");
    }

    /** 다른 기기에서 접속돼서 잠긴 경우 */
    private static void lockedDialog(final Activity a, License.State s) {
        String why = null;
        if (s != null && s.reason != null && s.reason.length() > 0) {
            try { why = License.reasonKr(s.reason); } catch (Throwable t) { why = null; }
        }
        String msg = ((why == null || why.length() == 0) ? "이 기기는 잠겼어." : why)
                + "\n\n키 1개는 기기 1대에서만 쓸 수 있어. 기기를 바꾸거나 초기화했으면 관리자에게 기기 초기화를 요청해줘.";

        AlertDialog.Builder b = Ui.dialog(a, "이 기기는 잠겼어");
        b.setMessage(msg);
        b.setPositiveButton("초기화 요청", new DialogInterface.OnClickListener() {
            @Override public void onClick(DialogInterface d, int w) { openMy(a); }
        });
        b.setNegativeButton("닫기", null);
        Ui.showDark(b);
        Log.add(a, "기기가 잠겨서 실행을 막았어");
    }

    private static void openUrl(Context c, String url, String what) {
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            c.startActivity(i);
            Log.add(c, what + "를 열었어");
        } catch (Throwable t) {
            Ui.toast(c, "브라우저를 못 열었어. 주소를 직접 열어줘");
            Log.add(c, what + " 열기 실패 (" + url + "): " + t);
        }
    }
}
