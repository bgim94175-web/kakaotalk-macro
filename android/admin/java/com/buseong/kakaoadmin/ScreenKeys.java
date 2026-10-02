package com.buseong.kakaoadmin;

import android.app.AlertDialog;
import android.view.Gravity;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * [키] 탭 — 라이선스 목록 · 검색 · 새 키 발급 · 상세 시트.
 *
 * 목록 한 줄에 들어가는 정보: 키(모노스페이스) · 소유자 · 기능칩 3개(각각 D-N 또는 없음)
 * · 기기명 · 초기화 횟수 · 상태(정상/회수/차단/미사용).
 * 위험한 동작(삭제·회수·차단·기능회수)은 반드시 확인 다이얼로그를 거친다.
 */
public final class ScreenKeys implements MainActivity.Screen {

    private static final int PAGE = 50;

    private final MainActivity a;

    private ScrollView rootView;
    private EditText search;
    private TextView countLabel;
    private LinearLayout listBox;
    private TextView moreBtn;

    private final ArrayList<JSONObject> rows = new ArrayList<JSONObject>();
    private String term = "";
    private int total = 0;
    private long serverNow = 0;
    /** 요청 세대 토큰. fetch() 마다 증가하고, 콜백은 자신이 최신 세대일 때만 렌더한다. */
    private int gen = 0;

    public ScreenKeys(MainActivity act) { this.a = act; }

    // ── 화면 ──────────────────────────────────────────────────────────────────

