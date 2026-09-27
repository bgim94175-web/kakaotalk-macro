package com.buseong.kakaoadmin;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.MalformedURLException;
import java.net.URL;
import java.net.URLEncoder;
import java.util.List;

/**
 * 관리자 API 래퍼. 전부 백그라운드 스레드에서 돌고 콜백은 메인 스레드로 온다.
 * 라이브러리 안 쓴다 — HttpURLConnection + org.json 만.
 *
 * 서버주소/비밀번호는 Prefs("kakao_admin") 에 저장하고, 모든 요청에 x-admin-password 헤더를 붙인다.
 * 타임아웃 20초. 네트워크 오류는 한국어로 분류해서 Result.error 에 담는다.
 *
 * 관리자 응답은 서명하지 않는다(비밀번호로 보호) — 그래서 검증 로직이 없다.
 */
public final class Api {
    private Api() {}

    /** 응답 한 건. ok=false 면 error 에 한국어 사유가 들어있다. */
    public static final class Result {
        /** 서버가 ok:true 를 줬나 */
        public boolean ok;
        /** 파싱된 응답 (전송 실패면 null) */
        public JSONObject json;
        /** 실패 사유 (한국어). ok=true 면 null */
        public String error;
        /** HTTP 상태코드 (전송 자체가 실패했으면 0) */
        public int code;
        /** 비밀번호가 틀렸다(401) — 화면은 이걸 보고 로그인으로 돌려보낸다 */
        public boolean unauthorized;

        /** 응답에서 문자열 꺼내기 (없으면 dflt) */
        public String str(String name, String dflt) {
            if (json == null) return dflt;
            String s = json.optString(name, null);
            return (s == null || s.length() == 0 || "null".equals(s)) ? dflt : s;
        }
        public long lng(String name) { return (json == null) ? 0L : json.optLong(name, 0L); }
        public int integer(String name) { return (json == null) ? 0 : json.optInt(name, 0); }
        public JSONArray arr(String name) {
            if (json == null) return new JSONArray();
            JSONArray a = json.optJSONArray(name);
            return (a == null) ? new JSONArray() : a;
        }
        /** 없으면 null (있는지 판단해야 할 때) */
        public JSONObject optObj(String name) {
            return (json == null) ? null : json.optJSONObject(name);
        }
        /** 없으면 빈 객체 */
        public JSONObject obj(String name) {
            if (json == null) return new JSONObject();
            JSONObject o = json.optJSONObject(name);
            return (o == null) ? new JSONObject() : o;
        }
    }

    /** 결과 콜백 (메인 스레드) */
    public interface Cb { void done(Result r); }

    // ── 상수 ──────────────────────────────────────────────────────────────────

    public static final String DEFAULT_BASE = "https://kakaotalk-macro.onrender.com";
    private static final int TIMEOUT_MS = 20000;

    /** 기능 id — 서버 lib/features.js 의 ALL 과 순서까지 같다 */
    public static final String[] FEATURES = { "macro", "roombot", "minigame" };

    /** 플랜 코드 (custom 은 관리자 전용) */
    public static final String[] PLAN_CODES  = { "month", "quarter", "year", "custom" };
    public static final String[] PLAN_LABELS = { "1개월", "3개월", "1년", "직접입력" };

    /** 감사기록 종류 — 빈 문자열은 '전체' */
    public static final String[] AUDIT_KINDS = {
        "", "activate", "mismatch", "takeover", "bad_sig", "tamper",
        "reset", "order", "expired", "revoked", "bad_deposit_token"
    };
    public static final String[] AUDIT_KIND_LABELS = {
        "전체", "활성화", "기기불일치", "지문변경", "서명위조", "변조탐지",
        "기기초기화", "주문", "기간만료", "회수·차단", "입금토큰"
    };

    /** 주문 상태 필터 */
    public static final String[] ORDER_STATUS        = { "pending", "done", "canceled", "" };
    public static final String[] ORDER_STATUS_LABELS = { "대기", "완료", "취소", "전체" };

    // ── 설정 (Prefs "kakao_admin") ────────────────────────────────────────────

    private static final String K_BASE     = "base";
    private static final String K_PASSWORD = "password";
    private static final String K_REMEMBER = "remember";

    /** 비번을 저장하지 않기로 했을 때 이 실행 동안만 들고 있는 값 */
    private static volatile String memPw = null;

