package com.buseong.kakaoadmin;

import android.app.AlertDialog;
import android.view.View;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;

/**
 * [주문] 탭 — 구매 신청 승인/취소, 그리고 자동 입금확인으로 들어온 입금 내역 처리.
 *
 * 세그먼트: 대기 · 완료 · 취소 · 전체 · 입금
 *  - 대기/완료/취소/전체 → /admin/orders?status=
 *  - 입금 → /admin/deposits (미매칭·모호 건을 위로 올린다)
 *
 * [승인] 은 기존키를 입력하면 그 키에 기능을 붙이고(연장), 비우면 새 키를 발급한다.
 */
public final class ScreenOrders implements MainActivity.Screen {

    private static final int LIMIT = 200;
    /** 세그먼트에서 '입금' 의 자리 */
    private static final int TAB_DEPOSIT = 4;

    private final MainActivity a;

    private ScrollView rootView;
    private LinearLayout listBox;
    private TextView countLabel;
    private TextView noteLabel;

    private int seg = 0;
    private boolean busy = false;

    public ScreenOrders(MainActivity act) { this.a = act; }

    // ── 화면 ──────────────────────────────────────────────────────────────────

    @Override public View view() {
        if (rootView != null) return rootView;

        LinearLayout page = Ui.screen(a);
        page.addView(Ui.hero(a, Theme.F_ORDERS, Icon.RECEIPT, "ORDERS · DEPOSITS", "주문 · 입금",
                "구매 신청 승인과 입금 내역 매칭을 처리합니다."));

        String[] labels = new String[Api.ORDER_STATUS_LABELS.length + 1];
        for (int i = 0; i < Api.ORDER_STATUS_LABELS.length; i++) labels[i] = Api.ORDER_STATUS_LABELS[i];
        labels[TAB_DEPOSIT] = "입금";

        View segView = Ui.segment(a, labels, 0, new Ui.OnPick() {
            @Override public void pick(int i) { seg = i; load(); }
        });
        page.addView(segView);

        LinearLayout countRow = Ui.dotLabel(a, "");
        countLabel = Ui.dotLabelText(countRow);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = Theme.dp(a, 20);
        countRow.setLayoutParams(lp);
        page.addView(countRow);

        noteLabel = Ui.hint(a, "");
        LinearLayout.LayoutParams np = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        np.topMargin = Theme.dp(a, 4);
        np.bottomMargin = Theme.dp(a, 8);
        noteLabel.setLayoutParams(np);
        noteLabel.setVisibility(View.GONE);
        page.addView(noteLabel);

        listBox = Ui.col(a);
        page.addView(listBox);

        rootView = Ui.scroll(a, page);
        return rootView;
    }

    @Override public void reload() { load(); }

    private void load() {
        if (seg == TAB_DEPOSIT) loadDeposits();
        else loadOrders();
    }

    private void busyBox() {
        if (listBox == null) return;
        listBox.removeAllViews();
        listBox.addView(Ui.emptyBox(a, "불러오는 중…"));
    }

    // ── 주문 ──────────────────────────────────────────────────────────────────