    @Override public View view() {
        if (rootView != null) return rootView;

        LinearLayout page = Ui.screen(a);

        // 검색
        LinearLayout searchRow = Ui.row(a);
        search = Ui.lineField(a, "키 · 소유자 · 메모 · 기기 검색");
        search.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        search.setLayoutParams(sp);
        search.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int id, android.view.KeyEvent e) {
                doSearch();
                return true;
            }
        });
        searchRow.addView(search);

        TextView go = Ui.btnSm(a, "검색", Theme.PRIMARY, true);
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        gp.leftMargin = Theme.dp(a, 8);
        gp.rightMargin = 0;
        go.setLayoutParams(gp);
        go.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { doSearch(); }
        });
        searchRow.addView(go);
        page.addView(searchRow);

        // 새 키 발급
        TextView create = Ui.btn(a, "＋  새 키 발급", true);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        cp.topMargin = Theme.dp(a, 10);
        create.setLayoutParams(cp);
        create.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openCreate(); }
        });
        page.addView(create);

        countLabel = Ui.label(a, "");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Theme.dp(a, 18);
        lp.bottomMargin = Theme.dp(a, 8);
        countLabel.setLayoutParams(lp);
        page.addView(countLabel);

        listBox = Ui.col(a);
        page.addView(listBox);

        moreBtn = Ui.btn(a, "더 보기", false);
        LinearLayout.LayoutParams mp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        mp.topMargin = Theme.dp(a, 4);
        moreBtn.setLayoutParams(mp);
        moreBtn.setVisibility(View.GONE);
        moreBtn.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { fetch(true); }
        });
        page.addView(moreBtn);

        rootView = Ui.scroll(a, page);
        return rootView;
    }

    @Override public void reload() { fetch(false); }

    private void doSearch() {
        term = (search == null || search.getText() == null) ? "" : search.getText().toString().trim();
        fetch(false);
    }

    // ── 서버에서 읽기 ─────────────────────────────────────────────────────────

    private void fetch(final boolean append) {
        final int myGen = ++gen;
        if (!append) {
            rows.clear();
            if (listBox != null) {
                listBox.removeAllViews();
                listBox.addView(Ui.emptyBox(a, "불러오는 중…"));
            }
            if (moreBtn != null) moreBtn.setVisibility(View.GONE);
        } else if (moreBtn != null) {
            moreBtn.setText("불러오는 중…");
        }
        final int offset = append ? rows.size() : 0;

        Api.list(a, term, PAGE, offset, new Api.Cb() {
            @Override public void done(Api.Result r) {
                // 내가 최신 요청이 아니면(검색어가 바뀌었거나 새로고침이 끼어들었다면) 결과를 버린다.
                if (myGen != gen) return;
                if (moreBtn != null) moreBtn.setText("더 보기");
                if (a.kicked(r)) return;
                if (!r.ok) {
                    if (listBox != null) {
                        listBox.removeAllViews();
                        listBox.addView(Ui.emptyBox(a, "목록을 불러오지 못했습니다\n" + r.error));
                    }
                    a.fail("키 목록", r);
                    return;
                }
                total = r.integer("total");
                serverNow = r.lng("now");
                JSONArray arr = r.arr("licenses");
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o != null) rows.add(o);
                }
                render();
            }
        });
    }

    private void render() {
        if (listBox == null) return;
        listBox.removeAllViews();
        long now = (serverNow > 0) ? serverNow : System.currentTimeMillis();

        if (countLabel != null) {
            String t = (term.length() > 0)
                    ? ("검색 '" + term + "' · " + rows.size() + " / " + total + "건")
                    : ("전체 " + total + "건 중 " + rows.size() + "건");
            countLabel.setText(t);
        }

        if (rows.isEmpty()) {
            listBox.addView(Ui.emptyBox(a, (term.length() > 0)
                    ? "검색 결과가 없습니다"
                    : "발급된 키가 없습니다\n상단 [새 키 발급] 으로 키를 발급하십시오"));
            if (moreBtn != null) moreBtn.setVisibility(View.GONE);
            return;
        }

        for (int i = 0; i < rows.size(); i++) listBox.addView(keyCard(rows.get(i), now));
        if (moreBtn != null) moreBtn.setVisibility(rows.size() < total ? View.VISIBLE : View.GONE);
    }

    // ── 목록 카드 ─────────────────────────────────────────────────────────────

    private LinearLayout keyCard(final JSONObject lic, long now) {
        LinearLayout card = Ui.listCard(a);
        final String key = lic.optString("key", "");

        // 1줄: 키 + 상태
        LinearLayout r1 = Ui.row(a);
        TextView kv = Ui.monoLine(a, key, 13.5f, Theme.TEXT);
        kv.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        r1.addView(kv);
        TextView st = Ui.chipSm(a, statusText(lic), statusColor(lic));
        LinearLayout.LayoutParams stp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        stp.leftMargin = Theme.dp(a, 8);
        stp.rightMargin = 0;
        st.setLayoutParams(stp);
        r1.addView(st);
        card.addView(r1);

        // 2줄: 소유자 · 연락처 (메모는 밀려서 소유자를 가리지 않게 상세 시트에서만 본다)
        String owner = str(lic, "owner_name");
        String contact = str(lic, "owner_contact");
        StringBuilder who = new StringBuilder();
        if (owner.length() > 0) who.append(owner);
        if (contact.length() > 0) who.append(who.length() > 0 ? " · " : "").append(contact);
        if (who.length() == 0) who.append("소유자 미지정");
        TextView w = Ui.sub(a, who.toString());
        w.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12.5f);
        w.setSingleLine(true);
        w.setEllipsize(android.text.TextUtils.TruncateAt.END);
        mt(w, 5);
        card.addView(w);

        // 3줄: 보유 기능만 색 칩으로 표시한다. 미보유는 끝에 회색 요약 칩 하나로 묶어
        //      '없음' 칩 반복으로 생기는 노이즈를 줄인다 (UI_V3: 켜진 것만 색).
        LinearLayout chips = Ui.row(a);
        mt(chips, 8);
        JSONArray feats = lic.optJSONArray("features");
        int owned = 0;
        StringBuilder missing = new StringBuilder();
        for (int i = 0; i < Api.FEATURES.length; i++) {
            String id = Api.FEATURES[i];
            JSONObject e = findFeat(feats, id);
            if (e != null) {
                chips.addView(Ui.chipSm(a, Api.featShort(id) + " " + featSuffix(e, now), featColor(e, now)));
                owned++;
            } else {
                if (missing.length() > 0) missing.append(" · ");
                missing.append(Api.featShort(id));
            }
        }
        if (owned == 0) {
            chips.addView(Ui.chipSm(a, "기능 미보유", Theme.DIM));
        } else if (missing.length() > 0) {
            chips.addView(Ui.chipSm(a, "미보유 " + missing, Theme.DIM));
        }
        card.addView(chips);

        // 4줄: 기기 · 초기화 · 마지막 접속
        String dev = str(lic, "device_name");
        if (dev.length() == 0) dev = (str(lic, "device_id").length() > 0) ? "기기 등록됨" : "미등록";
        int resets = lic.optInt("reset_count", 0);
        long seen = lic.optLong("last_seen", 0);
        StringBuilder meta = new StringBuilder();
        meta.append(dev);
        meta.append(" · 초기화 ").append(resets).append("회");
        meta.append(" · ").append(seen > 0 ? ("접속 " + Ui.fmtMin(seen)) : "접속 없음");
        TextView m = Ui.hint(a, meta.toString());
        m.setSingleLine(true);
        m.setEllipsize(android.text.TextUtils.TruncateAt.END);
        mt(m, 7);
        card.addView(m);

        card.setClickable(true);
        Ui.press(card);
        card.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { openDetail(key); }
        });
        return card;
    }

    private static JSONObject findFeat(JSONArray feats, String id) {
        if (feats == null) return null;
        for (int i = 0; i < feats.length(); i++) {
            JSONObject o = feats.optJSONObject(i);
            if (o != null && id.equals(o.optString("feature", ""))) return o;
        }
        return null;
    }

    /** 기능칩 꼬리말: 없음 / 미개시 / 만료 / D-N */
    private static String featSuffix(JSONObject e, long now) {
        if (e == null) return "없음";
        long exp = e.optLong("expires_at", 0);
        if (exp <= 0) return "미개시";
        if (exp <= now) return "만료";
        long d = (exp - now + 86400000L - 1) / 86400000L;
        return "D-" + d;
    }

    /** 만료 임박(7일 이내)은 AMBER, 없음은 회색 */
    private static int featColor(JSONObject e, long now) {
        if (e == null) return Theme.DIM;
        long exp = e.optLong("expires_at", 0);
        if (exp <= 0) return Theme.ACCENT2;
        if (exp <= now) return Theme.RED;
        long d = (exp - now + 86400000L - 1) / 86400000L;
        return (d <= 7) ? Theme.AMBER : Theme.ACCENT;
    }

    private static String statusText(JSONObject lic) {
        if (str(lic, "blocked_reason").length() > 0) return "차단";
        if (lic.optBoolean("revoked", false)) return "회수";
        if (str(lic, "device_id").length() == 0) return "미사용";
        return "정상";
    }

    private static int statusColor(JSONObject lic) {
        String s = statusText(lic);
        if (s.equals("차단") || s.equals("회수")) return Theme.RED;
        if (s.equals("미사용")) return Theme.DIM;
        return Theme.ACCENT;
    }

    // ── 상세 시트 ─────────────────────────────────────────────────────────────

    private void openDetail(final String key) {
        Ui.toast(a, "불러오는 중…");
        Api.license(a, key, new Api.Cb() {
            @Override public void done(Api.Result r) {
                if (a.kicked(r)) return;
                if (!r.ok) { a.fail("키 상세", r); return; }
                JSONObject lic = r.optObj("license");
                if (lic == null) { a.fail("키 상세", null); return; }
                showDetail(lic, r.arr("audit"), r.lng("now"));
            }
        });
    }

    private void showDetail(final JSONObject lic, JSONArray auditArr, long now) {
        if (now <= 0) now = System.currentTimeMillis();
        final String key = lic.optString("key", "");
        final boolean revoked = lic.optBoolean("revoked", false);
        final String blocked = str(lic, "blocked_reason");

        LinearLayout box = Ui.col(a);

        // 키 + 복사
        box.addView(Ui.mono(a, key));
        LinearLayout copyRow = Ui.row(a);
        mt(copyRow, 8);
        TextView copy = Ui.btnSm(a, "키 복사", Theme.PRIMARY, false);
        copy.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { Ui.copy(a, "라이선스 키", key); }
        });
        copyRow.addView(copy);
        TextView stc = Ui.chipSm(a, statusText(lic), statusColor(lic));
        copyRow.addView(stc);
        box.addView(copyRow);

        if (blocked.length() > 0) {
            TextView b = Ui.body(a, "차단 사유: " + blocked);
            b.setTextColor(Theme.RED);
            b.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 13f);
            mt(b, 10);
            box.addView(b);
        }

        // 기능별 상태 + 개별 회수
        box.addView(Ui.dividerTight(a));
        box.addView(Ui.label(a, "기능"));
        JSONArray feats = lic.optJSONArray("features");
        for (int i = 0; i < Api.FEATURES.length; i++) {
            final String id = Api.FEATURES[i];
            final JSONObject e = findFeat(feats, id);
            LinearLayout fr = Ui.row(a);
            mt(fr, 6);

            LinearLayout left = Ui.col(a);
            left.setLayoutParams(new LinearLayout.LayoutParams(0,
                    LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
            TextView nm = Ui.body(a, Api.featLabel(id));
            nm.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 14f);
            left.addView(nm);
            String line;
            if (e == null) {
                line = "미보유";
            } else {
                long exp = e.optLong("expires_at", 0);
                String plan = Api.planLabel(str(e, "plan"), (int) (e.optLong("duration_ms", 0) / 86400000L));
                line = plan + " · " + (exp > 0 ? (Ui.fmtDay(exp) + " 까지") : "활성화 대기");
            }
            TextView sub = Ui.hint(a, line);
            mt(sub, 2);
            left.addView(sub);
            fr.addView(left);

            fr.addView(Ui.chipSm(a, featSuffix(e, now), featColor(e, now)));

            if (e != null) {
                TextView rev = Ui.btnSm(a, "회수", Theme.RED, false);
                LinearLayout.LayoutParams rp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                rp.rightMargin = 0;
                rev.setLayoutParams(rp);
                rev.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) {
                        Ui.confirm(a, "기능 회수",
                                Api.featLabel(id) + " 기능을 이 키에서 삭제합니다.\n남은 기간도 함께 소멸되며 되돌릴 수 없습니다.",
                                "회수", true, new Runnable() {
                                    @Override public void run() {
                                        Api.revokeFeature(a, key, id, after("기능 회수", null));
                                    }
                                });
                    }
                });
                fr.addView(rev);
            }
            box.addView(fr);
        }

        // 상세 정보
        box.addView(Ui.dividerTight(a));
        box.addView(Ui.label(a, "정보"));
        box.addView(Ui.kvTight(a, "소유자", dash(str(lic, "owner_name"))));
        box.addView(Ui.kvTight(a, "연락처", dash(str(lic, "owner_contact"))));
        if (str(lic, "note").length() > 0) box.addView(Ui.kvStack(a, "메모", str(lic, "note")));
        box.addView(Ui.kvTight(a, "발급", Ui.fmtFull(lic.optLong("created_at", 0))));
        box.addView(Ui.kvTight(a, "활성화", Ui.fmtFull(lic.optLong("activated_at", 0))));
        box.addView(Ui.kvTight(a, "마지막 접속", Ui.fmtFull(lic.optLong("last_seen", 0))));
        box.addView(Ui.kvTight(a, "기기명", dash(str(lic, "device_name"))));
        if (str(lic, "device_id").length() > 0) box.addView(Ui.kvStack(a, "기기 ID", str(lic, "device_id")));
        if (str(lic, "device_fp").length() > 0) box.addView(Ui.kvStack(a, "기기 지문", str(lic, "device_fp")));
        box.addView(Ui.kvTight(a, "세션", lic.optBoolean("has_session", false)
                ? ("접속 중 · " + Ui.fmtMin(lic.optLong("session_at", 0))) : "없음"));
        int resets = lic.optInt("reset_count", 0);
        box.addView(Ui.kvColor(a, "기기 초기화", resets + "회"
                        + (lic.optLong("last_reset_at", 0) > 0
                           ? (" · " + Ui.fmtMin(lic.optLong("last_reset_at", 0))) : ""),
                resets >= 3 ? Theme.AMBER : Theme.TEXT));
        if (str(lic, "app_sig").length() > 0) box.addView(Ui.kvStack(a, "마지막 앱 서명", str(lic, "app_sig")));

        // 최근 기록
        if (auditArr != null && auditArr.length() > 0) {
            box.addView(Ui.dividerTight(a));
            box.addView(Ui.label(a, "최근 기록 " + auditArr.length() + "건"));
            for (int i = 0; i < auditArr.length(); i++) {
                JSONObject o = auditArr.optJSONObject(i);
                if (o == null) continue;
                String kind = o.optString("kind", "");
                LinearLayout row = Ui.row(a);
                mt(row, 6);
                TextView tm = Ui.hint(a, Ui.fmtSec(o.optLong("at", 0)));
                tm.setTypeface(android.graphics.Typeface.MONOSPACE);
                tm.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11f);
                row.addView(tm);
                TextView kc = Ui.chipSm(a, Api.kindLabel(kind), Ui.auditColor(kind));
                LinearLayout.LayoutParams kp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                kp.leftMargin = Theme.dp(a, 8);
                kc.setLayoutParams(kp);
                row.addView(kc);
                TextView dt = Ui.hint(a, dash(str(o, "detail")));
                dt.setSingleLine(true);
                dt.setEllipsize(android.text.TextUtils.TruncateAt.END);
                dt.setLayoutParams(new LinearLayout.LayoutParams(0,
                        LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
                row.addView(dt);
                box.addView(row);
            }
        }

        // 동작 버튼들
        box.addView(Ui.dividerTight(a));
        box.addView(Ui.label(a, "동작"));

        final AlertDialog.Builder b = Ui.dialog(a, "키 상세");
        b.setView(Ui.dialogBody(a, box));
        b.setNegativeButton("닫기", null);
        final AlertDialog dlg = b.create();

        TextView grant = Ui.btn(a, "기능 추가 / 연장", true);
        mt(grant, 10);
        grant.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { dismiss(dlg); openGrant(key); }
        });
        box.addView(grant);

        TextView reset = Ui.btn(a, "기기 초기화 (기기 고정 해제)", false);
        mt(reset, 8);
        reset.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Ui.confirm(a, "기기 초기화",
                        "이 키의 기기 고정을 해제합니다.\n다음 실행 시 새 기기에 재등록되며, 사용 기간은 계속 소진됩니다.\n"
                                + "초기화 누적 " + lic.optInt("reset_count", 0) + "회. 반복 요청 시 차단을 검토하십시오.",
                        "초기화", true, new Runnable() {
                            @Override public void run() {
                                Api.resetDevice(a, key, after("기기 초기화", dlg));
                            }
                        });
            }
        });
        box.addView(reset);

        TextView block = Ui.btn(a, blocked.length() > 0 ? "차단 해제" : "차단하기", false);
        mt(block, 8);
        block.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (blocked.length() > 0) {
                    Ui.confirm(a, "차단 해제", "이 키의 차단을 해제합니다.", "해제", false, new Runnable() {
                        @Override public void run() { Api.block(a, key, null, after("차단 해제", dlg)); }
                    });
                } else {
                    Ui.input(a, "차단 사유", "예: 키 공유 의심", null, false, new Ui.OnText() {
                        @Override public void text(final String s) {
                            if (s == null || s.length() == 0) { Ui.toast(a, "차단 사유를 입력하십시오"); return; }
                            Ui.confirm(a, "키 차단",
                                    "이 키를 차단합니다.\n대상 앱은 즉시 '차단된 라이선스 키입니다' 로 실행이 차단됩니다.\n사유: " + s,
                                    "차단", true, new Runnable() {
                                        @Override public void run() { Api.block(a, key, s, after("차단", dlg)); }
                                    });
                        }
                    });
                }
            }
        });
        box.addView(block);

        TextView rv = Ui.btn(a, revoked ? "회수 복구" : "키 회수", false);
        mt(rv, 8);
        rv.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                if (revoked) {
                    Ui.confirm(a, "회수 복구", "이 키를 다시 사용 가능한 상태로 복구합니다.", "복구", false, new Runnable() {
                        @Override public void run() { Api.revoke(a, key, false, after("회수 복구", dlg)); }
                    });
                } else {
                    Ui.confirm(a, "키 회수",
                            "이 키를 사용 중지합니다.\n대상 앱은 '사용이 중지된 라이선스 키입니다' 로 실행이 차단됩니다. 이후 복구가 가능합니다.",
                            "회수", true, new Runnable() {
                                @Override public void run() { Api.revoke(a, key, true, after("키 회수", dlg)); }
                            });
                }
            }
        });
        box.addView(rv);

        TextView del = Ui.btnDanger(a, "키 삭제");
        mt(del, 8);
        del.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                Ui.confirm(a, "키 삭제",
                        "이 키를 영구 삭제합니다.\n기능·기간·설정 백업이 모두 삭제되며 되돌릴 수 없습니다.\n\n" + key,
                        "영구 삭제", true, new Runnable() {
                            @Override public void run() { Api.delete(a, key, after("키 삭제", dlg)); }
                        });
            }
        });
        box.addView(del);

        Ui.showDark(dlg);
    }

    // ── 기능 추가 / 연장 ──────────────────────────────────────────────────────

    private void openGrant(final String key) {
        LinearLayout box = Ui.col(a);
        box.addView(Ui.sub(a, "보유 중인 기능은 남은 기간에 합산되고, 미보유 기능은 신규 추가됩니다."));

        final View[] checks = new View[Api.FEATURES.length];
        box.addView(Ui.dividerTight(a));
        box.addView(Ui.label(a, "기능 (여러 개 선택)"));
        for (int i = 0; i < Api.FEATURES.length; i++) {
            String id = Api.FEATURES[i];
            checks[i] = Ui.checkRow(a, Api.featLabel(id), Api.featDesc(id), i == 0, null);
            box.addView(checks[i]);
        }

        box.addView(Ui.dividerTight(a));
        box.addView(Ui.label(a, "기간"));
        final EditText days = Ui.numField(a, "일수 (예: 45)");
        final int[] plan = new int[] { 0 };
        View seg = Ui.segment(a, Api.PLAN_LABELS, 0, new Ui.OnPick() {
            @Override public void pick(int i) {
                plan[0] = i;
                days.setVisibility(("custom".equals(Api.PLAN_CODES[i])) ? View.VISIBLE : View.GONE);
            }
        });
        mt(seg, 8);
        box.addView(seg);
        days.setVisibility(View.GONE);
        mt(days, 10);
        box.addView(days);

        AlertDialog.Builder b = Ui.dialog(a, "기능 추가 / 연장");
        b.setView(Ui.dialogBody(a, box));
        b.setNegativeButton("취소", null);
        b.setPositiveButton("적용", null);
        final AlertDialog dlg = Ui.showDark(b);
        if (dlg == null) return;
        dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                List<String> picked = picked(checks);
                if (picked.isEmpty()) { Ui.toast(a, "기능을 1개 이상 선택하십시오"); return; }
                String code = Api.PLAN_CODES[plan[0]];
                int d = parseInt(days);
                if ("custom".equals(code) && (d < 1 || d > 3650)) {
                    Ui.toast(a, "일수를 1~3650 범위로 입력하십시오"); return;
                }
                Api.grant(a, key, picked, code, d, after("기능 추가/연장", dlg));
            }
        });
    }

    // ── 새 키 발급 ────────────────────────────────────────────────────────────

    private void openCreate() {
        LinearLayout box = Ui.col(a);

        final View[] checks = new View[Api.FEATURES.length];
        box.addView(Ui.label(a, "기능 (여러 개 선택)"));
        for (int i = 0; i < Api.FEATURES.length; i++) {
            String id = Api.FEATURES[i];
            checks[i] = Ui.checkRow(a, Api.featLabel(id), Api.featDesc(id), i == 0, null);
            box.addView(checks[i]);
        }

        box.addView(Ui.dividerTight(a));
        box.addView(Ui.label(a, "기간"));
        final EditText days = Ui.numField(a, "일수 (예: 45)");
        final int[] plan = new int[] { 0 };
        View seg = Ui.segment(a, Api.PLAN_LABELS, 0, new Ui.OnPick() {
            @Override public void pick(int i) {
                plan[0] = i;
                days.setVisibility(("custom".equals(Api.PLAN_CODES[i])) ? View.VISIBLE : View.GONE);
            }
        });
        mt(seg, 8);
        box.addView(seg);
        days.setVisibility(View.GONE);
        mt(days, 10);
        box.addView(days);

        box.addView(Ui.dividerTight(a));
        box.addView(Ui.label(a, "수량 · 소유자 · 메모"));
        final EditText count = Ui.numField(a, "수량 (기본 1, 최대 100)");
        mt(count, 8);
        box.addView(count);
        final EditText owner = Ui.lineField(a, "소유자 이름 (선택)");
        mt(owner, 8);
        box.addView(owner);
        final EditText contact = Ui.lineField(a, "연락처 (선택)");
        mt(contact, 8);
        box.addView(contact);
        final EditText note = Ui.lineField(a, "메모 (선택)");
        mt(note, 8);
        box.addView(note);

        AlertDialog.Builder b = Ui.dialog(a, "새 키 발급");
        b.setView(Ui.dialogBody(a, box));
        b.setNegativeButton("취소", null);
        b.setPositiveButton("발급", null);
        final AlertDialog dlg = Ui.showDark(b);
        if (dlg == null) return;
        dlg.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                final List<String> picked = picked(checks);
                if (picked.isEmpty()) { Ui.toast(a, "기능을 1개 이상 선택하십시오"); return; }
                String code = Api.PLAN_CODES[plan[0]];
                int d = parseInt(days);
                if ("custom".equals(code) && (d < 1 || d > 3650)) {
                    Ui.toast(a, "일수를 1~3650 범위로 입력하십시오"); return;
                }
                int n = parseInt(count);
                if (n <= 0) n = 1;
                if (n > 100) { Ui.toast(a, "1회 최대 100개까지 발급됩니다"); return; }

                Api.create(a, picked, code, d, n,
                        text(note), text(owner), text(contact), new Api.Cb() {
                    @Override public void done(Api.Result r) {
                        if (a.kicked(r)) return;
                        if (!r.ok) { a.fail("키 발급", r); return; }
                        dismiss(dlg);
                        ArrayList<String> out = new ArrayList<String>();
                        JSONArray arr = r.arr("keys");
                        for (int i = 0; i < arr.length(); i++) {
                            String k = arr.optString(i, "");
                            if (k.length() > 0) out.add(k);
                        }
                        App.log(a, "키 " + out.size() + "개 발급 (" + join(picked) + ")");
                        a.invalidate(2);
                        a.refreshStats();
                        term = "";
                        if (search != null) search.setText("");
                        fetch(false);
                        showIssued(out);
                    }
                });
            }
        });
    }

    /** 발급 결과 — 복사 가능한 목록 */
    private void showIssued(final List<String> keysOut) {
        LinearLayout box = Ui.col(a);
        if (keysOut.isEmpty()) {
            box.addView(Ui.sub(a, "서버가 키를 반환하지 않았습니다. [키] 목록을 새로고침하여 확인하십시오."));
        } else {
            box.addView(Ui.sub(a, keysOut.size() + "개 발급되었습니다. 항목을 누르면 개별 복사됩니다."));
            for (int i = 0; i < keysOut.size(); i++) {
                final String k = keysOut.get(i);
                LinearLayout row = Ui.row(a);
                mt(row, 8);
                TextView kt = Ui.monoLine(a, k, 14f, Theme.PRIMARY);
                kt.setLayoutParams(new LinearLayout.LayoutParams(0,
                        LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
                row.addView(kt);
                TextView cp = Ui.btnSm(a, "복사", Theme.PRIMARY, false);
                LinearLayout.LayoutParams cl = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                cl.leftMargin = Theme.dp(a, 8);
                cl.rightMargin = 0;
                cp.setLayoutParams(cl);
                cp.setOnClickListener(new View.OnClickListener() {
                    @Override public void onClick(View v) { Ui.copy(a, "키", k); }
                });
                row.addView(cp);
                box.addView(row);
            }
        }

        AlertDialog.Builder b = Ui.dialog(a, "발급 완료");
        b.setView(Ui.dialogBody(a, box));
        b.setNegativeButton("닫기", null);
        if (!keysOut.isEmpty()) {
            b.setPositiveButton("전체 복사", new android.content.DialogInterface.OnClickListener() {
                @Override public void onClick(android.content.DialogInterface d, int w) {
                    StringBuilder sb = new StringBuilder();
                    for (String k : keysOut) { if (sb.length() > 0) sb.append('\n'); sb.append(k); }
                    Ui.copy(a, "키 " + keysOut.size() + "개", sb.toString());
                }
            });
        }
        Ui.showDark(b);
    }

    // ── 공통 ──────────────────────────────────────────────────────────────────

    /** 성공하면 토스트 + 목록/통계 갱신, 실패하면 사유를 보여준다 */
    private Api.Cb after(final String what, final AlertDialog toClose) {
        return new Api.Cb() {
            @Override public void done(Api.Result r) {
                if (a.kicked(r)) return;
                if (!r.ok) { a.fail(what, r); return; }
                Ui.toast(a, what + " 완료");
                App.log(a, what + " 완료");
                dismiss(toClose);
                a.invalidate(2);
                a.refreshStats();
                fetch(false);
            }
        };
    }

    private static void dismiss(AlertDialog d) {
        if (d == null) return;
        try { d.dismiss(); } catch (Throwable ignore) { }
    }

    private static List<String> picked(View[] checks) {
        ArrayList<String> out = new ArrayList<String>();
        for (int i = 0; i < checks.length && i < Api.FEATURES.length; i++) {
            if (Ui.isOn(checks[i])) out.add(Api.FEATURES[i]);
        }
        return out;
    }

    private static String join(List<String> ids) {
        StringBuilder sb = new StringBuilder();
        for (String s : ids) { if (sb.length() > 0) sb.append(", "); sb.append(Api.featShort(s)); }
        return sb.toString();
    }

    private static int parseInt(EditText e) {
        if (e == null || e.getText() == null) return 0;
        String s = e.getText().toString().trim();
        if (s.length() == 0) return 0;
        try { return Integer.parseInt(s); } catch (Throwable t) { return 0; }
    }

    private static String text(EditText e) {
        if (e == null || e.getText() == null) return "";
        return e.getText().toString().trim();
    }

    private static String str(JSONObject o, String k) {
        if (o == null) return "";
        String s = o.optString(k, "");
        return ("null".equals(s) || s == null) ? "" : s;
    }

    private static String dash(String s) { return (s == null || s.length() == 0) ? "-" : s; }

    private void mt(View v, int dp) {
        LinearLayout.LayoutParams lp = (v.getLayoutParams() instanceof LinearLayout.LayoutParams)
                ? (LinearLayout.LayoutParams) v.getLayoutParams()
                : new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT,
                        LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Theme.dp(a, dp);
        v.setLayoutParams(lp);
    }
}