    private static SharedPreferences prefs(Context c) {
        if (c == null) return null;
        try { return c.getApplicationContext().getSharedPreferences(App.PREFS, Context.MODE_PRIVATE); }
        catch (Throwable t) { return null; }
    }

    /** 저장된 서버주소 (없으면 기본값) */
    public static String base(Context c) {
        SharedPreferences p = prefs(c);
        String s = (p == null) ? null : p.getString(K_BASE, null);
        s = normBase(s);
        return (s.length() == 0) ? DEFAULT_BASE : s;
    }

    public static void setBase(Context c, String url) {
        SharedPreferences p = prefs(c);
        if (p == null) return;
        String s = normBase(url);
        p.edit().putString(K_BASE, s.length() == 0 ? DEFAULT_BASE : s).apply();
    }

    /** 끝 슬래시 제거 + 스킴 없으면 https:// 붙이기 */
    public static String normBase(String url) {
        if (url == null) return "";
        String s = url.trim();
        if (s.length() == 0) return "";
        if (!s.startsWith("http://") && !s.startsWith("https://")) s = "https://" + s;
        while (s.endsWith("/")) s = s.substring(0, s.length() - 1);
        return s;
    }

    /** 현재 관리자 비밀번호 (저장 안 했으면 메모리 값) */
    public static String password(Context c) {
        if (memPw != null && memPw.length() > 0) return memPw;
        SharedPreferences p = prefs(c);
        String s = (p == null) ? null : p.getString(K_PASSWORD, null);
        return (s == null) ? "" : s;
    }

    /** 비번 저장 체크 상태 */
    public static boolean remember(Context c) {
        SharedPreferences p = prefs(c);
        return p != null && p.getBoolean(K_REMEMBER, false);
    }

    /** 로그인 = 서버주소 + 비번을 세팅한다 (remember 면 비번까지 저장) */
    public static void signIn(Context c, String url, String pw, boolean rememberPw) {
        setBase(c, url);
        memPw = (pw == null) ? "" : pw;
        SharedPreferences p = prefs(c);
        if (p == null) return;
        SharedPreferences.Editor e = p.edit().putBoolean(K_REMEMBER, rememberPw);
        if (rememberPw) e.putString(K_PASSWORD, memPw);
        else e.remove(K_PASSWORD);
        e.apply();
    }

    /** 로그아웃 — 저장된 비번까지 지운다 (서버주소는 남긴다) */
    public static void signOut(Context c) {
        memPw = null;
        SharedPreferences p = prefs(c);
        if (p != null) p.edit().remove(K_PASSWORD).putBoolean(K_REMEMBER, false).apply();
        App.log(c, "로그아웃했어");
    }

    /** 자동 로그인 가능? (저장된 비번이 있나) */
    public static boolean hasPassword(Context c) {
        return password(c).length() > 0;
    }

    // ── 엔드포인트 ────────────────────────────────────────────────────────────

    /** GET /admin/stats */
    public static void stats(Context c, Cb cb) { get(c, "/admin/stats", cb); }

    /** GET /admin/list?q=&limit=&offset= */
    public static void list(Context c, String term, int limit, int offset, Cb cb) {
        StringBuilder p = new StringBuilder("/admin/list?limit=").append(limit).append("&offset=").append(offset);
        if (term != null && term.trim().length() > 0) p.append("&q=").append(enc(term.trim()));
        get(c, p.toString(), cb);
    }

    /** GET /admin/license?key= (상세 + 최근 audit 20건) */
    public static void license(Context c, String key, Cb cb) {
        get(c, "/admin/license?key=" + enc(normKey(key)), cb);
    }

    /** GET /admin/audit?key=&kind=&limit= */
    public static void audit(Context c, String key, String kind, int limit, Cb cb) {
        StringBuilder p = new StringBuilder("/admin/audit?limit=").append(limit);
        if (key != null && key.trim().length() > 0) p.append("&key=").append(enc(normKey(key)));
        if (kind != null && kind.trim().length() > 0) p.append("&kind=").append(enc(kind.trim()));
        get(c, p.toString(), cb);
    }

    /** GET /admin/orders?status=&limit= */
    public static void orders(Context c, String status, int limit, Cb cb) {
        StringBuilder p = new StringBuilder("/admin/orders?limit=").append(limit);
        if (status != null && status.trim().length() > 0) p.append("&status=").append(enc(status.trim()));
        get(c, p.toString(), cb);
    }

