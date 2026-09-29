package com.buseong.kakaoauto;

import android.view.View;
import android.widget.LinearLayout;

import com.buseong.kakaoauto.engine.RoomLinks;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

/**
 * 방 관리봇. 홈에서 바로 들어가는 화면이고, 설정은 지금 고른 카카오 계정에만 저장된다.
 * 고른 방에서만 동작한다. 문장이 비어 있으면 그 항목은 메시지를 보내지 않는다.
 */
public final class ScreenGuard {
    private ScreenGuard() {}

    private static final int FC = Theme.F_ROOMBOT;

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> MAIN;
    private static WeakReference<LinearLayout> ROOMS;

    public static String summary(Settings s) {
        if (s == null || s.guard == null) return "꺼짐";
        int rooms = s.guard.roomRefs().size();
        int on = s.guard.enabledCount();
        if (rooms == 0) return "적용 방 없음";
        if (on == 0) return "방 " + rooms + "개 · 모두 꺼짐";
        return "방 " + rooms + "개 · 켜짐 " + on;
    }

    public static View open(MainActivity a) {
        ACT = new WeakReference<MainActivity>(a);
        LinearLayout col = Ui.screen(a);
        MAIN = new WeakReference<LinearLayout>(col);
        fillMain(a, col);
        return Ui.scroll(a, col);
    }

    private static void refresh() {
        MainActivity a = ACT == null ? null : ACT.get();
        if (a == null || a.isFinishing()) return;
        LinearLayout main = MAIN == null ? null : MAIN.get();
        if (main != null && main.isAttachedToWindow()) {
            main.removeAllViews();
            fillMain(a, main);
        }
        LinearLayout rooms = ROOMS == null ? null : ROOMS.get();
        if (rooms != null && rooms.isAttachedToWindow()) {
            rooms.removeAllViews();
            fillRooms(a, rooms);
        }
        try { MainActivity.refreshHome(); } catch (Throwable ignore) { }
    }

    private static void save(MainActivity a, Settings s) {
        ScreenMacro.apply(a, s);
        refresh();
    }