    private void loadOrders() {
        if (busy) return;
        busy = true;
        busyBox();
        final String status = Api.ORDER_STATUS[Math.max(0, Math.min(seg, Api.ORDER_STATUS.length - 1))];
        Api.orders(a, status, LIMIT, new Api.Cb() {
            @Override public void done(Api.Result r) {
                busy = false;
                if (a.kicked(r)) return;
                if (listBox == null) return;
                listBox.removeAllViews();
                if (!r.ok) {
                    listBox.addView(Ui.emptyBox(a, "주문 목록을 불러오지 못했습니다\n" + r.error));
                    a.fail("주문 목록", r);
                    return;
                }
                JSONArray arr = r.arr("orders");
                if (countLabel != null) {
                    countLabel.setText(status.length() == 0
                            ? ("전체 주문 " + arr.length() + "건")
                            : (Api.orderStatusLabel(status) + " 주문 " + arr.length() + "건"));
                }
                String bank = r.str("bank", "");
                if (noteLabel != null) {
                    if (bank.length() > 0) {
                        noteLabel.setText("입금 계좌: " + bank);
                        noteLabel.setVisibility(View.VISIBLE);
                    } else {
                        noteLabel.setVisibility(View.GONE);
                    }
                }
                if (arr.length() == 0) {
                    listBox.addView(Ui.emptyBox(a, "해당 조건의 주문이 없습니다"));
                    return;
                }
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o != null) listBox.addView(orderCard(o));
                }
            }
        });
    }

    private LinearLayout orderCard(final JSONObject o) {
        LinearLayout card = Ui.listCard(a);
        final String id = o.optString("id", "");
        final String status = o.optString("status", "");
        final String issued = str(o, "issued_key");
        final String target = str(o, "target_key");

        // 주문번호 + 상태
        LinearLayout r1 = Ui.row(a);
        TextView idv = Ui.monoLine(a, id, 13f, Theme.TEXT);
        idv.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        r1.addView(idv);
        TextView stc = Ui.chipSm(a, Api.orderStatusLabel(status), Api.orderStatusColor(status));
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        sp.leftMargin = Theme.dp(a, 8);
        sp.rightMargin = 0;
        stc.setLayoutParams(sp);
        r1.addView(stc);
        card.addView(r1);

        // 기능 + 플랜 + 금액
        LinearLayout r2 = Ui.row(a);
        mt(r2, 8);
        JSONArray feats = o.optJSONArray("features");
        if (feats != null) {
            for (int i = 0; i < feats.length(); i++) {
                String f = feats.optString(i, "");
                if (f.length() > 0) r2.addView(Ui.chipSm(a, Api.featShort(f), Theme.feature(f)));
            }
        }
        r2.addView(Ui.chipSm(a, Api.planLabel(o.optString("plan", ""), 0), Theme.SUB));
        card.addView(r2);

        LinearLayout r3 = Ui.row(a);
        mt(r3, 8);
        TextView amount = Ui.body(a, Ui.won(o.optLong("amount", 0)));
        amount.setTextColor(Theme.TEXT);
        amount.setTypeface(android.graphics.Typeface.create("sans-serif", android.graphics.Typeface.BOLD));
        amount.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 16f);
        amount.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        r3.addView(amount);
        long base = o.optLong("base_amount", 0);
        long amt = o.optLong("amount", 0);
        if (base > 0 && base != amt) {
            TextView suffix = Ui.hint(a, "확인용 " + (amt - base) + "원 포함");
            r3.addView(suffix);
        }
        if (o.optBoolean("needs_review", false)) {
            TextView nr = Ui.chipSm(a, "확인 필요", Theme.RED);
            LinearLayout.LayoutParams nl = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
            nl.leftMargin = Theme.dp(a, 8);
            nl.rightMargin = 0;
            nr.setLayoutParams(nl);
            r3.addView(nr);
        }
        card.addView(r3);

        // 입금자 · 연락처
        StringBuilder who = new StringBuilder();
        String dep = str(o, "depositor");
        String buyer = str(o, "buyer_name");
        String contact = str(o, "contact");
        who.append("입금자 ").append(dep.length() > 0 ? dep : "미기재");
        if (buyer.length() > 0 && !buyer.equals(dep)) who.append(" · 구매자 ").append(buyer);
        if (contact.length() > 0) who.append(" · ").append(contact);
        TextView w = Ui.sub(a, who.toString());
        w.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 12.5f);
        mt(w, 7);
        card.addView(w);

        StringBuilder meta = new StringBuilder();
        meta.append(Ui.fmtMin(o.optLong("created_at", 0)));
        if (target.length() > 0) meta.append(" · 기존키 연장 ").append(target);
        if (o.optLong("handled_at", 0) > 0) meta.append(" · 처리 ").append(Ui.fmtMin(o.optLong("handled_at", 0)));
        TextView m = Ui.hint(a, meta.toString());
        m.setSingleLine(true);
        m.setEllipsize(android.text.TextUtils.TruncateAt.MIDDLE);
        mt(m, 5);
        card.addView(m);

        if (str(o, "memo").length() > 0) {
            TextView mm = Ui.hint(a, "메모: " + str(o, "memo"));
            mt(mm, 5);
            card.addView(mm);
        }

        // 동작
        LinearLayout acts = Ui.row(a);
        mt(acts, 10);
        boolean any = false;
        if (!"done".equals(status) && !"canceled".equals(status)) {
            TextView ok = Ui.btnSm(a, "승인", Theme.F_ORDERS, true);
            ok.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { openApprove(id, target, o); }
            });
            acts.addView(ok);
            TextView no = Ui.btnSm(a, "취소", Theme.RED, false);
            no.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { openCancel(id); }
            });
            acts.addView(no);
            any = true;
        }
        if (issued.length() > 0) {
            TextView cp = Ui.btnSm(a, "발급키 복사", Theme.ACCENT, false);
            cp.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { Ui.copy(a, "발급된 키", issued); }
            });
            acts.addView(cp);
            any = true;
        }
        TextView cpid = Ui.btnSm(a, "주문번호 복사", Theme.SUB, false);
        cpid.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { Ui.copy(a, "주문번호", id); }
        });
        acts.addView(cpid);
        any = true;
        if (any) card.addView(acts);

        if (issued.length() > 0) {
            TextView ik = Ui.monoLine(a, "발급키 " + issued, 12f, Theme.ACCENT);
            mt(ik, 8);
            card.addView(ik);
        }
        return card;
    }

    /** 승인 — 기존키를 넣으면 연장, 비우면 신규발급 */
    private void openApprove(final String id, String targetKey, JSONObject o) {
        LinearLayout box = Ui.col(a);
        box.addView(Ui.sub(a, "기존 키에 기능을 추가하려면 아래에 키를 입력하십시오. 비워 두면 신규 키가 발급됩니다."));

        LinearLayout info = Ui.col(a);
        mt(info, 10);
        info.addView(Ui.kvTight(a, "주문", id));
        info.addView(Ui.kvTight(a, "금액", Ui.won(o.optLong("amount", 0))));
        info.addView(Ui.kvTight(a, "플랜", Api.planLabel(o.optString("plan", ""), 0)));
        JSONArray feats = o.optJSONArray("features");
        StringBuilder fs = new StringBuilder();
        if (feats != null) {
            for (int i = 0; i < feats.length(); i++) {
                if (fs.length() > 0) fs.append(", ");
                fs.append(Api.featLabel(feats.optString(i, "")));
            }
        }
        info.addView(Ui.kvTight(a, "기능", fs.length() == 0 ? "-" : fs.toString()));
        info.addView(Ui.kvTight(a, "입금자", dash(str(o, "depositor"))));
        box.addView(info);

        final EditText key = Ui.lineField(a, "기존 키 (비우면 신규 발급)");
        if (targetKey != null && targetKey.length() > 0) key.setText(targetKey);
        mt(key, 12);
        box.addView(key);

        AlertDialog.Builder b = Ui.dialog(a, "주문 승인");
        b.setView(Ui.dialogBody(a, box));
        b.setNegativeButton("취소", null);
        b.setPositiveButton("승인", null);
        final AlertDialog dlg = Ui.showDark(b);
        if (dlg == null) return;
        View pos = dlg.getButton(AlertDialog.BUTTON_POSITIVE);
        if (pos == null) return;
        pos.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) {
                final String k = Api.normKey(key.getText() == null ? "" : key.getText().toString());
                String msg = (k.length() > 0)
                        ? ("기존 키에 기능을 추가합니다.\n" + k + "\n보유 중인 기능은 남은 기간에 합산됩니다.")
                        : "신규 키를 발급하고 이 주문을 완료 처리합니다.";
                Ui.confirm(a, "주문 승인", msg, "승인", false, new Runnable() {
                    @Override public void run() {
                        Api.orderApprove(a, id, k, new Api.Cb() {
                            @Override public void done(Api.Result r) {
                                if (a.kicked(r)) return;
                                if (!r.ok) { a.fail("주문 승인", r); return; }
                                dismiss(dlg);
                                String issuedKey = r.str("key", "");
                                App.log(a, "주문 승인 " + id + " → " + issuedKey
                                        + (r.json != null && r.json.optBoolean("already", false) ? " (이미 처리됨)" : ""));
                                a.invalidate(0);
                                a.invalidate(2);
                                a.refreshStats();
                                load();
                                showIssued(id, issuedKey, r.json != null && r.json.optBoolean("issued", false));
                            }
                        });
                    }
                });
            }
        });
    }

    private void showIssued(String id, final String key, boolean isNew) {
        LinearLayout box = Ui.col(a);
        box.addView(Ui.sub(a, id + " 이 완료 처리되었습니다. " + (isNew ? "신규 키가 발급되었습니다." : "기존 키가 연장되었습니다.")));
        TextView big = Ui.monoBig(a, (key == null || key.length() == 0) ? "(키 없음)" : key);
        mt(big, 14);
        box.addView(big);
        TextView tip = Ui.hint(a, "구매자에게 이 키를 전달하십시오. 구매자는 /order/<주문번호> 페이지에서도 확인할 수 있습니다.");
        mt(tip, 10);
        box.addView(tip);

        AlertDialog.Builder b = Ui.dialog(a, "승인 완료");
        b.setView(Ui.dialogBody(a, box));
        b.setNegativeButton("닫기", null);
        b.setPositiveButton("키 복사", new android.content.DialogInterface.OnClickListener() {
            @Override public void onClick(android.content.DialogInterface d, int w) {
                Ui.copy(a, "발급된 키", key == null ? "" : key);
            }
        });
        Ui.showDark(b);
    }

    private void openCancel(final String id) {
        Ui.input(a, "주문 취소", "취소 사유 (예: 입금 없음)", null, false, new Ui.OnText() {
            @Override public void text(final String s) {
                Ui.confirm(a, "주문 취소",
                        id + " 을 취소 처리합니다.\n" + (s.length() > 0 ? ("사유: " + s) : "사유 미기재로 취소됩니다."),
                        "취소 처리", true, new Runnable() {
                            @Override public void run() {
                                Api.orderCancel(a, id, s, new Api.Cb() {
                                    @Override public void done(Api.Result r) {
                                        if (a.kicked(r)) return;
                                        if (!r.ok) { a.fail("주문 취소", r); return; }
                                        Ui.toast(a, "주문이 취소되었습니다");
                                        App.log(a, "주문 취소 " + id + (s.length() > 0 ? (" / " + s) : ""));
                                        a.invalidate(2);
                                        a.refreshStats();
                                        load();
                                    }
                                });
                            }
                        });
            }
        });
    }

    // ── 입금 내역 ─────────────────────────────────────────────────────────────

    private void loadDeposits() {
        if (busy) return;
        busy = true;
        busyBox();
        Api.deposits(a, "", LIMIT, new Api.Cb() {
            @Override public void done(Api.Result r) {
                busy = false;
                if (a.kicked(r)) return;
                if (listBox == null) return;
                listBox.removeAllViews();
                if (!r.ok) {
                    listBox.addView(Ui.emptyBox(a, "입금 내역을 불러오지 못했습니다\n" + r.error));
                    a.fail("입금 내역", r);
                    return;
                }
                JSONArray arr = r.arr("deposits");
                int attention = r.integer("needs_attention");
                boolean hook = r.json != null && r.json.optBoolean("hook_enabled", false);
                boolean auto = r.json != null && r.json.optBoolean("auto_approve", false);

                if (countLabel != null) {
                    countLabel.setText("입금 " + arr.length() + "건"
                            + (attention > 0 ? (" · 확인 필요 " + attention + "건") : ""));
                }
                if (noteLabel != null) {
                    noteLabel.setText("웹훅 " + (hook ? "켜짐" : "꺼짐(DEPOSIT_TOKEN 미설정)")
                            + " · 자동승인 " + (auto ? "켜짐" : "꺼짐"));
                    noteLabel.setVisibility(View.VISIBLE);
                }
                if (arr.length() == 0) {
                    listBox.addView(Ui.emptyBox(a, "입금 기록이 없습니다\n"
                            + "자동화 앱이 /api/deposit-hook 으로 알림을 전송하면 이 목록에 기록됩니다."));
                    return;
                }
                // 확인이 필요한 건(미매칭·모호)을 위로
                ArrayList<JSONObject> top = new ArrayList<JSONObject>();
                ArrayList<JSONObject> rest = new ArrayList<JSONObject>();
                for (int i = 0; i < arr.length(); i++) {
                    JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    String st = o.optString("status", "");
                    if ("unmatched".equals(st) || "ambiguous".equals(st)) top.add(o);
                    else rest.add(o);
                }
                for (int i = 0; i < top.size(); i++) listBox.addView(depositCard(top.get(i)));
                if (!top.isEmpty() && !rest.isEmpty()) listBox.addView(Ui.dividerTight(a));
                for (int i = 0; i < rest.size(); i++) listBox.addView(depositCard(rest.get(i)));
            }
        });
    }

    private LinearLayout depositCard(final JSONObject d) {
        LinearLayout card = Ui.listCard(a);
        final long depId = d.optLong("id", 0);
        final String status = d.optString("status", "");
        final String raw = str(d, "raw");

        LinearLayout r1 = Ui.row(a);
        TextView amt = Ui.body(a, d.isNull("amount") ? "금액 못 읽음" : Ui.won(d.optLong("amount", 0)));
        amt.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
        amt.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, 15.5f);
        amt.setLayoutParams(new LinearLayout.LayoutParams(0,
                LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        r1.addView(amt);
        TextView stc = Ui.chipSm(a, Api.depositStatusLabel(status), Api.depositStatusColor(status));
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        sp.rightMargin = 0;
        stc.setLayoutParams(sp);
        r1.addView(stc);
        card.addView(r1);

        StringBuilder meta = new StringBuilder();
        meta.append(Ui.fmtMin(d.optLong("at", 0)));
        String nm = str(d, "name");
        if (nm.length() > 0) meta.append(" · ").append(nm);
        String src = str(d, "source");
        if (src.length() > 0) meta.append(" · ").append(src);
        String mo = str(d, "matched_order");
        if (mo.length() > 0) meta.append(" · 주문 ").append(mo);
        TextView m = Ui.hint(a, meta.toString());
        mt(m, 6);
        card.addView(m);

        TextView rawV = Ui.hint(a, raw.length() > 0 ? raw : "(원문 없음)");
        rawV.setSingleLine(true);
        rawV.setEllipsize(android.text.TextUtils.TruncateAt.END);
        rawV.setTextColor(Theme.SUB);
        rawV.setBackground(Theme.round(Theme.CARD2, Theme.R_SM, Theme.LINE, 1, a));
        int rp = Theme.dp(a, 9);
        rawV.setPadding(rp, rp, rp, rp);
        mt(rawV, 8);
        rawV.setClickable(true);
        Ui.press(rawV);
        rawV.setOnClickListener(new View.OnClickListener() {
            @Override public void onClick(View v) { Ui.showText(a, "입금 알림 원문", raw); }
        });
        card.addView(rawV);

        if ("unmatched".equals(status) || "ambiguous".equals(status)) {
            LinearLayout acts = Ui.row(a);
            mt(acts, 10);
            TextView match = Ui.btnSm(a, "수동 매칭", Theme.F_DEPOSIT, true);
            match.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) { pickOrderFor(depId, d.optLong("amount", 0)); }
            });
            acts.addView(match);
            TextView ig = Ui.btnSm(a, "무시", Theme.SUB, false);
            ig.setOnClickListener(new View.OnClickListener() {
                @Override public void onClick(View v) {
                    Ui.confirm(a, "입금 무시", "이 입금 기록을 무시 처리합니다.\n목록의 확인 필요 표시가 해제됩니다.",
                            "무시", false, new Runnable() {
                                @Override public void run() {
                                    Api.depositIgnore(a, depId, new Api.Cb() {
                                        @Override public void done(Api.Result r) {
                                            if (a.kicked(r)) return;
                                            if (!r.ok) { a.fail("입금 무시", r); return; }
                                            Ui.toast(a, "무시 처리되었습니다");
                                            App.log(a, "입금기록 " + depId + " 무시");
                                            a.refreshStats();
                                            load();
                                        }
                                    });
                                }
                            });
                }
            });
            acts.addView(ig);
            card.addView(acts);
        }
        return card;
    }

    /** 대기 주문 목록을 띄워서 이 입금과 묶을 주문을 고르게 한다 */
    private void pickOrderFor(final long depositId, final long amount) {
        Ui.toast(a, "대기 주문을 불러오는 중…");
        Api.orders(a, "pending", LIMIT, new Api.Cb() {
            @Override public void done(Api.Result r) {
                if (a.kicked(r)) return;
                if (!r.ok) { a.fail("대기 주문", r); return; }
                final JSONArray arr = r.arr("orders");
                LinearLayout box = Ui.col(a);
                if (arr.length() == 0) {
                    box.addView(Ui.emptyBox(a, "대기 중인 주문이 없습니다"));
                } else {
                    box.addView(Ui.sub(a, "이 입금(" + Ui.won(amount) + ")에 매칭할 주문을 선택하십시오."));
                }

                final AlertDialog.Builder b = Ui.dialog(a, "수동 매칭");
                b.setView(Ui.dialogBody(a, box));
                b.setNegativeButton("닫기", null);
                final AlertDialog dlg = b.create();

                for (int i = 0; i < arr.length(); i++) {
                    final JSONObject o = arr.optJSONObject(i);
                    if (o == null) continue;
                    final String id = o.optString("id", "");
                    long amt = o.optLong("amount", 0);
                    LinearLayout row = Ui.listCard(a);
                    mt(row, 8);
                    LinearLayout top = Ui.row(a);
                    TextView idv = Ui.monoLine(a, id, 12.5f, Theme.TEXT);
                    idv.setLayoutParams(new LinearLayout.LayoutParams(0,
                            LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
                    top.addView(idv);
                    top.addView(Ui.chipSm(a, Ui.won(amt), amt == amount ? Theme.ACCENT : Theme.SUB));
                    row.addView(top);
                    TextView sub = Ui.hint(a, dash(str(o, "depositor")) + " · "
                            + Api.planLabel(o.optString("plan", ""), 0) + " · "
                            + Ui.fmtMin(o.optLong("created_at", 0)));
                    mt(sub, 5);
                    row.addView(sub);
                    row.setClickable(true);
                    Ui.press(row);
                    row.setOnClickListener(new View.OnClickListener() {
                        @Override public void onClick(View v) {
                            Ui.confirm(a, "수동 매칭",
                                    "입금기록 " + depositId + " 을 주문 " + id + " 에 매칭하고 승인합니다.\n"
                                            + "키가 발급 또는 연장되고 주문이 완료 처리됩니다.",
                                    "매칭 + 승인", false, new Runnable() {
                                        @Override public void run() {
                                            Api.depositMatch(a, depositId, id, new Api.Cb() {
                                                @Override public void done(Api.Result r2) {
                                                    if (a.kicked(r2)) return;
                                                    if (!r2.ok) { a.fail("수동 매칭", r2); return; }
                                                    dismiss(dlg);
                                                    String k = r2.str("key", "");
                                                    App.log(a, "입금 수동매칭 " + depositId + " → 주문 " + id + " / 키 " + k);
                                                    a.invalidate(0);
                                                    a.invalidate(2);
                                                    a.refreshStats();
                                                    load();
                                                    showIssued(id, k, true);
                                                }
                                            });
                                        }
                                    });
                        }
                    });
                    box.addView(row);
                }
                Ui.showDark(dlg);
            }
        });
    }

    // ── 공통 ──────────────────────────────────────────────────────────────────

    private static void dismiss(AlertDialog d) {
        if (d == null) return;
        try { d.dismiss(); } catch (Throwable ignore) { }
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