    /** GET /admin/deposits?status=&limit= */
    public static void deposits(Context c, String status, int limit, Cb cb) {
        StringBuilder p = new StringBuilder("/admin/deposits?limit=").append(limit);
        if (status != null && status.trim().length() > 0) p.append("&status=").append(enc(status.trim()));
        get(c, p.toString(), cb);
    }

    /** GET /admin/sigs */
    public static void sigs(Context c, Cb cb) { get(c, "/admin/sigs", cb); }

    /** POST /admin/create — 새 키 발급. days 는 plan=custom 일 때만 쓴다. */
    public static void create(Context c, List<String> features, String plan, int days, int count,
                              String note, String ownerName, String ownerContact, Cb cb) {
        JSONObject b = new JSONObject();
        try {
            b.put("features", jarr(features));
            b.put("plan", plan);
            if ("custom".equals(plan)) b.put("days", days);
            b.put("count", Math.max(1, count));
            putIf(b, "note", note);
            putIf(b, "owner_name", ownerName);
            putIf(b, "owner_contact", ownerContact);
        } catch (Throwable t) {
            fail(c, cb, "요청을 만들지 못했어: " + t);
            return;
        }
        post(c, "/admin/create", b, cb);
    }

    /** POST /admin/grant — 기존 키에 기능 추가/연장 (이미 있으면 남은 기간에 더함) */
    public static void grant(Context c, String key, List<String> features, String plan, int days, Cb cb) {
        JSONObject b = new JSONObject();
        try {
            b.put("key", normKey(key));
            b.put("features", jarr(features));
            b.put("plan", plan);
            if ("custom".equals(plan)) b.put("days", days);
        } catch (Throwable t) {
            fail(c, cb, "요청을 만들지 못했어: " + t);
            return;
        }
        post(c, "/admin/grant", b, cb);
    }

    /** POST /admin/revoke-feature — 기능 하나만 회수 */
    public static void revokeFeature(Context c, String key, String feature, Cb cb) {
        post(c, "/admin/revoke-feature", json2("key", normKey(key), "feature", feature), cb);
    }

    /** POST /admin/revoke — 키 회수(true) / 복구(false) */
    public static void revoke(Context c, String key, boolean revoked, Cb cb) {
        JSONObject b = new JSONObject();
        try { b.put("key", normKey(key)); b.put("revoked", revoked); }
        catch (Throwable t) { fail(c, cb, "요청을 만들지 못했어: " + t); return; }
        post(c, "/admin/revoke", b, cb);
    }

    /** POST /admin/block — reason 이 비어있으면 차단 해제 */
    public static void block(Context c, String key, String reason, Cb cb) {
        JSONObject b = new JSONObject();
        try {
            b.put("key", normKey(key));
            if (reason == null || reason.trim().length() == 0) b.put("reason", JSONObject.NULL);
            else b.put("reason", reason.trim());
        } catch (Throwable t) { fail(c, cb, "요청을 만들지 못했어: " + t); return; }
        post(c, "/admin/block", b, cb);
    }

    /** POST /admin/reset-device — 기기 고정 해제 (reset_count++) */
    public static void resetDevice(Context c, String key, Cb cb) {
        post(c, "/admin/reset-device", json1("key", normKey(key)), cb);
    }

    /** POST /admin/delete — 키 완전 삭제 */
    public static void delete(Context c, String key, Cb cb) {
        post(c, "/admin/delete", json1("key", normKey(key)), cb);
    }

    /** POST /admin/order-approve — key 를 비우면 신규 발급 */
    public static void orderApprove(Context c, String id, String key, Cb cb) {
        JSONObject b = new JSONObject();
        try {
            b.put("id", normOrderId(id));
            String k = normKey(key);
            if (k.length() > 0) b.put("key", k);
        } catch (Throwable t) { fail(c, cb, "요청을 만들지 못했어: " + t); return; }
        post(c, "/admin/order-approve", b, cb);
    }

    /** POST /admin/order-cancel */
    public static void orderCancel(Context c, String id, String memo, Cb cb) {
        JSONObject b = new JSONObject();
        try {
            b.put("id", normOrderId(id));
            if (memo != null && memo.trim().length() > 0) b.put("memo", memo.trim());
        } catch (Throwable t) { fail(c, cb, "요청을 만들지 못했어: " + t); return; }
        post(c, "/admin/order-cancel", b, cb);
    }

