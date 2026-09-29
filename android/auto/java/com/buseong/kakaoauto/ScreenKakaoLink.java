package com.buseong.kakaoauto;

import android.app.AlertDialog;
import android.content.Context;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.buseong.kakaoauto.engine.Engine;
import com.buseong.kakaoauto.engine.EngineException;
import com.buseong.kakaoauto.engine.KakaoEngine;
import com.buseong.kakaoauto.engine.RoomLinks;

import java.lang.ref.WeakReference;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 카카오 계정 직접 연결 — 폰 내장 엔진({@link KakaoEngine}) 의 화면.
 *
 * 연결(아이디·비밀번호 + 폰 카카오톡에서 코드 확인), 대상 대화방 ↔ 카카오 방 연결, 연결 해제만 다룬다.
 * 발송 경로는 {@link ImageSender} · {@link Scheduler} 가 {@code EngineSend} 로 정한다.
 * 비밀번호는 입력창과 로그인 요청 동안에만 메모리에 있고 어디에도 저장·기록하지 않는다.
 */
public final class ScreenKakaoLink {
    private ScreenKakaoLink() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;
    private static final Handler H = new Handler(Looper.getMainLooper());
    private static final ExecutorService IO = Executors.newSingleThreadExecutor();

    private static WeakReference<LinearLayout> BODY;
    private static WeakReference<MainActivity> ACT;

    // ── 다른 화면에 붙이는 행 ───────────────────────────────────────────────

    /** 「카카오 계정 직접 연결 · 상태 ›」 행 */
    public static LinearLayout row(final MainActivity a, int color) {
        KakaoEngine.Status st = Engine.get(a).status();
        return Ui.navRow(a, Icon.KEY, color, "카카오 계정 직접 연결", value(st), valueColor(st), new Runnable() {
            @Override public void run() { open(a); }
        });
    }

    /** 이 방이 직접 연결로 발송되는지 한 줄 요약 (이미지 화면용) */
    public static String routeLine(Context c, RoomRef ref) {
        if (!Engine.packaged(c)) return null;
        if (!Engine.ready(c)) return "카카오 계정을 직접 연결하면 화면 조작 없이 백그라운드에서 전송됩니다.";
        RoomLinks.Link l = (ref == null) ? null : RoomLinks.get(c, ref);
        if (l == null) return "이 대화방은 카카오 방과 연결되지 않았습니다. 연결하면 백그라운드에서 전송됩니다.";
        return "카카오 방 「" + l.kakaoName + "」 로 직접 전송됩니다 (" + ImageSender.MAX + "장까지 한 번에).";
    }

    public static void open(MainActivity a) {
        Nav.push(a, "카카오 계정 직접 연결", build(a));
    }

    private static String value(KakaoEngine.Status st) {
        switch (st.link) {
            case UNAVAILABLE: return "미포함";
            case READY: return st.accountHint.length() > 0 ? st.accountHint : "연결됨";
            case KICKED: return "다시 연결 필요";
            case REAUTH: return "다시 로그인 필요";
            default: return "연결 안 됨";
        }
    }

    private static int valueColor(KakaoEngine.Status st) {
        switch (st.link) {
            case READY: return Theme.OK;
            case KICKED:
            case REAUTH: return Theme.AMBER;
            default: return Theme.DIM;
        }
    }

