package com.buseong.kakaoauto;

import android.graphics.Typeface;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.lang.ref.WeakReference;

/**
 * 내정보 탭. 라이선스 · 기능 만료일 · 기기 · 서버주소(고급) · 로그 · 로그아웃.
 * 문제가 생겼을 때 사용자가 제일 먼저 오는 화면이니까, 로그를 크게 다룬다.
 */
public final class ScreenAccount {
    private ScreenAccount() {}

    private static final int MATCH = LinearLayout.LayoutParams.MATCH_PARENT;
    private static final int WRAP = LinearLayout.LayoutParams.WRAP_CONTENT;

    private static final int F_ADV = 1;
    private static final int F_LOG = 1 << 1;
    private static int openBits = 0;

    private static WeakReference<MainActivity> ACT;
    private static WeakReference<LinearLayout> BODY;

    // ── 셸 ──────────────────────────────────────────────────────────────────

    public static View build(MainActivity a) {
        LinearLayout col = Ui.screen(a);
        ACT = new WeakReference<MainActivity>(a);
        BODY = new WeakReference<LinearLayout>(col);
        try {
            fill(a, col);
        } catch (Throwable t) {
            Log.add(a, "내정보 화면을 그리다 오류가 났어: " + t);
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
            Log.add(a, "내정보 화면을 갱신하다 오류가 났어: " + t);
        }
    }

    private static void fill(final MainActivity a, LinearLayout col) {
        col.addView(Ui.title(a, "내정보"));

        final License.State st = License.state(a);

        col.addView(licenseCard(a, st));

        col.addView(Ui.sectionHeader(a, "구독", "기능별 남은 기간"));
        for (int i = 0; i < Features.ALL.length; i++) {
            final String id = Features.ALL[i];
            Ui.State fs = MainActivity.featState(a, id);
            long exp = 0L;
            License.Feat f = (st.features == null) ? null : st.features.get(id);
            if (f != null) exp = f.expiresAt;
            col.addView(featureRow(a, id, fs, exp));
        }

        col.addView(Ui.sectionHeader(a, "기기", "이 기기 정보"));
        col.addView(deviceCard(a, st));

        col.addView(advFold(a).card);
        col.addView(logFold(a).card);

        col.addView(signOutBtn(a));
        col.addView(footer(a));
    }

    // ── 라이선스 ────────────────────────────────────────────────────────────