    /** POST /admin/deposit-match — 입금기록을 주문에 수동 매칭하고 승인까지 */
    public static void depositMatch(Context c, long depositId, String orderId, Cb cb) {
        JSONObject b = new JSONObject();
        try { b.put("deposit_id", depositId); b.put("order_id", normOrderId(orderId)); }
        catch (Throwable t) { fail(c, cb, "요청을 만들지 못했어: " + t); return; }
        post(c, "/admin/deposit-match", b, cb);
    }

    /** POST /admin/deposit-ignore */
    public static void depositIgnore(Context c, long depositId, Cb cb) {
        JSONObject b = new JSONObject();
        try { b.put("deposit_id", depositId); }
        catch (Throwable t) { fail(c, cb, "요청을 만들지 못했어: " + t); return; }
        post(c, "/admin/deposit-ignore", b, cb);
    }

    /** POST /admin/sig-add — 앱 서명 허용목록에 추가 */
    public static void sigAdd(Context c, String sha256, String label, Cb cb) {
        JSONObject b = new JSONObject();
        try {
            b.put("sha256", normSha(sha256));
            if (label != null && label.trim().length() > 0) b.put("label", label.trim());
        } catch (Throwable t) { fail(c, cb, "요청을 만들지 못했어: " + t); return; }
        post(c, "/admin/sig-add", b, cb);
    }

    /** POST /admin/sig-del */
    public static void sigDel(Context c, String sha256, Cb cb) {
        post(c, "/admin/sig-del", json1("sha256", normSha(sha256)), cb);
    }

    // ── 도메인 어휘 (서버 lib/features.js · lib/keys.js 와 같은 말을 쓴다) ──────

    public static String featLabel(String id) {
        if ("macro".equals(id)) return "자동발송 매크로";
        if ("roombot".equals(id)) return "방 관리봇";
        if ("minigame".equals(id)) return "미니게임봇";
        return (id == null) ? "" : id;
    }

    /** 목록 칩에 쓰는 짧은 이름 */
    public static String featShort(String id) {
        if ("macro".equals(id)) return "매크로";
        if ("roombot".equals(id)) return "방관리";
        if ("minigame".equals(id)) return "미니게임";
        return (id == null) ? "" : id;
    }

    public static String featDesc(String id) {
        if ("macro".equals(id)) return "방별 주기 자동발송 · 이미지 첨부 · 메시지추적 · 오픈프로필 자동응답";
        if ("roombot".equals(id)) return "입/퇴장 인사, 금지어 감지, 도배 감지, 공지 자동안내";
        if ("minigame".equals(id)) return "끝말잇기 · 숫자야구 · 주사위 · 퀴즈 · 랭킹";
        return "";
    }

    public static String planLabel(String plan, int days) {
        if ("custom".equals(plan)) return (days > 0 ? days : 0) + "일";
        if ("month".equals(plan)) return "1개월";
        if ("quarter".equals(plan)) return "3개월";
        if ("year".equals(plan)) return "1년";
        return (plan == null || plan.length() == 0) ? "-" : plan;
    }

    public static String kindLabel(String kind) {
        if (kind == null) return "-";
        if (kind.equals("activate")) return "활성화";
        if (kind.equals("mismatch")) return "기기불일치";
        if (kind.equals("takeover")) return "지문변경";
        if (kind.equals("bad_sig")) return "서명위조";
        if (kind.equals("tamper")) return "변조탐지";
        if (kind.equals("expired")) return "기간만료";
        if (kind.equals("revoked")) return "회수·차단";
        if (kind.equals("reset")) return "기기초기화";
        if (kind.equals("order")) return "주문";
        if (kind.equals("bad_deposit_token")) return "입금토큰";
        return kind;
    }

    public static String orderStatusLabel(String s) {
        if ("pending".equals(s)) return "대기";
        if ("paid".equals(s)) return "입금확인";
        if ("done".equals(s)) return "완료";
        if ("canceled".equals(s)) return "취소";
        return (s == null || s.length() == 0) ? "-" : s;
    }

    public static int orderStatusColor(String s) {
        if ("pending".equals(s)) return Theme.AMBER;
        if ("done".equals(s)) return Theme.ACCENT;
        if ("paid".equals(s)) return Theme.ACCENT2;
        if ("canceled".equals(s)) return Theme.DIM;
        return Theme.SUB;
    }

