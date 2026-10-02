package com.buseong.kakaoauto;

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
    //  서브화면은 중첩된다 (메시지 추적 → 규칙 → 감지 대화방). 값이 바뀌면 지금 열려 있는
    //  화면 전부를 제자리에서 다시 그려야 하니까, 화면마다 "다시 채우는 방법" 을 들고 있는다.

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
            Log.add(a, "설정 화면 구성에 실패했습니다: " + t);
        }
        return Ui.scroll(a, col);
    }

    /** 지금 열려 있는 상세 화면을 모두 제자리에서 다시 그린다 */
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
                Log.add(a, "설정 화면 갱신에 실패했습니다: " + t);
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

    /** 저장 + 열려 있는 화면 전부 갱신 (탭 요약까지) */
    private static void save(MainActivity a, Settings s) {
        ScreenMacro.apply(a, s);
        refresh();
        ScreenMacro.refresh();
    }

    // ── 1. 메시지 ───────────────────────────────────────────────────────────

    public static View message(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final boolean empty = (s.macro.message == null || s.macro.message.trim().length() == 0);

                col.addView(Ui.sectionHeader(a, null, "발송 메시지 (기본값)"));
                LinearLayout g = Ui.group(a);
                g.addView(Ui.navRow(a, "메시지 편집", empty ? "설정 필요" : "수정",
                        empty ? Theme.AMBER : Theme.SUB, new Runnable() {
                            @Override public void run() { editMessage(a, s); }
                        }));
                col.addView(g);

                TextView prev = Ui.body(a, empty ? "설정되지 않았습니다." : s.macro.message);
                prev.setTextColor(empty ? Theme.DIM : Theme.TEXT);
                prev.setMaxLines(12);
                prev.setEllipsize(TextUtils.TruncateAt.END);
                prev.setBackground(Theme.round(Theme.CARD, Theme.R_LG, Theme.LINE, 1, a));
                int p = Theme.dp(a, 16);
                prev.setPadding(p, p, p, p);
                LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(MATCH, WRAP);
                prev.setLayoutParams(pp);
                col.addView(prev);

                col.addView(Nav.note(a, "입력한 내용이 그대로 발송되며 여러 줄 입력이 유지됩니다.\n"
                        + "이 메시지는 전역 기본값입니다. 계정별 기본값·대화방별 설정이 있으면 그 값이 우선 발송됩니다.\n"
                        + "치환 토큰은 메시지 추적·자동응답에서만 적용됩니다.", Theme.ACCENT2, null, null));
            }
        });
    }

    private static void editMessage(final MainActivity a, final Settings s) {
        Nav.editText(a, "발송 메시지", "발송할 내용을 입력하십시오", s.macro.message, true,
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

    // ── 2. 쿨타임 (전역 기본값) ──────────────────────────────────────────────
    //  이 화면은 전역 기본값을 편집한다. 계정별 기본값·방별 덮어쓰기가 있으면 그 값이 우선한다.

    public static View cycle(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);

                col.addView(Ui.sectionHeader(a, null, "쿨타임 (기본값)"));
                LinearLayout g = Ui.group(a);
                g.addView(Ui.navRow(a, "쿨타임",
                        s.macro.cooldownMinMin + "~" + s.macro.cooldownMaxMin + "분", Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editCooldown(a, s); }
                        }));
                g.addView(Ui.navRow(a, "최소 신규 메시지", s.macro.minMessages + "개", Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editMinMessages(a, s); }
                        }));
                col.addView(g);

                col.addView(Nav.note(a, "발송 후 다음 발송까지 대기하는 시간입니다."
                        + " 최소~최대 사이의 임의 시각에 발송됩니다.\n"
                        + "이 값은 전역 기본값입니다. 계정별 기본값·대화방별 설정이 있으면 그 값이 우선 적용됩니다.",
                        Theme.ACCENT2, null, null));
            }
        });
    }

    private static void editCooldown(final MainActivity a, final Settings s) {
        final Nav.NumField lo = new Nav.NumField("최소 쿨타임 (분)", "20", 1, 1440, s.macro.cooldownMinMin);
        final Nav.NumField hi = new Nav.NumField("최대 쿨타임 (분)", "40", 1, 1440, s.macro.cooldownMaxMin);
        Nav.editNums(a, "쿨타임 (기본값)", "최소~최대 사이의 임의 시각에 발송됩니다.",
                new Nav.NumField[] { lo, hi }, new Nav.OnNums() {
                    @Override public String ok() {
                        if (lo.value > hi.value) {
                            Nav.errText(hi.err, "최대 쿨타임은 최소 쿨타임 이상으로 입력하십시오");
                            return "";
                        }
                        s.macro.cooldownMinMin = lo.value;
                        s.macro.cooldownMaxMin = hi.value;
                        save(a, s);
                        Log.add(a, "기본 쿨타임을 " + lo.value + "~" + hi.value + "분으로 변경했습니다.");
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

    public static View image(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);

                View warn = ScreenMacro.imgFailNote(a);
                if (warn != null) col.addView(warn);

                // ── 첨부 이미지 ──
                col.addView(Ui.sectionHeader(a, null, "첨부 이미지"));
                LinearLayout card = Ui.card(a);
                card.addView(Ui.label(a, "최대 " + Settings.MAX_IMAGES + "장"));

                final LinearLayout strip = new LinearLayout(a);
                strip.setOrientation(LinearLayout.HORIZONTAL);
                card.addView(Nav.thumbStrip(a, strip));
                paintThumbs(a, s, strip);

                final int left = Math.max(0, Settings.MAX_IMAGES - s.macro.images.size());
                card.addView(Nav.wideBtn(a, (left > 0) ? ("이미지 선택 (" + left + "장 추가 가능)")
                        : ("첨부 한도 도달 · 최대 " + Settings.MAX_IMAGES + "장"), false, new Runnable() {
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
                col.addView(card);

                // ── 전송 방식 ──
                col.addView(Ui.sectionHeader(a, null, "전송 방식"));
                LinearLayout g = Ui.group(a);
                g.addView(Ui.navRow(a, "전송 모드", ScreenMacro.imgModeKr(s.macro.sendImages),
                        Settings.IMG_NEVER.equals(s.macro.sendImages) ? Theme.DIM : Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { pickImgMode(a, s); }
                        }));
                if (Settings.IMG_EVERY_N.equals(s.macro.sendImages)) {
                    g.addView(Ui.navRow(a, "전송 주기", s.macro.imageEveryN + "회마다", Theme.TEXT,
                            new Runnable() {
                                @Override public void run() { editEveryN(a, s); }
                            }));
                }
                // 카카오톡이 "이미지를 받는다" 고 해놓고 무시하면 앱은 성공으로 보고한다 —
                // 실제 업로드 여부를 확인할 방법이 없어서 사용자가 끌 수 있어야 한다.
                boolean replyImg;
                try { replyImg = ImageSender.replyImageEnabled(a); } catch (Throwable t) { replyImg = false; }
                g.addView(Ui.navRowSwitch(a, "알림 답장 전송",
                        "화면 전환 없이 전송합니다. 발송 기록만 남고 실제 전송이 되지 않으면 미사용으로 설정하십시오.",
                        replyImg, new Ui.OnToggle() {
                            @Override public void on(boolean v) {
                                try {
                                    ImageSender.setReplyImageEnabled(a, v);
                                } catch (Throwable t) {
                                    Log.add(a, "알림 답장 전송 설정을 저장하지 못했습니다: " + t);
                                }
                                Log.add(a, v ? "알림 답장 이미지 전송을 사용으로 변경했습니다."
                                        : "알림 답장 이미지 전송을 미사용으로 변경했습니다.");
                            }
                        }));
                // 채팅방 첨부 경로는 카카오톡 화면을 실제로 조작한다(채팅방이 열리고 시트가 떴다 닫힌다).
                // 화면이 움직이는 것을 원하지 않는 사용자는 끌 수 있어야 한다.
                boolean attachImg;
                try { attachImg = ImageSender.attachEnabled(a); } catch (Throwable t) { attachImg = false; }
                g.addView(Ui.navRowSwitch(a, "채팅방 첨부 전송",
                        "대화방을 열어 이미지를 첨부합니다. 카카오톡 화면이 일시적으로 전환됩니다.",
                        attachImg, new Ui.OnToggle() {
                            @Override public void on(boolean v) {
                                try {
                                    ImageSender.setAttachEnabled(a, v);
                                } catch (Throwable t) {
                                    Log.add(a, "채팅방 첨부 전송 설정을 저장하지 못했습니다: " + t);
                                }
                            }
                        }));
                col.addView(g);

                // ── 점검 · 문제 해결 ──
                // 권한/상태 경고 4건은 '전송 점검' 한 행으로 접고(값에 '주의 N건'),
                // 진단 기록·전용 기기 설정·즉시 발송·전송 진단은 '전송 문제 해결' 서브화면으로 모은다.
                // 상단 본문은 첨부 이미지·전송 방식 두 섹션만 남는다 (UI_V3 §3 화면당 ≤7 · 섹션 ≤3).
                col.addView(Ui.sectionHeader(a, null, "점검 · 문제 해결"));
                final int checks = imgCheckCount(a);
                LinearLayout g2 = Ui.group(a);
                g2.addView(Ui.navRow(a, "전송 점검",
                        (checks > 0) ? ("주의 " + checks + "건") : "정상",
                        (checks > 0) ? Theme.AMBER : Theme.ACCENT, new Runnable() {
                            @Override public void run() { Nav.push(a, "전송 점검", transmitCheck(a)); }
                        }));
                g2.addView(Ui.navRow(a, "전송 문제 해결", null, 0, new Runnable() {
                    @Override public void run() { Nav.push(a, "전송 문제 해결", troubleshoot(a)); }
                }));
                col.addView(g2);
            }
        });
    }

    /** '전송 점검' 행의 값에 쓸 주의 건수 (접근성·오버레이·타사 접근성·백그라운드 차단) */
    private static int imgCheckCount(MainActivity a) {
        int n = 0;
        try { if (!ImageSender.accessibilityOn(a)) n++; } catch (Throwable t) { n++; }
        try { if (!ImageSender.overlayOn(a)) n++; } catch (Throwable t) { n++; }
        try { if (ImageSender.otherAccessibilityOn(a)) n++; } catch (Throwable t) { /* 무시 */ }
        try { if (ImageSender.backgroundBlockedAt(a) > 0L) n++; } catch (Throwable t) { /* 무시 */ }
        return n;
    }

    /** 전송 점검 — 권한/상태 경고를 한 화면에 모은다 (상단 본문에서 접어 내린 서브화면) */
    private static View transmitCheck(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                col.addView(Ui.sectionHeader(a, null, "전송 점검"));
                boolean any = false;

                boolean accOn;
                try { accOn = ImageSender.accessibilityOn(a); } catch (Throwable t) { accOn = false; }
                if (!accOn) {
                    any = true;
                    col.addView(Nav.note(a, "접근성 권한이 비활성 상태입니다."
                            + " 이미지 전송이 불가하며, 텍스트 발송은 정상 동작합니다.",
                            Theme.AMBER, "권한 설정", new Runnable() {
                                @Override public void run() { ImageSender.openSettings(a); }
                            }));
                }
                boolean ovOn;
                try { ovOn = ImageSender.overlayOn(a); } catch (Throwable t) { ovOn = false; }
                if (!ovOn) {
                    any = true;
                    col.addView(Nav.note(a, "「다른 앱 위에 표시」 권한이 비활성 상태입니다."
                            + " 예약 발송에서 시스템이 공유창 실행을 차단할 수 있습니다."
                            + " 앱이 화면에 표시된 상태에서는 이 권한 없이도 동작할 수 있습니다.",
                            Theme.AMBER, "권한 설정", new Runnable() {
                                @Override public void run() { ImageSender.openOverlaySettings(a); }
                            }));
                }
                // 타사 접근성 자동화 앱은 차단하지 않는다. 자동 클릭이 공유 화면을 함께 조작하면
                // 전송이 실패하므로 사실만 알린다 (진단 기록에도 같은 항목이 들어간다).
                String otherAcc;
                try { otherAcc = ImageSender.otherAccessibilityOn(a) ? ImageSender.otherAccessibility(a) : ""; }
                catch (Throwable t) { otherAcc = ""; }
                if (otherAcc.length() > 0) {
                    any = true;
                    col.addView(Nav.note(a, ImageSender.OTHER_ACC_HELP + "\n활성 앱: " + otherAcc,
                            Theme.AMBER, null, null));
                }
                // 백그라운드 전송 불가로 확정된 상태 — 예약 발송에서는 이미지가 생략된다
                long bgAt;
                try { bgAt = ImageSender.backgroundBlockedAt(a); } catch (Throwable t) { bgAt = 0L; }
                if (bgAt > 0L) {
                    any = true;
                    col.addView(Nav.note(a, "예약 발송에서 카카오톡 공유창이 "
                            + ImageSender.BG_FAIL_LIMIT + "회 연속 표시되지 않았습니다."
                            + " 현재 예약 발송은 이미지를 생략하고 텍스트만 발송합니다."
                            + " 전송 문제 해결의 즉시 이미지 발송으로 1회 전송에 성공하면 예약 발송이 다시 이미지를 첨부합니다.",
                            Theme.AMBER, null, null));
                }

                if (!any) {
                    col.addView(Nav.note(a, "현재 점검할 항목이 없습니다. 이미지 전송 준비가 완료된 상태입니다.",
                            Theme.ACCENT2, null, null));
                }
            }
        });
    }

    /** 전송 문제 해결 — 진단 기록·전용 기기 설정·즉시 발송·전송 진단을 모은 서브화면 */
    private static View troubleshoot(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);

                col.addView(Ui.sectionHeader(a, null, "기록 · 안내"));
                final long dumpAt = ScreenMacro.dumpAtSafe(a);
                LinearLayout g = Ui.group(a);
                g.addView(Ui.navRow(a, "진단 기록",
                        (dumpAt > 0) ? ScreenMacro.agoShort(dumpAt) : "없음",
                        (dumpAt > 0) ? Theme.TEXT : Theme.DIM, new Runnable() {
                            @Override public void run() { ScreenMacro.showDiag(a); }
                        }));
                g.addView(Ui.navRow(a, "전용 기기 설정 안내", null, 0, new Runnable() {
                    @Override public void run() { Nav.push(a, "전용 기기 설정", deviceGuide(a)); }
                }));
                col.addView(g);

                final List<RoomRef> rooms = s.macro.roomRefs();
                final TextView now = Ui.btn(a, "즉시 이미지 발송", false);
                LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(MATCH, WRAP);
                np.topMargin = Theme.dp(a, 10);
                now.setLayoutParams(np);
                now.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { sendImagesNow(a, s, now); }
                });
                col.addView(now);

                final TextView diag = Ui.btn(a, "전송 진단", false);
                LinearLayout.LayoutParams dp2 = new LinearLayout.LayoutParams(MATCH, WRAP);
                dp2.topMargin = Theme.dp(a, 8);
                diag.setLayoutParams(dp2);
                diag.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { ScreenMacro.runDiag(a, s, diag); }
                });
                col.addView(diag);

                if (rooms.size() > 1) {
                    col.addView(Ui.sub(a, "즉시 이미지 발송·전송 진단은 대상 대화방 중 첫 번째"
                            + "(「" + rooms.get(0).label(a) + "」)에만 전송됩니다."));
                }
                col.addView(Ui.sub(a, "전송 진단은 실제 전송을 1회 수행하며, 실패 시 카카오톡 화면 구성을 기록합니다."
                        + " 기록된 내용을 개발자에게 전달하면 원인 분석이 가능합니다."));
            }
        });
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
        String[] labels = { "안 보냄", "매번", "N회마다", "수동 전송만" };
        String[] descs = {
                "이미지를 첨부하지 않습니다",
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

    /**
     * 매크로 전용 기기(평소에 쓰지 않는 여분 기기) 설정 안내.
     * 이미지 전송은 카카오톡 공유 화면을 실제로 조작해야 해서 화면이 꺼지거나 잠겨 있으면 동작하지 않는다.
     * 현장 실패의 절반이 이 세 항목에서 해결되므로 별도 화면으로 둔다.
     */
    private static View deviceGuide(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(MainActivity a, LinearLayout col) {
                col.addView(Ui.sectionHeader(a, null, "설정 항목"));
                LinearLayout card = Ui.card(a);
                card.addView(step(a, "1. 설정 › 잠금화면 › 화면 잠금 방식을 「없음」 으로 설정하십시오."
                        + " 잠금 상태에서는 공유 화면 조작이 불가합니다.", false));
                card.addView(step(a, "2. 개발자 옵션 › 「충전 중 화면 켜짐 유지」 를 활성화하십시오."
                        + " 화면 절전 해제 단계가 없어져 실패율이 감소합니다.", true));
                card.addView(step(a, "3. 충전기를 연결하십시오. 2번 항목은 충전 중에만 적용됩니다.", true));
                col.addView(card);

                col.addView(Nav.note(a, "이미지 전송 시 카카오톡 화면이 표시됩니다. 텍스트 발송은 화면 전환이 없습니다.",
                        Theme.ACCENT2, null, null));
                col.addView(Nav.note(a, "전용 기기에만 적용하십시오."
                        + " 상시 사용 기기는 화면 잠금 해제 시 보안이 취약해지며, 이미지 전송 시마다 화면이 전환됩니다.",
                        Theme.AMBER, null, null));
            }
        });
    }

    private static TextView step(MainActivity a, String text, boolean gap) {
        TextView t = Ui.sub(a, text);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        if (gap) lp.topMargin = Theme.dp(a, 12);
        t.setLayoutParams(lp);
        return t;
    }

    /** 즉시 이미지 발송 — 대상 대화방 중 첫 번째 한 곳으로만 보낸다 */
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
            Ui.toast(a, all.isEmpty() ? "대상 대화방을 먼저 설정하십시오."
                    : "대상 대화방이 모두 미사용 계정에 속합니다.");
            return;
        }
        boolean accOn;
        try { accOn = ImageSender.accessibilityOn(a); } catch (Throwable t) { accOn = false; }
        if (!accOn) {
            Nav.confirm(a, "접근성 권한 필요",
                    "이미지 전송은 카카오톡 화면을 조작하므로 접근성 권한이 필요합니다.",
                    "권한 설정", new Runnable() {
                        @Override public void run() { ImageSender.openSettings(a); }
                    });
            return;
        }

        final RoomRef room = pick;
        final String label = room.label(a);
        final String idle = "즉시 이미지 발송";
        final List<String> uris = new ArrayList<String>(s.macro.images);
        // ★ 보내기 전 화면 기록 시각. 이게 없으면 지난 덤프를 "그때 화면" 이라고 거짓말한다.
        final long dumpBefore = ScreenMacro.dumpAtSafe(a);
        Nav.busy(btn, true, "전송 중…", idle);
        // 사용자가 직접 전송을 누른 시점 = 권한을 고치고 다시 확인해보는 시점이다.
        // 백그라운드 불가 확정을 풀어 예약 발송이 다시 이미지를 시도하게 한다.
        try { ImageSender.clearBackgroundBlocked(a); } catch (Throwable ignore) { }
        Log.add(a, "이미지 " + uris.size() + "장을 「" + label + "」 로 전송합니다.");
        try {
            // ★ RoomRef 를 그대로 넘긴다. key() 를 넘기면 계정 구분자가 붙은 문자열이
            //   카톡 화면 매칭에 쓰여 어떤 텍스트와도 일치하지 않는다.
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
                    boolean freshDump = ScreenMacro.dumpAtSafe(a) > dumpBefore;
                    String msg = freshDump
                            ? (why + "\n\n실패 시점의 카카오톡 화면 구성을 기록했습니다."
                                + " 기록을 개발자에게 전달하면 원인 분석이 가능합니다.")
                            : (why + "\n\n이번 시도의 화면 기록은 없습니다."
                                + " 카카오톡 공유 화면에 도달하기 전에 종료되었습니다.");
                    Nav.confirm(a, "이미지 전송 실패", msg, "진단 보기", new Runnable() {
                        @Override public void run() { ScreenMacro.showDiag(a); }
                    });
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

    // ── 4. 메시지 추적 (트리거) ─────────────────────────────────────────────

    public static View triggers(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);

                col.addView(Ui.sectionHeader(a, null, "추적 규칙"));
                col.addView(Ui.sub(a, "지정한 문자열이 감지되면 즉시 발송합니다. 발송 주기와 독립적으로 동작합니다."));
                col.addView(Nav.gap(a, 12));

                if (s.triggers.isEmpty()) {
                    LinearLayout empty = Ui.card(a);
                    empty.addView(Ui.sub(a, "등록된 규칙이 없습니다. 아래 [규칙 추가] 를 선택하십시오."));
                    col.addView(empty);
                }
                for (int i = 0; i < s.triggers.size(); i++) {
                    col.addView(triggerCard(a, s, s.triggers.get(i)));
                }

                col.addView(Nav.wideBtn(a, "규칙 추가", false, new Runnable() {
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
        g.addView(Ui.navRow(a, "세부 설정", t.enabled ? "사용" : "미사용",
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
                col.addView(g1);

                // ── 감지 범위 ──
                // 핵심 3행(이름·문자열·비교)과 분리해 '감지 조건' 카드의 6행 과밀을 푼다.
                col.addView(Ui.sectionHeader(a, null, "감지 범위"));
                LinearLayout g1b = Ui.group(a);
                g1b.addView(Ui.navRow(a, "감지 대화방", roomBadge(a, t.roomRefs()), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() {
                                Nav.push(a, "감지 대화방", roomSelect(a, trigRooms(a, s, t),
                                        "선택하지 않으면 모든 대화방에서 감지합니다."));
                            }
                        }));
                g1b.addView(Ui.navRowSwitch(a, "대소문자 무시", null, t.ignoreCase, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        t.ignoreCase = v;
                        ScreenMacro.apply(a, s);
                    }
                }));
                g1b.addView(Ui.navRowSwitch(a, "본인 메시지 포함",
                        "본인 발송 메시지도 감지합니다. 반복 발송 위험이 있어 기본값은 미사용입니다.",
                        t.fromMe, new Ui.OnToggle() {
                            @Override public void on(boolean v) {
                                t.fromMe = v;
                                ScreenMacro.apply(a, s);
                            }
                        }));
                col.addView(g1b);

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

    // ── 5. 개인 대화 자동응답 ───────────────────────────────────────────────

    public static View autoReply(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final Settings.AutoReplyCfg r = s.autoreply;

                col.addView(Ui.sectionHeader(a, null, "자동응답"));
                LinearLayout g1 = Ui.group(a);
                g1.addView(Ui.navRowSwitch(a, "사용", "1:1 대화에 지정한 메시지를 발송합니다.",
                        r.enabled, new Ui.OnToggle() {
                            @Override public void on(boolean v) {
                                r.enabled = v;
                                ScreenMacro.apply(a, s);
                                ScreenMacro.refresh();
                                Log.add(a, v ? "개인 대화 자동응답을 사용으로 변경했습니다."
                                        : "개인 대화 자동응답을 미사용으로 변경했습니다.");
                            }
                        }));
                boolean noMsg = (r.message == null || r.message.trim().length() == 0);
                g1.addView(Ui.navRow(a, "응답 메시지",
                        noMsg ? "설정 필요" : Nav.preview(r.message, 18),
                        noMsg ? Theme.AMBER : Theme.TEXT, new Runnable() {
                            @Override public void run() { editReplyMsg(a, s, r); }
                        }));
                g1.addView(Ui.navRow(a, "적용 대상", ScreenMacro.scopeKr(r.scope), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { pickScope(a, s, r); }
                        }));
                if (Settings.SCOPE_EXCEPT.equals(r.scope)) {
                    final int n = r.exceptRoomRefs().size();
                    g1.addView(Ui.navRow(a, "제외 대화방", (n == 0) ? "없음" : (n + "개"),
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
                g2.addView(Ui.navRow(a, "운영 시간", hoursKr(r), Theme.TEXT, new Runnable() {
                    @Override public void run() { editHours(a, s, r); }
                }));
                g2.addView(Ui.navRow(a, "재응답 간격", Nav.dur(r.cooldownMs), Theme.TEXT, new Runnable() {
                    @Override public void run() { editReplyCooldown(a, s, r); }
                }));
                g2.addView(Ui.navRow(a, "랜덤 지연",
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

                // ── 키워드 규칙 ──
                // '모든 1:1 응답'(위 사용 토글)과 별개로, 특정 문자열이 감지되면 지정한 답장을 보낸다.
                // 규칙에 매치되면 일반 응답보다 먼저 발송된다.
                col.addView(Ui.sectionHeader(a, null, "키워드 규칙"));
                col.addView(Ui.sub(a, "특정 문자열이 감지되면 지정한 답장을 발송합니다."
                        + " 규칙에 매치되면 일반 응답보다 먼저 적용됩니다."));
                col.addView(Nav.gap(a, 12));

                if (r.rules.isEmpty()) {
                    LinearLayout empty = Ui.card(a);
                    empty.addView(Ui.sub(a, "등록된 규칙이 없습니다. 아래 [규칙 추가] 를 선택하십시오."));
                    col.addView(empty);
                }
                for (int i = 0; i < r.rules.size(); i++) {
                    col.addView(keywordCard(a, s, r, r.rules.get(i)));
                }

                col.addView(Nav.wideBtn(a, "규칙 추가", false, new Runnable() {
                    @Override public void run() {
                        if (r.rules.size() >= Settings.MAX_KEYWORD_RULES) {
                            Ui.toast(a, "규칙은 최대 " + Settings.MAX_KEYWORD_RULES + "개까지 등록됩니다.");
                            return;
                        }
                        newKeyword(a, s, r);
                    }
                }));
            }
        });
    }

    // ── 키워드 규칙 (오픈프로필 갠톡) ────────────────────────────────────────
    //  메시지 추적(triggerDetail)과 같은 형태의 목록·편집 UI를 쓴다.

    /** 규칙 한 건 = 사용 여부·삭제 행 + 세부 설정 행 */
    private static LinearLayout keywordCard(final MainActivity a, final Settings s,
                                            final Settings.AutoReplyCfg r,
                                            final Settings.KeywordRule k) {
        LinearLayout g = Ui.group(a);
        String[] badges = { modeKr(k.mode) };
        g.addView(Ui.checkRow(a, k.title(), kwMeta(k), badges, k.enabled,
                new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        k.enabled = v;
                        ScreenMacro.apply(a, s);
                        ScreenMacro.refresh();
                        Log.add(a, "키워드 규칙 「" + k.title() + "」 을(를) "
                                + (v ? "사용으로" : "미사용으로") + " 변경했습니다.");
                    }
                },
                new Runnable() {
                    @Override public void run() { removeKeyword(a, s, r, k); }
                }));
        g.addView(Ui.navRow(a, "세부 설정", k.enabled ? "사용" : "미사용",
                k.enabled ? Theme.TEXT : Theme.DIM, new Runnable() {
                    @Override public void run() {
                        Nav.push(a, "키워드 규칙", keywordDetail(a, k.id));
                    }
                }));
        return g;
    }

    private static String kwMeta(Settings.KeywordRule k) {
        return "「" + Nav.preview(k.pattern, 14) + "」 → " + Nav.preview(k.reply, 14);
    }

    /** 규칙 삭제 — 확인창 없이 지우고 5초간 되돌리기를 띄운다 (메시지 추적과 같은 규칙) */
    private static void removeKeyword(final MainActivity a, final Settings s,
                                      final Settings.AutoReplyCfg r, final Settings.KeywordRule k) {
        int idx = r.rules.indexOf(k);
        final int at = (idx < 0) ? r.rules.size() : idx;
        final String name = k.title();
        r.removeRule(k.id);
        save(a, s);
        Log.add(a, "키워드 규칙 「" + name + "」 을(를) 삭제했습니다.");
        Nav.snack("규칙 「" + name + "」 삭제", "되돌리기", new Runnable() {
            @Override public void run() {
                Settings now = Settings.load(a);
                Settings.AutoReplyCfg nr = now.autoreply;
                if (nr.ruleById(k.id) != null) return;
                if (nr.rules.size() >= Settings.MAX_KEYWORD_RULES) {
                    Ui.toast(a, "규칙은 최대 " + Settings.MAX_KEYWORD_RULES + "개까지 등록됩니다.");
                    return;
                }
                int pos = (at > nr.rules.size()) ? nr.rules.size() : at;
                nr.rules.add(pos, k);
                save(a, now);
                Log.add(a, "키워드 규칙 「" + name + "」 삭제를 취소했습니다.");
            }
        });
    }

    /** 새 규칙 — 필수값(감지 문자열·답장)만 받고 만든 뒤, 나머지는 세부 설정에서 고친다 */
    private static void newKeyword(final MainActivity a, final Settings s,
                                   final Settings.AutoReplyCfg r) {
        LinearLayout body = Nav.col(a);
        body.addView(fieldLabel(a, "감지 문자열", 0));
        final android.widget.EditText pat = line(a, "예) 문의", "");
        body.addView(pat);
        final TextView patErr = Nav.errLine(a);
        body.addView(patErr);

        body.addView(fieldLabel(a, "답장", 14));
        final android.widget.EditText reply = multi(a, "{이름} {시간} {날짜} 사용 가능", "");
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
                    Nav.errText(replyErr, "답장을 입력하십시오");
                    return "";
                }
                Settings.KeywordRule k = new Settings.KeywordRule();
                k.pattern = p;
                k.reply = rp;
                String why = r.addRule(k);
                if (why != null) return why;
                MacroDetail.save(a, s);
                Log.add(a, "키워드 규칙 「" + k.title() + "」 을(를) 추가했습니다.");
                return null;
            }
        });
    }

    /** 규칙 하나의 전용 서브화면. 값은 고치는 즉시 저장된다. */
    private static View keywordDetail(MainActivity a, final String id) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);
                final Settings.AutoReplyCfg r = s.autoreply;
                final Settings.KeywordRule k = r.ruleById(id);
                if (k == null) {
                    col.addView(Ui.sectionHeader(a, null, "규칙 없음"));
                    col.addView(Ui.sub(a, "삭제된 규칙입니다. 뒤로 이동하십시오."));
                    return;
                }

                // ── 감지 조건 ──
                col.addView(Ui.sectionHeader(a, null, "감지 조건"));
                LinearLayout g1 = Ui.group(a);
                g1.addView(Ui.navRow(a, "감지 문자열", Nav.preview(k.pattern, 18), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editKwPattern(a, s, r, k); }
                        }));
                g1.addView(Ui.navRow(a, "비교 방식", modeKr(k.mode), Theme.TEXT, new Runnable() {
                    @Override public void run() { pickKwMode(a, s, r, k); }
                }));
                g1.addView(Ui.navRowSwitch(a, "대소문자 무시", null, k.ignoreCase, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        k.ignoreCase = v;
                        ScreenMacro.apply(a, s);
                    }
                }));
                col.addView(g1);

                // ── 발송 ──
                col.addView(Ui.sectionHeader(a, null, "발송"));
                LinearLayout g2 = Ui.group(a);
                g2.addView(Ui.navRow(a, "답장", Nav.preview(k.reply, 18), Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editKwReply(a, s, r, k); }
                        }));
                g2.addView(Ui.navRow(a, "쿨다운", Nav.dur(k.cooldownMs), Theme.TEXT, new Runnable() {
                    @Override public void run() { editKwCooldown(a, s, r, k); }
                }));
                col.addView(g2);

                // ── 동작 ──
                col.addView(Ui.sectionHeader(a, null, "동작"));
                LinearLayout g3 = Ui.group(a);
                g3.addView(Ui.navRowSwitch(a, "사용", null, k.enabled, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        k.enabled = v;
                        ScreenMacro.apply(a, s);
                        ScreenMacro.refresh();
                    }
                }));
                col.addView(g3);

                col.addView(Nav.note(a, "쿨다운은 같은 상대에게 이 규칙을 다시 적용하기까지의 최소 간격입니다."
                        + " 답장에는 {이름} {시간} {날짜} 이 치환됩니다.", Theme.ACCENT2, null, null));

                TextView del = Ui.btn(a, "규칙 삭제", false);
                del.setTextColor(Theme.RED);
                LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
                dp.topMargin = Theme.dp(a, 10);
                del.setLayoutParams(dp);
                del.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        Nav.confirm(a, "규칙 삭제", "「" + k.title() + "」 을(를) 삭제합니다.",
                                "삭제", new Runnable() {
                                    @Override public void run() {
                                        Nav.pop();
                                        removeKeyword(a, s, r, k);
                                    }
                                });
                    }
                });
                col.addView(del);
            }
        });
    }

    private static void editKwPattern(final MainActivity a, final Settings s,
                                      final Settings.AutoReplyCfg r, final Settings.KeywordRule k) {
        Nav.editText(a, "감지 문자열", "예) 문의", k.pattern, false,
                "이 문자열이 감지되면 답장을 발송합니다.", new Nav.OnText() {
                    @Override public String text(String value) {
                        String old = k.pattern;
                        k.pattern = (value == null) ? "" : value;
                        String bad = k.validate();
                        if (bad != null) { k.pattern = old; return bad; }
                        save(a, s);
                        Log.add(a, "키워드 규칙 「" + k.title() + "」 의 감지 문자열을 변경했습니다.");
                        return null;
                    }
                });
    }

    private static void editKwReply(final MainActivity a, final Settings s,
                                    final Settings.AutoReplyCfg r, final Settings.KeywordRule k) {
        Nav.editText(a, "답장", "발송할 내용을 입력하십시오", k.reply, true,
                "{이름} {시간} {날짜} 이 치환됩니다. 최대 2000자.", new Nav.OnText() {
                    @Override public String text(String value) {
                        String old = k.reply;
                        k.reply = (value == null) ? "" : value;
                        String bad = k.validate();
                        if (bad != null) { k.reply = old; return bad; }
                        save(a, s);
                        Log.add(a, "키워드 규칙 「" + k.title() + "」 의 답장을 변경했습니다.");
                        return null;
                    }
                });
    }

    private static void pickKwMode(final MainActivity a, final Settings s,
                                   final Settings.AutoReplyCfg r, final Settings.KeywordRule k) {
        int sel = 0;
        for (int i = 0; i < Settings.MODES.length; i++) {
            if (Settings.MODES[i].equals(k.mode)) sel = i;
        }
        Nav.choose(a, "비교 방식", new String[] { "포함", "정확히", "시작", "정규식" },
                new String[] { "메시지에 포함되면 감지합니다",
                        "메시지 전체가 일치할 때만 감지합니다",
                        "메시지가 이 문자열로 시작할 때 감지합니다",
                        "정규식으로 감지합니다. 형식 오류는 저장 시 안내됩니다" },
                sel, new Nav.OnPick() {
                    @Override public void pick(int index) {
                        if (index < 0 || index >= Settings.MODES.length) return;
                        String old = k.mode;
                        k.mode = Settings.MODES[index];
                        String bad = k.validate();
                        if (bad != null) {
                            k.mode = old;
                            Ui.toast(a, bad);
                            return;
                        }
                        save(a, s);
                        Log.add(a, "키워드 규칙 「" + k.title() + "」 의 비교 방식을 "
                                + modeKr(k.mode) + " 로 변경했습니다.");
                    }
                });
    }

    private static void editKwCooldown(final MainActivity a, final Settings s,
                                       final Settings.AutoReplyCfg r, final Settings.KeywordRule k) {
        final Nav.NumField n = new Nav.NumField("쿨다운 (분)", "360", 0, 10080,
                (int) (k.cooldownMs / 60000L));
        Nav.editNums(a, "쿨다운", "같은 상대에게 이 시간 내에는 이 규칙을 다시 적용하지 않습니다.",
                new Nav.NumField[] { n }, new Nav.OnNums() {
                    @Override public String ok() {
                        k.cooldownMs = n.value * 60000L;
                        save(a, s);
                        return null;
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

    // ── 6. 발송 제한 ────────────────────────────────────────────────────────

    public static View limits(MainActivity a) {
        return screen(a, new Filler() {
            @Override public void fill(final MainActivity a, LinearLayout col) {
                final Settings s = Settings.load(a);

                col.addView(Ui.sectionHeader(a, null, "발송 제한"));
                LinearLayout g = Ui.group(a);
                String q = ScreenMacro.quietKr(s);
                g.addView(Ui.navRow(a, "방해금지 시간", q, "없음".equals(q) ? Theme.DIM : Theme.TEXT,
                        new Runnable() {
                            @Override public void run() { editQuiet(a, s); }
                        }));
                col.addView(g);

                col.addView(Nav.note(a, "방해금지 시간에는 자동발송이 중지됩니다.",
                        Theme.ACCENT2, null, null));
            }
        });
    }

    private static void editQuiet(final MainActivity a, final Settings s) {
        LinearLayout body = Nav.col(a);
        body.addView(Ui.sub(a, "해당 시간대에는 발송을 중지합니다. 두 칸을 모두 비우면 제한이 해제됩니다.\n"
                + "22:00 ~ 07:00 처럼 자정을 넘겨도 됩니다."));

        body.addView(fieldLabel(a, "시작 (HH:mm)", 14));
        final android.widget.EditText from = line(a, "22:00", s.macro.quietFrom);
        body.addView(from);
        final TextView fromErr = Nav.errLine(a);
        body.addView(fromErr);

        body.addView(fieldLabel(a, "종료 (HH:mm)", 14));
        final android.widget.EditText to = line(a, "07:00", s.macro.quietTo);
        body.addView(to);
        final TextView toErr = Nav.errLine(a);
        body.addView(toErr);

        Nav.form(a, "방해금지 시간", body, "저장", new Nav.OnSave() {
            @Override public String save() {
                Nav.errClear(fromErr);
                Nav.errClear(toErr);
                String fv = from.getText().toString().trim();
                String tv = to.getText().toString().trim();
                if (fv.length() == 0 && tv.length() == 0) {
                    s.macro.quietFrom = "";
                    s.macro.quietTo = "";
                    MacroDetail.save(a, s);
                    Log.add(a, "방해금지 시간을 해제했습니다.");
                    return null;
                }
                boolean bad = false;
                if (Settings.hhmm(fv) < 0) {
                    Nav.errText(fromErr, "HH:mm 형식으로 입력하십시오 (예 22:00)");
                    bad = true;
                }
                if (Settings.hhmm(tv) < 0) {
                    Nav.errText(toErr, "HH:mm 형식으로 입력하십시오 (예 07:00)");
                    bad = true;
                }
                if (bad) return "";
                if (Settings.hhmm(fv) == Settings.hhmm(tv)) {
                    Nav.errText(toErr, "시작과 종료가 같으면 제한이 적용되지 않습니다");
                    return "";
                }
                s.macro.quietFrom = fv;
                s.macro.quietTo = tv;
                MacroDetail.save(a, s);
                Log.add(a, "방해금지 시간을 " + fv + "~" + tv + " 로 설정했습니다.");
                return null;
            }
        });
    }

    // ── 대화방 다중 선택 서브화면 ───────────────────────────────────────────
    //  대상 대화방(매크로)은 ScreenRooms 가 담당한다. 이 화면은 규칙·자동응답처럼
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
