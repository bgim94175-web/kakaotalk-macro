package com.buseong.kakaoauto;

import android.app.AlarmManager;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.view.View;
import android.widget.LinearLayout;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * 시작 설정 (온보딩 · 권한 마법사). 인증 직후 한 번 자동으로 열리고, 이후에는 홈의
 * 「시작 설정」 카드와 내정보 › 권한에서 연다.
 *
 * 단계는 위에서 아래로 한 번에 하나만 강조한다 (가장 먼저 남은 단계). 시스템 설정 화면으로
 * 보내기 전에는 무엇을 켜야 하는지 한 번 설명한다 — 설정 목록에서 앱 이름을 찾지 못하는 일이 가장 잦다.
 * 설정에서 돌아오면 MainActivity.onResume → Nav.reload 가 이 화면도 제자리에서 다시 그린다.
 */
public final class Setup {
    private Setup() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    /** 자동으로 한 번 열었는가 */
    private static final String K_SHOWN = "ui_setup_shown";
    public static final int REQ_POST_NOTI = 9102;

    private static final String LISTENER_NAME = "카톡 오토 · 알림 읽기";

    // ── 단계 ────────────────────────────────────────────────────────────────

    /** 단계 한 개 */
    static final class Step {
        final String title;
        final String desc;
        final String btn;
        final boolean done;
        final boolean optional;
        final Runnable go;

        Step(String title, String desc, String btn, boolean done, boolean optional, Runnable go) {
            this.title = title;
            this.desc = desc;
            this.btn = btn;
            this.done = done;
            this.optional = optional;
            this.go = go;
        }
    }

    /** 지금 기기 상태로 단계 목록을 만든다. a 가 null 이면 동작(go) 없이 상태만 계산한다. */
    static List<Step> steps(final Context c, final MainActivity a) {
        ArrayList<Step> out = new ArrayList<Step>();

        boolean noti;
        try { noti = KakaoListener.connected(c); } catch (Throwable t) { noti = false; }
        out.add(new Step("알림 접근 허용",
                "카카오톡 알림으로 대화방을 확인하고 답장으로 발송합니다. 모든 기능의 전제 조건입니다.",
                "허용", noti, false, (a == null) ? null : new Runnable() {
                    @Override public void run() { openListener(a); }
                }));

        out.add(new Step("배터리 최적화 제외",
                "화면이 꺼진 상태에서도 예약 발송과 봇 응답이 중단되지 않도록 제외 항목으로 등록합니다.",
                "제외", ignoringBattery(c), false, (a == null) ? null : new Runnable() {
                    @Override public void run() { askBattery(a); }
                }));

        if (Build.VERSION.SDK_INT >= 31) {
            out.add(new Step("정확한 알람 허용",
                    "예약 발송을 지정한 시각에 맞춰 실행합니다. 미허용 시 시스템이 발송 시각을 늦출 수 있습니다.",
                    "허용", exactAlarmOk(c), true, (a == null) ? null : new Runnable() {
                        @Override public void run() { openExactAlarm(a); }
                    }));
        }

        if (Build.VERSION.SDK_INT >= 33) {
            out.add(new Step("알림 표시 허용",
                    "발송 실패 · 라이선스 만료 안내를 알림으로 받습니다.",
                    "허용", postNotiOk(c), true, (a == null) ? null : new Runnable() {
                        @Override public void run() { askPostNoti(a); }
                    }));
        }

        int rooms;
        try { rooms = KakaoListener.knownRooms(c).size(); } catch (Throwable t) { rooms = 0; }
        out.add(new Step("대화방 감지",
                (rooms > 0) ? ("대화방 " + rooms + "개가 감지되었습니다.")
                        : "카카오톡 메시지를 1회 수신하면 대화방이 자동으로 등록됩니다. 대화방 이름을 직접 입력할 수도 있습니다.",
                "카카오톡", rooms > 0, true, (a == null) ? null : new Runnable() {
                    @Override public void run() { openKakao(a); }
                }));

        if (License.allowed(c, Features.MACRO) && KakaoAccount.ready(c)) {
            Settings s = Settings.load(c);
            boolean msgOk = s.macro.message != null && s.macro.message.trim().length() > 0;
            boolean roomOk = !s.macro.roomRefs().isEmpty();
            out.add(new Step("발송 메시지 작성", "자동발송 매크로가 보낼 방에 발송할 본문입니다.",
                    "작성", msgOk, false, (a == null) ? null : new Runnable() {
                        @Override public void run() { Nav.push(a, "메시지", MacroDetail.message(a)); }
                    }));
            out.add(new Step("보낼 방", "자동발송 매크로가 발송할 대화방을 선택합니다.",
                    "선택", roomOk, false, (a == null) ? null : new Runnable() {
                        @Override public void run() { Nav.push(a, "보낼 방", ScreenRooms.build(a)); }
                    }));
        }
        return out;
    }

