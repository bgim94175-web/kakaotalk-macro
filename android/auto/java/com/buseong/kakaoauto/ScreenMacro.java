package com.buseong.kakaoauto;

import android.content.Intent;
import android.graphics.Typeface;
import android.text.InputType;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;

/**
 * 매크로 화면. 자동발송 · 메시지 · 대상 방 · 주기 · 사진 첨부 · 메시지 추적 · 오픈프로필 자동응답.
 *
 * 복잡한 설정은 전부 접힌 카드(Nav.fold) 안이나 다이얼로그로 숨긴다.
 * 첫 화면에는 "지금 값" 만 보인다.
 */
public final class ScreenMacro {
    private ScreenMacro() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    // 펼쳐둔 카드 기억용 비트 (다시 그려도 접히지 않게)
    private static final int F_MSG = 1;
    private static final int F_ROOMS = 1 << 1;
    private static final int F_CYCLE = 1 << 2;
    private static final int F_IMAGE = 1 << 3;
    private static final int F_TRIG = 1 << 4;
    private static final int F_REPLY = 1 << 5;
    private static final int F_LIMIT = 1 << 6;
    private static int openBits = 0;

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    // ── 셸 ──────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        // 게이트는 진입할 때 한 번만 (refresh 때마다 창을 띄우면 성가시다)
        Gate.check(a, Features.MACRO);
        LinearLayout col = Ui.screen(a);
        ACT = new WeakReference<MainActivity>(a);
        BODY = new WeakReference<LinearLayout>(col);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "매크로 화면을 그리다 오류가 났어: " + t);
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
            Log.add(a, "매크로 화면을 갱신하다 오류가 났어: " + t);
        }
    }

    private static void fill(final MainActivity a, LinearLayout col) {
        col.addView(Ui.title(a, "매크로"));

        if (!License.allowed(a, Features.MACRO)) {
            fillLocked(a, col);
            return;
        }
        if (!Settings.canSave(a)) {
            col.addView(Nav.note(a, "설정을 저장할 수 없는 상태야 (설정키 없음).\n"
                    + "내정보 탭에서 라이선스를 다시 인증해줘.", Theme.RED, "내정보로 가기",
                    new Runnable() { @Override public void run() { Nav.go(Nav.ACCOUNT); } }));
        }

        final Settings s = Settings.load(a);

        col.addView(Ui.sub(a, "카톡 알림 답장으로 보낸다. 그 방 알림이 한 번은 와야 발송할 수 있어."));
        col.addView(Nav.gap(a, 14));

        col.addView(autoCard(a, s));

        col.addView(Ui.sectionHeader(a, "무엇을 · 어디로", "발송 내용"));
        col.addView(messageFold(a, s).card);
        col.addView(roomsFold(a, s).card);
        col.addView(cycleFold(a, s).card);

        col.addView(Ui.sectionHeader(a, "추가 기능", "사진 · 추적 · 자동응답"));
        col.addView(imageFold(a, s).card);
        col.addView(triggerFold(a, s).card);
        col.addView(replyFold(a, s).card);
        col.addView(limitFold(a, s).card);
    }

    private static void fillLocked(final MainActivity a, LinearLayout col) {
        col.addView(Ui.sub(a, "매크로 기능이 아직 켜져 있지 않아."));
        col.addView(Nav.gap(a, 14));
        LinearLayout card = Ui.card(a);
        card.addView(Ui.h2(a, Features.label(Features.MACRO)));
        TextView d = Ui.sub(a, Features.descLong(Features.MACRO));
        LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
        dp.topMargin = Theme.dp(a, 10);
        d.setLayoutParams(dp);
        card.addView(d);
        card.addView(Nav.wideBtn(a, "구매하기", true, new Runnable() {
            @Override public void run() { Gate.openBuy(a, Features.MACRO); }
        }));
        card.addView(Nav.wideBtn(a, "구매했는데 안 켜졌어 (새로고침)", false, new Runnable() {
            @Override public void run() { Nav.go(Nav.ACCOUNT); }
        }));
        col.addView(card);
    }

    // ── 1. 자동발송 ─────────────────────────────────────────────────────────

    private static LinearLayout autoCard(final MainActivity a, final Settings s) {
        LinearLayout card = Ui.card(a);

        final TextView nextLine = Ui.sub(a, nextText(a, s));
        final TextView sendBtn = Ui.btn(a, "지금 한 번 보내기", false);

        card.addView(Ui.switchRow(a, "자동발송", "정해진 주기로 대상 방에 메시지를 보낸다",
                s.macro.enabled, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        s.macro.enabled = v;
                        apply(a, s);
                        nextLine.setText(nextText(a, s));
                        Log.add(a, v ? "자동발송을 켰어" : "자동발송을 껐어");
                    }
                }));
        card.addView(Ui.divider(a));
        card.addView(nextLine);

        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
        bp.topMargin = Theme.dp(a, 12);
        sendBtn.setLayoutParams(bp);
        sendBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { sendNow(a, s, sendBtn, nextLine); }
        });
        card.addView(sendBtn);
        return card;
    }

    private static String nextText(MainActivity a, Settings s) {
        if (!s.macro.enabled) return "자동발송이 꺼져 있어. 켜면 주기에 맞춰 예약된다.";
        if (s.macro.rooms.isEmpty()) return "대상 방이 없어서 발송이 안 돼.";
        if (s.macro.message.trim().length() == 0) return "발송 메시지가 비어있어서 발송이 안 돼.";
        long at = 0L;
        try {
            at = Scheduler.nextAt(a);
        } catch (Throwable t) {
            at = s.macro.nextAt;
        }
        return "다음 발송 · " + Nav.whenRel(at);
    }

    /** 수동 발송 (주기와 무관하게 지금 한 번) */
    private static void sendNow(final MainActivity a, final Settings s, final TextView btn,
                                final TextView nextLine) {
        if (!License.allowed(a, Features.MACRO)) { Gate.check(a, Features.MACRO); return; }
        if (s.macro.rooms.isEmpty()) { Ui.toast(a, "대상 방을 먼저 추가해줘"); return; }
        final String msg = s.macro.message;
        if (msg == null || msg.trim().length() == 0) { Ui.toast(a, "보낼 메시지를 먼저 적어줘"); return; }

        Nav.busy(btn, true, "보내는 중…", "지금 한 번 보내기");
        int ok = 0;
        StringBuilder failed = new StringBuilder();
        for (int i = 0; i < s.macro.rooms.size(); i++) {
            String room = s.macro.rooms.get(i);
            boolean sent = false;
            try {
                sent = KakaoListener.sendTo(a, room, msg);
            } catch (Throwable t) {
                Log.add(a, "수동 발송 중 오류 (" + room + "): " + t);
            }
            if (sent) ok++;
            else {
                if (failed.length() > 0) failed.append(", ");
                failed.append(room);
            }
        }
        if (ok > 0) MainActivity.countSent(a, ok);
        Log.add(a, "수동 발송 · 성공 " + ok + "건"
                + ((failed.length() > 0) ? (" / 실패: " + failed) : ""));
        Nav.busy(btn, false, "보내는 중…", "지금 한 번 보내기");
        nextLine.setText(nextText(a, s));

        if (ok == 0) {
            Ui.toast(a, "한 건도 못 보냈어. 로그를 봐줘");
        } else if (failed.length() > 0) {
            Ui.toast(a, ok + "건 보냈어. 일부 방은 실패했어");
        } else {
            Ui.toast(a, ok + "건 보냈어");
        }
    }

    // ── 2. 발송 메시지 ──────────────────────────────────────────────────────

    private static Nav.Fold messageFold(final MainActivity a, final Settings s) {
        final Nav.Fold f = fold(a, F_MSG, "발송 메시지", msgSummary(s));

        final TextView prev = Ui.body(a, prevText(s.macro.message));
        prev.setMaxLines(4);
        prev.setEllipsize(TextUtils.TruncateAt.END);
        prev.setBackground(Theme.round(Theme.CARD2, Theme.R_MD, Theme.LINE, 1, a));
        int p = Theme.dp(a, 12);
        prev.setPadding(p, p, p, p);
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(MATCH, WRAP);
        pp.topMargin = Theme.dp(a, 8);
        prev.setLayoutParams(pp);
        f.body.addView(prev);

        f.body.addView(Nav.wideBtn(a, "메시지 수정", false, new Runnable() {
            @Override public void run() {
                Nav.editText(a, "발송 메시지", "여기에 보낼 내용을 적어줘", s.macro.message, true,
                        "여러 줄도 그대로 보내진다.", new Nav.OnText() {
                            @Override public String text(String value) {
                                if (value == null || value.trim().length() == 0) {
                                    return "보낼 메시지를 적어줘";
                                }
                                if (value.length() > 2000) return "2000자 이하로 줄여줘";
                                s.macro.message = value;
                                apply(a, s);
                                prev.setText(prevText(value));
                                f.summary(msgSummary(s));
                                Log.add(a, "발송 메시지를 바꿨어");
                                return null;
                            }
                        });
            }
        }));
        return f;
    }

    private static String msgSummary(Settings s) {
        String m = s.macro.message;
        if (m == null || m.trim().length() == 0) return "아직 비어있어";
        return Nav.preview(m, 48);
    }

    private static String prevText(String m) {
        if (m == null || m.trim().length() == 0) return "(비어있어)";
        return m;
    }

    // ── 3. 대상 방 ──────────────────────────────────────────────────────────

    private static Nav.Fold roomsFold(final MainActivity a, final Settings s) {
        final Nav.Fold f = fold(a, F_ROOMS, "대상 방", roomSummary(s.macro.rooms));

        f.body.addView(Ui.sub(a, "카톡에 보이는 방 이름과 정확히 같아야 해. 칩을 누르면 지워진다."));
        final Nav.Flow flow = Nav.flow(a);
        f.body.addView(flow);

        final Runnable changed = new Runnable() {
            @Override public void run() {
                apply(a, s);
                f.summary(roomSummary(s.macro.rooms));
            }
        };
        Nav.chipEditor(flow, s.macro.rooms, Theme.ACCENT, "아직 없어", changed);

        f.body.addView(Nav.wideBtn(a, "방 추가", false, new Runnable() {
            @Override public void run() {
                Nav.pickRooms(a, "대상 방 추가", KakaoListener.knownRooms(a), s.macro.rooms,
                        new Nav.OnRooms() {
                            @Override public void rooms(List<String> picked) {
                                int added = 0;
                                for (int i = 0; i < picked.size(); i++) {
                                    String v = picked.get(i);
                                    if (!s.macro.rooms.contains(v)) { s.macro.rooms.add(v); added++; }
                                }
                                changed.run();
                                Nav.chipEditor(flow, s.macro.rooms, Theme.ACCENT, "아직 없어", changed);
                                Log.add(a, "대상 방 " + added + "개를 추가했어");
                            }
                        });
            }
        }));
        return f;
    }

    private static String roomSummary(List<String> rooms) {
        if (rooms == null || rooms.isEmpty()) return "아직 없어 — 최소 1개는 필요해";
        return rooms.size() + "개 · " + Nav.preview(Nav.join(rooms, ""), 40);
    }

    // ── 4. 발송 주기 ────────────────────────────────────────────────────────

    private static Nav.Fold cycleFold(final MainActivity a, final Settings s) {
        final Nav.Fold f = fold(a, F_CYCLE, "발송 주기", cycleSummary(s));

        f.body.addView(Ui.kv(a, "간격", s.macro.intervalMinMin + " ~ " + s.macro.intervalMaxMin + "분 (랜덤)"));
        f.body.addView(Ui.kv(a, "최소 새 메시지", s.macro.minMessages + "개"));
        f.body.addView(Ui.sub(a, "내가 마지막으로 보낸 뒤 다른 사람 메시지가 이만큼 쌓여야 보낸다. 0 이면 항상 보낸다."));

        f.body.addView(Nav.wideBtn(a, "주기 수정", false, new Runnable() {
            @Override public void run() {
                final Nav.NumField lo = new Nav.NumField("최소 간격 (분)", "20", 1, 1440, s.macro.intervalMinMin);
                final Nav.NumField hi = new Nav.NumField("최대 간격 (분)", "40", 1, 1440, s.macro.intervalMaxMin);
                final Nav.NumField mm = new Nav.NumField("최소 새 메시지 수", "1", 0, 200, s.macro.minMessages);
                Nav.editNums(a, "발송 주기", "간격 안에서 랜덤한 시각에 보낸다 (봇처럼 안 보이게).",
                        new Nav.NumField[] { lo, hi, mm }, new Nav.OnNums() {
                            @Override public String ok() {
                                if (lo.value > hi.value) {
                                    Nav.errText(hi.err, "최대 간격은 최소 간격보다 크거나 같아야 해");
                                    return "";
                                }
                                s.macro.intervalMinMin = lo.value;
                                s.macro.intervalMaxMin = hi.value;
                                s.macro.minMessages = mm.value;
                                apply(a, s);
                                f.summary(cycleSummary(s));
                                refresh();
                                Log.add(a, "발송 주기를 바꿨어: " + cycleSummary(s));
                                return null;
                            }
                        });
            }
        }));
        return f;
    }

    private static String cycleSummary(Settings s) {
        return s.macro.intervalMinMin + "~" + s.macro.intervalMaxMin + "분마다 · 새 메시지 "
                + s.macro.minMessages + "개 이상";
    }

    // ── 5. 사진 첨부 ────────────────────────────────────────────────────────

    private static Nav.Fold imageFold(final MainActivity a, final Settings s) {
        final Nav.Fold f = fold(a, F_IMAGE, "사진 첨부", imageSummary(s));

        f.body.addView(Ui.sub(a, "최대 " + Settings.MAX_IMAGES + "장. 알림 답장으로는 사진을 못 보내서,"
                + " 카톡 공유 화면을 접근성 권한으로 대신 눌러서 보낸다."));

        final LinearLayout strip = new LinearLayout(a);
        strip.setOrientation(LinearLayout.HORIZONTAL);
        f.body.addView(Nav.thumbStrip(a, strip));
        paintThumbs(a, s, strip, f);

        final TextView pick = Ui.btn(a, "사진 고르기", false);
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(MATCH, WRAP);
        pp.topMargin = Theme.dp(a, 12);
        pick.setLayoutParams(pp);
        pick.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                openBits |= F_IMAGE;    // 돌아왔을 때 이 카드가 펼쳐진 채로 보이게
                if (s.macro.images.size() >= Settings.MAX_IMAGES) {
                    Ui.toast(a, "이미 " + Settings.MAX_IMAGES + "장이야. 지우고 다시 골라줘");
                    return;
                }
                Ui.toast(a, "최대 " + Settings.MAX_IMAGES + "장까지 고를 수 있어");
                try {
                    ImagePicker.pick(a, MainActivity.REQ_IMAGES);
                } catch (Throwable t) {
                    Log.add(a, "사진 선택 창을 못 열었어: " + t);
                    Ui.toast(a, "사진 선택 창을 못 열었어");
                }
            }
        });
        f.body.addView(pick);

        f.body.addView(Ui.divider(a));
        f.body.addView(Nav.actionRow(a, "전송 모드", imgModeKr(s.macro.sendImages) + imgEveryTail(s),
                "변경", new Runnable() {
                    @Override public void run() { pickImgMode(a, s, f); }
                }));

        if (Settings.IMG_EVERY_N.equals(s.macro.sendImages)) {
            f.body.addView(Nav.actionRow(a, "몇 번마다", s.macro.imageEveryN + "번째 발송마다", "수정",
                    new Runnable() {
                        @Override public void run() {
                            final Nav.NumField n = new Nav.NumField("N (번째 발송마다)", "3", 1, 100,
                                    s.macro.imageEveryN);
                            Nav.editNums(a, "사진 전송 간격", "예) 3 이면 3·6·9번째 발송에 사진이 붙는다.",
                                    new Nav.NumField[] { n }, new Nav.OnNums() {
                                        @Override public String ok() {
                                            s.macro.imageEveryN = n.value;
                                            apply(a, s);
                                            refresh();
                                            return null;
                                        }
                                    });
                        }
                    }));
        }

        boolean accOn;
        try { accOn = ImageSender.accessibilityOn(a); } catch (Throwable t) { accOn = false; }
        if (!accOn) {
            f.body.addView(Nav.note(a, "접근성 권한이 꺼져 있어서 사진은 못 보내.\n"
                    + "텍스트 발송은 영향 없어.", Theme.AMBER, "접근성 켜기", new Runnable() {
                @Override public void run() { ImageSender.openSettings(a); }
            }));
        }

        final TextView now = Ui.btn(a, "지금 사진만 보내기", false);
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(MATCH, WRAP);
        np.topMargin = Theme.dp(a, 12);
        now.setLayoutParams(np);
        now.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { sendImagesNow(a, s, now); }
        });
        f.body.addView(now);
        return f;
    }

    private static void paintThumbs(final MainActivity a, final Settings s,
                                    final LinearLayout strip, final Nav.Fold f) {
        strip.removeAllViews();
        if (s.macro.images.isEmpty()) {
            TextView e = Ui.sub(a, "아직 고른 사진이 없어");
            strip.addView(e);
            f.summary(imageSummary(s));
            return;
        }
        for (int i = 0; i < s.macro.images.size(); i++) {
            final String uri = s.macro.images.get(i);
            strip.addView(Nav.thumb(a, uri, new Runnable() {
                @Override public void run() {
                    s.macro.images.remove(uri);
                    try { ImagePicker.release(a, uri); } catch (Throwable t) { /* 권한 해제 실패는 무해 */ }
                    apply(a, s);
                    paintThumbs(a, s, strip, f);
                    Log.add(a, "첨부 사진 1장을 지웠어");
                }
            }));
        }
        f.summary(imageSummary(s));
    }

    private static void pickImgMode(final MainActivity a, final Settings s, final Nav.Fold f) {
        String[] labels = { "안 보냄", "매번", "N번째 발송마다", "수동 전송만" };
        String[] descs = {
                "사진은 붙이지 않는다",
                "발송할 때마다 사진도 같이 보낸다",
                "정해둔 횟수마다 한 번씩만 사진을 보낸다",
                "자동으로는 안 보내고, 버튼을 누를 때만 보낸다"
        };
        int sel = 0;
        for (int i = 0; i < Settings.IMG_MODES.length; i++) {
            if (Settings.IMG_MODES[i].equals(s.macro.sendImages)) sel = i;
        }
        Nav.choose(a, "사진 전송 모드", labels, descs, sel, new Nav.OnPick() {
            @Override public void pick(int index) {
                if (index < 0 || index >= Settings.IMG_MODES.length) return;
                s.macro.sendImages = Settings.IMG_MODES[index];
                apply(a, s);
                Log.add(a, "사진 전송 모드를 「" + imgModeKr(s.macro.sendImages) + "」로 바꿨어");
                refresh();
            }
        });
    }

    private static void sendImagesNow(final MainActivity a, final Settings s, final TextView btn) {
        if (!License.allowed(a, Features.MACRO)) { Gate.check(a, Features.MACRO); return; }
        if (s.macro.images.isEmpty()) { Ui.toast(a, "먼저 사진을 골라줘"); return; }
        if (s.macro.rooms.isEmpty()) { Ui.toast(a, "대상 방을 먼저 추가해줘"); return; }
        boolean accOn;
        try { accOn = ImageSender.accessibilityOn(a); } catch (Throwable t) { accOn = false; }
        if (!accOn) {
            Nav.confirm(a, "접근성 권한이 필요해",
                    "사진 전송은 카톡 화면을 대신 눌러야 해서 접근성 권한이 필요해. 지금 켜러 갈래?",
                    "설정 열기", new Runnable() {
                        @Override public void run() { ImageSender.openSettings(a); }
                    });
            return;
        }

        final String room = s.macro.rooms.get(0);
        final List<String> uris = new ArrayList<String>(s.macro.images);
        Nav.busy(btn, true, "보내는 중…", "지금 사진만 보내기");
        Log.add(a, "사진 " + uris.size() + "장을 「" + room + "」로 보내는 중");
        try {
            ImageSender.send(a, room, uris, new Runnable() {
                @Override public void run() {
                    Nav.busy(btn, false, "보내는 중…", "지금 사진만 보내기");
                    Ui.toast(a, "사진 전송을 끝냈어. 카톡에서 확인해줘");
                }
            });
        } catch (Throwable t) {
            Nav.busy(btn, false, "보내는 중…", "지금 사진만 보내기");
            Log.add(a, "사진 전송을 시작하지 못했어: " + t);
            Ui.toast(a, "사진 전송을 시작하지 못했어");
        }
    }

    /** MainActivity.onActivityResult 에서 넘어온다 */
    public static void onImagesPicked(MainActivity a, int res, Intent data) {
        if (a == null) return;
        if (res != android.app.Activity.RESULT_OK) {
            Log.add(a, "사진 선택을 취소했어");
            return;
        }
        Settings s = Settings.load(a);
        int space = Settings.MAX_IMAGES - s.macro.images.size();
        if (space <= 0) {
            Ui.toast(a, "이미 " + Settings.MAX_IMAGES + "장이야");
            return;
        }
        List<String> got;
        try {
            got = ImagePicker.onResult(a, data, space);
        } catch (Throwable t) {
            Log.add(a, "사진 선택 결과를 못 읽었어: " + t);
            Ui.toast(a, "사진을 못 읽었어");
            return;
        }
        if (got == null || got.isEmpty()) {
            Ui.toast(a, "고른 사진이 없어");
            return;
        }
        int added = 0;
        for (int i = 0; i < got.size(); i++) {
            if (s.macro.addImage(got.get(i))) added++;
        }
        apply(a, s);
        Log.add(a, "첨부 사진 " + added + "장을 추가했어 (총 " + s.macro.images.size() + "장)");
        if (added < got.size()) {
            Ui.toast(a, "최대 " + Settings.MAX_IMAGES + "장까지야");
        }
        refresh();
    }

    private static String imageSummary(Settings s) {
        int n = s.macro.images.size();
        if (n == 0) return "없음";
        return n + "장 · " + imgModeKr(s.macro.sendImages) + imgEveryTail(s);
    }

    private static String imgModeKr(String mode) {
        if (Settings.IMG_EVERY.equals(mode)) return "매번 보냄";
        if (Settings.IMG_EVERY_N.equals(mode)) return "N번마다";
        if (Settings.IMG_MANUAL.equals(mode)) return "수동만";
        return "안 보냄";
    }

    private static String imgEveryTail(Settings s) {
        if (!Settings.IMG_EVERY_N.equals(s.macro.sendImages)) return "";
        return " (" + s.macro.imageEveryN + ")";
    }

    // ── 6. 메시지 추적 (트리거) ─────────────────────────────────────────────

    private static Nav.Fold triggerFold(final MainActivity a, final Settings s) {
        final Nav.Fold f = fold(a, F_TRIG, "메시지 추적", trigSummary(s));

        f.body.addView(Ui.sub(a, "정해둔 메시지가 어느 방에 올라오면 바로 답장한다. 주기 발송과 따로 돈다."));

        if (s.triggers.isEmpty()) {
            TextView e = Ui.sub(a, "아직 트리거가 없어. 아래에서 하나 만들어봐.");
            LinearLayout.LayoutParams ep = new LinearLayout.LayoutParams(MATCH, WRAP);
            ep.topMargin = Theme.dp(a, 10);
            e.setLayoutParams(ep);
            f.body.addView(e);
        }
        for (int i = 0; i < s.triggers.size(); i++) {
            f.body.addView(triggerRow(a, s, s.triggers.get(i)));
        }

        f.body.addView(Nav.wideBtn(a, "새 트리거", false, new Runnable() {
            @Override public void run() {
                if (s.triggers.size() >= Settings.MAX_TRIGGERS) {
                    Ui.toast(a, "트리거는 최대 " + Settings.MAX_TRIGGERS + "개까지야");
                    return;
                }
                editTrigger(a, s, null);
            }
        }));
        return f;
    }

    private static LinearLayout triggerRow(final MainActivity a, final Settings s,
                                           final Settings.TriggerCfg t) {
        LinearLayout row = Ui.row(a);
        row.setMinimumHeight(Theme.dp(a, 56));
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(MATCH, WRAP);
        rp.topMargin = Theme.dp(a, 10);
        row.setLayoutParams(rp);

        LinearLayout left = new LinearLayout(a);
        left.setOrientation(LinearLayout.VERTICAL);
        left.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        left.setClickable(true);
        left.setFocusable(true);
        left.setMinimumHeight(Theme.dp(a, 48));
        int lp2 = Theme.dp(a, 4);
        left.setPadding(0, lp2, 0, lp2);
        Ui.press(left);

        TextView nt = new TextView(a);
        nt.setText(t.title());
        nt.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14.5f);
        nt.setTextColor(t.enabled ? Theme.TEXT : Theme.DIM);
        nt.setTypeface(Typeface.DEFAULT_BOLD);
        nt.setSingleLine(true);
        nt.setEllipsize(TextUtils.TruncateAt.END);
        nt.setIncludeFontPadding(false);
        left.addView(nt, new LinearLayout.LayoutParams(MATCH, WRAP));

        TextView mt = Ui.sub(a, trigMeta(t));
        mt.setMaxLines(2);
        mt.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(MATCH, WRAP);
        mp.topMargin = Theme.dp(a, 3);
        mt.setLayoutParams(mp);
        left.addView(mt);

        left.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { editTrigger(a, s, t); }
        });
        row.addView(left);

        row.addView(Nav.toggle(a, t.enabled, new Ui.OnToggle() {
            @Override public void on(boolean v) {
                t.enabled = v;
                apply(a, s);
                nt.setTextColor(v ? Theme.TEXT : Theme.DIM);
                Log.add(a, "트리거 「" + t.title() + "」를 " + (v ? "켰어" : "껐어"));
            }
        }));
        return row;
    }

    private static String trigMeta(Settings.TriggerCfg t) {
        StringBuilder sb = new StringBuilder();
        sb.append(modeKr(t.mode)).append(" · 「").append(Nav.preview(t.pattern, 20)).append("」");
        sb.append(" · 감지: ").append(t.rooms.isEmpty() ? "모든 방" : (t.rooms.size() + "개 방"));
        sb.append(" · 보낼 곳: ").append((t.target == null || t.target.trim().length() == 0)
                ? "감지된 방" : Nav.preview(t.target, 14));
        return sb.toString();
    }

    private static String trigSummary(Settings s) {
        if (s.triggers.isEmpty()) return "없음";
        int on = 0;
        for (int i = 0; i < s.triggers.size(); i++) if (s.triggers.get(i).enabled) on++;
        return s.triggers.size() + "개 · " + on + "개 켜짐";
    }

    private static String modeKr(String mode) {
        if (Settings.MODE_EXACT.equals(mode)) return "정확히";
        if (Settings.MODE_STARTS.equals(mode)) return "시작";
        if (Settings.MODE_REGEX.equals(mode)) return "정규식";
        return "포함";
    }

    /** 트리거 편집 다이얼로그. old 가 null 이면 새로 만든다. */
    private static void editTrigger(final MainActivity a, final Settings s,
                                    final Settings.TriggerCfg old) {
        final boolean isNew = (old == null);
        final Settings.TriggerCfg t = isNew ? new Settings.TriggerCfg() : old;

        // 다이얼로그에서 취소하면 원래 값이 살아있어야 하니까 편집값은 따로 들고 있는다
        final String[] mode = { t.mode };
        final boolean[] flags = { t.ignoreCase, t.fromMe, t.oncePerRoom, t.enabled };

        LinearLayout body = Nav.col(a);

        body.addView(fieldLabel(a, "이름 (표시용)", 0));
        final EditText name = line(a, "예) 출석 체크", t.name);
        body.addView(name);

        body.addView(fieldLabel(a, "감지할 문자열", 14));
        final EditText pat = line(a, "예) 출석", t.pattern);
        body.addView(pat);
        final TextView patErr = Nav.errLine(a);
        body.addView(patErr);

        body.addView(fieldLabel(a, "비교 방식", 14));
        final TextView modeBtn = Ui.btn(a, modeKr(mode[0]), false);
        modeBtn.setLayoutParams(new LinearLayout.LayoutParams(MATCH, WRAP));
        modeBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                int sel = 0;
                for (int i = 0; i < Settings.MODES.length; i++) {
                    if (Settings.MODES[i].equals(mode[0])) sel = i;
                }
                Nav.choose(a, "비교 방식", new String[] { "포함", "정확히", "시작", "정규식" },
                        new String[] { "메시지 안에 들어있으면 감지",
                                "메시지 전체가 똑같을 때만 감지",
                                "메시지가 이걸로 시작할 때 감지",
                                "정규식으로 감지 (틀리면 저장할 때 알려준다)" },
                        sel, new Nav.OnPick() {
                            @Override public void pick(int index) {
                                mode[0] = Settings.MODES[index];
                                modeBtn.setText(modeKr(mode[0]));
                            }
                        });
            }
        });
        body.addView(modeBtn);

        body.addView(fieldLabel(a, "감지할 방 (쉼표 · 비우면 모든 방)", 14));
        final EditText rooms = line(a, "비우면 모든 방", Nav.join(t.rooms, ""));
        body.addView(rooms);

        body.addView(fieldLabel(a, "보낼 메시지", 14));
        final EditText reply = multi(a, "{방} {이름} {메시지} {시간} 쓸 수 있어", t.reply);
        body.addView(reply);
        final TextView replyErr = Nav.errLine(a);
        body.addView(replyErr);

        body.addView(fieldLabel(a, "보낼 방 (비우면 감지된 방)", 14));
        final EditText target = line(a, "비우면 감지된 방에 답장", t.target);
        body.addView(target);

        body.addView(fieldLabel(a, "랜덤 지연 (초 · 0~60)", 14));
        final EditText delay = num(a, "0", String.valueOf(t.delayMs / 1000));
        body.addView(delay);
        final TextView delayErr = Nav.errLine(a);
        body.addView(delayErr);

        body.addView(fieldLabel(a, "재발동 최소 간격 (초)", 14));
        final EditText cool = num(a, "60", String.valueOf(t.cooldownMs / 1000));
        body.addView(cool);
        final TextView coolErr = Nav.errLine(a);
        body.addView(coolErr);

        body.addView(Ui.divider(a));
        body.addView(Ui.switchRow(a, "대소문자 무시", null, flags[0], new Ui.OnToggle() {
            @Override public void on(boolean v) { flags[0] = v; }
        }));
        body.addView(Ui.switchRow(a, "내 메시지도 감지", "보통은 꺼둔다 (자기 말에 반응하면 무한반복 위험)",
                flags[1], new Ui.OnToggle() {
                    @Override public void on(boolean v) { flags[1] = v; }
                }));
        body.addView(Ui.switchRow(a, "방마다 1회만", "한 방에서 한 번 발동하면 더 안 보낸다",
                flags[2], new Ui.OnToggle() {
                    @Override public void on(boolean v) { flags[2] = v; }
                }));
        body.addView(Ui.switchRow(a, "사용", null, flags[3], new Ui.OnToggle() {
            @Override public void on(boolean v) { flags[3] = v; }
        }));

        if (!isNew) {
            TextView del = Ui.btn(a, "이 트리거 삭제", false);
            del.setTextColor(Theme.RED);
            LinearLayout.LayoutParams dp = new LinearLayout.LayoutParams(MATCH, WRAP);
            dp.topMargin = Theme.dp(a, 14);
            del.setLayoutParams(dp);
            del.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    Nav.confirm(a, "트리거를 지울까?", "「" + t.title() + "」를 지운다. 되돌릴 수 없어.",
                            "삭제", new Runnable() {
                                @Override public void run() {
                                    s.removeTrigger(t.id);
                                    try { Trigger.resetState(a, t.id); } catch (Throwable ig) { }
                                    apply(a, s);
                                    Log.add(a, "트리거 「" + t.title() + "」를 지웠어");
                                    refresh();
                                }
                            });
                }
            });
            body.addView(del);
        }

        Nav.form(a, isNew ? "새 트리거" : "트리거 편집", body, "저장", new Nav.OnSave() {
            @Override public String save() {
                Nav.errClear(patErr);
                Nav.errClear(replyErr);
                Nav.errClear(delayErr);
                Nav.errClear(coolErr);

                String p = pat.getText().toString();
                if (p.trim().length() == 0) {
                    Nav.errText(patErr, "감지할 문자열을 입력해줘");
                    return "";
                }
                String rp = reply.getText().toString();
                if (rp.trim().length() == 0) {
                    Nav.errText(replyErr, "보낼 메시지를 입력해줘");
                    return "";
                }
                int dsec;
                try {
                    dsec = Integer.parseInt(delay.getText().toString().trim());
                } catch (Throwable e) {
                    Nav.errText(delayErr, "숫자만 넣어줘");
                    return "";
                }
                if (dsec < 0 || dsec > 60) {
                    Nav.errText(delayErr, "0 ~ 60 사이로 넣어줘");
                    return "";
                }
                int csec;
                try {
                    csec = Integer.parseInt(cool.getText().toString().trim());
                } catch (Throwable e) {
                    Nav.errText(coolErr, "숫자만 넣어줘");
                    return "";
                }
                if (csec < 0 || csec > 86400) {
                    Nav.errText(coolErr, "0 ~ 86400 사이로 넣어줘");
                    return "";
                }

                // 검증 전용 사본으로 먼저 확인한다 (실패하면 원본이 안 더러워진다)
                Settings.TriggerCfg probe = new Settings.TriggerCfg();
                probe.id = t.id;
                probe.name = name.getText().toString().trim();
                probe.pattern = p;
                probe.mode = mode[0];
                probe.ignoreCase = flags[0];
                probe.rooms = split(rooms.getText().toString());
                probe.fromMe = flags[1];
                probe.reply = rp;
                probe.target = target.getText().toString().trim();
                probe.delayMs = dsec * 1000;
                probe.cooldownMs = csec * 1000L;
                probe.oncePerRoom = flags[2];
                probe.enabled = flags[3];

                String bad;
                try {
                    bad = Trigger.validate(probe);
                } catch (Throwable e) {
                    bad = "트리거를 검사하다 오류가 났어: " + e.getClass().getSimpleName();
                }
                if (bad != null) {
                    if (bad.contains("정규식") || bad.contains("문자열")) Nav.errText(patErr, bad);
                    else if (bad.contains("메시지")) Nav.errText(replyErr, bad);
                    return bad.contains("정규식") || bad.contains("문자열") || bad.contains("메시지")
                            ? "" : bad;
                }

                t.name = probe.name;
                t.pattern = probe.pattern;
                t.mode = probe.mode;
                t.ignoreCase = probe.ignoreCase;
                t.rooms = probe.rooms;
                t.fromMe = probe.fromMe;
                t.reply = probe.reply;
                t.target = probe.target;
                t.delayMs = probe.delayMs;
                t.cooldownMs = probe.cooldownMs;
                t.oncePerRoom = probe.oncePerRoom;
                t.enabled = probe.enabled;

                if (isNew) {
                    String why = s.addTrigger(t);
                    if (why != null) return why;
                }
                apply(a, s);
                Log.add(a, (isNew ? "트리거를 만들었어: " : "트리거를 고쳤어: ") + t.title());
                refresh();
                return null;
            }
        });
    }

    // ── 7. 오픈프로필 자동응답 ──────────────────────────────────────────────

    private static Nav.Fold replyFold(final MainActivity a, final Settings s) {
        final Nav.Fold f = fold(a, F_REPLY, "오픈프로필 자동응답", replySummary(s));
        final Settings.AutoReplyCfg r = s.autoreply;

        f.body.addView(Ui.switchRow(a, "자동응답 사용", "오픈프로필로 온 1:1 톡에 정해둔 메시지를 보낸다",
                r.enabled, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        r.enabled = v;
                        apply(a, s);
                        f.summary(replySummary(s));
                        Log.add(a, v ? "오픈프로필 자동응답을 켰어" : "오픈프로필 자동응답을 껐어");
                    }
                }));
        f.body.addView(Ui.divider(a));

        f.body.addView(Nav.actionRow(a, "응답 메시지",
                (r.message == null || r.message.trim().length() == 0)
                        ? "아직 비어있어 — 비우면 안 보낸다" : Nav.preview(r.message, 44),
                "수정", new Runnable() {
                    @Override public void run() {
                        Nav.editText(a, "응답 메시지", "예) 안녕하세요 {이름}님, 곧 답장드릴게요",
                                r.message, true,
                                "{이름} {시간} {날짜} 를 쓸 수 있어. 여러 줄도 그대로 보내진다.",
                                new Nav.OnText() {
                                    @Override public String text(String value) {
                                        if (value == null || value.trim().length() == 0) {
                                            return "응답 메시지를 적어줘";
                                        }
                                        if (value.length() > 2000) return "2000자 이하로 줄여줘";
                                        r.message = value;
                                        apply(a, s);
                                        refresh();
                                        return null;
                                    }
                                });
                    }
                }));

        f.body.addView(Nav.actionRow(a, "적용 대상", scopeKr(r.scope), "변경", new Runnable() {
            @Override public void run() {
                int sel = 0;
                for (int i = 0; i < Settings.SCOPES.length; i++) {
                    if (Settings.SCOPES[i].equals(r.scope)) sel = i;
                }
                Nav.choose(a, "적용 대상",
                        new String[] { "모든 1:1", "모르는 사람만", "특정 방 제외" },
                        new String[] { "1:1 톡이면 모두 응답",
                                "전에 본 적 없는 상대에게만 응답",
                                "아래 목록에 있는 방만 빼고 응답" },
                        sel, new Nav.OnPick() {
                            @Override public void pick(int index) {
                                r.scope = Settings.SCOPES[index];
                                apply(a, s);
                                refresh();
                            }
                        });
            }
        }));

        if (Settings.SCOPE_EXCEPT.equals(r.scope)) {
            f.body.addView(Ui.label(a, "제외할 방"));
            final Nav.Flow flow = Nav.flow(a);
            f.body.addView(flow);
            final Runnable changed = new Runnable() {
                @Override public void run() { apply(a, s); }
            };
            Nav.chipEditor(flow, r.exceptRooms, Theme.AMBER, "아직 없어", changed);
            f.body.addView(Nav.wideBtn(a, "제외할 방 추가", false, new Runnable() {
                @Override public void run() {
                    Nav.pickRooms(a, "제외할 방 추가", KakaoListener.knownRooms(a), r.exceptRooms,
                            new Nav.OnRooms() {
                                @Override public void rooms(List<String> picked) {
                                    for (int i = 0; i < picked.size(); i++) {
                                        String v = picked.get(i);
                                        if (!r.exceptRooms.contains(v)) r.exceptRooms.add(v);
                                    }
                                    changed.run();
                                    Nav.chipEditor(flow, r.exceptRooms, Theme.AMBER, "아직 없어", changed);
                                }
                            });
                }
            }));
        }

        f.body.addView(Nav.actionRow(a, "운영 시간", hoursKr(r), "수정", new Runnable() {
            @Override public void run() {
                final Nav.NumField from = new Nav.NumField("시작 시 (0~24)", "9", 0, 24, r.hourFrom);
                final Nav.NumField to = new Nav.NumField("종료 시 (0~24)", "23", 0, 24, r.hourTo);
                Nav.editNums(a, "운영 시간",
                        "이 시간대에만 응답한다. 시작과 종료를 같게 하면 24시간 응답.\n"
                                + "22 ~ 6 처럼 자정을 넘겨도 된다.",
                        new Nav.NumField[] { from, to }, new Nav.OnNums() {
                            @Override public String ok() {
                                r.hourFrom = from.value;
                                r.hourTo = to.value;
                                apply(a, s);
                                refresh();
                                return null;
                            }
                        });
            }
        }));

        f.body.addView(Nav.actionRow(a, "같은 사람 재응답 간격", Nav.dur(r.cooldownMs), "수정",
                new Runnable() {
                    @Override public void run() {
                        final Nav.NumField n = new Nav.NumField("간격 (분)", "360", 0, 10080,
                                (int) (r.cooldownMs / 60000L));
                        Nav.editNums(a, "재응답 간격", "같은 사람에게 이 시간 안에는 다시 응답하지 않는다.",
                                new Nav.NumField[] { n }, new Nav.OnNums() {
                                    @Override public String ok() {
                                        r.cooldownMs = n.value * 60000L;
                                        apply(a, s);
                                        refresh();
                                        return null;
                                    }
                                });
                    }
                }));

        f.body.addView(Nav.actionRow(a, "하루 최대 응답",
                r.dailyLimit + "건 (오늘 " + AutoReply.today(a) + "건)", "수정", new Runnable() {
                    @Override public void run() {
                        final Nav.NumField n = new Nav.NumField("하루 최대 응답 수", "100", 1, 2000,
                                r.dailyLimit);
                        Nav.editNums(a, "하루 최대 응답", "자정에 0으로 초기화된다.",
                                new Nav.NumField[] { n }, new Nav.OnNums() {
                                    @Override public String ok() {
                                        r.dailyLimit = n.value;
                                        apply(a, s);
                                        refresh();
                                        return null;
                                    }
                                });
                    }
                }));

        f.body.addView(Nav.actionRow(a, "랜덤 지연", (r.delayMaxMs <= 0) ? "없음"
                : ("0 ~ " + (r.delayMaxMs / 1000) + "초"), "수정", new Runnable() {
            @Override public void run() {
                final Nav.NumField n = new Nav.NumField("최대 지연 (초)", "30", 0, 120,
                        r.delayMaxMs / 1000);
                Nav.editNums(a, "랜덤 지연", "바로 답하면 봇처럼 보여. 0~이 값 사이에서 랜덤하게 늦춘다.",
                        new Nav.NumField[] { n }, new Nav.OnNums() {
                            @Override public String ok() {
                                r.delayMaxMs = n.value * 1000;
                                apply(a, s);
                                refresh();
                                return null;
                            }
                        });
            }
        }));

        f.body.addView(Ui.switchRow(a, "첫 메시지에만", "그 사람의 첫 톡에만 응답하고, 이어지는 톡은 무시",
                r.firstOnly, new Ui.OnToggle() {
                    @Override public void on(boolean v) {
                        r.firstOnly = v;
                        apply(a, s);
                    }
                }));
        return f;
    }

    private static String replySummary(Settings s) {
        Settings.AutoReplyCfg r = s.autoreply;
        if (!r.enabled) return "꺼짐";
        return "켜짐 · " + scopeKr(r.scope) + " · " + hoursKr(r);
    }

    private static String scopeKr(String scope) {
        if (Settings.SCOPE_UNKNOWN.equals(scope)) return "모르는 사람만";
        if (Settings.SCOPE_EXCEPT.equals(scope)) return "특정 방 제외";
        return "모든 1:1";
    }

    private static String hoursKr(Settings.AutoReplyCfg r) {
        if (r.hourFrom == r.hourTo) return "24시간";
        if (r.hourFrom == 0 && r.hourTo == 24) return "24시간";
        return r.hourFrom + "시 ~ " + r.hourTo + "시";
    }

    // ── 8. 발송 제한 ────────────────────────────────────────────────────────

    private static Nav.Fold limitFold(final MainActivity a, final Settings s) {
        final Nav.Fold f = fold(a, F_LIMIT, "발송 제한", limitSummary(s));

        f.body.addView(Nav.actionRow(a, "방해금지 시간", quietKr(s), "수정", new Runnable() {
            @Override public void run() { editQuiet(a, s, f); }
        }));
        f.body.addView(Nav.actionRow(a, "하루 최대 발송",
                s.macro.dailyLimit + "건 (오늘 " + MainActivity.sentToday(a) + "건)", "수정",
                new Runnable() {
                    @Override public void run() {
                        final Nav.NumField n = new Nav.NumField("하루 최대 발송 수", "200", 1, 5000,
                                s.macro.dailyLimit);
                        Nav.editNums(a, "하루 최대 발송", "이 수를 넘으면 그날은 더 안 보낸다.",
                                new Nav.NumField[] { n }, new Nav.OnNums() {
                                    @Override public String ok() {
                                        s.macro.dailyLimit = n.value;
                                        apply(a, s);
                                        refresh();
                                        return null;
                                    }
                                });
                    }
                }));
        return f;
    }

    private static void editQuiet(final MainActivity a, final Settings s, final Nav.Fold f) {
        LinearLayout body = Nav.col(a);
        body.addView(Ui.sub(a, "이 시간대에는 발송을 멈춘다. 둘 다 비우면 제한 없음.\n"
                + "22:00 ~ 07:00 처럼 자정을 넘겨도 된다."));

        body.addView(fieldLabel(a, "시작 (HH:mm)", 14));
        final EditText from = line(a, "22:00", s.macro.quietFrom);
        body.addView(from);
        final TextView fromErr = Nav.errLine(a);
        body.addView(fromErr);

        body.addView(fieldLabel(a, "종료 (HH:mm)", 14));
        final EditText to = line(a, "07:00", s.macro.quietTo);
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
                    apply(a, s);
                    f.summary(limitSummary(s));
                    refresh();
                    return null;
                }
                boolean bad = false;
                if (Settings.hhmm(fv) < 0) { Nav.errText(fromErr, "HH:mm 으로 넣어줘 (예 22:00)"); bad = true; }
                if (Settings.hhmm(tv) < 0) { Nav.errText(toErr, "HH:mm 으로 넣어줘 (예 07:00)"); bad = true; }
                if (bad) return "";
                if (Settings.hhmm(fv) == Settings.hhmm(tv)) {
                    Nav.errText(toErr, "시작과 종료가 같으면 제한이 안 걸려");
                    return "";
                }
                s.macro.quietFrom = fv;
                s.macro.quietTo = tv;
                apply(a, s);
                f.summary(limitSummary(s));
                refresh();
                Log.add(a, "방해금지 시간을 " + fv + " ~ " + tv + " 로 맞췄어");
                return null;
            }
        });
    }

    private static String quietKr(Settings s) {
        if (Settings.hhmm(s.macro.quietFrom) < 0 || Settings.hhmm(s.macro.quietTo) < 0) return "없음";
        return s.macro.quietFrom + " ~ " + s.macro.quietTo;
    }

    private static String limitSummary(Settings s) {
        return "방해금지 " + quietKr(s) + " · 하루 " + s.macro.dailyLimit + "건";
    }

    // ── 공통 ────────────────────────────────────────────────────────────────

    /**
     * 설정 저장 + 알람 갱신. 값이 바뀌면 무조건 여기를 거친다.
     *
     * Scheduler 쪽 계약: 매크로가 켜져 있고 기능도 살아있을 때만 ensureScheduled 를 부르고,
     * 아니면 cancel 을 부른다. 그러니 cancel 에서 "주기 발송 알람" 만 지워라 —
     * 하트비트/부팅복구를 같은 알람에 태웠으면 그건 살려둬야 한다.
     */
    private static void apply(MainActivity a, Settings s) {
        try {
            s.save(a);
        } catch (Throwable t) {
            Log.add(a, "설정 저장에 실패했어: " + t);
            Ui.toast(a, "설정을 저장하지 못했어");
            return;
        }
        try {
            if (s.macro.enabled && License.allowed(a, Features.MACRO)) Scheduler.ensureScheduled(a);
            else Scheduler.cancel(a);
        } catch (Throwable t) {
            Log.add(a, "발송 예약을 갱신하지 못했어: " + t);
        }
    }

    /** 펼침 상태를 기억하는 접이식 카드 */
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

    private static TextView fieldLabel(MainActivity a, String s, int topDp) {
        TextView t = Ui.label(a, s);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(a, topDp);
        lp.bottomMargin = Theme.dp(a, 6);
        t.setLayoutParams(lp);
        return t;
    }

    private static EditText line(MainActivity a, String hint, String value) {
        EditText e = Ui.field(a, hint);
        e.setSingleLine(true);
        e.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        e.setText((value == null) ? "" : value);
        return e;
    }

    private static EditText multi(MainActivity a, String hint, String value) {
        EditText e = Ui.field(a, hint);
        e.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE);
        e.setMinLines(3);
        e.setMaxLines(8);
        e.setText((value == null) ? "" : value);
        return e;
    }

    private static EditText num(MainActivity a, String hint, String value) {
        EditText e = Ui.field(a, hint);
        e.setSingleLine(true);
        e.setInputType(InputType.TYPE_CLASS_NUMBER);
        e.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        e.setText((value == null) ? "" : value);
        return e;
    }

    /** "가, 나, 다" → 리스트. 빈 조각은 버린다. */
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