    public static String depositStatusLabel(String s) {
        if ("matched".equals(s)) return "매칭됨";
        if ("unmatched".equals(s)) return "미매칭";
        if ("duplicate".equals(s)) return "중복";
        if ("ambiguous".equals(s)) return "모호";
        if ("ignored".equals(s)) return "무시";
        return (s == null || s.length() == 0) ? "-" : s;
    }

    public static int depositStatusColor(String s) {
        if ("matched".equals(s)) return Theme.ACCENT;
        if ("unmatched".equals(s)) return Theme.AMBER;
        if ("ambiguous".equals(s)) return Theme.RED;
        if ("duplicate".equals(s)) return Theme.DIM;
        if ("ignored".equals(s)) return Theme.DIM;
        return Theme.SUB;
    }

    /** 키 정규화 — 서버 keys.normKey 와 같은 규칙 */
    public static String normKey(String s) {
        if (s == null) return "";
        return s.trim().toUpperCase(java.util.Locale.ROOT).replaceAll("\\s+", "");
    }

    /** 주문번호 정규화 — 서버 keys.normOrderId 와 같은 규칙 */
    public static String normOrderId(String s) {
        if (s == null) return "";
        String v = s.trim().toUpperCase(java.util.Locale.ROOT).replaceAll("[^A-Z0-9-]", "");
        return (v.length() > 32) ? v.substring(0, 32) : v;
    }

    /** SHA-256 hex 정규화 (콜론·공백 제거, 소문자) */
    public static String normSha(String s) {
        if (s == null) return "";
        return s.trim().toLowerCase(java.util.Locale.ROOT).replaceAll("[^0-9a-f]", "");
    }

    // ── HTTP ──────────────────────────────────────────────────────────────────

    private static void get(Context c, String path, Cb cb) { call(c, "GET", path, null, cb); }
    private static void post(Context c, String path, JSONObject body, Cb cb) {
        call(c, "POST", path, (body == null) ? new JSONObject() : body, cb);
    }

    private static void call(Context ctx, final String method, final String path,
                             final JSONObject body, final Cb cb) {
        final Context c = (ctx == null) ? null : ctx.getApplicationContext();
        if (c == null) {
            if (cb != null) cb.done(err(0, "앱 상태가 이상해 (컨텍스트 없음)"));
            return;
        }
        final String base = base(c);
        final String pw = password(c);
        final Handler main = new Handler(Looper.getMainLooper());
        new Thread(new Runnable() {
            @Override public void run() {
                Result r;
                try {
                    r = exec(base, method, path, pw, body);
                } catch (Throwable t) {
                    r = err(0, "요청 중에 알 수 없는 오류가 났어: " + t);
                }
                if (!r.ok) App.log(c, method + " " + path + " 실패 — " + r.error);
                final Result out = r;
                main.post(new Runnable() {
                    @Override public void run() {
                        if (cb == null) return;
                        try { cb.done(out); }
                        catch (Throwable t) { App.log(c, "응답 처리 중 오류: " + t); }
                    }
                });
            }
        }, "admin-api").start();
    }

    /** 실제 통신. 백그라운드 스레드에서만 부른다. */
    private static Result exec(String base, String method, String path, String pw, JSONObject body) {
        if (pw == null || pw.length() == 0) return err(401, "비밀번호가 없어 — 다시 로그인해줘");

        URL url;
        try {
            url = new URL(base + path);
        } catch (MalformedURLException e) {
            return err(0, "서버 주소가 잘못됐어: " + base);
        }

        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) url.openConnection();
            conn.setConnectTimeout(TIMEOUT_MS);
            conn.setReadTimeout(TIMEOUT_MS);
            conn.setRequestMethod(method);
            conn.setInstanceFollowRedirects(true);
            conn.setUseCaches(false);
            conn.setRequestProperty("x-admin-password", pw);
            conn.setRequestProperty("Accept", "application/json");
            conn.setRequestProperty("Accept-Charset", "UTF-8");
            conn.setRequestProperty("User-Agent", "KakaoAdmin/2.0 (Android)");

            if (body != null) {
                byte[] payload = body.toString().getBytes("UTF-8");
                conn.setDoOutput(true);
                conn.setFixedLengthStreamingMode(payload.length);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                OutputStream os = conn.getOutputStream();
                try { os.write(payload); os.flush(); } finally { closeQuiet(os); }
            }

            int code = conn.getResponseCode();
            String text = read((code >= 400) ? conn.getErrorStream() : conn.getInputStream());