    /** 남은 필수 단계 수 */
    public static int missingRequired(Context c) {
        List<Step> st = steps(c, null);
        int n = 0;
        for (int i = 0; i < st.size(); i++) if (!st.get(i).done && !st.get(i).optional) n++;
        return n;
    }

    /** {완료 수, 전체 수} */
    public static int[] progress(Context c) {
        List<Step> st = steps(c, null);
        int d = 0;
        for (int i = 0; i < st.size(); i++) if (st.get(i).done) d++;
        return new int[] { d, st.size() };
    }

    // ── 화면 ────────────────────────────────────────────────────────────────

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    /** 시작 설정 서브화면을 연다 */
    public static void open(MainActivity a) {
        if (a == null) return;
        Nav.push(a, "시작 설정", build(a));
    }

    /** 인증 직후 한 번만 자동으로 연다 (필수 단계가 남아 있을 때) */
    public static void maybeFirstRun(MainActivity a) {
        if (a == null) return;
        if (!KakaoAccount.ready(a)) return;
        if (Prefs.getBool(a, K_SHOWN, false)) return;
        Prefs.putBool(a, K_SHOWN, true);
        if (missingRequired(a) > 0) open(a);
    }

    static View build(MainActivity a) {
        Theme.setAccent(Theme.GOLD);
        ACT = new WeakReference<MainActivity>(a);
        LinearLayout col = Ui.screen(a);
        BODY = new WeakReference<LinearLayout>(col);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "시작 설정 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 열려 있으면 제자리에서 다시 그린다 */
    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (a == null || col == null || a.isFinishing() || !col.isAttachedToWindow()) return;
        int keep = Theme.accent();
        try {
            Theme.setAccent(Theme.GOLD);
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "시작 설정 화면 갱신에 실패했습니다: " + t);
        } finally {
            Theme.setAccent(keep);
        }
    }

    private static void fill(final MainActivity a, LinearLayout col) {
        List<Step> st = steps(a, a);
        int done = 0;
        int req = 0;
        int reqDone = 0;
        int cur = -1;
        for (int i = 0; i < st.size(); i++) {
            Step s = st.get(i);
            if (s.done) done++;
            if (!s.optional) { req++; if (s.done) reqDone++; }
            if (cur < 0 && !s.done) cur = i;
        }

        LinearLayout hero = Ui.hero(a, Theme.GOLD, Icon.SPARK, "GETTING STARTED", "시작 설정",
                "백그라운드 발송에 필요한 권한과 기본 설정을 순서대로 완료합니다.");
        hero.addView(Ui.heroRule(a, Theme.GOLD));
        LinearLayout stats = Ui.row(a);
        stats.setPadding(0, Theme.dp(a, 10), 0, Theme.dp(a, 12));
        stats.addView(Ui.stat(a, "완료", done + " / " + st.size(), Theme.TEXT));
        stats.addView(Ui.stat(a, "필수 항목", reqDone + " / " + req,
                (reqDone == req) ? Theme.OK : Theme.AMBER));
        hero.addView(stats);
        hero.addView(Ui.progress(a, done, st.size(), Theme.GOLD));
        col.addView(hero);

        col.addView(Ui.sectionHeader(a, null, "설정 단계"));
        for (int i = 0; i < st.size(); i++) {
            final Step s = st.get(i);
            col.addView(Ui.stepRow(a, i + 1, s.done, i == cur, s.optional, s.title, s.desc,
                    s.done ? null : s.btn, s.go));
        }

        String oem = oemBatteryHint();
        if (oem != null) {
            col.addView(Nav.note(a, oem, Theme.ACCENT2, null, null));
        }

        if (reqDone == req) {
            col.addView(Nav.note(a, "필수 설정을 모두 완료했습니다. 기능별 세부 설정은 각 탭에서 진행하십시오.",
                    Theme.OK, "홈으로", new Runnable() {
                        @Override public void run() { Nav.go(Nav.HOME); }
                    }));
        }
    }

    // ── 동작 ────────────────────────────────────────────────────────────────

    private static void openListener(final MainActivity a) {
        Nav.confirm(a, "알림 접근 허용",
                "다음 화면의 목록에서 「" + LISTENER_NAME + "」 을(를) 찾아 허용하십시오.\n"
                        + "알림 내용은 이 기기 안에서만 처리되며 외부로 전송되지 않습니다.",
                "설정 열기", new Runnable() {
                    @Override public void run() {
                        Nav.openIntent(a, new Intent(android.provider.Settings
                                .ACTION_NOTIFICATION_LISTENER_SETTINGS), "알림 접근 설정");
                    }
                });
    }

    private static void askBattery(final MainActivity a) {
        Nav.confirm(a, "배터리 최적화 제외",
                "다음 창에서 「허용」 을 선택하십시오. 절전 상태에서도 예약 알람이 유지됩니다.",
                "계속", new Runnable() {
                    @Override public void run() { requestBattery(a); }
                });
    }

    private static void openExactAlarm(final MainActivity a) {
        if (Build.VERSION.SDK_INT < 31) return;
        Nav.confirm(a, "정확한 알람 허용",
                "다음 화면에서 「알람 및 리마인더 설정 허용」 을 사용으로 변경하십시오.",
                "설정 열기", new Runnable() {
                    @Override public void run() {
                        Intent i = new Intent("android.settings.REQUEST_SCHEDULE_EXACT_ALARM");
                        i.setData(Uri.parse("package:" + a.getPackageName()));
                        Nav.openIntent(a, i, "알람 권한");
                    }
                });
    }

    private static void askPostNoti(MainActivity a) {
        if (Build.VERSION.SDK_INT < 33) return;
        try {
            a.requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, REQ_POST_NOTI);
        } catch (Throwable t) {
            Log.add(a, "알림 권한 요청에 실패했습니다: " + t);
            Intent i = new Intent("android.settings.APP_NOTIFICATION_SETTINGS");
            i.putExtra("android.provider.extra.APP_PACKAGE", a.getPackageName());
            Nav.openIntent(a, i, "앱 알림 설정");
        }
    }

    private static void openKakao(MainActivity a) {
        Intent i = null;
        try { i = a.getPackageManager().getLaunchIntentForPackage("com.kakao.talk"); } catch (Throwable t) { i = null; }
        if (i == null) {
            Ui.toast(a, "카카오톡이 설치되어 있지 않습니다.");
            return;
        }
        Nav.openIntent(a, i, "카카오톡");
    }

    // ── 상태 확인 (다른 화면도 쓴다) ────────────────────────────────────────

    public static boolean ignoringBattery(Context c) {
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isIgnoringBatteryOptimizations(c.getPackageName());
        } catch (Throwable t) {
            return false;
        }
    }

    public static void requestBattery(Context c) {
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

    public static boolean exactAlarmOk(Context c) {
        if (Build.VERSION.SDK_INT < 31) return true;
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            return am != null && am.canScheduleExactAlarms();
        } catch (Throwable t) {
            return false;
        }
    }

    public static boolean postNotiOk(Context c) {
        if (Build.VERSION.SDK_INT < 33) return true;
        try {
            return c.checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                    == android.content.pm.PackageManager.PERMISSION_GRANTED;
        } catch (Throwable t) {
            return false;
        }
    }

    /** 제조사 절전 기능은 시스템 배터리 최적화와 별개다. 해당 제조사만 한 줄 안내한다. */
    static String oemBatteryHint() {
        String m = (Build.MANUFACTURER == null) ? "" : Build.MANUFACTURER.toLowerCase(Locale.ROOT);
        if (m.contains("samsung")) {
            return "삼성 기기: 설정 › 배터리 › 백그라운드 사용 한도 › 「절전 예외 앱」 에 카톡 오토를 추가하십시오.";
        }
        if (m.contains("xiaomi") || m.contains("redmi") || m.contains("poco")) {
            return "샤오미 기기: 앱 정보 › 배터리 절약 모드를 「제한 없음」 으로, 자동 시작을 사용으로 설정하십시오.";
        }
        if (m.contains("huawei") || m.contains("honor")) {
            return "화웨이 기기: 앱 실행 관리에서 카톡 오토를 수동 관리로 변경하고 백그라운드 실행을 허용하십시오.";
        }
        if (m.contains("oppo") || m.contains("oneplus") || m.contains("realme") || m.contains("vivo")) {
            return "앱 정보 › 배터리 › 「백그라운드 활동 허용」 을 사용으로 설정하십시오.";
        }
        return null;
    }
}
