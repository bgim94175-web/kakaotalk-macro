package com.buseong.kakaoauto;

import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

/**
 * 봇 설정 상세 — 전용 서브화면 모음 (UI_V3 1·7장).
 *
 * 봇 탭은 「대화방 관리봇 · 지금 값 · ›」 두 행만 보여주고, 행을 누르면 여기 화면이
 * {@link Nav#push} 로 올라온다. 예전 세그먼트 + 아코디언 7개를 걷어낸 자리다 —
 * 접혀 있으면 안에 뭐가 있는지 모르고, 펼치면 옆 카드와 섞여서 경계가 사라진다.
 *
 * 화면 규칙은 매크로 쪽({@link MacroDetail})과 같다: 목록형 행 + 값은 다이얼로그에서 고치고,
 * 항목이 6개를 넘으면 한 단계 더 들어가는 서브화면으로 나눈다. 값은 고치는 즉시 저장된다.
 */
public final class BotDetail {
    private BotDetail() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    /** 금지어·관리자 명단의 최대 개수 (칩이 화면을 덮는 걸 막는다) */
    private static final int LIST_MAX = 60;

    // ── 화면 틀 ─────────────────────────────────────────────────────────────
    //  서브화면은 중첩된다 (관리봇 → 감지 규칙 → 금지어). 값이 바뀌면 지금 열려 있는
    //  화면 전부를 제자리에서 다시 그려야 하니까 화면마다 "다시 채우는 방법" 을 들고 있는다.

    /** 화면 본문을 채우는 방법 */
    private interface Filler { void fill(MainActivity a, LinearLayout col); }

    private static final class Pane {
        final WeakReference<LinearLayout> body;
        final Filler fill;

        Pane(LinearLayout body, Filler fill) {
            this.body = new WeakReference<LinearLayout>(body);
            this.fill = fill;
        }
    }

    private static final ArrayList<Pane> PANES = new ArrayList<Pane>();
    private static WeakReference<MainActivity> ACT;