    private static LinearLayout licenseCard(final MainActivity a, final License.State st) {
        LinearLayout card = Ui.card(a);

        LinearLayout head = Ui.row(a);
        TextView t = Ui.h2(a, "라이선스");
        t.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        head.addView(t);
        boolean ok = st.licensed && !st.locked;
        head.addView(Ui.chip(a, ok ? "인증됨" : (st.locked ? "잠김" : "미인증"),
                ok ? Theme.ACCENT : Theme.RED));
        card.addView(head);

        TextView keyView = Ui.mono(a, maskKey(st.key));
        LinearLayout.LayoutParams kp = new LinearLayout.LayoutParams(MATCH, WRAP);
        kp.topMargin = Theme.dp(a, 12);
        keyView.setLayoutParams(kp);
        card.addView(keyView);

        LinearLayout btns = Ui.row(a);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
        bp.topMargin = Theme.dp(a, 10);
        btns.setLayoutParams(bp);

        TextView copy = Ui.btn(a, "키 복사", false);
        copy.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        copy.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (st.key == null || st.key.length() == 0) { Ui.toast(a, "복사할 키가 없어"); return; }
                Nav.copy(a, "라이선스 키", st.key);
            }
        });
        btns.addView(copy);

        final TextView refresh = Ui.btn(a, "기능 새로고침", true);
        LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(0, WRAP, 1.2f);
        rp.leftMargin = Theme.dp(a, 10);
        refresh.setLayoutParams(rp);
        refresh.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Nav.busy(refresh, true, "확인 중…", "기능 새로고침");
                License.refresh(a, new License.Cb() {
                    @Override public void done(boolean okk, String reason) {
                        Nav.busy(refresh, false, "확인 중…", "기능 새로고침");
                        if (a.isFinishing()) return;
                        if (!okk) {
                            Ui.toast(a, License.reasonKr(reason));
                            Log.add(a, "기능 새로고침 실패: " + License.reasonKr(reason));
                            a.renderShell();
                            return;
                        }
                        Ui.toast(a, "최신 상태로 맞췄어");
                        a.renderShell();
                    }
                });
            }
        });
        btns.addView(refresh);
        card.addView(btns);

        if (!ok) {
            String why = License.reasonKr(st.reason);
            card.addView(Nav.note(a, (why.length() == 0 ? "인증이 안 된 상태야." : why)
                    + "\n다시 인증하려면 로그아웃 후 키를 넣어줘.", Theme.RED, null, null));
        } else {
            card.addView(Ui.kv(a, "마지막 확인", Nav.when(st.lastOk)));
            card.addView(Ui.kv(a, "오프라인 허용", Nav.dur(st.graceMs)));
        }

        card.addView(Nav.wideBtn(a, "구매 · 연장하기", false, new Runnable() {
            @Override public void run() { Gate.openBuy(a, Features.MACRO); }
        }));
        return card;
    }

    private static String maskKey(String key) {
        if (key == null || key.length() == 0) return "키 없음";
        String k = key.trim();
        if (k.length() <= 8) return k;
        int tail = 4;
        StringBuilder sb = new StringBuilder();
        sb.append(k, 0, 4);
        for (int i = 4; i < k.length() - tail; i++) {
            char ch = k.charAt(i);
            sb.append(ch == '-' ? '-' : '•');
        }
        sb.append(k.substring(k.length() - tail));
        return sb.toString();
    }

    // ── 기능별 만료일 카드 ──────────────────────────────────────────────────

    private static LinearLayout featureRow(final MainActivity a, final String id,
                                           Ui.State fs, final long expiresAt) {
        return Ui.featureCard(a, Features.label(id), expiryDesc(fs, expiresAt), fs, expiresAt,
                new Runnable() {
                    @Override public void run() { Gate.openBuy(a, id); }
                }, null);
    }

    private static String expiryDesc(Ui.State fs, long expiresAt) {
        if (fs == Ui.State.OFF) {
            if (expiresAt > 0) return "기간이 끝났어 (" + Nav.day(expiresAt) + ")";
            return "아직 구매하지 않았어";
        }
        return Nav.day(expiresAt) + " 까지 · " + Ui.daysLeft(expiresAt) + "일 남았어";
    }

    // ── 기기 ────────────────────────────────────────────────────────────────

    private static LinearLayout deviceCard(final MainActivity a, License.State st) {
        LinearLayout card = Ui.card(a);
        card.addView(Ui.kv(a, "기기명", Device.deviceName()));
        card.addView(Ui.kv(a, "기기 ID", shortId(st.deviceId)));
        long at = MainActivity.activatedAt(a);
        card.addView(Ui.kv(a, "등록일", (at > 0) ? Nav.day(at) : "기록 없음"));
        card.addView(Ui.kv(a, "안드로이드", "SDK " + android.os.Build.VERSION.SDK_INT));

        card.addView(Nav.note(a, "키 1개는 기기 1대에서만 쓸 수 있어.\n"
                + "기기를 바꾸거나 초기화했으면 관리자에게 기기 초기화를 요청해줘.",
                Theme.ACCENT2, "기기 초기화 요청", new Runnable() {
                    @Override public void run() { Gate.openMy(a); }
                }));
        return card;
    }

    // ── 고급 (서버 주소) ────────────────────────────────────────────────────

    private static Nav.Fold advFold(final MainActivity a) {
        final Nav.Fold f = fold(a, F_ADV, "고급", "서버 주소 · 방 목록 초기화");

        f.body.addView(Ui.sub(a, "보통은 손댈 필요 없어. 관리자가 알려준 경우에만 바꿔줘."));
        f.body.addView(Nav.actionRow(a, "서버 주소", License.server(a), "변경", new Runnable() {
            @Override public void run() { editServer(a); }
        }));
        f.body.addView(Ui.divider(a));
        f.body.addView(Nav.actionRow(a, "감지된 방 목록",
                KakaoListener.knownRooms(a).size() + "개 기억 중", "비우기", new Runnable() {
                    @Override public void run() {
                        Nav.confirm(a, "방 목록을 비울까?",
                                "지금까지 감지한 방 이름을 다 지운다. 설정한 대상 방은 안 지워져.\n"
                                        + "카톡 알림이 다시 오면 새로 채워진다.",
                                "비우기", new Runnable() {
                                    @Override public void run() {
                                        KakaoListener.clearRooms(a);
                                        Log.add(a, "감지된 방 목록을 비웠어");
                                        refresh();
                                    }
                                });
                    }
                }));
        return f;
    }

    private static void editServer(final MainActivity a) {
        LinearLayout body = Nav.col(a);
        body.addView(Ui.sub(a, "비우고 저장하면 기본 주소로 돌아간다.\n기본값: " + License.SERVER));

        TextView lb = Ui.label(a, "서버 주소");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(a, 14);
        lp.bottomMargin = Theme.dp(a, 6);
        lb.setLayoutParams(lp);
        body.addView(lb);

        final EditText f = Ui.field(a, License.SERVER);
        f.setSingleLine(true);
        f.setGravity(Gravity.CENTER_VERTICAL | Gravity.START);
        f.setText(License.server(a));
        body.addView(f);
        final TextView err = Nav.errLine(a);
        body.addView(err);

        Nav.form(a, "서버 주소", body, "저장", new Nav.OnSave() {
            @Override public String save() {
                Nav.errClear(err);
                String v = f.getText().toString().trim();
                if (v.length() > 0 && !v.startsWith("http://") && !v.startsWith("https://")) {
                    Nav.errText(err, "http:// 또는 https:// 로 시작해야 해");
                    return "";
                }
                License.setServer(a, v);
                refresh();
                return null;
            }
        });
    }

    // ── 로그 ────────────────────────────────────────────────────────────────

    private static Nav.Fold logFold(final MainActivity a) {
        final int n = Log.count(a);
        final Nav.Fold f = fold(a, F_LOG, "활동 로그", n + "줄 보관 중 (최근 200줄)");

        final String dump = Log.dump(a);
        TextView view = Ui.mono(a, (dump == null || dump.length() == 0) ? "(비어있어)" : dump);
        view.setMaxLines(14);
        view.setEllipsize(TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(MATCH, WRAP);
        vp.topMargin = Theme.dp(a, 10);
        view.setLayoutParams(vp);
        f.body.addView(view);

        LinearLayout btns = Ui.row(a);
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(MATCH, WRAP);
        bp.topMargin = Theme.dp(a, 12);
        btns.setLayoutParams(bp);

        TextView all = Ui.btn(a, "전체보기", false);
        all.setLayoutParams(new LinearLayout.LayoutParams(0, WRAP, 1f));
        all.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Nav.showText(a, "활동 로그", Log.dump(a), new Runnable() {
                    @Override public void run() { Nav.copy(a, "활동 로그", Log.dump(a)); }
                });
            }
        });
        btns.addView(all);

        TextView copy = Ui.btn(a, "복사", false);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(0, WRAP, 1f);
        cp.leftMargin = Theme.dp(a, 8);
        copy.setLayoutParams(cp);
        copy.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { Nav.copy(a, "활동 로그", Log.dump(a)); }
        });
        btns.addView(copy);

        TextView clear = Ui.btn(a, "지우기", false);
        clear.setTextColor(Theme.RED);
        LinearLayout.LayoutParams lp2 = new LinearLayout.LayoutParams(0, WRAP, 1f);
        lp2.leftMargin = Theme.dp(a, 8);
        clear.setLayoutParams(lp2);
        clear.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Nav.confirm(a, "로그를 지울까?", "보관된 " + Log.count(a) + "줄을 다 지운다. 되돌릴 수 없어.",
                        "지우기", new Runnable() {
                            @Override public void run() {
                                Log.clear(a);
                                Ui.toast(a, "로그를 지웠어");
                                refresh();
                            }
                        });
            }
        });
        btns.addView(clear);
        f.body.addView(btns);
        return f;
    }

    // ── 로그아웃 · 꼬리말 ───────────────────────────────────────────────────

    private static TextView signOutBtn(final MainActivity a) {
        TextView b = Ui.btn(a, "로그아웃", false);
        b.setTextColor(Theme.RED);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(a, 20);
        b.setLayoutParams(lp);
        b.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Nav.confirm(a, "로그아웃할까?",
                        "이 기기에서 라이선스를 뗀다. 저장된 설정(방·메시지·트리거)도 같이 지워져 — "
                                + "설정은 라이선스 키로 암호화돼 있어서 키가 없으면 못 읽어.\n\n"
                                + "기기 고정은 서버에 남아있으니, 같은 기기에서 같은 키로 다시 인증할 수 있어.",
                        "로그아웃", new Runnable() {
                            @Override public void run() {
                                try {
                                    Scheduler.cancel(a);
                                } catch (Throwable t) {
                                    Log.add(a, "발송 예약을 못 껐어: " + t);
                                }
                                License.signOut(a);
                                Ui.toast(a, "로그아웃했어");
                                a.renderShell();
                            }
                        });
            }
        });
        return b;
    }

    private static LinearLayout footer(final MainActivity a) {
        LinearLayout box = Nav.col(a);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(MATCH, WRAP);
        lp.topMargin = Theme.dp(a, 22);
        box.setLayoutParams(lp);

        TextView v = Ui.sub(a, "카톡 오토 " + Device.appVersionName(a)
                + " (" + Device.appVersion(a) + ")");
        v.setGravity(Gravity.CENTER);
        box.addView(v);

        String sig = Device.appSigSha256(a);
        String shown = (sig == null || sig.length() < 12) ? "확인 불가" : sig.substring(0, 12);
        final String full = (sig == null) ? "" : sig;
        TextView sv = new TextView(a);
        sv.setText("서명 " + shown);
        sv.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12f);
        sv.setTextColor(Theme.DIM);
        sv.setTypeface(Typeface.MONOSPACE);
        sv.setGravity(Gravity.CENTER);
        sv.setIncludeFontPadding(false);
        sv.setMinimumHeight(Theme.dp(a, 48));
        sv.setClickable(true);
        sv.setFocusable(true);
        Ui.press(sv);
        sv.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View vv) {
                if (full.length() == 0) { Ui.toast(a, "서명을 못 읽었어"); return; }
                Nav.copy(a, "앱 서명 SHA-256", full);
            }
        });
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(MATCH, WRAP);
        sp.topMargin = Theme.dp(a, 4);
        sv.setLayoutParams(sp);
        box.addView(sv);

        String tamper = Device.tamperFlags(a);
        if (tamper != null && tamper.length() > 0) {
            box.addView(Nav.note(a, "변조 지표가 감지됐어: " + tamper + "\n"
                    + "정식 APK가 아니거나 개발자 모드일 수 있어. 인증이 거부될 수 있어.",
                    Theme.AMBER, null, null));
        }
        return box;
    }

    // ── 공통 ────────────────────────────────────────────────────────────────

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

    private static String shortId(String id) {
        if (id == null || id.length() == 0) return "-";
        if (id.length() <= 10) return id;
        return id.substring(0, 6) + "…" + id.substring(id.length() - 4);
    }
}