            if (code == 401 || code == 403) {
                Result r = err(code, "비밀번호가 틀렸어");
                r.unauthorized = true;
                return r;
            }
            if (code == 404) return err(code, "서버에 그 기능이 없어 — 서버를 최신으로 배포했는지 확인해줘");
            if (code >= 500) return err(code, "서버 오류 (" + code + ")" + shortTail(text));

            JSONObject json;
            try {
                json = new JSONObject(text == null ? "" : text);
            } catch (Throwable t) {
                return err(code, "서버 응답을 이해 못 했어 (JSON 아님)" + shortTail(text));
            }

            Result r = new Result();
            r.code = code;
            r.json = json;
            r.ok = json.optBoolean("ok", false);
            if (!r.ok) {
                String e = json.optString("error", null);
                if (e == null || e.length() == 0 || "null".equals(e)) e = "서버가 거절했어";
                r.error = e;
            }
            return r;

        } catch (java.net.SocketTimeoutException e) {
            return err(0, "서버가 20초 안에 답을 안 줬어 (Render 가 자고 있으면 첫 요청이 느려. 다시 눌러봐)");
        } catch (java.net.UnknownHostException e) {
            return err(0, "서버에 연결 못 했어 — 주소를 못 찾아 (" + base + ")");
        } catch (java.net.ConnectException e) {
            return err(0, "서버에 연결 못 했어 — 연결이 거부됐어");
        } catch (javax.net.ssl.SSLException e) {
            return err(0, "서버에 연결 못 했어 — 보안 연결(HTTPS) 실패");
        } catch (IOException e) {
            return err(0, "서버에 연결 못 했어 (" + e.getClass().getSimpleName() + ")");
        } catch (Throwable t) {
            return err(0, "요청 실패: " + t);
        } finally {
            if (conn != null) {
                try { conn.disconnect(); } catch (Throwable ignore) { }
            }
        }
    }

    private static String read(InputStream in) {
        if (in == null) return "";
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try {
            byte[] buf = new byte[4096];
            int n;
            int total = 0;
            while ((n = in.read(buf)) > 0) {
                bos.write(buf, 0, n);
                total += n;
                if (total > 4 * 1024 * 1024) break; // 관리자 응답이 4MB 넘을 일은 없다
            }
            return new String(bos.toByteArray(), "UTF-8");
        } catch (Throwable t) {
            return "";
        } finally {
            closeQuiet(in);
        }
    }

    private static void closeQuiet(java.io.Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (Throwable ignore) { }
    }

    /** 오류 메시지에 서버가 준 본문 앞부분을 조금 붙여서 원인을 보이게 한다 */
    private static String shortTail(String text) {
        if (text == null) return "";
        String s = text.replace('\n', ' ').replace('\r', ' ').trim();
        if (s.length() == 0) return "";
        if (s.length() > 120) s = s.substring(0, 120) + "…";
        return ": " + s;
    }

    private static Result err(int code, String msg) {
        Result r = new Result();
        r.ok = false;
        r.code = code;
        r.error = msg;
        return r;
    }

    private static void fail(Context c, final Cb cb, final String msg) {
        App.log(c, msg);
        if (cb == null) return;
        new Handler(Looper.getMainLooper()).post(new Runnable() {
            @Override public void run() { cb.done(err(0, msg)); }
        });
    }

    // ── JSON 헬퍼 ─────────────────────────────────────────────────────────────

    private static JSONArray jarr(List<String> items) {
        JSONArray a = new JSONArray();
        if (items != null) for (String s : items) if (s != null && s.length() > 0) a.put(s);
        return a;
    }

    private static JSONObject json1(String k, String v) {
        JSONObject o = new JSONObject();
        try { o.put(k, v == null ? "" : v); } catch (Throwable ignore) { }
        return o;
    }

    private static JSONObject json2(String k1, String v1, String k2, String v2) {
        JSONObject o = json1(k1, v1);
        try { o.put(k2, v2 == null ? "" : v2); } catch (Throwable ignore) { }
        return o;
    }

    private static void putIf(JSONObject o, String k, String v) {
        if (v == null) return;
        String s = v.trim();
        if (s.length() == 0) return;
        try { o.put(k, s); } catch (Throwable ignore) { }
    }

    private static String enc(String s) {
        try { return URLEncoder.encode(s == null ? "" : s, "UTF-8"); }
        catch (Throwable t) { return ""; }
    }
}