    /** 서브화면 한 장을 만든다 */
    private static View screen(MainActivity a, Filler f) {
        ACT = new WeakReference<MainActivity>(a);
        prune();
        LinearLayout col = Ui.screen(a);
        PANES.add(new Pane(col, f));
        try {
            f.fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "봇 설정 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 지금 열려 있는 봇 상세 화면을 모두 제자리에서 다시 그린다 */
    public static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        if (a == null || a.isFinishing()) { PANES.clear(); return; }
        for (int i = PANES.size() - 1; i >= 0; i--) {
            Pane p = PANES.get(i);
            LinearLayout col = p.body.get();
            if (col == null || !col.isAttachedToWindow()) { PANES.remove(i); continue; }
            try {
                col.removeAllViews();
                p.fill.fill(a, col);
            } catch (Throwable t) {
                Log.add(a, "봇 설정 화면 갱신에 실패했습니다: " + t);
            }
        }
    }

    /** 화면에서 떼어진 판을 버린다 (뒤로 나간 화면이 계속 쌓이지 않게) */
    private static void prune() {
        for (int i = PANES.size() - 1; i >= 0; i--) {
            LinearLayout col = PANES.get(i).body.get();
            if (col == null || !col.isAttachedToWindow()) PANES.remove(i);
        }
    }

    /** 저장만 한다 (토글처럼 화면을 다시 그리면 안 되는 자리). 실패하면 false. */
    private static boolean store(MainActivity a, Settings s) {
        if (!Settings.canSave(a)) {
            Log.add(a, "설정키가 없어 설정을 저장하지 못했습니다.");
            Ui.toast(a, "설정을 저장하지 못했습니다. 내정보 탭에서 라이선스를 인증하십시오.");
            return false;
        }
        try {
            s.save(a);
        } catch (Throwable t) {
            Log.add(a, "설정 저장에 실패했습니다: " + t);
            Ui.toast(a, "설정을 저장하지 못했습니다.");
            return false;
        }
        return true;
    }

    /** 저장 + 열려 있는 화면 전부 갱신 (봇 탭 요약까지) */
    private static void save(MainActivity a, Settings s) {
        if (!store(a, s)) return;
        refresh();
        ScreenBot.refresh();
    }

    // ── 1. 대화방 관리봇 ────────────────────────────────────────────────────

    public static View roomBot(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                if (!License.allowed(a, Features.ROOMBOT)) {
                    locked(a, col, Features.ROOMBOT, ScreenBot.NAME_ROOMBOT);
                    return;
                }
                notSavable(a, col);

                final Settings s = Settings.load(a);
                final Settings.RoomBotCfg r = s.roombot;

                col.addView(Nav.gap(a, 6));
                col.addView(onCard(a, s, ScreenBot.NAME_ROOMBOT,
                        "등록한 대화방의 입·퇴장, 금지어, 도배를 감시합니다", true));

                // ── 대상 ──
                col.addView(Ui.sectionHeader(a, null, "대상"));
                LinearLayout g1 = Ui.group(a);
                List<RoomRef> rooms = r.roomRefs();
                g1.addView(Ui.navRow(a, "대상 대화방", roomValue(a, rooms),
                        rooms.isEmpty() ? Theme.AMBER : Theme.TEXT, new Runnable() {
                            @Override public void run() {
                                Nav.push(a, "대상 대화방", roomSelect(a, roomBotRooms(a),
                                        "선택한 대화방에서만 동작합니다. 선택이 없으면 동작하지 않습니다."));
                            }
                        }));
                col.addView(g1);

                // ── 설정 ──
                col.addView(Ui.sectionHeader(a, null, "설정"));
                LinearLayout g2 = Ui.group(a);
                g2.addView(Ui.navRow(a, "입·퇴장 인사", greetValue(r),
                        (r.welcomeOn || r.leaveOn) ? Theme.TEXT : Theme.DIM, new Runnable() {
                            @Override public void run() { Nav.push(a, "입·퇴장 인사", greet(a)); }
                        }));
                g2.addView(Ui.navRow(a, "감지 규칙", detectValue(r), Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "감지 규칙", detect(a)); }
                }));
                g2.addView(Ui.navRow(a, "명령 · 관리", cmdValue(r), Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "명령 · 관리", command(a)); }
                }));
                col.addView(g2);

                // ── 기록 ──
                col.addView(Ui.sectionHeader(a, null, "기록"));
                LinearLayout g3 = Ui.group(a);
                final List<String> warned = topWarned(a);
                g3.addView(Ui.navRow(a, "경고 누적",
                        warned.isEmpty() ? "없음" : (warned.size() + "명"),
                        warned.isEmpty() ? Theme.DIM : Theme.TEXT, new Runnable() {
                            @Override public void run() { Nav.push(a, "경고 누적", warns(a)); }
                        }));
                col.addView(g3);

                col.addView(Nav.note(a, RoomBot.LIMIT_NOTE, Theme.AMBER, null, null));
            }
        });
    }

    /** 입·퇴장 인사 */
    private static View greet(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final Settings.RoomBotCfg r = s.roombot;

                col.addView(Ui.sectionHeader(a, null, "입장"));
                LinearLayout g1 = Ui.group(a);
                g1.addView(Ui.navRowSwitch(a, "입장 인사", null, r.welcomeOn, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        r.welcomeOn = v;
                        store(a, s);
                        ScreenBot.refresh();
                    }
                }));
                g1.addView(Ui.navRow(a, "입장 메시지", msgValue(r.welcomeMsg),
                        msgColor(r.welcomeMsg, r.welcomeOn), new Runnable() {
                            @Override public void run() {
                                Nav.editText(a, "입장 메시지", "예) {이름}님 환영합니다",
                                        r.welcomeMsg, true,
                                        "{이름} 은 입장한 사람의 이름으로 치환됩니다.", new Nav.OnText() {
                                            @Override public String text(String value) {
                                                if (value == null || value.trim().length() == 0) {
                                                    return "입장 메시지를 입력하십시오.";
                                                }
                                                if (value.length() > 2000) return "2000자 이하로 입력하십시오.";
                                                r.welcomeMsg = value;
                                                save(a, s);
                                                return null;
                                            }
                                        });
                            }
                        }));
                col.addView(g1);

                col.addView(Ui.sectionHeader(a, null, "퇴장"));
                LinearLayout g2 = Ui.group(a);
                g2.addView(Ui.navRowSwitch(a, "퇴장 인사", null, r.leaveOn, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        r.leaveOn = v;
                        store(a, s);
                        ScreenBot.refresh();
                    }
                }));
                g2.addView(Ui.navRow(a, "퇴장 메시지", msgValue(r.leaveMsg),
                        msgColor(r.leaveMsg, r.leaveOn), new Runnable() {
                            @Override public void run() {
                                Nav.editText(a, "퇴장 메시지", "예) {이름}님 안녕히 가십시오",
                                        r.leaveMsg, true,
                                        "{이름} 은 퇴장한 사람의 이름으로 치환됩니다.", new Nav.OnText() {
                                            @Override public String text(String value) {
                                                if (value == null || value.trim().length() == 0) {
                                                    return "퇴장 메시지를 입력하십시오.";
                                                }
                                                if (value.length() > 2000) return "2000자 이하로 입력하십시오.";
                                                r.leaveMsg = value;
                                                save(a, s);
                                                return null;
                                            }
                                        });
                            }
                        }));
                col.addView(g2);

                col.addView(Nav.note(a, "입·퇴장 알림이 대화방 알림으로 수신될 때만 감지됩니다.",
                        Theme.ACCENT2, null, null));
            }
        });
    }

    /** 감지 규칙 — 금지어 · 도배 · 링크 */
    private static View detect(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final Settings.RoomBotCfg r = s.roombot;

                // ── 금지어 ──
                col.addView(Ui.sectionHeader(a, null, "금지어"));
                LinearLayout g1 = Ui.group(a);
                g1.addView(Ui.navRow(a, "금지어 목록",
                        r.banWords.isEmpty() ? "없음" : (r.banWords.size() + "개"),
                        r.banWords.isEmpty() ? Theme.DIM : Theme.TEXT, new Runnable() {
                            @Override public void run() {
                                Nav.push(a, "금지어", words(a, WORDS_BAN));
                            }
                        }));
                g1.addView(Ui.navRow(a, "경고문", msgValue(r.warnMsg),
                        msgColor(r.warnMsg, !r.banWords.isEmpty()), new Runnable() {
                            @Override public void run() {
                                editOptional(a, s, "금지어 경고문", r.warnMsg,
                                        "{이름} {단어} 를 사용할 수 있습니다. 비워 두면 발송하지 않습니다.",
                                        new Nav.OnText() {
                                            @Override public String text(String value) {
                                                r.warnMsg = value;
                                                save(a, s);
                                                return null;
                                            }
                                        });
                            }
                        }));
                col.addView(g1);

                // ── 도배 ──
                col.addView(Ui.sectionHeader(a, null, "도배"));
                LinearLayout g2 = Ui.group(a);
                g2.addView(Ui.navRow(a, "기준",
                        r.floodSecs + "초 / " + r.floodCount + "개", Theme.TEXT, new Runnable() {
                            @Override public void run() {
                                final Nav.NumField secs =
                                        new Nav.NumField("기준 시간 (초)", "10", 1, 600, r.floodSecs);
                                final Nav.NumField cnt =
                                        new Nav.NumField("허용 개수", "5", 2, 100, r.floodCount);
                                Nav.editNums(a, "도배 기준",
                                        "한 사람이 기준 시간 안에 허용 개수를 초과하여 발송하면 경고합니다.",
                                        new Nav.NumField[] { secs, cnt }, new Nav.OnNums() {
                                            @Override public String ok() {
                                                r.floodSecs = secs.value;
                                                r.floodCount = cnt.value;
                                                save(a, s);
                                                Log.add(a, "도배 기준을 " + secs.value + "초 / "
                                                        + cnt.value + "개로 설정했습니다.");
                                                return null;
                                            }
                                        });
                            }
                        }));
                g2.addView(Ui.navRow(a, "경고문", msgValue(r.floodMsg),
                        msgColor(r.floodMsg, true), new Runnable() {
                            @Override public void run() {
                                editOptional(a, s, "도배 경고문", r.floodMsg,
                                        "{이름} 을 사용할 수 있습니다. 비워 두면 발송하지 않습니다.",
                                        new Nav.OnText() {
                                            @Override public String text(String value) {
                                                r.floodMsg = value;
                                                save(a, s);
                                                return null;
                                            }
                                        });
                            }
                        }));
                col.addView(g2);

                // ── 링크 ──
                col.addView(Ui.sectionHeader(a, null, "링크 · 초대"));
                LinearLayout g3 = Ui.group(a);
                g3.addView(Ui.navRowSwitch(a, "링크 차단 경고",
                        "링크가 포함된 메시지에 경고를 발송합니다", r.blockLinks, new Ui.OnToggle() {
                            @Override public void on(boolean v) {
                                r.blockLinks = v;
                                store(a, s);
                                ScreenBot.refresh();
                            }
                        }));
                g3.addView(Ui.navRow(a, "경고문", msgValue(r.linkMsg),
                        msgColor(r.linkMsg, r.blockLinks), new Runnable() {
                            @Override public void run() {
                                editOptional(a, s, "링크 경고문", r.linkMsg,
                                        "{이름} 을 사용할 수 있습니다. 비워 두면 발송하지 않습니다.",
                                        new Nav.OnText() {
                                            @Override public String text(String value) {
                                                r.linkMsg = value;
                                                save(a, s);
                                                return null;
                                            }
                                        });
                            }
                        }));
                col.addView(g3);
            }
        });
    }

    /** 명령 · 관리 */
    private static View command(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final Settings.RoomBotCfg r = s.roombot;

                col.addView(Ui.sectionHeader(a, null, "명령"));
                LinearLayout g1 = Ui.group(a);
                g1.addView(Ui.navRow(a, "명령 접두사", r.cmdPrefix, Theme.TEXT, new Runnable() {
                    @Override public void run() { editPrefix(a, s, true); }
                }));
                g1.addView(Ui.navRow(a, "공지문", msgValue(r.notice),
                        msgColor(r.notice, true), new Runnable() {
                            @Override public void run() {
                                editOptional(a, s, "공지문", r.notice,
                                        "「" + r.cmdPrefix + "공지」 입력 시 이 내용을 발송합니다."
                                                + " 비워 두면 발송하지 않습니다.",
                                        new Nav.OnText() {
                                            @Override public String text(String value) {
                                                r.notice = value;
                                                save(a, s);
                                                return null;
                                            }
                                        });
                            }
                        }));
                col.addView(g1);

                col.addView(Ui.sectionHeader(a, null, "관리"));
                LinearLayout g2 = Ui.group(a);
                g2.addView(Ui.navRow(a, "관리자 명단",
                        r.adminNames.isEmpty() ? "없음" : (r.adminNames.size() + "명"),
                        r.adminNames.isEmpty() ? Theme.DIM : Theme.TEXT, new Runnable() {
                            @Override public void run() {
                                Nav.push(a, "관리자 명단", words(a, WORDS_ADMIN));
                            }
                        }));
                g2.addView(Ui.navRow(a, "1일 최대 발송", r.dailyLimit + "회", Theme.TEXT,
                        new Runnable() {
                            @Override public void run() {
                                final Nav.NumField n = new Nav.NumField("1일 최대 발송 수", "300",
                                        1, 5000, r.dailyLimit);
                                Nav.editNums(a, "1일 최대 발송",
                                        "봇이 1일에 발송할 수 있는 메시지 수입니다. 자정에 초기화됩니다.",
                                        new Nav.NumField[] { n }, new Nav.OnNums() {
                                            @Override public String ok() {
                                                r.dailyLimit = n.value;
                                                save(a, s);
                                                Log.add(a, "대화방 관리봇 1일 최대 발송을 "
                                                        + n.value + "회로 설정했습니다.");
                                                return null;
                                            }
                                        });
                            }
                        }));
                col.addView(g2);
            }
        });
    }

    /** 경고 누적 현황 + 초기화 */
    private static View warns(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final List<String> rows = topWarned(a);

                col.addView(Ui.sectionHeader(a, null, "경고 누적 상위"));
                if (rows.isEmpty()) {
                    LinearLayout box = Ui.card(a);
                    box.addView(Ui.sub(a, "누적된 경고가 없습니다."));
                    col.addView(box);
                    return;
                }
                LinearLayout g = Ui.group(a);
                for (int i = 0; i < rows.size(); i++) {
                    g.addView(textRow(a, rows.get(i)));
                }
                col.addView(g);

                TextView clear = Nav.wideBtn(a, "경고 기록 초기화", false, new Runnable() {
                    @Override public void run() {
                        Nav.confirm(a, "경고 기록 초기화",
                                "누적된 경고 기록을 전부 삭제합니다. 대화방 설정은 유지됩니다.",
                                "초기화", new Runnable() {
                                    @Override public void run() {
                                        int n;
                                        try {
                                            n = RoomBot.clearWarns(a);
                                        } catch (Throwable t) {
                                            Log.add(a, "경고 기록 초기화에 실패했습니다: " + t);
                                            Ui.toast(a, "초기화에 실패했습니다.");
                                            return;
                                        }
                                        Log.add(a, "경고 기록 " + n + "건을 초기화했습니다.");
                                        Ui.toast(a, "경고 기록 " + n + "건을 초기화했습니다.");
                                        refresh();
                                    }
                                });
                    }
                });
                clear.setTextColor(Theme.RED);
                col.addView(clear);
            }
        });
    }

    // ── 2. 미니게임봇 ───────────────────────────────────────────────────────

    public static View miniGame(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                if (!License.allowed(a, Features.MINIGAME)) {
                    locked(a, col, Features.MINIGAME, ScreenBot.NAME_MINIGAME);
                    return;
                }
                notSavable(a, col);

                final Settings s = Settings.load(a);
                final Settings.MiniGameCfg g = s.minigame;

                col.addView(Nav.gap(a, 6));
                col.addView(onCard(a, s, ScreenBot.NAME_MINIGAME,
                        "명령어로 게임을 진행하고 대화방별 점수를 기록합니다", false));

                // ── 대상 ──
                col.addView(Ui.sectionHeader(a, null, "대상"));
                LinearLayout g1 = Ui.group(a);
                List<RoomRef> rooms = g.roomRefs();
                g1.addView(Ui.navRow(a, "대상 대화방", roomValue(a, rooms),
                        rooms.isEmpty() ? Theme.AMBER : Theme.TEXT, new Runnable() {
                            @Override public void run() {
                                Nav.push(a, "대상 대화방", roomSelect(a, miniGameRooms(a),
                                        "선택한 대화방에서만 명령을 처리합니다."
                                                + " 선택이 없으면 동작하지 않습니다."));
                            }
                        }));
                col.addView(g1);

                // ── 설정 ──
                col.addView(Ui.sectionHeader(a, null, "설정"));
                LinearLayout g2 = Ui.group(a);
                g2.addView(Ui.navRow(a, "게임 선택", gamesValue(g),
                        (onGames(g) > 0) ? Theme.TEXT : Theme.AMBER, new Runnable() {
                            @Override public void run() { Nav.push(a, "게임 선택", games(a)); }
                        }));
                g2.addView(Ui.navRow(a, "명령 접두사", g.cmdPrefix, Theme.TEXT, new Runnable() {
                    @Override public void run() { editPrefix(a, s, false); }
                }));
                g2.addView(Ui.navRow(a, "응답 쿨다운", Nav.dur(g.cooldownMs), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() {
                                final Nav.NumField n = new Nav.NumField("쿨다운 (초)", "3", 0, 600,
                                        (int) (g.cooldownMs / 1000L));
                                Nav.editNums(a, "응답 쿨다운",
                                        "동일 대화방에서 이 시간 안에는 재응답하지 않습니다.",
                                        new Nav.NumField[] { n }, new Nav.OnNums() {
                                            @Override public String ok() {
                                                g.cooldownMs = n.value * 1000L;
                                                save(a, s);
                                                Log.add(a, "미니게임봇 응답 쿨다운을 "
                                                        + n.value + "초로 설정했습니다.");
                                                return null;
                                            }
                                        });
                            }
                        }));
                g2.addView(Ui.navRow(a, "1일 최대 발송", g.dailyLimit + "회", Theme.TEXT,
                        new Runnable() {
                            @Override public void run() {
                                final Nav.NumField n = new Nav.NumField("1일 최대 발송 수", "300",
                                        1, 5000, g.dailyLimit);
                                Nav.editNums(a, "1일 최대 발송",
                                        "봇이 1일에 발송할 수 있는 메시지 수입니다. 자정에 초기화됩니다.",
                                        new Nav.NumField[] { n }, new Nav.OnNums() {
                                            @Override public String ok() {
                                                g.dailyLimit = n.value;
                                                save(a, s);
                                                Log.add(a, "미니게임봇 1일 최대 발송을 "
                                                        + n.value + "회로 설정했습니다.");
                                                return null;
                                            }
                                        });
                            }
                        }));
                col.addView(g2);

                // ── 안내 · 기록 ──
                col.addView(Ui.sectionHeader(a, null, "명령어 · 기록"));
                LinearLayout g3 = Ui.group(a);
                // 실제로 처리되는 명령 수 = 사용 중 게임 + 공통 명령 2종(랭킹·도움).
                // 게임 구성이 바뀌어도 값이 실제를 가리킨다.
                g3.addView(Ui.navRow(a, "명령어 목록", (onGames(g) + 2) + "개", Theme.SUB, new Runnable() {
                    @Override public void run() { Nav.push(a, "명령어 목록", commands(a)); }
                }));
                g3.addView(Ui.navRow(a, "점수 · 진행 상태", scoreValue(a, g), Theme.SUB,
                        new Runnable() {
                            @Override public void run() { Nav.push(a, "점수 · 진행 상태", scores(a)); }
                        }));
                col.addView(g3);
            }
        });
    }

    /** 게임 5종 on/off */
    private static View games(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final Settings.MiniGameCfg g = s.minigame;

                col.addView(Ui.sectionHeader(a, null, "사용할 게임"));
                LinearLayout grp = Ui.group(a);
                for (int i = 0; i < Settings.GAMES.length; i++) {
                    final String id = Settings.GAMES[i];
                    grp.addView(Ui.navRowSwitch(a, Settings.gameLabel(id),
                            "명령어 " + g.cmdPrefix + Settings.gameCmd(id), g.gameOn(id),
                            new Ui.OnToggle() {
                                @Override public void on(boolean v) {
                                    g.setGame(id, v);
                                    store(a, s);
                                    ScreenBot.refresh();
                                }
                            }));
                }
                col.addView(grp);

                col.addView(Nav.note(a, "미사용으로 변경한 게임의 명령어는 무시됩니다.",
                        Theme.ACCENT2, null, null));
            }
        });
    }

    /** 명령어 목록 (누르면 복사) */
    private static View commands(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings.MiniGameCfg g = Settings.load(a).minigame;
                final String p = g.cmdPrefix;

                col.addView(Ui.sectionHeader(a, null, "게임"));
                LinearLayout g1 = Ui.group(a);
                cmdRow(a, g1, p + "끝말잇기", "단어를 이어서 입력합니다. 두음법칙·중복을 검사합니다", g.word);
                cmdRow(a, g1, p + "숫자야구", "3자리 숫자 추측 (스트라이크 · 볼)", g.baseball);
                cmdRow(a, g1, p + "주사위", "주사위 1개를 굴립니다", g.dice);
                cmdRow(a, g1, p + "가위바위보", "봇과 1회 대결합니다", g.rps);
                cmdRow(a, g1, p + "퀴즈", "내장 문제 1개를 출제합니다", g.quiz);
                col.addView(g1);

                col.addView(Ui.sectionHeader(a, null, "공통"));
                LinearLayout g2 = Ui.group(a);
                cmdRow(a, g2, p + "랭킹", "해당 대화방의 점수 순위를 발송합니다", true);
                cmdRow(a, g2, p + "도움", "명령어 목록을 대화방에 발송합니다", true);
                col.addView(g2);

                col.addView(Nav.note(a, "항목을 선택하면 명령어가 클립보드에 복사됩니다.",
                        Theme.ACCENT2, null, null));
            }
        });
    }

    private static void cmdRow(final MainActivity a, LinearLayout into, final String cmd,
                               String desc, boolean on) {
        LinearLayout r = Nav.actionRow(a, cmd, on ? desc : (desc + " · 미사용"), "복사",
                new Runnable() {
                    @Override public void run() { Nav.copy(a, "명령어", cmd); }
                });
        int ph = Theme.dp(a, 16);
        r.setPadding(ph, Theme.dp(a, 10), ph, Theme.dp(a, 10));
        r.setMinimumHeight(Theme.dp(a, 56));
        into.addView(r);
    }

    /** 점수 · 진행 상태 (대상 대화방별) + 초기화 */
    private static View scores(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings.MiniGameCfg g = Settings.load(a).minigame;
                final List<RoomRef> rooms = g.roomRefs();

                if (rooms.isEmpty()) {
                    col.addView(Ui.sectionHeader(a, null, "점수"));
                    LinearLayout box = Ui.card(a);
                    box.addView(Ui.sub(a, "대상 대화방이 설정되지 않았습니다."));
                    col.addView(box);
                } else {
                    for (int i = 0; i < rooms.size(); i++) {
                        RoomRef ref = rooms.get(i);
                        col.addView(Ui.sectionHeader(a, null, ref.label(a)));
                        LinearLayout grp = Ui.group(a);
                        List<String> rank = ranking(a, ref);
                        if (rank.isEmpty()) {
                            grp.addView(textRow(a, "기록된 점수가 없습니다."));
                        } else {
                            for (int j = 0; j < rank.size(); j++) {
                                grp.addView(textRow(a, rank.get(j)));
                            }
                        }
                        String cur = currentGame(ref);
                        grp.addView(kvRow(a, "진행 중 게임", (cur.length() == 0) ? "없음" : cur,
                                (cur.length() == 0) ? Theme.DIM : Theme.TEXT));
                        col.addView(grp);
                    }
                }

                TextView clearScore = Nav.wideBtn(a, "점수 전체 초기화", false, new Runnable() {
                    @Override public void run() {
                        Nav.confirm(a, "점수 전체 초기화",
                                "모든 대화방의 점수 기록을 삭제합니다.", "초기화", new Runnable() {
                                    @Override public void run() {
                                        try {
                                            MiniGame.clearScores(a, null);
                                        } catch (Throwable t) {
                                            Log.add(a, "점수 초기화에 실패했습니다: " + t);
                                            Ui.toast(a, "초기화에 실패했습니다.");
                                            return;
                                        }
                                        Log.add(a, "미니게임 점수를 전체 초기화했습니다.");
                                        Ui.toast(a, "점수를 초기화했습니다.");
                                        refresh();
                                    }
                                });
                    }
                });
                clearScore.setTextColor(Theme.RED);
                col.addView(clearScore);

                col.addView(Nav.wideBtn(a, "진행 중 게임 종료", false, new Runnable() {
                    @Override public void run() {
                        Nav.confirm(a, "진행 중 게임 종료",
                                "모든 대화방의 진행 중인 게임을 종료합니다. 점수는 유지됩니다.",
                                "종료", new Runnable() {
                                    @Override public void run() {
                                        try {
                                            MiniGame.resetGames(a, null);
                                        } catch (Throwable t) {
                                            Log.add(a, "게임 종료 처리에 실패했습니다: " + t);
                                            Ui.toast(a, "처리에 실패했습니다.");
                                            return;
                                        }
                                        Log.add(a, "진행 중인 미니게임을 전체 종료했습니다.");
                                        Ui.toast(a, "진행 중인 게임을 종료했습니다.");
                                        refresh();
                                    }
                                });
                    }
                }));
            }
        });
    }

    // ── 공통 조각 ───────────────────────────────────────────────────────────

    /** 미구매 상태. 기능 설명 + 구매 + 구매 내역 재조회. */
    private static void locked(final MainActivity a, LinearLayout col, final String feat,
                               String name) {
        final String refresh = "구매 내역 새로고침";
        col.addView(Nav.gap(a, 6));
        col.addView(Ui.featureCard(a, name, Features.descLong(feat),
                Ui.State.OFF, 0L, new Runnable() {
                    @Override public void run() { Gate.openBuy(a, feat); }
                }, null));

        final TextView again = Ui.btn(a, refresh, false);
        again.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        again.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Nav.refreshFeature(a, again, feat, refresh);
            }
        });
        col.addView(again);
        col.addView(Ui.sub(a, "결제 후 활성화까지 시간이 소요될 수 있습니다."
                + " 활성화되지 않으면 위 버튼으로 구매 내역을 다시 조회하십시오."));
    }

    /** 설정키가 없으면 저장이 안 된다 — 화면 맨 위에서 알린다 */
    private static void notSavable(final MainActivity a, LinearLayout col) {
        if (Settings.canSave(a)) return;
        col.addView(Nav.note(a, "설정키가 없어 설정을 저장할 수 없습니다."
                + " 내정보 탭에서 라이선스를 다시 인증하십시오.", Theme.RED, "내정보 열기",
                new Runnable() { @Override public void run() { Nav.go(Nav.ACCOUNT); } }));
    }

    /** 봇 사용 토글 카드 (매크로 탭의 자동발송 카드와 같은 모양) */
    private static LinearLayout onCard(final MainActivity a, final Settings s, String name,
                                       String desc, final boolean forRoomBot) {
        LinearLayout card = Ui.card(a);
        final TextView status = Ui.sub(a, statusText(a, s, forRoomBot));
        status.setTextColor(statusColor(s, forRoomBot));

        boolean on = forRoomBot ? s.roombot.enabled : s.minigame.enabled;
        card.addView(Ui.switchRow(a, name, desc, on, new Ui.OnToggle() {
            @Override public void on(boolean v) {
                if (forRoomBot) s.roombot.enabled = v;
                else s.minigame.enabled = v;
                store(a, s);
                status.setText(statusText(a, s, forRoomBot));
                status.setTextColor(statusColor(s, forRoomBot));
                Log.add(a, (forRoomBot ? "대화방 관리봇을 " : "미니게임봇을 ")
                        + (v ? "사용으로 변경했습니다." : "미사용으로 변경했습니다."));
                ScreenBot.refresh();
            }
        }));
        card.addView(Ui.divider(a));
        card.addView(status);
        return card;
    }

    private static String statusText(MainActivity a, Settings s, boolean forRoomBot) {
        boolean on = forRoomBot ? s.roombot.enabled : s.minigame.enabled;
        if (!on) return "미사용";
        List<RoomRef> rooms = forRoomBot ? s.roombot.roomRefs() : s.minigame.roomRefs();
        if (rooms.isEmpty()) return "대상 대화방 미설정 · 동작 보류";
        int off = 0;
        for (int i = 0; i < rooms.size(); i++) {
            if (!s.accountOn(rooms.get(i).acc)) off++;
        }
        if (off >= rooms.size()) return "대상 대화방이 모두 미사용 계정 · 동작 보류";
        if (!forRoomBot && onGames(s.minigame) == 0) return "사용할 게임 미선택 · 동작 보류";
        return "사용 중 · 대상 대화방 " + rooms.size() + "개";
    }

    private static int statusColor(Settings s, boolean forRoomBot) {
        boolean on = forRoomBot ? s.roombot.enabled : s.minigame.enabled;
        if (!on) return Theme.DIM;
        List<RoomRef> rooms = forRoomBot ? s.roombot.roomRefs() : s.minigame.roomRefs();
        if (rooms.isEmpty()) return Theme.AMBER;
        if (!forRoomBot && onGames(s.minigame) == 0) return Theme.AMBER;
        return Theme.SUB;
    }

    /** 누를 수 없는 한 줄 (기록 목록용 — navRow 는 `›` 가 항상 붙어서 못 쓴다) */
    private static TextView textRow(MainActivity a, String text) {
        TextView t = Ui.body(a, text);
        t.setTextColor(Theme.SUB);
        t.setSingleLine(true);
        t.setEllipsize(android.text.TextUtils.TruncateAt.END);
        int ph = Theme.dp(a, 16);
        t.setPadding(ph, Theme.dp(a, 14), ph, Theme.dp(a, 14));
        t.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        return t;
    }

    /** 누를 수 없는 「제목 · 값」 한 줄 */
    private static LinearLayout kvRow(MainActivity a, String title, String value, int valueColor) {
        LinearLayout r = Ui.kv(a, title, value);
        int ph = Theme.dp(a, 16);
        r.setPadding(ph, Theme.dp(a, 14), ph, Theme.dp(a, 14));
        if (r.getChildCount() >= 2 && (r.getChildAt(1) instanceof TextView)) {
            ((TextView) r.getChildAt(1)).setTextColor((valueColor == 0) ? Theme.SUB : valueColor);
        }
        return r;
    }

    // ── 값 요약 ─────────────────────────────────────────────────────────────

    /** `2개` · 계정이 2개 이상이면 `2개 · 부계정 1개 포함`. 0개면 `설정 필요`. */
    private static String roomValue(MainActivity a, List<RoomRef> rooms) {
        if (rooms == null || rooms.isEmpty()) return "설정 필요";
        int sub = 0;
        for (int i = 0; i < rooms.size(); i++) {
            if (!rooms.get(i).isDefault()) sub++;
        }
        String v = rooms.size() + "개";
        if (Accounts.multi(a) && sub > 0) v = v + " · 부계정 " + sub + "개 포함";
        return v;
    }

    private static String greetValue(Settings.RoomBotCfg r) {
        if (!r.welcomeOn && !r.leaveOn) return "미사용";
        if (r.welcomeOn && r.leaveOn) return "입장 · 퇴장 사용";
        return r.welcomeOn ? "입장만 사용" : "퇴장만 사용";
    }

    /**
     * 값 칸은 행 폭의 절반까지만 쓰니까 (Ui.navRow) 가장 판단에 필요한 값만 넣는다.
     * 금지어가 없으면 실제로 도는 건 도배 감지뿐이라 그 기준을 대신 보여준다.
     */
    private static String detectValue(Settings.RoomBotCfg r) {
        StringBuilder sb = new StringBuilder();
        if (r.banWords.isEmpty()) {
            sb.append("도배 ").append(r.floodSecs).append("초/").append(r.floodCount).append("개");
        } else {
            sb.append("금지어 ").append(r.banWords.size()).append("개");
        }
        if (r.blockLinks) sb.append(" · 링크 차단");
        return sb.toString();
    }

    private static String cmdValue(Settings.RoomBotCfg r) {
        return "접두사 " + r.cmdPrefix + " · 관리자 " + r.adminNames.size() + "명";
    }

    private static int onGames(Settings.MiniGameCfg g) {
        int n = 0;
        for (int i = 0; i < Settings.GAMES.length; i++) {
            if (g.gameOn(Settings.GAMES[i])) n++;
        }
        return n;
    }

    private static String gamesValue(Settings.MiniGameCfg g) {
        int n = onGames(g);
        if (n == 0) return "전체 미사용";
        return n + "종 사용";
    }

    private static String scoreValue(MainActivity a, Settings.MiniGameCfg g) {
        List<RoomRef> rooms = g.roomRefs();
        for (int i = 0; i < rooms.size(); i++) {
            if (!ranking(a, rooms.get(i)).isEmpty()) return "기록 있음";
        }
        return "기록 없음";
    }

    /** 비어 있으면 `미설정`, 아니면 18자 미리보기 */
    private static String msgValue(String v) {
        if (v == null || v.trim().length() == 0) return "미설정";
        return Nav.preview(v, 18);
    }

    /**
     * 메시지 값 글자색. 해당 기능을 쓰는데 문구가 비어 있으면 AMBER 로 손댈 자리를 알린다.
     * 기능 자체가 꺼져 있으면 DIM.
     */
    private static int msgColor(String v, boolean used) {
        boolean empty = (v == null || v.trim().length() == 0);
        if (!used) return Theme.DIM;
        return empty ? Theme.AMBER : Theme.TEXT;
    }

    // ── 문자열 목록 (금지어 · 관리자 명단) ──────────────────────────────────

    private static final int WORDS_BAN = 0;
    private static final int WORDS_ADMIN = 1;

    /**
     * 금지어·관리자 명단처럼 짧은 문자열이 여러 건인 목록. 칩을 누르면 확인 후 삭제된다.
     * (행 하나에 이름 하나를 쓰면 40개짜리 명단에서 화면이 끝없이 길어진다)
     */
    private static View words(MainActivity a, final int which) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final Settings.RoomBotCfg r = s.roombot;
                final boolean ban = (which == WORDS_BAN);
                final List<String> items = ban ? r.banWords : r.adminNames;
                final int color = ban ? Theme.RED : Theme.VIOLET;
                final String what = ban ? "금지어" : "관리자";

                col.addView(Ui.sectionHeader(a, null, what + " " + items.size() + "개"));

                LinearLayout card = Ui.card(a);
                final Nav.Flow flow = Nav.flow(a);
                card.addView(flow);
                Nav.chipEditor(flow, items, color, "등록된 " + what + "이(가) 없습니다.",
                        new Runnable() {
                            @Override public void run() {
                                if (ban) r.banWords = items;
                                else r.adminNames = items;
                                save(a, s);
                            }
                        });
                col.addView(card);

                col.addView(Nav.wideBtn(a, what + " 추가", false, new Runnable() {
                    @Override public void run() {
                        Nav.editText(a, what + " 추가",
                                ban ? "쉼표로 여러 개 입력" : "카카오톡 표시 이름 (쉼표로 여러 명)",
                                "", false,
                                ban ? "해당 단어가 포함된 메시지에 경고를 발송합니다."
                                    : "관리자 전용 명령을 사용할 수 있으며, 경고 누적 시 호출됩니다.",
                                new Nav.OnText() {
                                    @Override public String text(String value) {
                                        List<String> got = split(value);
                                        if (got.isEmpty()) {
                                            return ban ? "추가할 단어를 입력하십시오."
                                                    : "이름을 입력하십시오.";
                                        }
                                        int added = 0;
                                        for (int i = 0; i < got.size(); i++) {
                                            if (items.size() >= LIST_MAX) break;
                                            if (items.contains(got.get(i))) continue;
                                            items.add(got.get(i));
                                            added++;
                                        }
                                        if (added == 0) {
                                            return (items.size() >= LIST_MAX)
                                                    ? ("최대 " + LIST_MAX + "개까지 등록됩니다.")
                                                    : "이미 등록된 항목입니다.";
                                        }
                                        if (ban) r.banWords = items;
                                        else r.adminNames = items;
                                        save(a, s);
                                        Log.add(a, what + " " + added + "개를 추가했습니다.");
                                        return null;
                                    }
                                });
                    }
                }));

                col.addView(Nav.note(a, "항목을 선택하면 삭제 확인 후 즉시 저장됩니다."
                        + " 최대 " + LIST_MAX + "개까지 등록됩니다.", Theme.ACCENT2, null, null));
            }
        });
    }

    // ── 대화방 다중 선택 (봇 전용) ──────────────────────────────────────────
    //  매크로의 대상 대화방은 ScreenRooms 가 담당한다. 봇은 "이 봇이 도는 대화방" 이라
    //  삭제·초기화 없이 선택만 한다 (감지 목록 정리는 매크로 쪽 화면 한 곳에서만 한다).

    /** 어떤 설정의 대화방 목록인지 (읽고 쓰는 방법만 넘긴다) */
    private interface RefList {
        List<RoomRef> get();
        void set(List<RoomRef> list);
    }

    private static RefList roomBotRooms(final MainActivity a) {
        return new RefList() {
            @Override public List<RoomRef> get() { return Settings.load(a).roombot.roomRefs(); }

            @Override public void set(List<RoomRef> list) {
                Settings s = Settings.load(a);
                s.roombot.setRoomRefs(list);
                save(a, s);
            }
        };
    }

    private static RefList miniGameRooms(final MainActivity a) {
        return new RefList() {
            @Override public List<RoomRef> get() { return Settings.load(a).minigame.roomRefs(); }

            @Override public void set(List<RoomRef> list) {
                Settings s = Settings.load(a);
                s.minigame.setRoomRefs(list);
                save(a, s);
            }
        };
    }

    private static View roomSelect(MainActivity a, final RefList rl, final String help) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final List<RoomRef> picked = rl.get();
                final List<KakaoListener.RoomInfo> known = knownRooms(a);

                if (help != null && help.length() > 0) {
                    col.addView(Nav.note(a, help, Theme.ACCENT2, null, null));
                    col.addView(Nav.gap(a, 6));
                }

                if (known.isEmpty() && picked.isEmpty()) {
                    col.addView(Ui.sectionHeader(a, null, "감지된 대화방"));
                    LinearLayout box = Ui.card(a);
                    box.addView(Ui.sub(a, "감지된 대화방이 없습니다."
                            + " 카카오톡 메시지를 1회 수신하면 자동으로 등록됩니다."));
                    col.addView(box);
                } else if (!Accounts.multi(a)) {
                    col.addView(Ui.sectionHeader(a, null,
                            "감지된 대화방 · 선택 " + picked.size() + "개"));
                    col.addView(rows(a, rl, known));
                } else {
                    // 계정이 2개 이상일 때만 계정 머리글을 붙인다 (UI_V3 6장)
                    ArrayList<String> accs = new ArrayList<String>();
                    for (int i = 0; i < known.size(); i++) {
                        String k = known.get(i).ref.acc;
                        if (!accs.contains(k)) accs.add(k);
                    }
                    for (int i = 0; i < accs.size(); i++) {
                        String k = accs.get(i);
                        ArrayList<KakaoListener.RoomInfo> mine =
                                new ArrayList<KakaoListener.RoomInfo>();
                        for (int j = 0; j < known.size(); j++) {
                            if (known.get(j).ref.acc.equals(k)) mine.add(known.get(j));
                        }
                        if (mine.isEmpty()) continue;
                        col.addView(Ui.sectionHeader(a, null, Accounts.nameOf(a, k)));
                        col.addView(rows(a, rl, mine));
                    }
                }

                // 감지 목록에 없는데 선택돼 있는 대화방 (직접 입력분 · 캐시에서 사라진 것)
                ArrayList<RoomRef> orphans = new ArrayList<RoomRef>();
                for (int i = 0; i < picked.size(); i++) {
                    RoomRef r = picked.get(i);
                    boolean found = false;
                    for (int j = 0; j < known.size(); j++) {
                        if (known.get(j).ref.equals(r)) { found = true; break; }
                    }
                    if (!found) orphans.add(r);
                }
                if (!orphans.isEmpty()) {
                    col.addView(Ui.sectionHeader(a, null, "직접 추가"));
                    LinearLayout g = Ui.group(a);
                    for (int i = 0; i < orphans.size(); i++) {
                        final RoomRef r = orphans.get(i);
                        g.addView(Ui.checkRow(a, r.label(a), "감지 기록 없음", null, true,
                                new Ui.OnToggle() {
                                    @Override public void on(boolean v) { toggle(rl, r, v); }
                                },
                                new Runnable() {
                                    @Override public void run() {
                                        toggle(rl, r, false);
                                        refresh();
                                        Nav.snack("「" + r.label(a) + "」 선택 해제", null, null);
                                    }
                                }));
                    }
                    col.addView(g);
                }

                col.addView(Nav.wideBtn(a, "직접 입력 추가", false, new Runnable() {
                    @Override public void run() { manualRoom(a, rl); }
                }));
            }
        });
    }

    /** 감지된 대화방 체크 목록 한 묶음 */
    private static LinearLayout rows(final MainActivity a, final RefList rl,
                                     List<KakaoListener.RoomInfo> list) {
        LinearLayout g = Ui.group(a);
        List<RoomRef> picked = rl.get();
        for (int i = 0; i < list.size(); i++) {
            KakaoListener.RoomInfo info = list.get(i);
            final RoomRef ref = info.ref;
            String[] badges = { info.group ? "단체" : "1:1" };
            String sub = (info.lastAt > 0) ? ScreenMacro.agoShort(info.lastAt) : "감지 시각 미확인";
            g.addView(Ui.checkRow(a, ref.name, sub, badges, has(picked, ref), new Ui.OnToggle() {
                @Override public void on(boolean v) { toggle(rl, ref, v); }
            }, null));
        }
        return g;
    }

    private static boolean has(List<RoomRef> list, RoomRef r) {
        if (list == null || r == null) return false;
        for (int i = 0; i < list.size(); i++) {
            if (r.equals(list.get(i))) return true;
        }
        return false;
    }

    /** 선택/해제 후 즉시 저장 */
    private static void toggle(RefList rl, RoomRef r, boolean on) {
        if (rl == null || r == null || !r.valid()) return;
        List<RoomRef> list = rl.get();
        boolean had = has(list, r);
        if (on && !had) {
            list.add(r);
        } else if (!on && had) {
            for (int i = list.size() - 1; i >= 0; i--) {
                if (r.equals(list.get(i))) list.remove(i);
            }
        } else {
            return;
        }
        rl.set(list);
    }

    /** 감지되지 않은 대화방을 직접 입력한다 (계정이 여러 개면 계정도 같이 고른다) */
    private static void manualRoom(final MainActivity a, final RefList rl) {
        final List<Accounts.Acc> accs = Accounts.all(a);
        if (!Accounts.multi(a) || accs.size() < 2) {
            String acc = accs.isEmpty() ? RoomRef.DEFAULT_ACC : accs.get(0).key;
            askRoomName(a, rl, acc);
            return;
        }
        String[] labels = new String[accs.size()];
        String[] descs = new String[accs.size()];
        for (int i = 0; i < accs.size(); i++) {
            labels[i] = accs.get(i).name;
            int n;
            try { n = KakaoListener.roomCount(a, accs.get(i).key); } catch (Throwable t) { n = 0; }
            descs[i] = "감지된 대화방 " + n + "개";
        }
        Nav.choose(a, "계정 선택", labels, descs, 0, new Nav.OnPick() {
            @Override public void pick(int index) {
                if (index < 0 || index >= accs.size()) return;
                askRoomName(a, rl, accs.get(index).key);
            }
        });
    }

    private static void askRoomName(final MainActivity a, final RefList rl, final String acc) {
        Nav.editText(a, "대화방 직접 입력", "카카오톡에 표시되는 대화방 이름", "", false,
                "카카오톡에 표시되는 이름과 정확히 일치해야 동작합니다.", new Nav.OnText() {
                    @Override public String text(String value) {
                        RoomRef r = RoomRef.of(acc, value);
                        if (!r.valid()) return "대화방 이름을 입력하십시오.";
                        toggle(rl, r, true);
                        refresh();
                        Log.add(a, "대화방 「" + r.label(a) + "」 을(를) 봇 대상으로 추가했습니다.");
                        return null;
                    }
                });
    }

    private static List<KakaoListener.RoomInfo> knownRooms(MainActivity a) {
        try {
            List<KakaoListener.RoomInfo> l = KakaoListener.knownRooms(a);
            return (l == null) ? new ArrayList<KakaoListener.RoomInfo>() : l;
        } catch (Throwable t) {
            return new ArrayList<KakaoListener.RoomInfo>();
        }
    }

    // ── 엔진 조회 (예외가 나도 화면은 떠야 한다) ────────────────────────────

    private static List<String> topWarned(MainActivity a) {
        try {
            List<String> l = RoomBot.topWarned(a, 10);
            return (l == null) ? new ArrayList<String>() : l;
        } catch (Throwable t) {
            return new ArrayList<String>();
        }
    }

    private static List<String> ranking(MainActivity a, RoomRef ref) {
        try {
            List<String> l = MiniGame.ranking(a, ref, 5);
            return (l == null) ? new ArrayList<String>() : l;
        } catch (Throwable t) {
            return new ArrayList<String>();
        }
    }

    private static String currentGame(RoomRef ref) {
        try {
            String v = MiniGame.currentGame(ref);
            return (v == null) ? "" : v;
        } catch (Throwable t) {
            return "";
        }
    }

    // ── 입력 도우미 ─────────────────────────────────────────────────────────

    /** 비워도 되는 문구 편집 (경고문·공지문처럼 비우면 발송하지 않는다) */
    private static void editOptional(final MainActivity a, final Settings s, String titleTxt,
                                     String value, String help, final Nav.OnText cb) {
        Nav.editText(a, titleTxt, "비워 두면 발송하지 않습니다", value, true, help,
                new Nav.OnText() {
                    @Override public String text(String v) {
                        if (v != null && v.length() > 2000) return "2000자 이하로 입력하십시오.";
                        return (cb == null) ? null : cb.text(v);
                    }
                });
    }

    /** 명령 접두사 (3글자 이하, 공백 불가) */
    private static void editPrefix(final MainActivity a, final Settings s, final boolean forRoomBot) {
        String cur = forRoomBot ? s.roombot.cmdPrefix : s.minigame.cmdPrefix;
        Nav.editText(a, "명령 접두사", "!", cur, false,
                "이 문자로 시작하는 메시지만 명령으로 처리합니다. 1글자를 권장합니다. (예: ! / . / ~)",
                new Nav.OnText() {
                    @Override public String text(String value) {
                        String v = (value == null) ? "" : value.trim();
                        if (v.length() == 0) return "접두사를 입력하십시오.";
                        if (v.length() > 3) return "3글자 이하로 입력하십시오.";
                        if (v.contains(" ")) return "공백은 사용할 수 없습니다.";
                        if (forRoomBot) s.roombot.cmdPrefix = v;
                        else s.minigame.cmdPrefix = v;
                        save(a, s);
                        Log.add(a, "명령 접두사를 「" + v + "」 로 설정했습니다.");
                        return null;
                    }
                });
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
