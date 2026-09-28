package com.buseong.kakaoauto;

import android.view.View;
import android.widget.LinearLayout;

import java.lang.ref.WeakReference;
import java.util.List;

/**
 * 봇 탭 — <b>2행 목록만</b> 있는 화면 (UI_V3 7장).
 *
 * 예전에는 세그먼트 하나에 두 봇을 욱여넣고, 그 안에 아코디언 8개를 쌓아 뒀다.
 * 세그먼트는 지금 어느 봇을 보고 있는지 기억해야 하고, 아코디언은 접히면 내용이 안 보인다 —
 * 사용자가 "UI 구분이 안 돼서 뭘 설정해야 할지 모르겠다" 고 한 자리다.
 *
 * 그래서 이 화면은 「봇 이름 · 지금 값 · ›」 두 행만 남기고, 설정은 전부
 * {@link BotDetail} 의 전용 서브화면으로 내보냈다. 설정 항목은 하나도 빠지지 않았다.
 */
public final class ScreenBot {
    private ScreenBot() {}

    /** 화면에 쓰는 봇 이름 (홈 화면도 같은 이름을 쓴다) */
    static final String NAME_ROOMBOT = "대화방 관리봇";
    static final String NAME_MINIGAME = "미니게임봇";

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    // ── 셸 ──────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        // 화면을 보는 것만으로는 구매 모달을 띄우지 않는다 — 상세 화면의 잠금 카드가 안내한다.
        LinearLayout col = Ui.screen(a);
        ACT = new WeakReference<MainActivity>(a);
        BODY = new WeakReference<LinearLayout>(col);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "봇 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 탭 본문을 제자리에서 다시 그린다 (상세에서 값을 바꾼 뒤 요약을 맞추는 용도) */
    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (a == null || col == null || a.isFinishing()) return;
        int keep = Theme.accent();
        try {
            Theme.setAccent(Nav.tabColor(Nav.BOT));
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "봇 화면 갱신에 실패했습니다: " + t);
        } finally {
            Theme.setAccent(keep);
        }
    }

    private static void fill(final MainActivity a, LinearLayout col) {
        col.addView(Ui.pageHead(a, "BOTS", "봇", "대상 대화방에서 알림을 받아 자동으로 응답합니다.", Theme.F_ROOMBOT));

        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "설정키가 없어 설정을 저장할 수 없습니다."
                    + " 내정보 탭에서 라이선스를 다시 인증하십시오.", Theme.RED, "내정보 열기",
                    new Runnable() { @Override public void run() { Nav.go(Nav.ACCOUNT); } }));
        }

        col.addView(botCard(a, Features.ROOMBOT, NAME_ROOMBOT, "ROOM GUARD",
                "입·퇴장 인사 · 금지어 · 도배 감지 · 공지 안내", roomBotValue(a), roomBotColor(a),
                new Runnable() {
                    @Override public void run() { Nav.push(a, NAME_ROOMBOT, BotDetail.roomBot(a)); }
                }));
        col.addView(botCard(a, Features.MINIGAME, NAME_MINIGAME, "MINI GAME",
                "끝말잇기 · 숫자야구 · 주사위 · 퀴즈 · 랭킹", miniGameValue(a), miniGameColor(a),
                new Runnable() {
                    @Override public void run() { Nav.push(a, NAME_MINIGAME, BotDetail.miniGame(a)); }
                }));

        col.addView(Nav.note(a, "각 봇에서 대상 대화방과 동작을 설정합니다."
                + " 봇은 대상 대화방의 알림이 수신될 때 동작합니다.", Theme.ACCENT2, null, null));
    }

    /** 봇 하나 = 기능 색 머리 카드 한 장. 카드 전체가 눌린다. */
    private static View botCard(MainActivity a, String feat, String name, String eyebrow, String desc,
                                String value, int valueColor, final Runnable onTap) {
        int fc = Features.color(feat);
        LinearLayout card = Ui.hero(a, fc, Features.icon(feat), eyebrow, name, desc);
        card.addView(Ui.heroRule(a, fc));
        LinearLayout r = Ui.row(a);
        r.setPadding(0, Theme.dp(a, 8), 0, 0);
        View dot = new View(a);
        boolean live = (valueColor == Theme.TEXT);
        dot.setBackground(Theme.circle(live ? Theme.OK : ((valueColor == Theme.AMBER) ? Theme.AMBER : Theme.DIM), a));
        LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(Theme.dp(a, 7), Theme.dp(a, 7));
        dp.rightMargin = Theme.dp(a, 10);
        r.addView(dot, dp);
        android.widget.TextView v = Ui.body(a, value);
        v.setTextColor(live ? Theme.TEXT : valueColor);
        v.setLayoutParams(new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        r.addView(v);
        android.widget.TextView go = Ui.sub(a, License.allowed(a, feat) ? "설정" : "기능 안내");
        go.setTextColor(fc);
        r.addView(go);
        View arrow = Ui.icon(a, Icon.CHEVRON, fc, 16);
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(Theme.dp(a, 16), Theme.dp(a, 16));
        ap.leftMargin = Theme.dp(a, 4);
        r.addView(arrow, ap);
        card.addView(r);
        card.setClickable(true);
        card.setFocusable(true);
        card.setContentDescription(name + ", " + value);
        Ui.press(card);
        card.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View vv) { onTap.run(); }
        });
        return card;
    }

    // ── 값 요약 (UI_V3 2장 — 제목만 있는 행은 만들지 않는다) ────────────────

    /** `사용 중 · 2개` / `미사용` / `미구매` / `대상 대화방 미설정` */
    static String roomBotValue(MainActivity a) {
        if (!License.allowed(a, Features.ROOMBOT)) return "미구매";
        Settings s = Settings.load(a);
        if (!s.roombot.enabled) return "미사용";
        List<RoomRef> rooms = s.roombot.roomRefs();
        if (rooms.isEmpty()) return "대상 대화방 미설정";
        return "사용 중 · " + rooms.size() + "개";
    }

    static int roomBotColor(MainActivity a) {
        if (!License.allowed(a, Features.ROOMBOT)) return Theme.DIM;
        Settings s = Settings.load(a);
        if (!s.roombot.enabled) return Theme.DIM;
        if (s.roombot.roomRefs().isEmpty()) return Theme.AMBER;
        return Theme.TEXT;
    }

    /** `사용 중 · 1개` / `미사용` / `미구매` / `대상 대화방 미설정` / `사용할 게임 미선택` */
    static String miniGameValue(MainActivity a) {
        if (!License.allowed(a, Features.MINIGAME)) return "미구매";
        Settings s = Settings.load(a);
        if (!s.minigame.enabled) return "미사용";
        List<RoomRef> rooms = s.minigame.roomRefs();
        if (rooms.isEmpty()) return "대상 대화방 미설정";
        if (gamesOn(s) == 0) return "사용할 게임 미선택";
        return "사용 중 · " + rooms.size() + "개";
    }

    static int miniGameColor(MainActivity a) {
        if (!License.allowed(a, Features.MINIGAME)) return Theme.DIM;
        Settings s = Settings.load(a);
        if (!s.minigame.enabled) return Theme.DIM;
        if (s.minigame.roomRefs().isEmpty() || gamesOn(s) == 0) return Theme.AMBER;
        return Theme.TEXT;
    }

    private static int gamesOn(Settings s) {
        int n = 0;
        for (int i = 0; i < Settings.GAMES.length; i++) {
            if (s.minigame.gameOn(Settings.GAMES[i])) n++;
        }
        return n;
    }
}
