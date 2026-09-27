package com.buseong.kakaoadmin;

import android.app.AlertDialog;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * [설정] 탭 — 서버주소·비밀번호 수정, 앱서명 허용목록, 통계 상세, 로그아웃, 마지막 크래시/로그 보기.
 *
 * 앱서명 허용목록(app_signatures)이 비어있으면 서버가 서명검사를 통과시켜준다(이관 유예).
 * 그래서 이 화면에서 "비어있음" 을 눈에 띄게 경고한다 — 리패키징 방지의 핵심이니까.
 */
public final class ScreenSettings implements MainActivity.Screen {

    private final MainActivity a;

    private ScrollView rootView;
    private EditText baseField;
    private EditText pwFieldView;
    private View rememberRow;
    private LinearLayout sigBox;
    private TextView sigNote;
    private LinearLayout statBox;
    private TextView crashLabel;

    public ScreenSettings(MainActivity act) { this.a = act; }

    // ── 화면 ──────────────────────────────────────────────────────────────────

    @Override public View view() {
        if (rootView != null) return rootView;

        LinearLayout page = Ui.screen(a);
        page.addView(Ui.title(a, "설정"));

        // ── 서버 접속
        LinearLayout conn = Ui.card(a);
        conn.addView(Ui.h2(a, "서버 접속"));
        TextView ch = Ui.sub(a, "주소나 비밀번호를 바꾸면 저장할 때 바로 확인해봐.");
        mt(ch, 6);
        conn.addView(ch);

        TextView l1 = Ui.label(a, "서버 주소");
        mt(l1, 14);
        conn.addView(l1);
        baseField = Ui.lineField(a, Api.DEFAULT_BASE);
        baseField.setText(Api.base(a));
        baseField.setInputType(android.text.InputType.TYPE_TEXT_VARIATION_URI);
        mt(baseField, 7);
        conn.addView(baseField);

        TextView l2 = Ui.label(a, "관리자 비밀번호");
        mt(l2, 14);
        conn.addView(l2);
        pwFieldView = Ui.pwField(a, "바꾸지 않으려면 비워둬");
        mt(pwFieldView, 7);
        conn.addView(pwFieldView);

        rememberRow = Ui.switchRow(a, "비밀번호 저장", "끄면 앱을 닫을 때 비번이 사라져.",
                Api.remember(a), null);
        mt(rememberRow, 4);
        conn.addView(rememberRow);

        TextView save = Ui.btn(a, "저장하고 확인", true);
        mt(save, 6);
        save.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { saveConn(); }
        });
        conn.addView(save);
        page.addView(conn);

        // ── 앱서명 허용목록
        LinearLayout sigs = Ui.card(a);
        sigs.addView(Ui.h2(a, "앱 서명 허용목록"));
        TextView sh = Ui.sub(a, "여기에 등록된 SHA-256 서명으로 빌드된 APK 만 인증을 통과해.\n"
                + "빌드할 때 build.sh 가 출력하는 '서버 등록용 hex' 를 붙여넣어라.");
        mt(sh, 6);
        sigs.addView(sh);

        sigNote = Ui.hint(a, "");
        mt(sigNote, 10);
        sigs.addView(sigNote);

        sigBox = Ui.col(a);
        mt(sigBox, 10);
        sigs.addView(sigBox);

        TextView addSig = Ui.btn(a, "＋  서명 추가", false);
        mt(addSig, 10);
        addSig.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openAddSig(); }
        });
        sigs.addView(addSig);
        page.addView(sigs);

        // ── 통계 상세
        LinearLayout st = Ui.card(a);
        st.addView(Ui.h2(a, "통계"));
        statBox = Ui.col(a);
        mt(statBox, 8);
        st.addView(statBox);
        page.addView(st);

        // ── 진단
        LinearLayout diag = Ui.card(a);
        diag.addView(Ui.h2(a, "진단"));
        crashLabel = Ui.hint(a, "");
        mt(crashLabel, 8);
        diag.addView(crashLabel);

        TextView logBtn = Ui.btn(a, "앱 로그 보기", false);
        mt(logBtn, 10);
        logBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Ui.showText(a, "앱 로그 (최근 200줄)", App.logDump(a));
            }
        });
        diag.addView(logBtn);

        TextView crashBtn = Ui.btn(a, "마지막 크래시 보기", false);
        mt(crashBtn, 8);
        crashBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String c = App.lastCrash(a);
                if (c == null) { Ui.toast(a, "저장된 크래시가 없어 — 좋은 거야"); return; }
                Ui.showText(a, "마지막 크래시 · " + Ui.fmtFull(App.lastCrashAt(a)), c);
            }
        });
        diag.addView(crashBtn);

        TextView clearBtn = Ui.btn(a, "로그·크래시 기록 지우기", false);
        mt(clearBtn, 8);
        clearBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Ui.confirm(a, "기록 지우기", "이 기기에 쌓인 앱 로그와 크래시 기록을 지울까?\n"
                        + "서버 기록(감사로그)은 안 지워져.", "지우기", true, new Runnable() {
                    @Override public void run() {
                        App.logClear(a);
                        App.clearCrash(a);
                        App.log(a, "로그를 비웠어");
                        paintCrash();
                        Ui.toast(a, "지웠어");
                    }
                });
            }
        });
        diag.addView(clearBtn);
        page.addView(diag);

        // ── 로그아웃
        LinearLayout out = Ui.card(a);
        out.addView(Ui.h2(a, "로그아웃"));
        TextView oh = Ui.sub(a, "저장된 비밀번호를 이 기기에서 지우고 로그인 화면으로 돌아가.");
        mt(oh, 6);
        out.addView(oh);
        TextView logout = Ui.btnDanger(a, "로그아웃");
        mt(logout, 12);
        logout.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Ui.confirm(a, "로그아웃", "저장된 비밀번호를 지우고 로그인 화면으로 갈까?",
                        "로그아웃", true, new Runnable() {
                            @Override public void run() {
                                Api.signOut(a);
                                a.showLogin(null);
                            }
                        });
            }
        });
        out.addView(logout);
        page.addView(out);

        TextView ver = Ui.hint(a, "KakaoAdmin v2.0 · 관리자 전용\n서버: " + Api.base(a));
        LinearLayout.LayoutParams vp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        vp.topMargin = Theme.dp(a, 6);
        ver.setLayoutParams(vp);
        page.addView(ver);

        rootView = Ui.scroll(a, page);
        return rootView;
    }

    @Override public void reload() {
        paintCrash();
        paintStats();
        loadSigs();
    }

    // ── 서버 접속 저장 ────────────────────────────────────────────────────────

    private void saveConn() {
        String base = (baseField == null || baseField.getText() == null)
                ? "" : baseField.getText().toString().trim();
        String pw = (pwFieldView == null || pwFieldView.getText() == null)
                ? "" : pwFieldView.getText().toString();
        boolean keep = Ui.isOn(rememberRow);

        if (pw.length() == 0) pw = Api.password(a);
        if (pw.length() == 0) { Ui.toast(a, "비밀번호가 없어 — 새로 입력해줘"); return; }

        Api.signIn(a, base, pw, keep);
        if (pwFieldView != null) pwFieldView.setText("");
        Ui.toast(a, "확인 중…");
        Api.stats(a, new Api.Cb() {
            @Override public void done(Api.Result r) {
                if (!r.ok) {
                    // 401 이면 kicked 가 로그인 화면으로 보낸다
                    if (a.kicked(r)) return;
                    a.fail("서버 확인", r);
                    return;
                }
                Ui.toast(a, "저장했어");
                App.log(a, "서버 설정 저장 (" + Api.base(a) + ")");
                a.refreshStats();
                reload();
            }
        });
    }

    // ── 앱서명 허용목록 ───────────────────────────────────────────────────────

    private void loadSigs() {
        if (sigBox == null) return;
        sigBox.removeAllViews();
        sigBox.addView(Ui.emptyBox(a, "불러오는 중…"));
        Api.sigs(a, new Api.Cb() {
            @Override public void done(Api.Result r) {
                if (a.kicked(r)) return;
                if (sigBox == null) return;
                sigBox.removeAllViews();
                if (!r.ok) {
                    sigBox.addView(Ui.emptyBox(a, "허용목록을 못 읽었어\n" + r.error));
                    a.fail("서명 목록", r);
                    return;
                }
                JSONArray arr = r.arr("sigs");
                JSONArray env = r.arr("env_sigs");
                int minVer = r.integer("min_app_version");

                if (sigNote != null) {
                    StringBuilder n = new StringBuilder();
                    if (arr.length() == 0 && env.length() == 0) {
                        n.append("⚠ 허용목록이 완전히 비어있어 → 서버가 서명검사를 통과시켜. 지금 등록해줘.");
                        sigNote.setTextColor(Theme.AMBER);
                    } else {
                        n.append("DB ").append(arr.length()).append("개");
                        if (env.length() > 0) n.append(" · 환경변수 ").append(env.length()).append("개");
                        n.append(" · 최소 앱 버전 ").append(minVer == 0 ? "미적용" : String.valueOf(minVer));
                        sigNote.setTextColor(Theme.DIM);
                    }
                    sigNote.setText(n.toString());
                }

                if (arr.length() == 0) {
                    sigBox.addView(Ui.emptyBox(a, "DB 에 등록된 서명이 없어"));
                } else {
                    for (int i = 0; i < arr.length(); i++) {
                        JSONObject o = arr.optJSONObject(i);
                        if (o != null) sigBox.addView(sigRow(o));
                    }
                }

                for (int i = 0; i < env.length(); i++) {
                    String sha = env.optString(i, "");
                    if (sha.length() == 0) continue;
                    LinearLayout row = Ui.listCard(a);
                    LinearLayout top = Ui.row(a);
                    TextView lb = Ui.body(a, "환경변수 ALLOWED_APP_SIGS");
                    lb.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13f);
                    lb.setLayoutParams(new LinearLayout.LayoutParams(0,
                            LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
                    top.addView(lb);
                    TextView ro = Ui.chipSm(a, "읽기전용", Theme.DIM);
                    LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
                            LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                    rp.rightMargin = 0;
                    ro.setLayoutParams(rp);
                    top.addView(ro);
                    row.addView(top);
                    TextView sv = Ui.monoLine(a, sha, 11.5f, Theme.SUB);
                    mt(sv, 6);
                    row.addView(sv);
                    sigBox.addView(row);
                }
            }
        });
    }

    private LinearLayout sigRow(JSONObject o) {
        final String sha = o.optString("sha256", "");
        String label = o.optString("label", "");
        if ("null".equals(label)) label = "";
        boolean allowed = o.optBoolean("allowed", true);

        LinearLayout row = Ui.listCard(a);
        LinearLayout top = Ui.row(a);
        TextView lb = Ui.body(a, label.length() > 0 ? label : "(이름 없음)");
        lb.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13.5f);
        lb.setSingleLine(true);
        lb.setEllipsize(android.text.TextUtils.TruncateAt.END);
        lb.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        top.addView(lb);
        top.addView(Ui.chipSm(a, allowed ? "허용" : "차단", allowed ? Theme.ACCENT : Theme.RED));
        row.addView(top);

        TextView sv = Ui.monoLine(a, sha, 11.5f, Theme.SUB);
        mt(sv, 6);
        row.addView(sv);

        LinearLayout acts = Ui.row(a);
        mt(acts, 10);
        TextView cp = Ui.btnSm(a, "복사", Theme.SUB, false);
        cp.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { Ui.copy(a, "서명", sha); }
        });
        acts.addView(cp);
        TextView del = Ui.btnSm(a, "삭제", Theme.RED, false);
        del.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Ui.confirm(a, "서명 삭제",
                        "이 서명을 허용목록에서 지울까?\n이 서명으로 빌드된 앱은 다음 인증에서 '위조된 앱이야' 로 막혀.\n\n" + sha,
                        "삭제", true, new Runnable() {
                            @Override public void run() {
                                Api.sigDel(a, sha, new Api.Cb() {
                                    @Override public void done(Api.Result r) {
                                        if (a.kicked(r)) return;
                                        if (!r.ok) { a.fail("서명 삭제", r); return; }
                                        Ui.toast(a, "삭제했어");
                                        App.log(a, "앱서명 삭제 " + sha);
                                        loadSigs();
                                    }
                                });
                            }
                        });
            }
        });
        acts.addView(del);
        row.addView(acts);
        return row;
    }

    private void openAddSig() {
        LinearLayout box = Ui.col(a);
        box.addView(Ui.sub(a, "build.sh 가 출력한 '서버 등록용 hex' 64자를 붙여넣어. 콜론이 있어도 알아서 지워줘."));
        final EditText sha = Ui.field(a, "SHA-256 (64자 hex)");
        sha.setTypeface(android.graphics.Typeface.MONOSPACE);
        sha.setMinLines(2);
        mt(sha, 12);
        box.addView(sha);
        final EditText label = Ui.lineField(a, "이름 (예: 사용자앱 v2.0)");
        mt(label, 8);
        box.addView(label);

        AlertDialog.Builder b = Ui.dialog(a, "서명 추가");
        b.setView(Ui.dialogBody(a, box));
        b.setNegativeButton("취소", null);
        b.setPositiveButton("추가", null);
        final AlertDialog dlg = Ui.showDark(b);
        if (dlg == null) return;
        View pos = dlg.getButton(AlertDialog.BUTTON_POSITIVE);
        if (pos == null) return;
        pos.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                String hex = Api.normSha(sha.getText() == null ? "" : sha.getText().toString());
                if (hex.length() != 64) {
                    Ui.toast(a, "SHA-256 은 64자 hex 여야 해 (지금 " + hex.length() + "자)");
                    return;
                }
                String lb = (label.getText() == null) ? "" : label.getText().toString().trim();
                Api.sigAdd(a, hex, lb, new Api.Cb() {
                    @Override public void done(Api.Result r) {
                        if (a.kicked(r)) return;
                        if (!r.ok) { a.fail("서명 추가", r); return; }
                        try { dlg.dismiss(); } catch (Throwable ignore) { }
                        Ui.toast(a, "추가했어");
                        App.log(a, "앱서명 추가 " + hex);
                        loadSigs();
                    }
                });
            }
        });
    }

    // ── 통계 상세 ─────────────────────────────────────────────────────────────

    private void paintStats() {
        if (statBox == null) return;
        statBox.removeAllViews();
        JSONObject s = a.statsJson();
        if (s == null) {
            statBox.addView(Ui.emptyBox(a, "통계를 아직 못 읽었어 — 위의 [새로고침] 을 눌러봐"));
            return;
        }
        statBox.addView(Ui.kvTight(a, "총 키", Ui.num(s.optLong("total", 0)) + "개"));
        statBox.addView(Ui.kvColor(a, "활성 키", Ui.num(s.optLong("active", 0)) + "개", Theme.ACCENT));
        statBox.addView(Ui.kvColor(a, "7일내 만료", Ui.num(s.optLong("expiring_7d", 0)) + "개", Theme.AMBER));
        statBox.addView(Ui.dividerTight(a));
        JSONObject byFeat = s.optJSONObject("by_feature");
        for (int i = 0; i < Api.FEATURES.length; i++) {
            String id = Api.FEATURES[i];
            long n = (byFeat == null) ? 0 : byFeat.optLong(id, 0);
            statBox.addView(Ui.kvTight(a, Api.featLabel(id), Ui.num(n) + "개 사용중"));
        }
        statBox.addView(Ui.dividerTight(a));
        long pend = s.optLong("pending_orders", 0);
        statBox.addView(Ui.kvColor(a, "대기 주문", Ui.num(pend) + "건",
                pend > 0 ? Theme.PRIMARY : Theme.TEXT));
        long dep = s.optLong("deposits_attention", 0);
        statBox.addView(Ui.kvColor(a, "확인 필요 입금", Ui.num(dep) + "건",
                dep > 0 ? Theme.RED : Theme.TEXT));
        statBox.addView(Ui.kvTight(a, "회수된 키", Ui.num(s.optLong("revoked", 0)) + "개"));
        statBox.addView(Ui.kvColor(a, "차단된 키", Ui.num(s.optLong("blocked", 0)) + "개",
                s.optLong("blocked", 0) > 0 ? Theme.RED : Theme.TEXT));
        statBox.addView(Ui.kvTight(a, "서버 시각", Ui.fmtFull(s.optLong("now", 0))));
    }

    private void paintCrash() {
        if (crashLabel == null) return;
        String c = App.lastCrash(a);
        if (c == null) {
            crashLabel.setText("저장된 크래시 없음 · 로그 " + lines(App.logDump(a)) + "줄");
            crashLabel.setTextColor(Theme.DIM);
        } else {
            crashLabel.setText("마지막 크래시 " + Ui.fmtFull(App.lastCrashAt(a))
                    + " · 로그 " + lines(App.logDump(a)) + "줄");
            crashLabel.setTextColor(Theme.AMBER);
        }
    }

    private static int lines(String s) {
        if (s == null || s.length() == 0) return 0;
        int n = 1;
        for (int i = 0; i < s.length(); i++) if (s.charAt(i) == '\n') n++;
        return n;
    }

    private void mt(View v, int dp) {
        LinearLayout.LayoutParams lp = (v.getLayoutParams() instanceof LinearLayout.LayoutParams)
                ? (LinearLayout.LayoutParams) v.getLayoutParams()
                : new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Theme.dp(a, dp);
        v.setLayoutParams(lp);
    }
}