    private static void fillMain(final MainActivity a, LinearLayout col) {
        final Settings s = Settings.load(a);
        final Settings.GuardCfg g = s.guard;
        LinearLayout hero = Ui.hero(a, FC, Icon.SHIELD, "ROOM", "방 관리봇",
                "고른 방에서만 동작합니다. 폰이 꺼져 있어도 이 계정의 상시 발송에서 계속됩니다.");
        hero.addView(Ui.heroRule(a, FC));
        col.addView(hero);

        col.addView(Ui.sectionHeader(a, null, "적용 방"));
        LinearLayout rooms = Ui.group(a);
        int n = g.roomRefs().size();
        rooms.addView(Ui.navRow(a, "동작하는 방", n == 0 ? "없음" : (n + "개"),
                n == 0 ? Theme.AMBER : Theme.TEXT, new Runnable() {
                    @Override public void run() { Nav.push(a, "적용 방", roomScreen(a)); }
                }));
        col.addView(rooms);

        col.addView(Ui.sectionHeader(a, null, "방 유지"));
        LinearLayout presence = Ui.group(a);
        presence.addView(Ui.navRowSwitch(a, "사용", "가벼운 입력 표시만 보냅니다. 대화 문장은 나가지 않습니다.",
                g.presenceOn, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        g.presenceOn = v;
                        save(a, s);
                        Log.add(a, v ? "방 유지를 켰습니다." : "방 유지를 껐습니다.");
                    }
                }));
        presence.addView(Ui.navRow(a, "간격", g.presenceMin + "분", Theme.TEXT, new Runnable() {
            @Override public void run() {
                final Nav.NumField f = new Nav.NumField("분", "10~240", 10, 240, g.presenceMin);
                Nav.editNums(a, "방 유지 간격", "이 간격으로 선택한 방에 입력 중임을 표시합니다.",
                        new Nav.NumField[] { f }, new Nav.OnNums() {
                            @Override public String ok() {
                                g.presenceMin = f.value;
                                save(a, s);
                                return null;
                            }
                        });
            }
        }));
        col.addView(presence);

        col.addView(Ui.sectionHeader(a, null, "강퇴 테러 방지"));
        LinearLayout kick = Ui.group(a);
        kick.addView(Ui.navRowSwitch(a, "사용",
                "짧은 시간에 강퇴가 몰리면, 이 계정이 방장 또는 부방장일 때만 이후 강퇴를 멈춥니다. 결과는 활동 로그에 남습니다.",
                g.kickOn, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        g.kickOn = v;
                        save(a, s);
                        Log.add(a, v ? "강퇴 테러 방지를 켰습니다." : "강퇴 테러 방지를 껐습니다.");
                    }
                }));
        kick.addView(Ui.navRow(a, "기준", g.kickSecs + "초 안에 " + g.kickCount + "건", Theme.TEXT, new Runnable() {
            @Override public void run() {
                final Nav.NumField sec = new Nav.NumField("초", "5~300", 5, 300, g.kickSecs);
                final Nav.NumField cnt = new Nav.NumField("건수", "3~30", 3, 30, g.kickCount);
                Nav.editNums(a, "강퇴 기준", "이 시간 안에 강퇴가 이 건수 이상이면 멈춥니다.",
                        new Nav.NumField[] { sec, cnt }, new Nav.OnNums() {
                            @Override public String ok() {
                                g.kickSecs = sec.value;
                                g.kickCount = cnt.value;
                                save(a, s);
                                return null;
                            }
                        });
            }
        }));
        col.addView(kick);

        col.addView(Ui.sectionHeader(a, null, "도배 방지"));
        LinearLayout flood = Ui.group(a);
        flood.addView(Ui.navRowSwitch(a, "사용",
                "기준을 넘긴 멤버에게는 설정한 시간 동안 다시 응답하지 않습니다.",
                g.floodOn, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        g.floodOn = v;
                        save(a, s);
                        Log.add(a, v ? "도배 방지를 켰습니다." : "도배 방지를 껐습니다.");
                    }
                }));
        flood.addView(Ui.navRow(a, "기준", g.floodSecs + "초 안에 " + g.floodCount + "개", Theme.TEXT, new Runnable() {
            @Override public void run() {
                final Nav.NumField sec = new Nav.NumField("초", "3~120", 3, 120, g.floodSecs);
                final Nav.NumField cnt = new Nav.NumField("메시지", "3~50", 3, 50, g.floodCount);
                Nav.editNums(a, "도배 기준", "이 시간 안에 메시지를 이만큼 보내면 느린 응답으로 바꿉니다.",
                        new Nav.NumField[] { sec, cnt }, new Nav.OnNums() {
                            @Override public String ok() {
                                g.floodSecs = sec.value;
                                g.floodCount = cnt.value;
                                save(a, s);
                                return null;
                            }
                        });
            }
        }));
        flood.addView(Ui.navRow(a, "느린 응답", g.floodSlowSecs + "초", Theme.TEXT, new Runnable() {
            @Override public void run() {
                final Nav.NumField f = new Nav.NumField("초", "10~600", 10, 600, g.floodSlowSecs);
                Nav.editNums(a, "느린 응답", "이 시간 동안 그 멤버에게 다시 응답하지 않습니다.",
                        new Nav.NumField[] { f }, new Nav.OnNums() {
                            @Override public String ok() {
                                g.floodSlowSecs = f.value;
                                save(a, s);
                                return null;
                            }
                        });
            }
        }));
        flood.addView(textRow(a, s, "안내 문장", g.floodText, "비어 있으면 메시지를 보내지 않습니다.", new TextPut() {
            @Override public void put(String v) { g.floodText = v; }
        }));
        col.addView(flood);

        col.addView(Ui.sectionHeader(a, null, "들낙 방지"));
        LinearLayout churn = Ui.group(a);
        churn.addView(Ui.navRowSwitch(a, "사용",
                "입장과 퇴장이 몰리면 그 시간 동안 환영을 보내지 않습니다.",
                g.churnOn, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        g.churnOn = v;
                        save(a, s);
                        Log.add(a, v ? "들낙 방지를 켰습니다." : "들낙 방지를 껐습니다.");
                    }
                }));
        churn.addView(Ui.navRow(a, "기준", g.churnSecs + "초 안에 " + g.churnCount + "건", Theme.TEXT, new Runnable() {
            @Override public void run() {
                final Nav.NumField sec = new Nav.NumField("초", "5~300", 5, 300, g.churnSecs);
                final Nav.NumField cnt = new Nav.NumField("건수", "3~50", 3, 50, g.churnCount);
                Nav.editNums(a, "들낙 기준", "이 시간 안의 입장과 퇴장이 이 건수 이상이면 잠시 멈춥니다.",
                        new Nav.NumField[] { sec, cnt }, new Nav.OnNums() {
                            @Override public String ok() {
                                g.churnSecs = sec.value;
                                g.churnCount = cnt.value;
                                save(a, s);
                                return null;
                            }
                        });
            }
        }));
        churn.addView(Ui.navRow(a, "멈춤", g.churnQuietSecs + "초", Theme.TEXT, new Runnable() {
            @Override public void run() {
                final Nav.NumField f = new Nav.NumField("초", "30~600", 30, 600, g.churnQuietSecs);
                Nav.editNums(a, "들낙 멈춤", "이 시간 동안 입장마다 환영을 보내지 않습니다.",
                        new Nav.NumField[] { f }, new Nav.OnNums() {
                            @Override public String ok() {
                                g.churnQuietSecs = f.value;
                                save(a, s);
                                return null;
                            }
                        });
            }
        }));
        churn.addView(textRow(a, s, "안내 문장", g.churnText, "비어 있으면 메시지를 보내지 않습니다.", new TextPut() {
            @Override public void put(String v) { g.churnText = v; }
        }));
        col.addView(churn);

        col.addView(Ui.sectionHeader(a, null, "자동 환영"));
        LinearLayout welcome = Ui.group(a);
        welcome.addView(Ui.navRowSwitch(a, "사용", "누군가 들어오면 환영 문장을 한 번 보냅니다.",
                g.welcomeOn, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        g.welcomeOn = v;
                        save(a, s);
                        Log.add(a, v ? "자동 환영을 켰습니다." : "자동 환영을 껐습니다.");
                    }
                }));
        welcome.addView(textRow(a, s, "환영 문장", g.welcomeText, "비어 있으면 보내지 않습니다.", new TextPut() {
            @Override public void put(String v) { g.welcomeText = v; }
        }));
        col.addView(welcome);

        col.addView(Ui.sectionHeader(a, null, "주기 공지"));
        LinearLayout notice = Ui.group(a);
        notice.addView(Ui.navRowSwitch(a, "사용", "정한 간격마다 공지 문장을 한 번 보냅니다.",
                g.noticeOn, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        g.noticeOn = v;
                        save(a, s);
                        Log.add(a, v ? "주기 공지를 켰습니다." : "주기 공지를 껐습니다.");
                    }
                }));
        notice.addView(textRow(a, s, "공지 문장", g.noticeText, "비어 있으면 보내지 않습니다.", new TextPut() {
            @Override public void put(String v) { g.noticeText = v; }
        }));
        notice.addView(Ui.navRow(a, "간격", g.noticeMin + "분", Theme.TEXT, new Runnable() {
            @Override public void run() {
                final Nav.NumField f = new Nav.NumField("분", "5~1440", 5, 1440, g.noticeMin);
                Nav.editNums(a, "공지 간격", "이 간격마다 선택한 방에 공지를 보냅니다.",
                        new Nav.NumField[] { f }, new Nav.OnNums() {
                            @Override public String ok() {
                                g.noticeMin = f.value;
                                save(a, s);
                                return null;
                            }
                        });
            }
        }));
        col.addView(notice);

        col.addView(Nav.note(a, "문장이 비어 있으면 그 항목은 메시지를 보내지 않습니다. 강퇴는 실행하지 않습니다.",
                Theme.ACCENT2, null, null));
    }

    private interface TextPut { void put(String value); }

    private static View textRow(final MainActivity a, final Settings s, final String title,
                                final String value, final String help, final TextPut put) {
        final String cur = value == null ? "" : value;
        final boolean empty = cur.trim().length() == 0;
        return Ui.navRow(a, title, empty ? "없음" : Nav.preview(cur, 18),
                empty ? Theme.DIM : Theme.TEXT, new Runnable() {
                    @Override public void run() {
                        Nav.editText(a, title, "문장", cur, true, help, new Nav.OnText() {
                            @Override public String text(String v) {
                                put.put(v == null ? "" : v);
                                save(a, s);
                                return null;
                            }
                        });
                    }
                });
    }

    private static View roomScreen(MainActivity a) {
        LinearLayout col = Ui.screen(a);
        ROOMS = new WeakReference<LinearLayout>(col);
        fillRooms(a, col);
        return Ui.scroll(a, col);
    }

    private static void fillRooms(final MainActivity a, LinearLayout col) {
        final Settings s = Settings.load(a);
        col.addView(Ui.pageHead(a, null, "적용 방", "켠 방에서만 방 관리봇이 동작합니다.", FC));
        Map<String, RoomLinks.Link> links = RoomLinks.all(a);
        List<RoomRef> picked = s.guard.roomRefs();
        if (links.isEmpty() && picked.isEmpty()) {
            col.addView(Nav.note(a, "연결된 대화방이 없습니다. 보낼 방에서 대화방을 연결하면 여기에 나타납니다.",
                    Theme.ACCENT2, null, null));
            return;
        }
        LinearLayout g = Ui.group(a);
        ArrayList<String> seen = new ArrayList<String>();
        for (RoomLinks.Link link : links.values()) {
            if (link == null) continue;
            final RoomRef ref = RoomRef.parse(link.roomKey);
            if (!ref.valid()) continue;
            seen.add(ref.key());
            String title = link.kakaoName.length() > 0 ? link.kakaoName : ref.name;
            g.addView(Ui.checkRow(a, title, "이 방에서 동작", null, contains(picked, ref), new Ui.OnToggle() {
                @Override public void on(boolean v) { toggle(a, s, ref, v); }
            }, null));
        }
        for (int i = 0; i < picked.size(); i++) {
            final RoomRef ref = picked.get(i);
            if (ref == null || !ref.valid() || seen.contains(ref.key())) continue;
            g.addView(Ui.checkRow(a, ref.name, "연결이 없습니다", null, true, new Ui.OnToggle() {
                @Override public void on(boolean v) { toggle(a, s, ref, v); }
            }, null));
        }
        col.addView(g);
    }

    private static boolean contains(List<RoomRef> list, RoomRef ref) {
        if (list == null || ref == null) return false;
        for (int i = 0; i < list.size(); i++) {
            if (ref.equals(list.get(i))) return true;
        }
        return false;
    }

    private static void toggle(MainActivity a, Settings s, RoomRef ref, boolean on) {
        List<RoomRef> list = s.guard.roomRefs();
        boolean had = contains(list, ref);
        if (on && !had) list.add(ref);
        if (!on && had) list.remove(ref);
        s.guard.setRoomRefs(list);
        save(a, s);
    }
}
