package com.buseong.kakaoadmin;

import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * [기록] 탭 — audit_log 조회.
 *
 * 종류 세그먼트 + 키 검색으로 필터한다.
 * 색: mismatch/takeover/bad_sig/tamper(+bad_deposit_token) = RED, activate = ACCENT,
 *     reset/order = AMBER, 나머지 SUB. (Ui.auditColor 한 곳에서만 정한다)
 * 시각은 MM/dd HH:mm:ss.
 */
public final class ScreenAudit implements MainActivity.Screen {

    private static final int LIMIT = 200;

    private final MainActivity a;

    private ScrollView rootView;
    private LinearLayout listBox;
    private TextView countLabel;
    private EditText keyField;

    private int kindIdx = 0;
    private String key = "";
    private boolean busy = false;

    public ScreenAudit(MainActivity act) { this.a = act; }

    @Override public View view() {
        if (rootView != null) return rootView;

        LinearLayout page = Ui.screen(a);

        View seg = Ui.segment(a, Api.AUDIT_KIND_LABELS, 0, new Ui.OnPick() {
            @Override public void pick(int i) { kindIdx = i; load(); }
        });
        page.addView(seg);

        LinearLayout searchRow = Ui.row(a);
        LinearLayout.LayoutParams srp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        srp.topMargin = Theme.dp(a, 10);
        searchRow.setLayoutParams(srp);

        keyField = Ui.lineField(a, "키로 좁히기 (KAKA-…)");
        keyField.setImeOptions(EditorInfo.IME_ACTION_SEARCH);
        keyField.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        keyField.setOnEditorActionListener(new TextView.OnEditorActionListener() {
            @Override public boolean onEditorAction(TextView v, int id, android.view.KeyEvent e) {
                applyKey();
                return true;
            }
        });
        searchRow.addView(keyField);

        TextView go = Ui.btnSm(a, "조회", Theme.PRIMARY, true);
        LinearLayout.LayoutParams gp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        gp.leftMargin = Theme.dp(a, 8);
        gp.rightMargin = 0;
        go.setLayoutParams(gp);
        go.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { applyKey(); }
        });
        searchRow.addView(go);
        page.addView(searchRow);

        countLabel = Ui.label(a, "");
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Theme.dp(a, 18);
        lp.bottomMargin = Theme.dp(a, 8);
        countLabel.setLayoutParams(lp);
        page.addView(countLabel);

        listBox = Ui.col(a);
        page.addView(listBox);

        rootView = Ui.scroll(a, page);
        return rootView;
    }

    @Override public void reload() { load(); }

    private void applyKey() {
        key = (keyField == null || keyField.getText() == null) ? "" : keyField.getText().toString().trim();
        load();
    }

    /** 다른 화면에서 "이 키의 기록만 보기" 로 넘어올 때 쓴다 */
    public void focusKey(String k) {
        key = (k == null) ? "" : k;
        kindIdx = 0;
        if (keyField != null) keyField.setText(key);
        load();
    }

    private void load() {
        if (busy) return;
        busy = true;
        if (listBox != null) {
            listBox.removeAllViews();
            listBox.addView(Ui.emptyBox(a, "불러오는 중…"));
        }
        final String kind = Api.AUDIT_KINDS[Math.max(0, Math.min(kindIdx, Api.AUDIT_KINDS.length - 1))];
        Api.audit(a, key, kind, LIMIT, new Api.Cb() {
            @Override public void done(Api.Result r) {
                busy = false;
                if (a.kicked(r)) return;
                if (listBox == null) return;
                listBox.removeAllViews();
                if (!r.ok) {
                    listBox.addView(Ui.emptyBox(a, "기록을 불러오지 못했습니다\n" + r.error));
                    a.fail("기록 조회", r);
                    return;
                }
                JSONArray arr = r.arr("audit");
                if (countLabel != null) {
                    StringBuilder t = new StringBuilder();
                    t.append(Api.AUDIT_KIND_LABELS[Math.max(0, Math.min(kindIdx,
                            Api.AUDIT_KIND_LABELS.length - 1))]);
                    t.append(" ").append(arr.length()).append("건");
                    if (key.length() > 0) t.append(" · 키 ").append(key);
                    if (arr.length() >= LIMIT) t.append(" (최근 ").append(LIMIT).append("건만)");
                    countLabel.setText(t.toString());
                }
                if (arr.length() == 0) {
                    listBox.addView(Ui.emptyBox(a, "해당 조건의 기록이 없습니다"));
                    return;
                }
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o != null) listBox.addView(auditCard(o));
                }
            }
        });
    }

    private LinearLayout auditCard(final JSONObject o) {
        final String kind = o.optString("kind", "");
        final int color = Ui.auditColor(kind);
        final String k = str(o, "key");

        LinearLayout card = Ui.listCard(a);
        // 이상 징후는 왼쪽에 색 테두리 느낌을 주려고 배경 자체를 살짝 물들인다
        if (color == Theme.RED) {
            card.setBackground(Theme.round(Theme.fade(Theme.RED, 0.07f), Theme.R_MD,
                    Theme.fade(Theme.RED, 0.28f), 1, a));
        }

        LinearLayout r1 = Ui.row(a);
        TextView tm = Ui.hint(a, Ui.fmtSec(o.optLong("at", 0)));
        tm.setTypeface(android.graphics.Typeface.MONOSPACE);
        tm.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 11.5f);
        tm.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        r1.addView(tm);
        TextView kc = Ui.chipSm(a, Api.kindLabel(kind), color);
        LinearLayout.LayoutParams kp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        kp.rightMargin = 0;
        kc.setLayoutParams(kp);
        r1.addView(kc);
        card.addView(r1);

        if (k.length() > 0) {
            TextView kv = Ui.monoLine(a, k, 12.5f, Theme.TEXT);
            mt(kv, 6);
            card.addView(kv);
        }

        String detail = str(o, "detail");
        if (detail.length() > 0) {
            TextView dv = Ui.sub(a, detail);
            dv.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12.5f);
            mt(dv, 5);
            card.addView(dv);
        }

        StringBuilder meta = new StringBuilder();
        String dn = str(o, "device_name");
        String di = str(o, "device_id");
        String ip = str(o, "ip");
        if (dn.length() > 0) meta.append(dn);
        if (di.length() > 0) meta.append(meta.length() > 0 ? " · " : "").append(di);
        if (ip.length() > 0) meta.append(meta.length() > 0 ? " · " : "").append("IP ").append(ip);
        if (meta.length() > 0) {
            TextView m = Ui.hint(a, meta.toString());
            m.setSingleLine(true);
            m.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
            mt(m, 6);
            card.addView(m);
        }

        if (k.length() > 0) {
            card.setClickable(true);
            Ui.press(card);
            card.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    android.app.AlertDialog.Builder b = Ui.dialog(a, "기록 " + Api.kindLabel(kind));
                    b.setMessage(Ui.fmtSec(o.optLong("at", 0))
                            + "\n\n키: " + k
                            + "\n기기: " + dash(str(o, "device_name"))
                            + "\n기기ID: " + dash(str(o, "device_id"))
                            + "\nIP: " + dash(str(o, "ip"))
                            + "\n\n" + dash(str(o, "detail")));
                    b.setNegativeButton("닫기", null);
                    b.setPositiveButton("이 키만 보기", new android.content.DialogInterface.OnClickListener() {
                        @Override public void onClick(android.content.DialogInterface d, int w) { focusKey(k); }
                    });
                    b.setNeutralButton("키 복사", new android.content.DialogInterface.OnClickListener() {
                        @Override public void onClick(android.content.DialogInterface d, int w) { Ui.copy(a, "키", k); }
                    });
                    Ui.showDark(b);
                }
            });
            card.setOnLongClickListener(new View.OnLongClickListener() {
                @Override public boolean onLongClick(View v) { Ui.copy(a, "키", k); return true; }
            });
        }
        return card;
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
