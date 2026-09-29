package com.buseong.kakaoauto;

import android.graphics.Typeface;
import android.text.TextUtils;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

/**
 * 매크로 설정 상세 — 전용 서브화면 모음 (UI_V3 1·4장).
 *
 * 매크로 탭은 「제목 · 지금 값 · ›」 행만 보여주고, 행을 누르면 여기 화면이 {@link Nav#push} 로 올라온다.
 * 아코디언은 쓰지 않는다 — 접혀 있으면 안에 뭐가 있는지 모르고, 펼치면 경계가 사라진다.
 * 상세 화면 안에서도 같은 규칙을 지킨다: 목록형 행 + 값은 다이얼로그에서 고친다.
 *
 * 값은 <b>고치는 즉시 저장</b>된다 (확인 버튼 없음). 저장은 {@link ScreenMacro#apply} 한 곳을 지난다.
 */
public final class MacroDetail {
    private MacroDetail() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    // ── 화면 틀 ─────────────────────────────────────────────────────────────
    //  서브화면은 중첩된다 (경쟁사 저격 → 규칙 → 감지 대화방). 값이 바뀌면 지금 열려 있는
    //  화면 전부를 제자리에서 다시 그려야 하니까, 화면마다 "다시 채우는 방법" 을 들고 있는다.

    /** 화면 본문을 채우는 방법 */
    private interface Filler { void fill(MainActivity a, LinearLayout col); }

    private static final class Pane {
        final WeakReference<LinearLayout> body;
        final Filler fill;
        /** 만들 때의 기능 색. 다시 채울 때도 같은 색으로 그린다 */
        final int accent = Theme.accent();

        Pane(LinearLayout body, Filler fill) {
            this.body = new WeakReference<LinearLayout>(body);
            this.fill = fill;
        }
    }

    private static final ArrayList<Pane> PANES = new ArrayList<Pane>();
    private static WeakReference<MainActivity> ACT;

    /** 기능 색을 정하고 서브화면 한 장을 만든다 (색은 이 화면과 여기서 여는 하위 화면이 같이 쓴다) */
    private static View screen(MainActivity a, int color, Filler f) {
        Theme.setAccent(color);
        return screen(a, f);
    }

    /** 서브화면 한 장을 만든다 (지금 기능 색을 이어받는다) */
    private static View screen(MainActivity a, Filler f) {
        ACT = new WeakReference<MainActivity>(a);
        prune();
        LinearLayout col = Ui.screen(a);
        PANES.add(new Pane(col, f));
        try {
            f.fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "설정 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 지금 열려 있는 상세 화면을 모두 제자리에서 다시 그린다 */
    public static void refresh() {
        final int keep = Theme.accent();
        try {
            MainActivity a = (ACT == null) ? null : ACT.get();
            if (a == null || a.isFinishing()) { PANES.clear(); return; }
            for (int i = PANES.size() - 1; i >= 0; i--) {
                Pane p = PANES.get(i);
                LinearLayout col = p.body.get();
                if (col == null || !col.isAttachedToWindow()) { PANES.remove(i); continue; }
                try {
                    col.removeAllViews();
                    Theme.setAccent(p.accent);
                    p.fill.fill(a, col);
                } catch (Throwable t) {
                    Log.add(a, "설정 화면 갱신에 실패했습니다: " + t);
                }
            }
        } finally {
            Theme.setAccent(keep);
        }
    }

    /** 화면에서 떼어진 판을 버린다 (뒤로 나간 화면이 계속 쌓이지 않게) */
    private static void prune() {
        for (int i = PANES.size() - 1; i >= 0; i--) {
            LinearLayout col = PANES.get(i).body.get();
            if (col == null || !col.isAttachedToWindow()) PANES.remove(i);
        }
    }

    /** 저장 + 열려 있는 화면 전부 갱신 (탭 요약까지) */
    private static void save(MainActivity a, Settings s) {
        ScreenMacro.apply(a, s);
        refresh();
        ScreenMacro.refresh();
        ScreenRooms.refresh();
    }

    // ── 1. 메시지 ───────────────────────────────────────────────────────────

    public static View message(MainActivity a) {
        return screen(a, Theme.F_MACRO, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final boolean empty = (s.macro.message == null || s.macro.message.trim().length() == 0);
                final int fc = Theme.F_MACRO;

                LinearLayout hero = Ui.hero(a, fc, Icon.BUBBLE, "MESSAGE", "발송 내용",
                        "방에 발송되는 본문입니다. 입력한 줄바꿈이 그대로 유지됩니다.");
                TextView prev = Ui.body(a, empty ? "설정되지 않았습니다." : s.macro.message);
                prev.setTextColor(empty ? Theme.DIM : Theme.TEXT);
                prev.setMaxLines(14);
                prev.setEllipsize(TextUtils.TruncateAt.END);
                prev.setBackground(Theme.round(Theme.fade(Theme.BG, 0.7f), Theme.R_LG, Theme.fade(fc, 0.22f), 1, a));
                int p = Theme.dp(a, 16);
                prev.setPadding(p, p, p, p);
                LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(MATCH, WRAP);
                pp.topMargin = Theme.dp(a, 16);
                prev.setLayoutParams(pp);
                hero.addView(prev);

                int len = empty ? 0 : s.macro.message.length();
                TextView cnt = Ui.sub(a, len + " / 2000자");
                cnt.setGravity(android.view.Gravity.END);
                LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(MATCH, WRAP);
                cp.topMargin = Theme.dp(a, 8);
                cnt.setLayoutParams(cp);
                hero.addView(cnt);

                hero.addView(Nav.wideBtn(a, empty ? "작성" : "편집", true, new Runnable() {
                    @Override public void run() { editMessage(a, s); }
                }));
                col.addView(hero);

                col.addView(Nav.note(a, "치환 토큰은 경쟁사 저격·자동응답에서만 적용됩니다.",
                        Theme.ACCENT2, null, null));
            }
        });
    }

    private static void editMessage(final MainActivity a, final Settings s) {
        Nav.editText(a, "발송 내용", "발송할 내용을 입력하십시오", s.macro.message, true,
                "최대 2000자. 여러 줄 입력이 유지됩니다.", new Nav.OnText() {
                    @Override public String text(String value) {
                        if (value == null || value.trim().length() == 0) {
                            return "발송 메시지를 입력하십시오.";
                        }
                        if (value.length() > 2000) return "2000자 이하로 입력하십시오.";
                        s.macro.message = value;
                        save(a, s);
                        Log.add(a, "발송 메시지를 변경했습니다.");
                        return null;
                    }
                });
    }

    // ── 2. 발송 쿨타임 ──────────────────────────────────────────────────────

    public static View cycle(MainActivity a) {
        return screen(a, Theme.F_MACRO, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final int fc = Theme.F_MACRO;

                LinearLayout hero = Ui.hero(a, fc, Icon.CLOCK, "SCHEDULE", "발송 쿨타임",
                        "방별 쿨타임이 없는 보낼 방은 이 간격을 사용합니다.");
                hero.addView(Ui.heroRule(a, fc));
                LinearLayout stats = Ui.row(a);
                stats.setPadding(0, Theme.dp(a, 10), 0, 0);
                stats.addView(Ui.stat(a, "발송 쿨타임", s.macro.baseText(), Theme.TEXT));
                hero.addView(stats);
                col.addView(hero);

                col.addView(Ui.sectionHeader(a, null, "발송 쿨타임"));
                LinearLayout g = Ui.group(a);
                g.addView(Ui.navRow(a, Icon.CLOCK, fc, "발송 쿨타임", s.macro.baseText(), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editInterval(a, s); }
                        }));
                col.addView(g);