    // ── 화면 ────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        ACT = new WeakReference<MainActivity>(a);
        LinearLayout col = Ui.screen(a);
        BODY = new WeakReference<LinearLayout>(col);
        fill(a, col);
        return Ui.scroll(a, col);
    }

    /** 이 화면과 이 화면을 여는 행이 있는 화면을 다시 그린다 */
    static void refresh() {
        MainActivity a = (ACT == null) ? null : ACT.get();
        LinearLayout col = (BODY == null) ? null : BODY.get();
        if (a != null && !a.isFinishing() && col != null && col.isAttachedToWindow()) {
            col.removeAllViews();
            try { fill(a, col); } catch (Throwable t) { Log.add(a, "직접 연결 화면 갱신에 실패했습니다: " + t); }
        }
        try { ScreenAccount.refresh(); } catch (Throwable ignore) { }
        try { MacroDetail.refresh(); } catch (Throwable ignore) { }
    }

    private static void fill(final MainActivity a, LinearLayout col) {
        final int fc = Theme.F_MACRO;
        final KakaoEngine.Status st = Engine.get(a).status();

        LinearLayout hero = Ui.hero(a, fc, Icon.KEY, "DIRECT", "카카오 계정 직접 연결",
                "카카오 계정으로 직접 발송합니다. 알림·화면 조작 없이 백그라운드에서 이미지 1~"
                        + ImageSender.MAX + "장과 메시지를 전송합니다.");
        hero.addView(Ui.heroRule(a, fc));
        LinearLayout stats = Ui.row(a);
        stats.setPadding(0, Theme.dp(a, 10), 0, 0);
        stats.addView(Ui.stat(a, "상태", value(st), valueColor(st)));
        stats.addView(Ui.stat(a, "연결 대화방", RoomLinks.all(a).size() + "개", Theme.TEXT));
        hero.addView(stats);
        if (st.link != KakaoEngine.Link.UNAVAILABLE && st.link != KakaoEngine.Link.READY) {
            hero.addView(Nav.wideBtn(a, st.link == KakaoEngine.Link.NONE ? "계정 연결" : "다시 연결", true,
                    new Runnable() {
                        @Override public void run() { loginDialog(a, false); }
                    }));
        }
        col.addView(hero);

        switch (st.link) {
            case UNAVAILABLE:
                col.addView(Nav.note(a, "이 설치 파일에는 직접 연결 엔진이 포함되어 있지 않습니다."
                        + " 알림 답장 방식으로만 발송합니다.", Theme.AMBER, null, null));
                return;
            case KICKED:
                col.addView(Nav.note(a, "다른 태블릿에서 같은 계정으로 로그인하여 연결이 해제되었습니다."
                        + " 다시 연결하면 그 기기의 카카오톡이 로그아웃됩니다.", Theme.AMBER, null, null));
                break;
            case REAUTH:
                col.addView(Nav.note(a, "저장된 로그인이 만료되었습니다. 아이디와 비밀번호로 다시 연결하십시오.",
                        Theme.AMBER, null, null));
                break;
            default:
                break;
        }
        if (st.lastError.length() > 0 && st.link == KakaoEngine.Link.READY) {
            col.addView(Nav.note(a, "최근 오류: " + st.lastError, Theme.AMBER, null, null));
        }

        if (st.link == KakaoEngine.Link.READY) {
            fillRooms(a, col, fc);

            col.addView(Ui.sectionHeader(a, null, "관리"));
            LinearLayout g = Ui.group(a);
            g.addView(Ui.navRow(a, Icon.PLUS, fc, "카카오 대화방에서 대상 추가", "", Theme.TEXT, new Runnable() {
                @Override public void run() { addFromKakao(a); }
            }));
            g.addView(Ui.navRow(a, Icon.DOOR, Theme.RED, "연결 해제", "", Theme.TEXT, new Runnable() {
                @Override public void run() { confirmUnlink(a); }
            }));
            col.addView(g);
        }

        col.addView(Nav.note(a, "카카오톡의 태블릿 로그인 자리를 사용합니다. 휴대폰 카카오톡은 그대로 유지되며,"
                + " 같은 계정으로 쓰던 태블릿이 있으면 그 기기는 로그아웃됩니다.\n"
                + "로그인 정보는 이 휴대폰에만 암호화되어 저장되고 비밀번호는 저장하지 않습니다.",
                Theme.ACCENT2, null, null));
    }

    // ── 대상 대화방 ↔ 카카오 방 ─────────────────────────────────────────────

    private static void fillRooms(final MainActivity a, LinearLayout col, int fc) {
        final List<RoomRef> targets = Settings.load(a).macro.roomRefs();
        col.addView(Ui.sectionHeader(a, null, "대상 대화방 연결"));
        if (targets.isEmpty()) {
            col.addView(Nav.note(a, "매크로 대상 대화방이 없습니다. 아래 「카카오 대화방에서 대상 추가」로"
                    + " 알림을 받은 적 없는 대화방도 바로 지정할 수 있습니다.", Theme.ACCENT2, null, null));
            return;
        }
        int unlinked = 0;
        LinearLayout g = Ui.group(a);
        for (int i = 0; i < targets.size(); i++) {
            final RoomRef r = targets.get(i);
            RoomLinks.Link l = RoomLinks.get(a, r);
            if (l == null) unlinked++;
            g.addView(Ui.navRow(a, Icon.ROOMS, fc, r.label(a), (l == null) ? "연결 안 됨" : ("› " + l.kakaoName),
                    (l == null) ? Theme.DIM : Theme.OK, new Runnable() {
                        @Override public void run() { pickFor(a, r); }
                    }));
        }
        col.addView(g);
        if (unlinked > 0) {
            col.addView(Nav.note(a, "연결되지 않은 대화방 " + unlinked + "개는 등록한 계정으로 보낼 수 없습니다. 목록에서 연결하십시오.",
                    Theme.ACCENT2, "이름으로 일괄 연결", new Runnable() {
                        @Override public void run() { matchByName(a); }
                    }));
        }
    }

    /** 카카오 방 목록을 받아 화면 스레드로 넘긴다 */
    private interface OnRooms { void rooms(List<KakaoEngine.KakaoRoom> list); }

    private static void loadRooms(final MainActivity a, final OnRooms cb) {
        final AlertDialog wait = progress(a, "대화방 목록을 불러오는 중입니다…");
        IO.execute(new Runnable() {
            @Override public void run() {
                List<KakaoEngine.KakaoRoom> list = null;
                String err = null;
                try {
                    list = Engine.get(a).rooms(true);
                } catch (EngineException e) {
                    err = e.userText();
                } catch (Throwable t) {
                    err = String.valueOf(t);
                }
                final List<KakaoEngine.KakaoRoom> got = list;
                final String why = err;
                H.post(new Runnable() {
                    @Override public void run() {
                        dismiss(wait);
                        if (a.isFinishing()) return;
                        if (got == null) {
                            fail(a, "대화방 목록을 불러오지 못했습니다", why);
                            refresh();
                            return;
                        }
                        cb.rooms(got);
                    }
                });
            }
        });
    }

    private static void pickFor(final MainActivity a, final RoomRef ref) {
        loadRooms(a, new OnRooms() {
            @Override public void rooms(final List<KakaoEngine.KakaoRoom> list) {
                if (list.isEmpty()) { Ui.toast(a, "카카오 계정에 대화방이 없습니다."); return; }
                final ArrayList<KakaoEngine.KakaoRoom> order = new ArrayList<KakaoEngine.KakaoRoom>();
                List<RoomLinks.Suggestion> sug = RoomLinks.suggest(a, singleton(ref), list);
                if (!sug.isEmpty()) order.addAll(sug.get(0).candidates);
                for (int i = 0; i < list.size(); i++) if (!order.contains(list.get(i))) order.add(list.get(i));
                final boolean linked = RoomLinks.get(a, ref) != null;
                int n = order.size() + (linked ? 1 : 0);
                String[] labels = new String[n];
                String[] descs = new String[n];
                int sugN = sug.isEmpty() ? 0 : sug.get(0).candidates.size();
                for (int i = 0; i < order.size(); i++) {
                    labels[i] = order.get(i).name();
                    descs[i] = describe(order.get(i)) + ((i < sugN) ? " · 이름 일치" : "");
                }
                if (linked) {
                    labels[n - 1] = "연결 끊기";
                    descs[n - 1] = "연결을 끊으면 이 대화방으로는 보내지 않습니다";
                }
                Nav.choose(a, "「" + ref.label(a) + "」 연결", labels, descs, -1, new Nav.OnPick() {
                    @Override public void pick(int index) {
                        if (index == order.size()) {
                            RoomLinks.remove(a, ref);
                            Log.add(a, "「" + ref.label(a) + "」 의 카카오 방 연결을 해제했습니다.");
                            refresh();
                            return;
                        }
                        if (index < 0 || index >= order.size()) return;
                        link(a, ref, order.get(index));
                    }
                });
            }
        });
    }

    private static void matchByName(final MainActivity a) {
        loadRooms(a, new OnRooms() {
            @Override public void rooms(List<KakaoEngine.KakaoRoom> list) {
                List<RoomLinks.Suggestion> sug = RoomLinks.suggest(a, Settings.load(a).macro.roomRefs(), list);
                final ArrayList<RoomLinks.Suggestion> sure = new ArrayList<RoomLinks.Suggestion>();
                int many = 0, none = 0;
                StringBuilder sb = new StringBuilder();
                for (int i = 0; i < sug.size(); i++) {
                    RoomLinks.Suggestion s = sug.get(i);
                    if (s.unique()) {
                        sure.add(s);
                        sb.append("• ").append(s.ref.label(a)).append("  →  ")
                          .append(describe(s.candidates.get(0))).append('\n');
                    } else if (s.candidates.isEmpty()) {
                        none++;
                    } else {
                        many++;
                    }
                }
                if (many > 0) sb.append("\n이름이 같은 방이 여럿인 대화방 ").append(many).append("개는 직접 선택하십시오.");
                if (none > 0) sb.append("\n이름이 같은 방이 없는 대화방 ").append(none).append("개는 직접 선택하십시오.");
                if (sure.isEmpty()) {
                    Ui.showDark(Ui.dialog(a, "이름으로 일괄 연결")
                            .setMessage("자동으로 연결할 수 있는 대화방이 없습니다." + sb)
                            .setPositiveButton("확인", null));
                    return;
                }
                Nav.confirm(a, "이름으로 일괄 연결", "아래 " + sure.size() + "개 대화방을 연결합니다. 이후 이미지는"
                        + " 연결된 카카오 방으로 직접 전송됩니다.\n\n" + sb.toString().trim(), "연결", new Runnable() {
                    @Override public void run() {
                        int ok = 0;
                        for (int i = 0; i < sure.size(); i++) {
                            if (RoomLinks.put(a, sure.get(i).ref, sure.get(i).candidates.get(0))) ok++;
                        }
                        Log.add(a, "대화방 " + ok + "개를 카카오 방과 연결했습니다.");
                        Ui.toast(a, "대화방 " + ok + "개를 연결했습니다.");
                        refresh();
                    }
                });
            }
        });
    }

    /** 카카오 방 목록에서 골라 매크로 대상으로 바로 추가한다 (알림을 받은 적 없는 방도 된다) */
    private static void addFromKakao(final MainActivity a) {
        loadRooms(a, new OnRooms() {
            @Override public void rooms(List<KakaoEngine.KakaoRoom> list) {
                final Settings s = Settings.load(a);
                final ArrayList<KakaoEngine.KakaoRoom> free = new ArrayList<KakaoEngine.KakaoRoom>();
                for (int i = 0; i < list.size(); i++) {
                    if (RoomLinks.refFor(a, list.get(i).chatId) == null) free.add(list.get(i));
                }
                if (free.isEmpty()) { Ui.toast(a, "추가할 수 있는 카카오 대화방이 없습니다."); return; }
                String[] labels = new String[free.size()];
                String[] descs = new String[free.size()];
                for (int i = 0; i < free.size(); i++) {
                    labels[i] = free.get(i).name();
                    descs[i] = describe(free.get(i));
                }
                Nav.choose(a, "대상 대화방 추가", labels, descs, -1, new Nav.OnPick() {
                    @Override public void pick(int index) {
                        if (index < 0 || index >= free.size()) return;
                        KakaoEngine.KakaoRoom k = free.get(index);
                        RoomRef ref = RoomRef.of(k.name());
                        if (RoomLinks.get(a, ref) != null) {
                            Ui.toast(a, "이름이 같은 대상 대화방이 이미 다른 카카오 방과 연결되어 있습니다.");
                            return;
                        }
                        if (!s.macro.coversRoom(ref)) {
                            s.macro.rooms.add(ref.key());
                            ScreenMacro.apply(a, s);
                        }
                        link(a, ref, k);
                        try { ScreenMacro.refresh(); } catch (Throwable ignore) { }
                    }
                });
            }
        });
    }

    private static void link(MainActivity a, RoomRef ref, KakaoEngine.KakaoRoom k) {
        if (!RoomLinks.put(a, ref, k)) {
            Ui.toast(a, "라이선스 인증 후 연결할 수 있습니다.");
            return;
        }
        Log.add(a, "「" + ref.label(a) + "」 을 카카오 방 「" + k.name() + "」 과 연결했습니다.");
        Ui.toast(a, "연결했습니다.");
        refresh();
    }

    private static String describe(KakaoEngine.KakaoRoom k) {
        String kind;
        if ("dm".equals(k.kind)) kind = "1:1";
        else if ("open".equals(k.kind)) kind = "오픈채팅";
        else if ("group".equals(k.kind)) kind = "그룹";
        else kind = "대화방";
        String n = (k.members > 0) ? (" · " + k.members + "명") : "";
        String at = (k.lastAt > 0) ? (" · " + ScreenRooms.ago(k.lastAt)) : "";
        return k.name() + " (" + kind + n + at + ")";
    }

    private static List<RoomRef> singleton(RoomRef r) {
        ArrayList<RoomRef> l = new ArrayList<RoomRef>();
        l.add(r);
        return l;
    }

    // ── 연결 (로그인) ───────────────────────────────────────────────────────

    private static void loginDialog(final MainActivity a, boolean forceDefault) {
        LinearLayout body = Nav.col(a);
        TextView help = Ui.sub(a, "카카오 계정(이메일 또는 전화번호)과 비밀번호를 입력하십시오."
                + " 다음 단계에서 휴대폰 카카오톡에 표시되는 코드를 확인합니다.");
        LinearLayout.LayoutParams hp = new LinearLayout.LayoutParams(MATCH, WRAP);
        hp.bottomMargin = Theme.dp(a, 12);
        help.setLayoutParams(hp);
        body.addView(help);

        final EditText id = Ui.field(a, "카카오 계정");
        id.setSingleLine(true);
        id.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        id.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS);
        body.addView(id);

        final EditText pw = Ui.field(a, "비밀번호");
        pw.setSingleLine(true);
        pw.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        pw.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
        LinearLayout.LayoutParams pp = new LinearLayout.LayoutParams(MATCH, WRAP);
        pp.topMargin = Theme.dp(a, 10);
        pw.setLayoutParams(pp);
        body.addView(pw);

        final boolean[] force = { forceDefault };
        LinearLayout sw = Ui.switchRow(a, "태블릿 로그인 가져오기",
                "같은 계정의 다른 태블릿이 로그인되어 있으면 로그아웃시키고 연결합니다", forceDefault,
                new Ui.OnToggle() {
                    @Override public void on(boolean v) { force[0] = v; }
                });
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(MATCH, WRAP);
        sp.topMargin = Theme.dp(a, 12);
        sw.setLayoutParams(sp);
        body.addView(sw);

        Nav.form(a, "카카오 계정 연결", body, "다음", new Nav.OnSave() {
            @Override public String save() {
                String acc = id.getText().toString().trim();
                String pass = pw.getText().toString();
                if (acc.length() == 0) return "카카오 계정을 입력하십시오.";
                if (pass.length() == 0) return "비밀번호를 입력하십시오.";
                pw.setText("");
                begin(a, acc, pass, force[0]);
                return null;
            }
        });
    }

    private static void begin(final MainActivity a, final String acc, final String pass, final boolean force) {
        final AlertDialog wait = progress(a, "카카오 서버에 연결하는 중입니다…");
        IO.execute(new Runnable() {
            @Override public void run() {
                KakaoEngine.LoginStep step = null;
                String err = null;
                try {
                    step = Engine.get(a).beginLogin(acc, pass, force);
                } catch (EngineException e) {
                    err = e.userText();
                } catch (Throwable t) {
                    err = String.valueOf(t);
                }
                final KakaoEngine.LoginStep got = step;
                final String why = err;
                H.post(new Runnable() {
                    @Override public void run() {
                        dismiss(wait);
                        if (a.isFinishing()) return;
                        if (got == null) { fail(a, "연결하지 못했습니다", why); return; }
                        if (got.kind == KakaoEngine.LoginStep.Kind.SLOT_OCCUPIED) {
                            Nav.confirm(a, "태블릿 로그인 사용 중",
                                    "이 계정은 다른 태블릿에 로그인되어 있습니다. 계속하면 그 기기의 카카오톡이 로그아웃됩니다.",
                                    "계속", new Runnable() {
                                        @Override public void run() { begin(a, acc, pass, true); }
                                    });
                            return;
                        }
                        step(a, got);
                    }
                });
            }
        });
    }

    private static void step(final MainActivity a, KakaoEngine.LoginStep s) {
        switch (s.kind) {
            case OK:
                Ui.toast(a, "카카오 계정을 연결했습니다.");
                refresh();
                if (!Settings.load(a).macro.roomRefs().isEmpty()) matchByName(a);
                return;
            case CONFIRM_ON_PHONE:
                confirmOnPhone(a, s);
                return;
            case BAD_CREDENTIALS:
                fail(a, "연결하지 못했습니다", "카카오 계정 또는 비밀번호가 일치하지 않습니다.");
                return;
            case EXPIRED:
                fail(a, "확인 시간 초과", "확인 코드가 만료되었습니다. 처음부터 다시 연결하십시오.");
                return;
            default:
                fail(a, "연결하지 못했습니다", s.message);
        }
    }

    /** 폰 카카오톡에 뜨는 확인 요청에 이 코드를 입력(확인)할 때까지 기다린다 */
    private static void confirmOnPhone(final MainActivity a, final KakaoEngine.LoginStep first) {
        LinearLayout body = Nav.col(a);
        int ph = Theme.dp(a, 22);
        body.setPadding(ph, Theme.dp(a, 6), ph, Theme.dp(a, 12));
        body.addView(Ui.sub(a, "아래 코드를 카카오톡의 기기 연결 요청에 입력하십시오."
                + " 이 앱에는 코드를 입력하지 않습니다. 확인이 끝나면 자동으로 다음 단계로 진행합니다."));
        TextView code = new TextView(a);
        code.setText(spaced(first.passcode));
        code.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        code.setTextSize(TypedValue.COMPLEX_UNIT_SP, 30f);
        code.setTextColor(Theme.GOLD_HI);
        code.setGravity(Gravity.CENTER);
        code.setTextIsSelectable(true);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(MATCH, WRAP);
        cp.topMargin = Theme.dp(a, 18);
        cp.bottomMargin = Theme.dp(a, 8);
        code.setLayoutParams(cp);
        body.addView(code);
        final TextView left = Ui.sub(a, first.remainingSeconds > 0
                ? ("유효 시간 " + (first.remainingSeconds / 60) + "분 " + (first.remainingSeconds % 60) + "초")
                : "확인을 기다리는 중입니다…");
        left.setGravity(Gravity.CENTER);
        body.addView(left);

        final boolean[] gone = { false };
        final AlertDialog d = Ui.dialog(a, "카카오톡에 입력")
                .setView(body)
                .setCancelable(false)
                .setNegativeButton("취소", new android.content.DialogInterface.OnClickListener() {
                    @Override public void onClick(android.content.DialogInterface di, int w) {
                        gone[0] = true;
                        Engine.get(a).cancelLogin(first.pendingId);
                    }
                })
                .create();
        Ui.showDark(d);

        final long until = System.currentTimeMillis()
                + ((first.remainingSeconds > 0) ? first.remainingSeconds * 1000L : 10 * 60 * 1000L);
        final Runnable tick = new Runnable() {
            @Override public void run() {
                if (gone[0] || !d.isShowing()) return;
                long s = Math.max(0L, (until - System.currentTimeMillis()) / 1000L);
                left.setText("유효 시간 " + (s / 60) + "분 " + (s % 60) + "초");
                H.postDelayed(this, 1000L);
            }
        };
        if (first.remainingSeconds > 0) H.post(tick);

        IO.execute(new Runnable() {
            @Override public void run() {
                KakaoEngine.LoginStep s = null;
                String err = null;
                while (!gone[0]) {
                    try {
                        s = Engine.get(a).awaitPhoneConfirm(first.pendingId);
                    } catch (EngineException e) {
                        err = e.userText();
                        break;
                    } catch (Throwable t) {
                        err = String.valueOf(t);
                        break;
                    }
                    if (s.kind != KakaoEngine.LoginStep.Kind.WAITING) break;
                }
                if (gone[0]) return;
                final KakaoEngine.LoginStep got = s;
                final String why = err;
                H.post(new Runnable() {
                    @Override public void run() {
                        gone[0] = true;
                        dismiss(d);
                        if (a.isFinishing()) return;
                        if (got == null) { fail(a, "연결하지 못했습니다", why); return; }
                        step(a, got);
                    }
                });
            }
        });
    }

    private static String spaced(String code) {
        if (code == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < code.length(); i++) {
            if (i > 0) sb.append(' ');
            sb.append(code.charAt(i));
        }
        return sb.toString();
    }

    private static void confirmUnlink(final MainActivity a) {
        Nav.confirm(a, "연결 해제", "이 휴대폰에 저장된 카카오 로그인과 대화방 연결을 삭제합니다."
                + " 이후에는 알림 답장 방식으로만 발송합니다.\n"
                + "카카오톡 › 설정 › 기기 연결 관리에서 이 기기를 함께 삭제할 수 있습니다.", "해제", new Runnable() {
            @Override public void run() {
                Engine.get(a).unlink();
                Ui.toast(a, "연결을 해제했습니다.");
                refresh();
            }
        });
    }

    // ── 공용 ────────────────────────────────────────────────────────────────

    private static AlertDialog progress(MainActivity a, String msg) {
        return Ui.showDark(Ui.dialog(a, "잠시 기다려 주십시오").setMessage(msg).setCancelable(false));
    }

    private static void dismiss(AlertDialog d) {
        try { if (d != null && d.isShowing()) d.dismiss(); } catch (Throwable ignore) { }
    }

    private static void fail(MainActivity a, String title, String why) {
        String msg = (why == null || why.trim().length() == 0) ? "원인을 확인하지 못했습니다." : why;
        Ui.showDark(Ui.dialog(a, title).setMessage(msg).setPositiveButton("확인", null));
    }
}
