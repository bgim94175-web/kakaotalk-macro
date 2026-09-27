package com.buseong.kakaoauto;

import android.graphics.Typeface;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

/**
 * 봇 화면. 위쪽 세그먼트로 방 관리봇 / 미니게임봇 을 한 화면에서 바꿔 본다.
 * 두 기능은 따로 결제되니까 세그먼트마다 게이트를 따로 본다.
 */
public final class ScreenBot {
    private ScreenBot() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    public static final int SEG_ROOM = 0;
    public static final int SEG_GAME = 1;

    // 방 관리봇 카드
    private static final int F_ROOMS = 1;
    private static final int F_GREET = 1 << 1;
    private static final int F_DETECT = 1 << 2;
    private static final int F_CMD = 1 << 3;
    // 미니게임봇 카드
    private static final int G_ROOMS = 1 << 4;
    private static final int G_GAMES = 1 << 5;
    private static final int G_TUNE = 1 << 6;
    private static final int G_HELP = 1 << 7;
    private static int openBits = 0;

    private static int seg = SEG_ROOM;
    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    // ── 셸 ──────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        LinearLayout col = Ui.screen(a);
        ACT = new WeakReference<MainActivity>(a);
        BODY = new WeakReference<LinearLayout>(col);
        gate(a, seg);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "봇 화면을 그리다 오류가 났어: " + t);
        }
        return Ui.scroll(a, col);
    }

    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (a == null || col == null || a.isFinishing()) return;
        try {
            col.removeAllViews();
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "봇 화면을 갱신하다 오류가 났어: " + t);
        }
    }

    private static String feature(int which) {
        return (which == SEG_GAME) ? Features.MINIGAME : Features.ROOMBOT;
    }

    private static void gate(MainActivity a, int which) {
        Gate.check(a, feature(which));
    }

    private static void fill(final MainActivity a, LinearLayout col) {
        col.addView(Ui.title(a, "봇"));
        col.addView(segment(a));

        final String feat = feature(seg);
        if (!License.allowed(a, feat)) {
            fillLocked(a, col, feat);
            return;
        }
        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "설정을 저장할 수 없는 상태야 (설정키 없음).\n"
                    + "내정보 탭에서 라이선스를 다시 인증해줘.", Theme.RED, "내정보로 가기",
                    new Runnable() { @Override public void run() { Nav.go(Nav.ACCOUNT); } }));
        }

        Settings s = Settings.load(a);
        if (seg == SEG_GAME) fillGame(a, col, s);
        else fillRoom(a, col, s);
    }

    private static void fillLocked(final MainActivity a, LinearLayout col, final String feat) {
        LinearLayout card = Ui.card(a);
        card.addView(Ui.h2(a, Features.label(feat)));
        TextView d = Ui.sub(a, Features.descLong(feat));
        LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
        dp.topMargin = Theme.dp(a, 10);
        d.setLayoutParams(dp);
        card.addView(d);
        card.addView(Nav.wideBtn(a, "구매하기", true, new Runnable() {
            @Override public void run() { Gate.openBuy(a, feat); }
        }));
        card.addView(Nav.wideBtn(a, "구매했는데 안 켜졌어 (새로고침)", false, new Runnable() {
            @Override public void run() { Nav.go(Nav.ACCOUNT); }
        }));
        col.addView(card);
    }

    // ── 세그먼트 컨트롤 ──────────────────────────────────────────────────────

    private static LinearLayout segment(final MainActivity a) {
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.HORIZONTAL);
        box.setBackground(Theme.round(Theme.CARD, Theme.R_MD, Theme.LINE, 1, a));
        int p = Theme.dp(a, 4);
        box.setPadding(p, p, p, p);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(a, 12);
        lp.bottomMargin = Theme.dp(a, 4);
        box.setLayoutParams(lp);

        String[] names = { "방 관리봇", "미니게임봇" };
        for (int i = 0; i < names.length; i++) {
            final int idx = i;
            boolean on = (seg == i);
            TextView t = new TextView(a);
            t.setText(names[i]);
            t.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14f);
            t.setTextColor(on ? Theme.ON_ACCENT : Theme.SUB);
            t.setTypeface(on ? Typeface.DEFAULT_BOLD : Typeface.DEFAULT);
            t.setGravity(Gravity.CENTER);
            t.setIncludeFontPadding(false);
            t.setMinimumHeight(Theme.dp(a, 44));
            t.setPadding(Theme.dp(a, 10), Theme.dp(a, 13), Theme.dp(a, 10), Theme.dp(a, 13));
            t.setBackground(on ? Theme.round(Theme.ACCENT, Theme.R_SM, 0, 0, a) : null);
            t.setClickable(true);
            t.setFocusable(true);
            Ui.press(t);
            t.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    if (seg == idx) return;
                    seg = idx;
                    gate(a, seg);
                    refresh();
                }
            });
            box.addView(t, new LinearLayout.LayoutParams(0, WRAP, 1f));
        }
        return box;
    }

    // ── 방 관리봇 ───────────────────────────────────────────────────────────

    private static void fillRoom(final MainActivity a, LinearLayout col, final Settings s) {
        final Settings.RoomBotCfg r = s.roombot;

        LinearLayout onCard = Ui.card(a);
        onCard.addView(Ui.switchRow(a, "방 관리봇 사용", "등록한 방에서 인사 · 금지어 · 도배를 지켜본다",
                r.enabled, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        r.enabled = v;
                        save(a, s);
                        Log.add(a, v ? "방 관리봇을 켰어" : "방 관리봇을 껐어");
                    }
                }));
        col.addView(onCard);

        col.addView(Ui.sectionHeader(a, "방 관리봇", "설정"));

        // 대상 방
        final Nav.Fold rooms = fold(a, F_ROOMS, "대상 방", roomsSummary(r.rooms));
        rooms.body.addView(Ui.sub(a, "이 방들에서만 동작한다. 칩을 누르면 지워진다."));
        final Nav.Flow flow = Nav.flow(a);
        rooms.body.addView(flow);
        final Runnable roomsChanged = new Runnable() {
            @Override public void run() {
                save(a, s);
                rooms.summary(roomsSummary(r.rooms));
            }
        };
        Nav.chipEditor(flow, r.rooms, Theme.ACCENT2, "아직 없어", roomsChanged);
        rooms.body.addView(Nav.wideBtn(a, "방 추가", false, new Runnable() {
            @Override public void run() {
                Nav.pickRooms(a, "관리할 방 추가", KakaoListener.knownRooms(a), r.rooms,
                        new Nav.OnRooms() {
                            @Override public void rooms(List<String> picked) {
                                for (int i = 0; i < picked.size(); i++) {
                                    String v = picked.get(i);
                                    if (!r.rooms.contains(v)) r.rooms.add(v);
                                }
                                roomsChanged.run();
                                Nav.chipEditor(flow, r.rooms, Theme.ACCENT2, "아직 없어", roomsChanged);
                            }
                        });
            }
        }));
        col.addView(rooms.card);

        // 인사말
        final Nav.Fold greet = fold(a, F_GREET, "입·퇴장 인사", greetSummary(r));
        greet.body.addView(Ui.switchRow(a, "입장 인사", null, r.welcomeOn, new Ui.OnToggle() {
            @Override public void on(boolean v) {
                r.welcomeOn = v;
                save(a, s);
                greet.summary(greetSummary(r));
            }
        }));
        greet.body.addView(Nav.actionRow(a, "입장 메시지", msgOr(r.welcomeMsg), "수정", new Runnable() {
            @Override public void run() {
                Nav.editText(a, "입장 메시지", "예) {이름}님 환영해요", r.welcomeMsg, true,
                        "{이름} 은 들어온 사람 이름으로 바뀐다.", new Nav.OnText() {
                            @Override public String text(String value) {
                                if (value == null || value.trim().length() == 0) {
                                    return "메시지를 적어줘 (비우면 인사를 못 보내)";
                                }
                                r.welcomeMsg = value;
                                save(a, s);
                                refresh();
                                return null;
                            }
                        });
            }
        }));
        greet.body.addView(Ui.divider(a));
        greet.body.addView(Ui.switchRow(a, "퇴장 인사", null, r.leaveOn, new Ui.OnToggle() {
            @Override public void on(boolean v) {
                r.leaveOn = v;
                save(a, s);
                greet.summary(greetSummary(r));
            }
        }));
        greet.body.addView(Nav.actionRow(a, "퇴장 메시지", msgOr(r.leaveMsg), "수정", new Runnable() {
            @Override public void run() {
                Nav.editText(a, "퇴장 메시지", "예) {이름}님 안녕히 가세요", r.leaveMsg, true,
                        "{이름} 은 나간 사람 이름으로 바뀐다.", new Nav.OnText() {
                            @Override public String text(String value) {
                                if (value == null || value.trim().length() == 0) {
                                    return "메시지를 적어줘 (비우면 인사를 못 보내)";
                                }
                                r.leaveMsg = value;
                                save(a, s);
                                refresh();
                                return null;
                            }
                        });
            }
        }));
        col.addView(greet.card);

        // 감지 규칙
        final Nav.Fold det = fold(a, F_DETECT, "감지 규칙", detectSummary(r));
        det.body.addView(Ui.label(a, "금지어"));
        final Nav.Flow bans = Nav.flow(a);
        det.body.addView(bans);
        final Runnable bansChanged = new Runnable() {
            @Override public void run() {
                save(a, s);
                det.summary(detectSummary(r));
            }
        };
        Nav.chipEditor(bans, r.banWords, Theme.RED, "아직 없어", bansChanged);
        det.body.addView(Nav.wideBtn(a, "금지어 추가", false, new Runnable() {
            @Override public void run() {
                Nav.editText(a, "금지어 추가", "쉼표로 여러 개", "", false,
                        "그 단어가 들어간 메시지가 오면 경고 메시지를 보낸다.", new Nav.OnText() {
                            @Override public String text(String value) {
                                List<String> got = split(value);
                                if (got.isEmpty()) return "추가할 단어를 적어줘";
                                for (int i = 0; i < got.size(); i++) {
                                    if (!r.banWords.contains(got.get(i))) r.banWords.add(got.get(i));
                                }
                                bansChanged.run();
                                Nav.chipEditor(bans, r.banWords, Theme.RED, "아직 없어", bansChanged);
                                return null;
                            }
                        });
            }
        }));
        det.body.addView(Nav.actionRow(a, "금지어 경고문", msgOr(r.warnMsg), "수정", new Runnable() {
            @Override public void run() {
                editMsg(a, s, "금지어 경고문", r.warnMsg, "{이름} {단어} 를 쓸 수 있어.", new Nav.OnText() {
                    @Override public String text(String value) {
                        r.warnMsg = value;
                        save(a, s);
                        refresh();
                        return null;
                    }
                });
            }
        }));

        det.body.addView(Ui.divider(a));
        det.body.addView(Nav.actionRow(a, "도배 기준",
                r.floodSecs + "초 안에 " + r.floodCount + "개 넘으면 경고", "수정", new Runnable() {
                    @Override public void run() {
                        final Nav.NumField secs = new Nav.NumField("몇 초 안에", "10", 1, 600, r.floodSecs);
                        final Nav.NumField cnt = new Nav.NumField("몇 개를 넘으면", "5", 2, 100, r.floodCount);
                        Nav.editNums(a, "도배 기준", "한 사람이 짧은 시간에 너무 많이 쓰면 경고한다.",
                                new Nav.NumField[] { secs, cnt }, new Nav.OnNums() {
                                    @Override public String ok() {
                                        r.floodSecs = secs.value;
                                        r.floodCount = cnt.value;
                                        save(a, s);
                                        refresh();
                                        return null;
                                    }
                                });
                    }
                }));
        det.body.addView(Nav.actionRow(a, "도배 경고문", msgOr(r.floodMsg), "수정", new Runnable() {
            @Override public void run() {
                editMsg(a, s, "도배 경고문", r.floodMsg, "{이름} 을 쓸 수 있어.", new Nav.OnText() {
                    @Override public String text(String value) {
                        r.floodMsg = value;
                        save(a, s);
                        refresh();
                        return null;
                    }
                });
            }
        }));

        det.body.addView(Ui.divider(a));
        det.body.addView(Ui.switchRow(a, "링크·초대 차단 경고", "링크가 올라오면 경고 메시지를 보낸다",
                r.blockLinks, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        r.blockLinks = v;
                        save(a, s);
                        det.summary(detectSummary(r));
                    }
                }));
        det.body.addView(Nav.actionRow(a, "링크 경고문", msgOr(r.linkMsg), "수정", new Runnable() {
            @Override public void run() {
                editMsg(a, s, "링크 경고문", r.linkMsg, "{이름} 을 쓸 수 있어.", new Nav.OnText() {
                    @Override public String text(String value) {
                        r.linkMsg = value;
                        save(a, s);
                        refresh();
                        return null;
                    }
                });
            }
        }));
        col.addView(det.card);

        // 명령 · 관리
        final Nav.Fold cmd = fold(a, F_CMD, "명령 · 관리", cmdSummary(r));
        cmd.body.addView(Nav.actionRow(a, "공지문", msgOr(r.notice), "수정", new Runnable() {
            @Override public void run() {
                editMsg(a, s, "공지문", r.notice,
                        "「" + r.cmdPrefix + "공지」 라고 쓰면 이 내용을 보낸다.", new Nav.OnText() {
                            @Override public String text(String value) {
                                r.notice = value;
                                save(a, s);
                                refresh();
                                return null;
                            }
                        });
            }
        }));
        cmd.body.addView(Nav.actionRow(a, "명령 접두사", r.cmdPrefix, "수정", new Runnable() {
            @Override public void run() { editPrefix(a, s, true); }
        }));
        cmd.body.addView(Ui.label(a, "관리자 이름"));
        final Nav.Flow admins = Nav.flow(a);
        cmd.body.addView(admins);
        final Runnable adminsChanged = new Runnable() {
            @Override public void run() {
                save(a, s);
                cmd.summary(cmdSummary(r));
            }
        };
        Nav.chipEditor(admins, r.adminNames, Theme.VIOLET, "아직 없어", adminsChanged);
        cmd.body.addView(Nav.wideBtn(a, "관리자 추가", false, new Runnable() {
            @Override public void run() {
                Nav.editText(a, "관리자 추가", "카톡에 보이는 이름 (쉼표로 여러 명)", "", false,
                        "관리자만 쓸 수 있는 명령이 있고, 경고가 뜨면 이 사람들을 호출한다.",
                        new Nav.OnText() {
                            @Override public String text(String value) {
                                List<String> got = split(value);
                                if (got.isEmpty()) return "이름을 적어줘";
                                for (int i = 0; i < got.size(); i++) {
                                    if (!r.adminNames.contains(got.get(i))) r.adminNames.add(got.get(i));
                                }
                                adminsChanged.run();
                                Nav.chipEditor(admins, r.adminNames, Theme.VIOLET, "아직 없어", adminsChanged);
                                return null;
                            }
                        });
            }
        }));
        cmd.body.addView(Nav.actionRow(a, "하루 최대 발송", r.dailyLimit + "건", "수정", new Runnable() {
            @Override public void run() {
                final Nav.NumField n = new Nav.NumField("하루 최대 발송 수", "300", 1, 5000, r.dailyLimit);
                Nav.editNums(a, "하루 최대 발송", "봇이 하루에 보낼 수 있는 메시지 수. 자정에 초기화된다.",
                        new Nav.NumField[] { n }, new Nav.OnNums() {
                            @Override public String ok() {
                                r.dailyLimit = n.value;
                                save(a, s);
                                refresh();
                                return null;
                            }
                        });
            }
        }));
        col.addView(cmd.card);

        col.addView(Nav.note(a, limitNote(), Theme.AMBER, null, null));
    }

    /** RoomBot 엔진이 알려주는 한계 안내. 아직 없으면 기본 문장을 쓴다. */
    private static String limitNote() {
        try {
            String n = RoomBot.LIMIT_NOTE;
            if (n != null && n.trim().length() > 0) return n;
        } catch (Throwable t) {
            // 엔진이 없어도 화면은 떠야 한다
        }
        return "카톡은 외부 앱이 강제퇴장을 못 해. 그래서 이 봇은 경고 메시지를 보내고 관리자를 호출하는 것까지만 한다.";
    }

    private static String roomsSummary(List<String> rooms) {
        if (rooms == null || rooms.isEmpty()) return "아직 없어 — 최소 1개는 필요해";
        return rooms.size() + "개 · " + Nav.preview(Nav.join(rooms, ""), 36);
    }

    private static String greetSummary(Settings.RoomBotCfg r) {
        if (!r.welcomeOn && !r.leaveOn) return "둘 다 꺼짐";
        if (r.welcomeOn && r.leaveOn) return "입장 · 퇴장 둘 다 켜짐";
        return r.welcomeOn ? "입장만 켜짐" : "퇴장만 켜짐";
    }

    private static String detectSummary(Settings.RoomBotCfg r) {
        StringBuilder sb = new StringBuilder();
        sb.append("금지어 ").append(r.banWords.size()).append("개");
        sb.append(" · 도배 ").append(r.floodSecs).append("초/").append(r.floodCount).append("개");
        if (r.blockLinks) sb.append(" · 링크 차단");
        return sb.toString();
    }

    private static String cmdSummary(Settings.RoomBotCfg r) {
        return "접두사 " + r.cmdPrefix + " · 관리자 " + r.adminNames.size() + "명 · 하루 " + r.dailyLimit + "건";
    }

    // ── 미니게임봇 ──────────────────────────────────────────────────────────

    private static void fillGame(final MainActivity a, LinearLayout col, final Settings s) {
        final Settings.MiniGameCfg g = s.minigame;

        LinearLayout onCard = Ui.card(a);
        onCard.addView(Ui.switchRow(a, "미니게임봇 사용", "명령어로 게임을 돌리고 방별 점수를 센다",
                g.enabled, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        g.enabled = v;
                        save(a, s);
                        Log.add(a, v ? "미니게임봇을 켰어" : "미니게임봇을 껐어");
                    }
                }));
        col.addView(onCard);

        col.addView(Ui.sectionHeader(a, "미니게임봇", "설정"));

        // 대상 방
        final Nav.Fold rooms = fold(a, G_ROOMS, "대상 방", roomsSummary(g.rooms));
        rooms.body.addView(Ui.sub(a, "이 방들에서만 명령을 받는다. 칩을 누르면 지워진다."));
        final Nav.Flow flow = Nav.flow(a);
        rooms.body.addView(flow);
        final Runnable roomsChanged = new Runnable() {
            @Override public void run() {
                save(a, s);
                rooms.summary(roomsSummary(g.rooms));
            }
        };
        Nav.chipEditor(flow, g.rooms, Theme.VIOLET, "아직 없어", roomsChanged);
        rooms.body.addView(Nav.wideBtn(a, "방 추가", false, new Runnable() {
            @Override public void run() {
                Nav.pickRooms(a, "게임할 방 추가", KakaoListener.knownRooms(a), g.rooms,
                        new Nav.OnRooms() {
                            @Override public void rooms(List<String> picked) {
                                for (int i = 0; i < picked.size(); i++) {
                                    String v = picked.get(i);
                                    if (!g.rooms.contains(v)) g.rooms.add(v);
                                }
                                roomsChanged.run();
                                Nav.chipEditor(flow, g.rooms, Theme.VIOLET, "아직 없어", roomsChanged);
                            }
                        });
            }
        }));
        col.addView(rooms.card);

        // 게임 켜기/끄기
        final Nav.Fold games = fold(a, G_GAMES, "게임 선택", gamesSummary(g));
        for (int i = 0; i < Settings.GAMES.length; i++) {
            final String id = Settings.GAMES[i];
            games.body.addView(Ui.switchRow(a, Settings.gameLabel(id),
                    g.cmdPrefix + Settings.gameCmd(id), g.gameOn(id), new Ui.OnToggle() {
                        @Override public void on(boolean v) {
                            g.setGame(id, v);
                            save(a, s);
                            games.summary(gamesSummary(g));
                        }
                    }));
        }
        col.addView(games.card);

        // 동작 설정
        final Nav.Fold tune = fold(a, G_TUNE, "동작 설정", tuneSummary(g));
        tune.body.addView(Nav.actionRow(a, "명령 접두사", g.cmdPrefix, "수정", new Runnable() {
            @Override public void run() { editPrefix(a, s, false); }
        }));
        tune.body.addView(Nav.actionRow(a, "응답 쿨다운", Nav.dur(g.cooldownMs), "수정", new Runnable() {
            @Override public void run() {
                final Nav.NumField n = new Nav.NumField("쿨다운 (초)", "3", 0, 600,
                        (int) (g.cooldownMs / 1000L));
                Nav.editNums(a, "응답 쿨다운", "같은 방에서 이 시간 안에는 또 응답하지 않는다.",
                        new Nav.NumField[] { n }, new Nav.OnNums() {
                            @Override public String ok() {
                                g.cooldownMs = n.value * 1000L;
                                save(a, s);
                                refresh();
                                return null;
                            }
                        });
            }
        }));
        tune.body.addView(Nav.actionRow(a, "하루 최대 발송", g.dailyLimit + "건", "수정", new Runnable() {
            @Override public void run() {
                final Nav.NumField n = new Nav.NumField("하루 최대 발송 수", "300", 1, 5000, g.dailyLimit);
                Nav.editNums(a, "하루 최대 발송", "봇이 하루에 보낼 수 있는 메시지 수. 자정에 초기화된다.",
                        new Nav.NumField[] { n }, new Nav.OnNums() {
                            @Override public String ok() {
                                g.dailyLimit = n.value;
                                save(a, s);
                                refresh();
                                return null;
                            }
                        });
            }
        }));
        col.addView(tune.card);

        // 명령어 도움말 표
        final Nav.Fold help = fold(a, G_HELP, "명령어", "방에 그대로 쳐보면 된다");
        help.body.addView(cmdTable(a, g));
        col.addView(help.card);
    }

    private static String gamesSummary(Settings.MiniGameCfg g) {
        StringBuilder sb = new StringBuilder();
        int n = 0;
        for (int i = 0; i < Settings.GAMES.length; i++) {
            if (!g.gameOn(Settings.GAMES[i])) continue;
            if (n > 0) sb.append(" · ");
            sb.append(Settings.gameLabel(Settings.GAMES[i]));
            n++;
        }
        if (n == 0) return "전부 꺼짐";
        return n + "종 켜짐 · " + sb;
    }

    private static String tuneSummary(Settings.MiniGameCfg g) {
        return "접두사 " + g.cmdPrefix + " · 쿨다운 " + Nav.dur(g.cooldownMs)
                + " · 하루 " + g.dailyLimit + "건";
    }

    /** 명령어 표 (왼쪽 명령 · 오른쪽 설명) */
    private static LinearLayout cmdTable(MainActivity a, Settings.MiniGameCfg g) {
        LinearLayout t = Nav.col(a);
        String p = g.cmdPrefix;
        addCmd(a, t, p + "끝말잇기", "단어를 이어간다. 두음법칙·중복을 걸러준다", g.word);
        addCmd(a, t, p + "숫자야구", "3자리 숫자 맞히기 (스트라이크/볼)", g.baseball);
        addCmd(a, t, p + "주사위", "주사위를 굴린다", g.dice);
        addCmd(a, t, p + "가위바위보", "봇과 한 판", g.rps);
        addCmd(a, t, p + "퀴즈", "내장 문제에서 하나 낸다", g.quiz);
        addCmd(a, t, p + "랭킹", "이 방의 점수 순위", true);
        addCmd(a, t, p + "도움", "명령어 목록을 방에 보낸다", true);
        return t;
    }

    private static void addCmd(MainActivity a, LinearLayout into, String cmd, String desc, boolean on) {
        LinearLayout r = Ui.row(a);
        int pv = Theme.dp(a, 7);
        r.setPadding(0, pv, 0, pv);

        TextView c = new TextView(a);
        c.setText(cmd);
        c.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f);
        c.setTextColor(on ? Theme.ACCENT : Theme.DIM);
        c.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        c.setIncludeFontPadding(false);
        c.setSingleLine(true);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(Theme.dp(a, 92), WRAP);
        c.setLayoutParams(cp);
        r.addView(c);

        TextView d = Ui.sub(a, on ? desc : (desc + " (꺼짐)"));
        d.setMaxLines(2);
        d.setEllipsize(TextUtils.TruncateAt.END);
        d.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        r.addView(d);
        into.addView(r);
    }

    // ── 공통 ────────────────────────────────────────────────────────────────

    private static void save(MainActivity a, Settings s) {
        try {
            s.save(a);
        } catch (Throwable t) {
            Log.add(a, "설정 저장에 실패했어: " + t);
            Ui.toast(a, "설정을 저장하지 못했어");
        }
    }

    private static Nav.Fold fold(MainActivity a, final int bit, String titleTxt, String summary) {
        Nav.Fold f = Nav.fold(a, titleTxt, summary, (openBits & bit) != 0);
        f.onToggle(new Ui.OnToggle() {
            @Override public void on(boolean v) {
                if (v) openBits |= bit;
                else openBits &= ~bit;
            }
        });
        return f;
    }

    /** 비어도 되는 메시지 편집 (경고문·공지문처럼 비우면 "안 보냄") */
    private static void editMsg(final MainActivity a, final Settings s, String titleTxt,
                                String value, String help, final Nav.OnText cb) {
        Nav.editText(a, titleTxt, "비우면 안 보낸다", value, true, help, new Nav.OnText() {
            @Override public String text(String v) {
                if (v != null && v.length() > 2000) return "2000자 이하로 줄여줘";
                return (cb == null) ? null : cb.text(v);
            }
        });
    }

    /** 명령 접두사 (한 글자 권장, 공백 금지) */
    private static void editPrefix(final MainActivity a, final Settings s, final boolean forRoomBot) {
        String cur = forRoomBot ? s.roombot.cmdPrefix : s.minigame.cmdPrefix;
        Nav.editText(a, "명령 접두사", "!", cur, false,
                "이 글자로 시작하는 메시지만 명령으로 본다. 한 글자를 추천해 (예: ! / . / ~)",
                new Nav.OnText() {
                    @Override public String text(String value) {
                        String v = (value == null) ? "" : value.trim();
                        if (v.length() == 0) return "접두사를 적어줘";
                        if (v.length() > 3) return "3글자 이하로 해줘";
                        if (v.contains(" ")) return "공백은 못 써";
                        if (forRoomBot) s.roombot.cmdPrefix = v;
                        else s.minigame.cmdPrefix = v;
                        save(a, s);
                        refresh();
                        return null;
                    }
                });
    }

    private static String msgOr(String v) {
        if (v == null || v.trim().length() == 0) return "비어있어 — 안 보낸다";
        return Nav.preview(v, 40);
    }

    private static List<String> split(String s) {
        ArrayList<String> out = new ArrayList<String>();
        if (s == null) return out;
        String[] parts = s.split(",");
        for (int i = 0; i < parts.length; i++) {
            String v = (parts[i] == null) ? "" : parts[i].trim();
            if (v.length() == 0) continue;
            if (!out.contains(v)) out.add(v);
        }
        return out;
    }
}