                col.addView(Nav.note(a, "방별 쿨타임은 보낼 방에서 그 방을 열어 지정합니다."
                        + " 그 방에서 0분으로 저장하면 이 발송 쿨타임을 사용합니다.",
                        Theme.ACCENT2, null, null));
            }
        });
    }

    /** 랜덤 쿨타임만. 발송 쿨타임·방별 쿨타임과 섞지 않는다. */
    public static View random(MainActivity a) {
        return screen(a, Theme.F_MACRO, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final int fc = Theme.F_MACRO;
                LinearLayout hero = Ui.hero(a, fc, Icon.CLOCK, "RANDOM", "랜덤 쿨타임",
                        "0분이면 발송 쿨타임만 사용합니다. 1분 이상이면 발송 쿨타임에 0분부터 이 값까지를 더합니다.");
                hero.addView(Ui.heroRule(a, fc));
                LinearLayout stats = Ui.row(a);
                stats.setPadding(0, Theme.dp(a, 10), 0, 0);
                stats.addView(Ui.stat(a, "랜덤 쿨타임", s.macro.randomText(), Theme.TEXT));
                hero.addView(stats);
                col.addView(hero);

                col.addView(Ui.sectionHeader(a, null, "랜덤 쿨타임"));
                LinearLayout g = Ui.group(a);
                g.addView(Ui.navRow(a, Icon.CLOCK, fc, "랜덤 쿨타임", s.macro.randomText(), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editRandom(a, s); }
                        }));
                col.addView(g);
            }
        });
    }

    /** 이 방의 쿨타임만. 다른 방과 기본 발송 쿨타임은 바꾸지 않는다. */
    public static View room(MainActivity a, final RoomRef room) {
        return screen(a, Theme.F_ROOMS, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                if (room == null) return;
                final Settings s = Settings.load(a);
                String label = room.label(a);
                LinearLayout hero = Ui.hero(a, Theme.F_ROOMS, Icon.ROOMS, "ROOM", "방별 쿨타임",
                        "「" + label + "」만 바뀝니다. 0분이면 기본 발송 쿨타임 "
                                + s.macro.baseText() + " 을 사용합니다.");
                hero.addView(Ui.heroRule(a, Theme.F_ROOMS));
                LinearLayout stats = Ui.row(a);
                stats.setPadding(0, Theme.dp(a, 10), 0, 0);
                stats.addView(Ui.stat(a, "이 방", s.macro.cooldownLabel(room), Theme.TEXT));
                hero.addView(stats);
                col.addView(hero);

                col.addView(Ui.sectionHeader(a, null, label));
                LinearLayout g = Ui.group(a);
                g.addView(Ui.navRow(a, Icon.CLOCK, Theme.F_ROOMS, "이 방 쿨타임",
                        s.macro.cooldownLabel(room), Theme.TEXT, new Runnable() {
                            @Override public void run() { editRoomCooldown(a, s, room); }
                        }));
                col.addView(g);
            }
        });
    }

    /** 최소 신규 메시지. 쿨타임 화면과 분리한다. */
    public static View minMessages(MainActivity a) {
        return screen(a, Theme.F_MACRO, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final int fc = Theme.F_MACRO;
                LinearLayout hero = Ui.hero(a, fc, Icon.BUBBLE, "GATE", "최소 신규 메시지",
                        "마지막 발송 이후 상대 메시지가 이 수량 이상인 방에만 보냅니다. 0은 항상 발송입니다.");
                col.addView(hero);
                col.addView(Ui.sectionHeader(a, null, "최소 신규 메시지"));
                LinearLayout g = Ui.group(a);
                g.addView(Ui.navRow(a, Icon.BUBBLE, fc, "최소 신규 메시지", s.macro.minMessages + "개",
                        Theme.TEXT, new Runnable() {
                            @Override public void run() { editMinMessages(a, s); }
                        }));
                col.addView(g);
            }
        });
    }

    private static void editInterval(final MainActivity a, final Settings s) {
        final Nav.NumField n = new Nav.NumField("발송 쿨타임 (분)", "1", 1, 1440, s.macro.baseMin);
        Nav.editNums(a, "발송 쿨타임", "방별 쿨타임이 없는 보낼 방은 이 간격으로 발송됩니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        s.macro.baseMin = n.value;
                        save(a, s);
                        Scheduler.ensureScheduled(a);
                        Log.add(a, "발송 쿨타임을 ~" + n.value + "분으로 변경했습니다.");
                        return null;
                    }
                });
    }

    private static void editRandom(final MainActivity a, final Settings s) {
        final Nav.NumField n = new Nav.NumField("랜덤 쿨타임 (분)", "0", 0, 1440, s.macro.randomMin);
        Nav.editNums(a, "랜덤 쿨타임", "0분이면 발송 쿨타임만 사용합니다. 1분 이상이면 발송 쿨타임에 0분부터 이 값까지를 더합니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        s.macro.randomMin = n.value;
                        save(a, s);
                        Scheduler.ensureScheduled(a);
                        Log.add(a, "랜덤 쿨타임을 " + n.value + "분으로 변경했습니다.");
                        return null;
                    }
                });
    }

    private static void editRoomCooldown(final MainActivity a, final Settings s, final RoomRef room) {
        final Nav.NumField n = new Nav.NumField("쿨타임 (분)", "0", 0, 1440, s.macro.cooldownMin(room));
        Nav.editNums(a, room.label(a), "0분이면 이 방은 기본 발송 쿨타임을 사용합니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        s.macro.setCooldownMin(room, n.value);
                        long last = s.macro.lastSent(room);
                        if (last > 0 && n.value > 0) {
                            s.macro.setDueAt(room, last + (long) n.value * 60000L);
                        }
                        save(a, s);
                        Scheduler.ensureScheduled(a);
                        if (n.value < 1) {
                            Log.add(a, "「" + room.label(a) + "」 쿨타임을 기본 발송 쿨타임으로 변경했습니다.");
                        } else {
                            Log.add(a, "「" + room.label(a) + "」 쿨타임을 " + n.value + "분으로 변경했습니다.");
                        }
                        return null;
                    }
                });
    }

    private static void editMinMessages(final MainActivity a, final Settings s) {
        final Nav.NumField mm = new Nav.NumField("최소 신규 메시지 수", "1", 0, 200, s.macro.minMessages);
        Nav.editNums(a, "최소 신규 메시지",
                "마지막 발송 이후 상대 메시지가 이 수량 이상 누적된 대화방에만 발송합니다. 0은 항상 발송입니다.",
                new Nav.NumField[] { mm }, new Nav.OnNums() {
                    @Override public String ok() {
                        s.macro.minMessages = mm.value;
                        save(a, s);
                        Log.add(a, "최소 신규 메시지를 " + mm.value + "개로 변경했습니다.");
                        return null;
                    }
                });
    }

    // ── 3. 이미지 첨부 ──────────────────────────────────────────────────────
    //  전송 경로(엔진)는 ImageSender 가 정한다. 이 화면은 이미지 선택·전송 조건·즉시 전송만 다룬다.

    public static View image(MainActivity a) {
        return screen(a, Theme.F_MACRO, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final int fc = Theme.F_MACRO;

                View warn = ScreenMacro.imgFailNote(a);
                if (warn != null) col.addView(warn);

                final int have = s.macro.images.size();
                LinearLayout hero = Ui.hero(a, fc, Icon.IMAGE, "IMAGES", "이미지",
                        "메시지와 함께 이미지를 1~" + Settings.MAX_IMAGES + "장 발송합니다. 선택 순서대로 전송됩니다.");
                LinearLayout cntRow = Ui.row(a);
                LinearLayout.LayoutParams crp = new LinearLayout.LayoutParams(MATCH, WRAP);
                crp.topMargin = Theme.dp(a, 14);
                cntRow.setLayoutParams(crp);
                TextView big = new TextView(a);
                big.setText(have + " / " + Settings.MAX_IMAGES);
                big.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 16f);
                big.setTypeface(Typeface.create("sans-serif", Typeface.BOLD));
                big.setTextColor(have > 0 ? Theme.TEXT : Theme.DIM);
                big.setIncludeFontPadding(false);
                cntRow.addView(big);
                TextView unit = Ui.sub(a, "  장 선택됨");
                cntRow.addView(unit);
                hero.addView(cntRow);
                hero.addView(spaced(a, Ui.progress(a, have, Settings.MAX_IMAGES, fc), 10));

                final LinearLayout strip = new LinearLayout(a);
                strip.setOrientation(LinearLayout.HORIZONTAL);
                hero.addView(spaced(a, Nav.thumbStrip(a, strip), 14));
                paintThumbs(a, s, strip);

                final int left = Math.max(0, Settings.MAX_IMAGES - have);
                hero.addView(Nav.wideBtn(a, (left > 0) ? ("이미지 선택 · " + left + "장 추가 가능")
                        : ("첨부 한도 도달 · 최대 " + Settings.MAX_IMAGES + "장"), left > 0 && have == 0, new Runnable() {
                    @Override public void run() {
                        if (left <= 0) {
                            Ui.toast(a, "이미지는 최대 " + Settings.MAX_IMAGES
                                    + "장까지 첨부됩니다. 기존 이미지를 삭제한 후 선택하십시오.");
                            return;
                        }
                        try {
                            ImagePicker.pick(a, MainActivity.REQ_IMAGES);
                        } catch (Throwable t) {
                            Log.add(a, "이미지 선택 화면을 열지 못했습니다: " + t);
                            Ui.toast(a, "이미지 선택 화면을 열 수 없습니다.");
                        }
                    }
                }));
                col.addView(hero);

                // ── 전송 조건 ──
                col.addView(Ui.sectionHeader(a, null, "전송 조건"));
                LinearLayout g = Ui.group(a);
                g.addView(Ui.navRow(a, Icon.SEND, fc, "전송 모드", ScreenMacro.imgModeKr(s.macro.sendImages),
                        s.macro.images.isEmpty() ? Theme.DIM : Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { pickImgMode(a, s); }
                        }));
                if (Settings.IMG_EVERY_N.equals(s.macro.sendImages)) {
                    g.addView(Ui.navRow(a, Icon.CLOCK, fc, "전송 주기", s.macro.imageEveryN + "회마다", Theme.TEXT,
                            new Runnable() {
                                @Override public void run() { editEveryN(a, s); }
                            }));
                }
                col.addView(g);

                // ── 즉시 전송 ──
                col.addView(Ui.sectionHeader(a, null, "즉시 전송"));
                final List<RoomRef> rooms = s.macro.roomRefs();
                LinearLayout card = Ui.card(a);
                card.addView(Ui.sub(a, rooms.isEmpty()
                        ? "방을 먼저 설정하십시오."
                        : ("첫 번째 방 「" + rooms.get(0).label(a) + "」 로 선택한 이미지를 1회 전송합니다.")));
                final TextView now = Ui.btn(a, "즉시 이미지 발송", false);
                LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(MATCH, WRAP);
                np.topMargin = Theme.dp(a, 12);
                now.setLayoutParams(np);
                now.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { sendImagesNow(a, s, now); }
                });
                card.addView(now);
                col.addView(card);

                String route = ScreenKakaoLink.routeLine(a, rooms.isEmpty() ? null : rooms.get(0));
                if (route != null) {
                    col.addView(Nav.note(a, route, Theme.ACCENT2, "직접 연결 설정", new Runnable() {
                        @Override public void run() { ScreenKakaoLink.open(a); }
                    }));
                }
            }
        });
    }

    private static View spaced(MainActivity a, View v, int topDp) {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        if (v.getLayoutParams() != null) lp.height = v.getLayoutParams().height;
        lp.topMargin = Theme.dp(a, topDp);
        v.setLayoutParams(lp);
        return v;
    }

    private static void paintThumbs(final MainActivity a, final Settings s, final LinearLayout strip) {
        strip.removeAllViews();
        if (s.macro.images.isEmpty()) {
            strip.addView(Ui.sub(a, "선택된 이미지가 없습니다."));
            return;
        }
        for (int i = 0; i < s.macro.images.size(); i++) {
            final String uri = s.macro.images.get(i);
            final int no = i + 1;
            strip.addView(Nav.thumb(a, uri, no, new Runnable() {
                @Override public void run() {
                    // URI 영속 권한까지 놓아주니까 되돌릴 수 없다 → 한 번 묻는다
                    Nav.confirm(a, "이미지 " + no + "번 삭제", "첨부 목록에서 제거하고 즉시 저장합니다.",
                            "삭제", new Runnable() {
                                @Override public void run() {
                                    s.macro.images.remove(uri);
                                    try { ImagePicker.release(a, uri); }
                                    catch (Throwable t) { /* 권한 해제 실패는 무해 */ }
                                    Nav.clearThumbCache();
                                    save(a, s);
                                    Log.add(a, "첨부 이미지 1장을 삭제했습니다.");
                                }
                            });
                }
            }));
        }
    }

    private static void pickImgMode(final MainActivity a, final Settings s) {
        String[] labels = { "매번", "N회마다", "수동 전송만" };
        String[] descs = {
                "발송 시마다 이미지를 함께 전송합니다",
                "지정한 발송 횟수마다 1회 전송합니다",
                "자동 전송하지 않고 즉시 이미지 발송만 사용합니다"
        };
        int sel = 0;
        for (int i = 0; i < Settings.IMG_MODES.length; i++) {
            if (Settings.IMG_MODES[i].equals(s.macro.sendImages)) sel = i;
        }
        Nav.choose(a, "전송 모드", labels, descs, sel, new Nav.OnPick() {
            @Override public void pick(int index) {
                if (index < 0 || index >= Settings.IMG_MODES.length) return;
                s.macro.sendImages = Settings.IMG_MODES[index];
                save(a, s);
                Log.add(a, "이미지 전송 모드를 「" + ScreenMacro.imgModeKr(s.macro.sendImages)
                        + "」 로 변경했습니다.");
            }
        });
    }

    private static void editEveryN(final MainActivity a, final Settings s) {
        final Nav.NumField n = new Nav.NumField("발송 횟수 (N)", "3", 1, 100, s.macro.imageEveryN);
        Nav.editNums(a, "전송 주기", "3으로 설정하면 3·6·9번째 발송에 이미지가 첨부됩니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        s.macro.imageEveryN = n.value;
                        save(a, s);
                        Log.add(a, "이미지 전송 주기를 " + n.value + "회마다로 변경했습니다.");
                        return null;
                    }
                });
    }

    /** 즉시 이미지 발송 — 방 중 첫 번째 한 곳으로만 보낸다 */
    private static void sendImagesNow(final MainActivity a, final Settings s, final TextView btn) {
        if (!License.allowed(a, Features.MACRO)) { Gate.check(a, Features.MACRO); return; }
        if (s.macro.images.isEmpty()) { Ui.toast(a, "이미지를 먼저 선택하십시오."); return; }

        List<RoomRef> all = s.macro.roomRefs();
        RoomRef pick = null;
        for (int i = 0; i < all.size(); i++) {
            RoomRef r = all.get(i);
            if (r != null && r.valid() && s.accountOn(r.acc)) { pick = r; break; }
        }
        if (pick == null) {
            Ui.toast(a, all.isEmpty() ? "방을 먼저 설정하십시오."
                    : "방이 모두 미사용 계정에 속합니다.");
            return;
        }

        final RoomRef room = pick;
        final String label = room.label(a);
        final String idle = "즉시 이미지 발송";
        final List<String> uris = new ArrayList<String>(s.macro.images);
        Nav.busy(btn, true, "전송 중…", idle);
        // 사용자가 직접 전송을 누른 시점 = 설정을 고치고 다시 확인해보는 시점이다.
        // 백그라운드 불가 확정을 풀어 예약 발송이 다시 이미지를 시도하게 한다.
        try { ImageSender.clearBackgroundBlocked(a); } catch (Throwable ignore) { }
        Log.add(a, "이미지 " + uris.size() + "장을 「" + label + "」 로 전송합니다.");
        try {
            // ★ RoomRef 를 그대로 넘긴다 (계정 구분자가 붙은 key() 문자열은 대화방 매칭에 쓸 수 없다)
            ImageSender.sendWithResult(a, room, uris, new ImageSender.Done() {
                @Override public void done(boolean ok, String detail) {
                    Nav.busy(btn, false, "전송 중…", idle);
                    if (ok) {
                        Scheduler.clearImageFail(a, label);
                        Ui.toast(a, "「" + label + "」 전송을 완료했습니다. 카카오톡에서 확인하십시오.");
                        refresh();
                        ScreenMacro.refresh();
                        return;
                    }
                    String why = (detail == null || detail.length() == 0) ? "원인 미확인" : detail;
                    Scheduler.noteImageFail(a, label, why);
                    Ui.showDark(Ui.dialog(a, "이미지 전송 실패").setMessage(why)
                            .setPositiveButton("확인", null));
                    refresh();
                    ScreenMacro.refresh();
                }
            });
        } catch (Throwable t) {
            Nav.busy(btn, false, "전송 중…", idle);
            Scheduler.noteImageFail(a, label, "전송을 시작하지 못했습니다. " + t);
            Log.add(a, "이미지 전송을 시작하지 못했습니다: " + t);
            Ui.toast(a, "이미지 전송을 시작하지 못했습니다.");
            refresh();
            ScreenMacro.refresh();
        }
    }

    // ── 4. 경쟁사 저격 (트리거) ─────────────────────────────────────────────

    public static View triggers(MainActivity a) {
        return screen(a, Theme.F_TRIGGER, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final int fc = Theme.F_TRIGGER;

                int on = 0;
                for (int i = 0; i < s.triggers.size(); i++) if (s.triggers.get(i).enabled) on++;
                LinearLayout hero = Ui.hero(a, fc, Icon.BOLT, "TRIGGERS", "경쟁사 저격",
                        "지정한 문자열이 감지되면 즉시 발송합니다. 발송 쿨타임과 독립적으로 동작합니다.");
                hero.addView(Ui.heroRule(a, fc));
                LinearLayout stats = Ui.row(a);
                stats.setPadding(0, Theme.dp(a, 10), 0, 0);
                stats.addView(Ui.stat(a, "등록 규칙", s.triggers.size() + " / " + Settings.MAX_TRIGGERS, Theme.TEXT));
                stats.addView(Ui.stat(a, "사용 중", on + "개", (on > 0) ? fc : Theme.DIM));
                hero.addView(stats);
                col.addView(hero);

                col.addView(Ui.sectionHeader(a, null, "추적 규칙"));

                if (s.triggers.isEmpty()) {
                    LinearLayout empty = Ui.card(a);
                    empty.addView(Ui.sub(a, "등록된 규칙이 없습니다. 아래 [규칙 추가] 를 선택하십시오."));
                    col.addView(empty);
                }
                for (int i = 0; i < s.triggers.size(); i++) {
                    col.addView(triggerCard(a, s, s.triggers.get(i)));
                }

                col.addView(Nav.wideBtn(a, "규칙 추가", s.triggers.isEmpty(), new Runnable() {
                    @Override public void run() {
                        if (s.triggers.size() >= Settings.MAX_TRIGGERS) {
                            Ui.toast(a, "규칙은 최대 " + Settings.MAX_TRIGGERS + "개까지 등록됩니다.");
                            return;
                        }
                        newTrigger(a, s);
                    }
                }));
            }
        });
    }

    /** 규칙 한 건 = 사용 여부·삭제 행 + 세부 설정 행 */
    private static LinearLayout triggerCard(final MainActivity a, final Settings s,
                                            final Settings.TriggerCfg t) {
        LinearLayout g = Ui.group(a);
        String[] badges = { modeKr(t.mode), roomBadge(a, t.roomRefs()) };
        g.addView(Ui.checkRow(a, t.title(), trigMeta(a, t), badges, t.enabled,
                new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        t.enabled = v;
                        ScreenMacro.apply(a, s);
                        ScreenMacro.refresh();
                        Log.add(a, "규칙 「" + t.title() + "」 을(를) "
                                + (v ? "사용으로" : "미사용으로") + " 변경했습니다.");
                    }
                },
                new Runnable() {
                    @Override public void run() { removeTrigger(a, s, t); }
                }));
        g.addView(Ui.navRow(a, Icon.GEAR, Theme.F_TRIGGER, "세부 설정", t.enabled ? "사용" : "미사용",
                t.enabled ? Theme.TEXT : Theme.DIM, new Runnable() {
                    @Override public void run() {
                        Nav.push(a, "추적 규칙", triggerDetail(a, t.id));
                    }
                }));
        return g;
    }

    private static String trigMeta(MainActivity a, Settings.TriggerCfg t) {
        String target = (t.target == null || t.target.trim().length() == 0)
                ? "감지된 대화방" : RoomRef.parse(t.target).label(a);
        return "「" + Nav.preview(t.pattern, 14) + "」 → " + Nav.preview(target, 14);
    }

    /** `모든 대화방` / `3개 대화방` */
    private static String roomBadge(MainActivity a, List<RoomRef> rooms) {
        if (rooms == null || rooms.isEmpty()) return "모든 대화방";
        return rooms.size() + "개 대화방";
    }

    /** 규칙 삭제 — 확인창 없이 지우고 5초간 되돌리기를 띄운다 (UI_V3 5장과 같은 규칙) */
    private static void removeTrigger(final MainActivity a, final Settings s,
                                      final Settings.TriggerCfg t) {
        int idx = s.triggers.indexOf(t);
        final int at = (idx < 0) ? s.triggers.size() : idx;
        final String name = t.title();
        s.removeTrigger(t.id);
        try { Trigger.resetState(a, t.id); } catch (Throwable ignore) { /* 상태 정리 실패는 무해 */ }
        save(a, s);
        Log.add(a, "규칙 「" + name + "」 을(를) 삭제했습니다.");
        Nav.snack("규칙 「" + name + "」 삭제", "되돌리기", new Runnable() {
            @Override public void run() {
                Settings now = Settings.load(a);
                if (now.triggerById(t.id) != null) return;
                if (now.triggers.size() >= Settings.MAX_TRIGGERS) {
                    Ui.toast(a, "규칙은 최대 " + Settings.MAX_TRIGGERS + "개까지 등록됩니다.");
                    return;
                }
                int pos = (at > now.triggers.size()) ? now.triggers.size() : at;
                now.triggers.add(pos, t);
                save(a, now);
                Log.add(a, "규칙 「" + name + "」 삭제를 취소했습니다.");
            }
        });
    }

    /** 새 규칙 — 필수값(감지 문자열·발송 메시지)만 받고 만든 뒤, 나머지는 세부 설정에서 고친다 */
    private static void newTrigger(final MainActivity a, final Settings s) {
        LinearLayout body = Nav.col(a);
        body.addView(fieldLabel(a, "규칙 이름 (선택)", 0));
        final android.widget.EditText name = line(a, "예) 출석 확인", "");
        body.addView(name);

        body.addView(fieldLabel(a, "감지 문자열", 14));
        final android.widget.EditText pat = line(a, "예) 출석", "");
        body.addView(pat);
        final TextView patErr = Nav.errLine(a);
        body.addView(patErr);

        body.addView(fieldLabel(a, "발송 메시지", 14));
        final android.widget.EditText reply = multi(a, "{방} {이름} {메시지} {시간} 사용 가능", "");
        body.addView(reply);
        final TextView replyErr = Nav.errLine(a);
        body.addView(replyErr);

        Nav.form(a, "규칙 추가", body, "저장", new Nav.OnSave() {
            @Override public String save() {
                Nav.errClear(patErr);
                Nav.errClear(replyErr);
                String p = pat.getText().toString();
                if (p.trim().length() == 0) {
                    Nav.errText(patErr, "감지 문자열을 입력하십시오");
                    return "";
                }
                String rp = reply.getText().toString();
                if (rp.trim().length() == 0) {
                    Nav.errText(replyErr, "발송 메시지를 입력하십시오");
                    return "";
                }
                Settings.TriggerCfg t = new Settings.TriggerCfg();
                t.name = name.getText().toString().trim();
                t.pattern = p;
                t.reply = rp;
                String bad;
                try {
                    bad = Trigger.validate(t);
                } catch (Throwable e) {
                    bad = "규칙 검사 중 오류가 발생했습니다. (" + e.getClass().getSimpleName() + ")";
                }
                if (bad != null) return bad;
                String why = s.addTrigger(t);
                if (why != null) return why;
                MacroDetail.save(a, s);
                Log.add(a, "규칙 「" + t.title() + "」 을(를) 추가했습니다.");
                return null;
            }
        });
    }

    /** 규칙 하나의 전용 서브화면. 값은 고치는 즉시 저장된다. */
    private static View triggerDetail(MainActivity a, final String id) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final Settings.TriggerCfg t = s.triggerById(id);
                if (t == null) {
                    col.addView(Ui.sectionHeader(a, null, "규칙 없음"));
                    col.addView(Ui.sub(a, "삭제된 규칙입니다. 뒤로 이동하십시오."));
                    return;
                }

                // ── 감지 조건 ──
                col.addView(Ui.sectionHeader(a, null, "감지 조건"));
                LinearLayout g1 = Ui.group(a);
                g1.addView(Ui.navRow(a, "규칙 이름",
                        (t.name == null || t.name.trim().length() == 0) ? "미설정" : t.name.trim(),
                        (t.name == null || t.name.trim().length() == 0) ? Theme.DIM : Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editTrigName(a, s, t); }
                        }));
                g1.addView(Ui.navRow(a, "감지 문자열", Nav.preview(t.pattern, 18), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editTrigPattern(a, s, t); }
                        }));
                g1.addView(Ui.navRow(a, "비교 방식", modeKr(t.mode), Theme.TEXT, new Runnable() {
                    @Override public void run() { pickTrigMode(a, s, t); }
                }));
                g1.addView(Ui.navRow(a, "감지 대화방", roomBadge(a, t.roomRefs()), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() {
                                Nav.push(a, "감지 대화방", roomSelect(a, trigRooms(a, s, t),
                                        "선택하지 않으면 모든 대화방에서 감지합니다."));
                            }
                        }));
                g1.addView(Ui.navRowSwitch(a, "대소문자 무시", null, t.ignoreCase, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        t.ignoreCase = v;
                        ScreenMacro.apply(a, s);
                    }
                }));
                g1.addView(Ui.navRowSwitch(a, "본인 메시지 포함",
                        "본인 발송 메시지도 감지합니다. 반복 발송 위험이 있어 기본값은 미사용입니다.",
                        t.fromMe, new Ui.OnToggle() {
                            @Override public void on(boolean v) {
                                t.fromMe = v;
                                ScreenMacro.apply(a, s);
                            }
                        }));
                col.addView(g1);

                // ── 발송 ──
                col.addView(Ui.sectionHeader(a, null, "발송"));
                LinearLayout g2 = Ui.group(a);
                g2.addView(Ui.navRow(a, "발송 메시지", Nav.preview(t.reply, 18), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editTrigReply(a, s, t); }
                        }));
                boolean autoTarget = (t.target == null || t.target.trim().length() == 0);
                g2.addView(Ui.navRow(a, "발송 대화방",
                        autoTarget ? "감지된 대화방" : RoomRef.parse(t.target).label(a),
                        autoTarget ? Theme.SUB : Theme.TEXT, new Runnable() {
                            @Override public void run() { pickTrigTarget(a, s, t); }
                        }));
                g2.addView(Ui.navRow(a, "랜덤 지연",
                        (t.delayMs <= 0) ? "없음" : ("0~" + (t.delayMs / 1000) + "초"),
                        (t.delayMs <= 0) ? Theme.DIM : Theme.TEXT, new Runnable() {
                            @Override public void run() { editTrigDelay(a, s, t); }
                        }));
                col.addView(g2);

                // ── 동작 ──
                col.addView(Ui.sectionHeader(a, null, "동작"));
                LinearLayout g3 = Ui.group(a);
                g3.addView(Ui.navRowSwitch(a, "사용", null, t.enabled, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        t.enabled = v;
                        ScreenMacro.apply(a, s);
                        ScreenMacro.refresh();
                    }
                }));
                g3.addView(Ui.navRow(a, "재발동 간격", Nav.dur(t.cooldownMs), Theme.TEXT, new Runnable() {
                    @Override public void run() { editTrigCooldown(a, s, t); }
                }));
                g3.addView(Ui.navRowSwitch(a, "대화방별 1회", "한 대화방에서 1회 발동하면 이후 발송하지 않습니다.",
                        t.oncePerRoom, new Ui.OnToggle() {
                            @Override public void on(boolean v) {
                                t.oncePerRoom = v;
                                ScreenMacro.apply(a, s);
                                refresh();
                            }
                        }));
                if (t.oncePerRoom) {
                    List<RoomRef> fired;
                    try {
                        fired = Trigger.firedRoomRefs(a, t.id);
                    } catch (Throwable e) {
                        fired = new ArrayList<RoomRef>();
                    }
                    final int n = fired.size();
                    g3.addView(Ui.navRow(a, "발동 기록", (n == 0) ? "없음" : (n + "개 대화방"),
                            (n == 0) ? Theme.DIM : Theme.TEXT, new Runnable() {
                                @Override public void run() {
                                    if (n == 0) {
                                        Ui.toast(a, "발동 기록이 없습니다.");
                                        return;
                                    }
                                    Nav.confirm(a, "발동 기록 초기화",
                                            "대화방 " + n + "개의 발동 기록을 삭제합니다. 해당 대화방에서 다시 발동합니다.",
                                            "초기화", new Runnable() {
                                                @Override public void run() {
                                                    try { Trigger.resetState(a, t.id); }
                                                    catch (Throwable e) { /* 무해 */ }
                                                    Log.add(a, "규칙 「" + t.title()
                                                            + "」 의 발동 기록을 초기화했습니다.");
                                                    refresh();
                                                }
                                            });
                                }
                            }));
                }
                col.addView(g3);

                TextView del = Ui.btn(a, "규칙 삭제", false);
                del.setTextColor(Theme.RED);
                LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
                dp.topMargin = Theme.dp(a, 10);
                del.setLayoutParams(dp);
                del.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        Nav.confirm(a, "규칙 삭제", "「" + t.title() + "」 을(를) 삭제합니다.",
                                "삭제", new Runnable() {
                                    @Override public void run() {
                                        Nav.pop();
                                        removeTrigger(a, s, t);
                                    }
                                });
                    }
                });
                col.addView(del);
            }
        });
    }

    private static void editTrigName(final MainActivity a, final Settings s,
                                     final Settings.TriggerCfg t) {
        Nav.editText(a, "규칙 이름", "예) 출석 확인", t.name, false,
                "목록에 표시되는 이름입니다. 비워두면 감지 문자열이 표시됩니다.", new Nav.OnText() {
                    @Override public String text(String value) {
                        t.name = (value == null) ? "" : value.trim();
                        save(a, s);
                        return null;
                    }
                });
    }

    private static void editTrigPattern(final MainActivity a, final Settings s,
                                        final Settings.TriggerCfg t) {
        Nav.editText(a, "감지 문자열", "예) 출석", t.pattern, false,
                "이 문자열이 감지되면 발송합니다.", new Nav.OnText() {
                    @Override public String text(String value) {
                        String old = t.pattern;
                        t.pattern = (value == null) ? "" : value;
                        String bad = trigCheck(t);
                        if (bad != null) { t.pattern = old; return bad; }
                        save(a, s);
                        Log.add(a, "규칙 「" + t.title() + "」 의 감지 문자열을 변경했습니다.");
                        return null;
                    }
                });
    }

    private static void editTrigReply(final MainActivity a, final Settings s,
                                      final Settings.TriggerCfg t) {
        Nav.editText(a, "발송 메시지", "발송할 내용을 입력하십시오", t.reply, true,
                "{방} {이름} {메시지} {시간} 이 치환됩니다. 최대 2000자.", new Nav.OnText() {
                    @Override public String text(String value) {
                        String old = t.reply;
                        t.reply = (value == null) ? "" : value;
                        String bad = trigCheck(t);
                        if (bad != null) { t.reply = old; return bad; }
                        save(a, s);
                        Log.add(a, "규칙 「" + t.title() + "」 의 발송 메시지를 변경했습니다.");
                        return null;
                    }
                });
    }

    private static void pickTrigMode(final MainActivity a, final Settings s,
                                     final Settings.TriggerCfg t) {
        int sel = 0;
        for (int i = 0; i < Settings.MODES.length; i++) {
            if (Settings.MODES[i].equals(t.mode)) sel = i;
        }
        Nav.choose(a, "비교 방식", new String[] { "포함", "정확히", "시작", "정규식" },
                new String[] { "메시지에 포함되면 감지합니다",
                        "메시지 전체가 일치할 때만 감지합니다",
                        "메시지가 이 문자열로 시작할 때 감지합니다",
                        "정규식으로 감지합니다. 형식 오류는 저장 시 안내됩니다" },
                sel, new Nav.OnPick() {
                    @Override public void pick(int index) {
                        if (index < 0 || index >= Settings.MODES.length) return;
                        String old = t.mode;
                        t.mode = Settings.MODES[index];
                        String bad = trigCheck(t);
                        if (bad != null) {
                            t.mode = old;
                            Ui.toast(a, bad);
                            return;
                        }
                        save(a, s);
                        Log.add(a, "규칙 「" + t.title() + "」 의 비교 방식을 "
                                + modeKr(t.mode) + " 로 변경했습니다.");
                    }
                });
    }

    private static void editTrigDelay(final MainActivity a, final Settings s,
                                      final Settings.TriggerCfg t) {
        final Nav.NumField n = new Nav.NumField("최대 지연 (초)", "0", 0, 60, t.delayMs / 1000);
        Nav.editNums(a, "랜덤 지연", "0부터 이 값 사이에서 임의로 지연한 후 발송합니다. 0은 즉시 발송입니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        int old = t.delayMs;
                        t.delayMs = n.value * 1000;
                        String bad = trigCheck(t);
                        if (bad != null) { t.delayMs = old; return bad; }
                        save(a, s);
                        return null;
                    }
                });
    }

    private static void editTrigCooldown(final MainActivity a, final Settings s,
                                         final Settings.TriggerCfg t) {
        final Nav.NumField n = new Nav.NumField("재발동 간격 (초)", "60", 0, 86400,
                (int) (t.cooldownMs / 1000L));
        Nav.editNums(a, "재발동 간격", "이 시간 내에는 같은 규칙이 다시 발동하지 않습니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        long old = t.cooldownMs;
                        t.cooldownMs = n.value * 1000L;
                        String bad = trigCheck(t);
                        if (bad != null) { t.cooldownMs = old; return bad; }
                        save(a, s);
                        return null;
                    }
                });
    }

    /** 발송 대화방 하나 고르기 (비우면 감지된 대화방으로 발송) */
    private static void pickTrigTarget(final MainActivity a, final Settings s,
                                       final Settings.TriggerCfg t) {
        final List<KakaoListener.RoomInfo> known = knownRooms(a);
        final ArrayList<String> labels = new ArrayList<String>();
        final ArrayList<String> keys = new ArrayList<String>();
        labels.add("감지된 대화방");
        keys.add("");
        for (int i = 0; i < known.size(); i++) {
            labels.add(known.get(i).ref.label(a));
            keys.add(known.get(i).ref.key());
        }
        labels.add("직접 입력");
        keys.add(null);

        int sel = 0;
        String cur = (t.target == null) ? "" : t.target.trim();
        if (cur.length() > 0) {
            String want = RoomRef.parse(cur).key();
            for (int i = 1; i < keys.size() - 1; i++) {
                if (want.equals(keys.get(i))) { sel = i; break; }
            }
        }
        String[] ls = labels.toArray(new String[labels.size()]);
        String[] ds = new String[ls.length];
        ds[0] = "감지된 대화방에 그대로 발송합니다";
        ds[ds.length - 1] = "감지되지 않은 대화방 이름을 직접 입력합니다";
        Nav.choose(a, "발송 대화방", ls, ds, sel, new Nav.OnPick() {
            @Override public void pick(int index) {
                if (index < 0 || index >= keys.size()) return;
                String k = keys.get(index);
                if (k == null) {
                    manualRoom(a, new OnRoom() {
                        @Override public void room(RoomRef r) {
                            t.target = r.key();
                            save(a, s);
                            Log.add(a, "규칙 「" + t.title() + "」 의 발송 대화방을 변경했습니다.");
                        }
                    });
                    return;
                }
                t.target = k;
                save(a, s);
                Log.add(a, "규칙 「" + t.title() + "」 의 발송 대화방을 변경했습니다.");
            }
        });
    }

    /** 규칙 검증 — 통과하면 null */
    private static String trigCheck(Settings.TriggerCfg t) {
        try {
            return Trigger.validate(t);
        } catch (Throwable e) {
            return "규칙 검사 중 오류가 발생했습니다. (" + e.getClass().getSimpleName() + ")";
        }
    }

    private static String modeKr(String mode) {
        if (Settings.MODE_EXACT.equals(mode)) return "정확히";
        if (Settings.MODE_STARTS.equals(mode)) return "시작";
        if (Settings.MODE_REGEX.equals(mode)) return "정규식";
        return "포함";
    }

    private static RefList trigRooms(final MainActivity a, final Settings s,
                                     final Settings.TriggerCfg t) {
        return new RefList() {
            @Override public List<RoomRef> get() { return t.roomRefs(); }
            @Override public void set(List<RoomRef> list) {
                t.setRoomRefs(list);
                save(a, s);
            }
        };
    }

    // ── 5. 갠톡 자동응답 ───────────────────────────────────────────────

    public static View autoReply(MainActivity a) {
        return screen(a, Theme.F_REPLY, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final Settings.AutoReplyCfg r = s.autoreply;
                final int fc = Theme.F_REPLY;

                LinearLayout hero = Ui.hero(a, fc, Icon.REPLY, "AUTO REPLY", "갠톡 자동응답",
                        "오픈프로필 등 1:1 대화에 지정한 메시지를 발송합니다.");
                hero.addView(Ui.heroRule(a, fc));
                hero.addView(Ui.switchRow(a, r.enabled ? "사용 중" : "사용 안 함",
                        "금일 응답 " + AutoReply.today(a) + "회 · 최대 " + r.dailyLimit + "회",
                        r.enabled, new Ui.OnToggle() {
                            @Override public void on(boolean v) {
                                r.enabled = v;
                                ScreenMacro.apply(a, s);
                                ScreenMacro.refresh();
                                Log.add(a, v ? "갠톡 자동응답을 사용으로 변경했습니다."
                                        : "갠톡 자동응답을 미사용으로 변경했습니다.");
                                refresh();
                            }
                        }));
                col.addView(hero);

                col.addView(Ui.sectionHeader(a, null, "응답 내용"));
                LinearLayout g1 = Ui.group(a);
                boolean noMsg = (r.message == null || r.message.trim().length() == 0);
                g1.addView(Ui.navRow(a, Icon.BUBBLE, fc, "응답 메시지",
                        noMsg ? "설정 필요" : Nav.preview(r.message, 18),
                        noMsg ? Theme.AMBER : Theme.TEXT, new Runnable() {
                            @Override public void run() { editReplyMsg(a, s, r); }
                        }));
                g1.addView(Ui.navRow(a, Icon.USERS, fc, "적용 대상", ScreenMacro.scopeKr(r.scope), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { pickScope(a, s, r); }
                        }));
                if (Settings.SCOPE_EXCEPT.equals(r.scope)) {
                    final int n = r.exceptRoomRefs().size();
                    g1.addView(Ui.navRow(a, Icon.ROOMS, fc, "제외 대화방", (n == 0) ? "없음" : (n + "개"),
                            (n == 0) ? Theme.AMBER : Theme.TEXT, new Runnable() {
                                @Override public void run() {
                                    Nav.push(a, "제외 대화방", roomSelect(a, exceptRooms(a, s, r),
                                            "선택한 대화방에는 자동응답을 발송하지 않습니다."));
                                }
                            }));
                }
                col.addView(g1);

                col.addView(Ui.sectionHeader(a, null, "응답 조건"));
                LinearLayout g2 = Ui.group(a);
                g2.addView(Ui.navRow(a, Icon.CLOCK, fc, "운영 시간", hoursKr(r), Theme.TEXT, new Runnable() {
                    @Override public void run() { editHours(a, s, r); }
                }));
                g2.addView(Ui.navRow(a, Icon.ALARM, fc, "재응답 간격", Nav.dur(r.cooldownMs), Theme.TEXT, new Runnable() {
                    @Override public void run() { editReplyCooldown(a, s, r); }
                }));
                g2.addView(Ui.navRow(a, Icon.GAUGE, fc, "1일 최대 응답",
                        r.dailyLimit + "회 · 금일 " + AutoReply.today(a) + "회", Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editReplyLimit(a, s, r); }
                        }));
                g2.addView(Ui.navRow(a, Icon.SPARK, fc, "랜덤 지연",
                        (r.delayMaxMs <= 0) ? "없음" : ("0~" + (r.delayMaxMs / 1000) + "초"),
                        (r.delayMaxMs <= 0) ? Theme.DIM : Theme.TEXT, new Runnable() {
                            @Override public void run() { editReplyDelay(a, s, r); }
                        }));
                g2.addView(Ui.navRowSwitch(a, "최초 1회만",
                        "상대의 첫 메시지에만 응답하고 이후 메시지는 무시합니다.",
                        r.firstOnly, new Ui.OnToggle() {
                            @Override public void on(boolean v) {
                                r.firstOnly = v;
                                ScreenMacro.apply(a, s);
                            }
                        }));
                col.addView(g2);
            }
        });
    }

    private static void editReplyMsg(final MainActivity a, final Settings s,
                                     final Settings.AutoReplyCfg r) {
        Nav.editText(a, "응답 메시지", "예) 안녕하세요 {이름}님, 확인 후 회신드립니다", r.message, true,
                "{이름} {시간} {날짜} 이 치환됩니다. 최대 2000자.", new Nav.OnText() {
                    @Override public String text(String value) {
                        if (value == null || value.trim().length() == 0) {
                            return "응답 메시지를 입력하십시오.";
                        }
                        if (value.length() > 2000) return "2000자 이하로 입력하십시오.";
                        r.message = value;
                        save(a, s);
                        Log.add(a, "자동응답 메시지를 변경했습니다.");
                        return null;
                    }
                });
    }

    private static void pickScope(final MainActivity a, final Settings s,
                                  final Settings.AutoReplyCfg r) {
        int sel = 0;
        for (int i = 0; i < Settings.SCOPES.length; i++) {
            if (Settings.SCOPES[i].equals(r.scope)) sel = i;
        }
        Nav.choose(a, "적용 대상",
                new String[] { "모든 1:1", "미등록 상대만", "특정 대화방 제외" },
                new String[] { "모든 1:1 대화에 응답합니다",
                        "이전 응답 이력이 없는 상대에게만 응답합니다",
                        "지정한 대화방을 제외하고 응답합니다" },
                sel, new Nav.OnPick() {
                    @Override public void pick(int index) {
                        if (index < 0 || index >= Settings.SCOPES.length) return;
                        r.scope = Settings.SCOPES[index];
                        save(a, s);
                        Log.add(a, "자동응답 적용 대상을 " + ScreenMacro.scopeKr(r.scope) + " 로 변경했습니다.");
                    }
                });
    }

    private static void editHours(final MainActivity a, final Settings s,
                                  final Settings.AutoReplyCfg r) {
        final Nav.NumField from = new Nav.NumField("시작 시 (0~24)", "9", 0, 24, r.hourFrom);
        final Nav.NumField to = new Nav.NumField("종료 시 (0~24)", "23", 0, 24, r.hourTo);
        Nav.editNums(a, "운영 시간",
                "이 시간대에만 응답합니다. 시작과 종료가 같으면 24시간 응답합니다. 22~6 처럼 자정을 넘겨도 됩니다.",
                new Nav.NumField[] { from, to }, new Nav.OnNums() {
                    @Override public String ok() {
                        r.hourFrom = from.value;
                        r.hourTo = to.value;
                        save(a, s);
                        return null;
                    }
                });
    }

    private static void editReplyCooldown(final MainActivity a, final Settings s,
                                          final Settings.AutoReplyCfg r) {
        final Nav.NumField n = new Nav.NumField("간격 (분)", "360", 0, 10080,
                (int) (r.cooldownMs / 60000L));
        Nav.editNums(a, "재응답 간격", "같은 상대에게 이 시간 내에는 다시 응답하지 않습니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        r.cooldownMs = n.value * 60000L;
                        save(a, s);
                        return null;
                    }
                });
    }

    private static void editReplyLimit(final MainActivity a, final Settings s,
                                       final Settings.AutoReplyCfg r) {
        final Nav.NumField n = new Nav.NumField("1일 최대 응답 수", "100", 1, 2000, r.dailyLimit);
        Nav.editNums(a, "1일 최대 응답", "자정에 초기화됩니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        r.dailyLimit = n.value;
                        save(a, s);
                        return null;
                    }
                });
    }

    private static void editReplyDelay(final MainActivity a, final Settings s,
                                       final Settings.AutoReplyCfg r) {
        final Nav.NumField n = new Nav.NumField("최대 지연 (초)", "30", 0, 120, r.delayMaxMs / 1000);
        Nav.editNums(a, "랜덤 지연", "0부터 이 값 사이에서 임의로 지연한 후 응답합니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        r.delayMaxMs = n.value * 1000;
                        save(a, s);
                        return null;
                    }
                });
    }

    private static String hoursKr(Settings.AutoReplyCfg r) {
        if (r.hourFrom == r.hourTo) return "24시간";
        if (r.hourFrom == 0 && r.hourTo == 24) return "24시간";
        return r.hourFrom + "시~" + r.hourTo + "시";
    }

    private static RefList exceptRooms(final MainActivity a, final Settings s,
                                       final Settings.AutoReplyCfg r) {
        return new RefList() {
            @Override public List<RoomRef> get() { return r.exceptRoomRefs(); }
            @Override public void set(List<RoomRef> list) {
                r.setExceptRoomRefs(list);
                save(a, s);
            }
        };
    }

    // ── 대화방 다중 선택 서브화면 ───────────────────────────────────────────
    //  방(매크로)은 ScreenRooms 가 담당한다. 이 화면은 규칙·자동응답처럼
    //  "설정 안에서 대화방 목록을 고르는" 자리에 쓴다. 고르면 즉시 저장한다.

    /** 어떤 설정의 대화방 목록인지 (읽고 쓰는 방법만 넘긴다) */
    private interface RefList {
        List<RoomRef> get();
        void set(List<RoomRef> list);
    }

    private interface OnRoom { void room(RoomRef r); }

    private static View roomSelect(MainActivity a, final RefList rl, final String help) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final List<RoomRef> picked = rl.get();
                final List<KakaoListener.RoomInfo> known = knownRooms(a);
                final boolean multi = Accounts.multi(a);

                if (help != null && help.length() > 0) {
                    col.addView(Nav.note(a, help, Theme.ACCENT2, null, null));
                    col.addView(Nav.gap(a, 6));
                }

                if (known.isEmpty() && picked.isEmpty()) {
                    col.addView(Ui.sectionHeader(a, null, "감지된 대화방"));
                    LinearLayout box = Ui.card(a);
                    box.addView(Ui.sub(a, "감지된 대화방이 없습니다."
                            + " 카카오톡 메시지를 1회 수신하면 자동으로 등록되며, 직접 입력하여 추가할 수도 있습니다."));
                    col.addView(box);
                } else if (!multi) {
                    col.addView(Ui.sectionHeader(a, null, "감지된 대화방"));
                    col.addView(rows(a, rl, known));
                } else {
                    // 계정이 2개 이상일 때만 계정 머리글을 붙인다 (UI_V3 6장).
                    // 계정 목록이 아니라 실제 감지된 방의 계정을 훑는다 — 등록이 늦은 계정의 방도 빠지지 않게.
                    ArrayList<String> accs = new ArrayList<String>();
                    for (int i = 0; i < known.size(); i++) {
                        String k = known.get(i).ref.acc;
                        if (!accs.contains(k)) accs.add(k);
                    }
                    for (int i = 0; i < accs.size(); i++) {
                        String k = accs.get(i);
                        ArrayList<KakaoListener.RoomInfo> mine = new ArrayList<KakaoListener.RoomInfo>();
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
                                    @Override public void on(boolean v) { toggle(a, rl, r, v); }
                                },
                                new Runnable() {
                                    @Override public void run() {
                                        toggle(a, rl, r, false);
                                        refresh();
                                        Nav.snack("「" + r.label(a) + "」 제외", null, null);
                                    }
                                }));
                    }
                    col.addView(g);
                }

                col.addView(Nav.wideBtn(a, "직접 입력 추가", false, new Runnable() {
                    @Override public void run() {
                        manualRoom(a, new OnRoom() {
                            @Override public void room(RoomRef r) {
                                toggle(a, rl, r, true);
                                refresh();
                            }
                        });
                    }
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
                @Override public void on(boolean v) { toggle(a, rl, ref, v); }
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
    private static void toggle(MainActivity a, RefList rl, RoomRef r, boolean on) {
        if (r == null || !r.valid()) return;
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
    private static void manualRoom(final MainActivity a, final OnRoom cb) {
        final List<Accounts.Acc> accs = Accounts.all(a);
        if (!Accounts.multi(a) || accs.size() < 2) {
            String acc = accs.isEmpty() ? RoomRef.DEFAULT_ACC : accs.get(0).key;
            askRoomName(a, acc, cb);
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
                askRoomName(a, accs.get(index).key, cb);
            }
        });
    }

    private static void askRoomName(final MainActivity a, final String acc, final OnRoom cb) {
        Nav.editText(a, "대화방 직접 입력", "카카오톡에 표시되는 대화방 이름", "", false,
                "카카오톡에 표시되는 이름과 정확히 일치해야 발송됩니다.", new Nav.OnText() {
                    @Override public String text(String value) {
                        RoomRef r = RoomRef.of(acc, value);
                        if (!r.valid()) return "대화방 이름을 입력하십시오.";
                        if (cb != null) cb.room(r);
                        Log.add(a, "대화방 「" + r.label(a) + "」 을(를) 직접 추가했습니다.");
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

    // ── 입력칸 ──────────────────────────────────────────────────────────────

    private static TextView fieldLabel(MainActivity a, String s, int topDp) {
        TextView t = Ui.label(a, s);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(a, topDp);
        lp.bottomMargin = Theme.dp(a, 6);
        t.setLayoutParams(lp);
        return t;
    }

    private static android.widget.EditText line(MainActivity a, String hint, String value) {
        android.widget.EditText e = Ui.field(a, hint);
        e.setSingleLine(true);
        e.setGravity(android.view.Gravity.CENTER_VERTICAL | android.view.Gravity.START);
        e.setText((value == null) ? "" : value);
        return e;
    }

    private static android.widget.EditText multi(MainActivity a, String hint, String value) {
        android.widget.EditText e = Ui.field(a, hint);
        e.setInputType(android.text.InputType.TYPE_CLASS_TEXT
                | android.text.InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        e.setMinLines(3);
        e.setMaxLines(8);
        e.setText((value == null) ? "" : value);
        return e;
    }
}
