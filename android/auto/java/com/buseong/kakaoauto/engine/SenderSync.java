package com.buseong.kakaoauto.engine;

import android.content.Context;
import android.util.Base64;

import com.buseong.kakaoauto.Device;
import com.buseong.kakaoauto.Features;
import com.buseong.kakaoauto.KakaoAccount;
import com.buseong.kakaoauto.License;
import com.buseong.kakaoauto.Log;
import com.buseong.kakaoauto.Prefs;
import com.buseong.kakaoauto.Settings;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 등록이 끝난 카카오 세션과 기능 설정을 상시 발송 프로세스에 넘긴다.
 *
 * 주소는 고객 고급 설정이 아니다. 라이선스 응답의 sender_url 을 쓰고,
 * 그 값이 없을 때만 {@link #FALLBACK_BASE} 를 쓴다. Render 무료 라이선스
 * 서버는 잠들기 때문에 발송 루프는 그 서버에 없다.
 */
public final class SenderSync {
    private SenderSync() {}

    /**
     * 라이선스 응답에 주소가 없을 때의 폴백. 비어 있으면 넘기지 않는다.
     * 고객이 고치는 칸이 아니다.
     */
    public static final String FALLBACK_BASE = "";

    private static final String K_URL = "sender_url";
    private static final String K_TOKEN = "sender_token";
    private static final String K_OWNS = "sender_owns";
    private static final String K_PENDING = "sender_pending";
    private static final String K_REAUTH = "sender_reauth";

    private static final ExecutorService Q = Executors.newSingleThreadExecutor();
    private static final Object LOCK = new Object();
    private static boolean running = false;
    private static boolean again = false;

    public static void noteLicense(Context c, JSONObject o) {
        if (c == null || o == null) return;
        String url = o.optString("sender_url", "");
        if (url != null && (url.startsWith("https://") || url.startsWith("http://"))) {
            Prefs.putStr(c, K_URL, trimSlash(url));
        }
        String tok = o.optString("sender_token", "");
        if (tok != null && tok.length() > 0 && !"null".equals(tok)) Prefs.putStr(c, K_TOKEN, tok);
    }

    public static boolean serverOwns(Context c) {
        return c != null && Prefs.getBool(c, K_OWNS, false);
    }

    public static boolean needsRegister(Context c) {
        return c != null && Prefs.getBool(c, K_REAUTH, false);
    }

    /** 폰의 LOCO 를 열면 서버 세션과 슬롯이 겹친다. 넘기는 중에도 열지 않는다. */
    public static boolean blocksPhoneFeatures(Context c) {
        return serverOwns(c) || (c != null && Prefs.getBool(c, K_PENDING, false));
    }

    public static String base(Context c) {
        String v = (c == null) ? "" : Prefs.getStr(c, K_URL, "");
        if (v == null || v.length() == 0 || "null".equals(v)) v = FALLBACK_BASE;
        return trimSlash(v == null ? "" : v);
    }

    public static boolean hasBase(Context c) {
        String b = base(c);
        return b.startsWith("https://") || b.startsWith("http://");
    }

    public static void onRegistered(Context c) {
        if (c == null) return;
        Prefs.putBool(c, K_PENDING, true);
        Prefs.putBool(c, K_REAUTH, false);
        schedule(c);
    }

    public static void onSettingsSaved(Context c) {
        if (c == null || !KakaoAccount.ready(c)) return;
        schedule(c);
    }

    public static void onUnlink(Context c) {
        if (c == null) return;
        final Context app = c.getApplicationContext();
        Prefs.putBool(app, K_OWNS, false);
        Prefs.putBool(app, K_PENDING, false);
        Prefs.putBool(app, K_REAUTH, false);
        Q.execute(new Runnable() {
            @Override public void run() {
                try {
                    if (!hasBase(app)) return;
                    JSONObject body = new JSONObject();
                    body.put("device_id", Device.deviceId(app));
                    post(app, "/v1/unlink", body, 20000);
                } catch (Throwable t) {
                    Log.add(app, "상시 발송 등록 해제 알림에 실패했습니다. (" + t + ")");
                }
            }
        });
    }

    public static void refreshStatus(final Context c) {
        if (c == null || !KakaoAccount.ready(c) || !hasBase(c)) return;
        Q.execute(new Runnable() {
            @Override public void run() {
                try {
                    String url = base(c) + "/v1/status?device_id=" + enc(Device.deviceId(c));
                    HttpResult r = open(c, "GET", url, null, 20000);
                    if (r.code != 200 || r.body == null) return;
                    JSONObject o = new JSONObject(r.body);
                    if (!o.optBoolean("ok", false)) return;
                    if (o.optBoolean("needs_register", false)) applyReauth(c, o.optString("reason", "reauth"));
                    else if (o.optBoolean("linked", false)) {
                        Prefs.putBool(c, K_OWNS, true);
                        Prefs.putBool(c, K_PENDING, false);
                        Prefs.putBool(c, K_REAUTH, false);
                    }
                } catch (Throwable ignore) { }
            }
        });
    }

    public static void awaitHandoff(Context c, long timeoutMs) {
        long until = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < until) {
            if (serverOwns(c) || !Prefs.getBool(c, K_PENDING, false)) return;
            try { Thread.sleep(200L); } catch (InterruptedException e) { return; }
        }
    }

    public static List<KakaoEngine.KakaoRoom> fetchRooms(Context c) throws EngineException {
        HttpResult r = open(c, "GET", base(c) + "/v1/chats?device_id=" + enc(Device.deviceId(c)), null, 90000);
        JSONObject o = readOk(r);
        if (o.optBoolean("needs_register", false)) {
            applyReauth(c, o.optString("reason", "reauth"));
            throw new EngineException("reauth_required", "카카오 로그인이 끊겼습니다. 계정을 다시 등록하십시오.");
        }
        JSONArray a = o.optJSONArray("chats");
        ArrayList<KakaoEngine.KakaoRoom> out = new ArrayList<KakaoEngine.KakaoRoom>();
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            JSONObject one = a.optJSONObject(i);
            if (one == null) continue;
            out.add(new KakaoEngine.KakaoRoom(
                    one.optString("chat_id"),
                    one.optString("kind"),
                    one.isNull("title") ? "" : one.optString("title"),
                    one.isNull("display_name") ? "" : one.optString("display_name"),
                    one.optInt("members"),
                    toMillis(one.optLong("last_at"))));
        }
        RoomLinks.saveRooms(c, out);
        return out;
    }

    public static KakaoEngine.SendResult sendText(Context c, String chatId, String text) throws EngineException {
        JSONObject body = new JSONObject();
        try {
            body.put("device_id", Device.deviceId(c));
            body.put("chat_id", chatId);
            body.put("text", text);
        } catch (Throwable t) {
            throw new EngineException("bad_request", String.valueOf(t));
        }
        JSONObject o = readOk(post(c, "/v1/send", body, 30000));
        if (o.optBoolean("needs_register", false)) {
            applyReauth(c, o.optString("reason", "reauth"));
            throw new EngineException("reauth_required", "카카오 로그인이 끊겼습니다. 계정을 다시 등록하십시오.");
        }
        String id = o.optString("log_id", "");
        if (!NodeEngine.isMessageId(id)) throw new EngineException("undelivered", "missing log_id");
        return new KakaoEngine.SendResult(o.optString("kind", "text"), id, System.currentTimeMillis());
    }

    public static KakaoEngine.SendResult sendImages(Context c, String chatId, List<File> files) throws EngineException {
        JSONObject body = new JSONObject();
        try {
            body.put("device_id", Device.deviceId(c));
            body.put("chat_id", chatId);
            JSONArray images = new JSONArray();
            if (files != null) {
                for (int i = 0; i < files.size() && i < 5; i++) images.put(b64(files.get(i)));
            }
            body.put("images", images);
        } catch (Throwable t) {
            throw new EngineException("bad_request", String.valueOf(t));
        }
        JSONObject o = readOk(post(c, "/v1/send-images", body, 120000));
        if (o.optBoolean("needs_register", false)) {
            applyReauth(c, o.optString("reason", "reauth"));
            throw new EngineException("reauth_required", "카카오 로그인이 끊겼습니다. 계정을 다시 등록하십시오.");
        }
        String id = o.optString("log_id", "");
        if (!NodeEngine.isMessageId(id)) throw new EngineException("undelivered", "missing log_id");
        return new KakaoEngine.SendResult(o.optString("kind"), id, System.currentTimeMillis());
    }

    private static void schedule(Context c) {
        final Context app = c.getApplicationContext();
        synchronized (LOCK) {
            if (running) { again = true; return; }
            running = true;
        }
        Q.execute(new Runnable() {
            @Override public void run() {
                try {
                    boolean more;
                    do {
                        synchronized (LOCK) { again = false; }
                        pushOnce(app);
                        synchronized (LOCK) { more = again; }
                    } while (more);
                } finally {
                    boolean restart = false;
                    synchronized (LOCK) {
                        running = false;
                        if (again) restart = true;
                    }
                    if (restart) schedule(app);
                }
            }
        });
    }

    private static void pushOnce(Context c) {
        if (!KakaoAccount.ready(c) || !TokenVault.linked(c)) {
            Prefs.putBool(c, K_PENDING, false);
            return;
        }
        if (!hasBase(c)) {
            Prefs.putBool(c, K_PENDING, false);
            Prefs.putBool(c, K_OWNS, false);
            Log.add(c, "상시 발송 서버 주소가 없습니다. 폰을 끄면 발송이 멈춥니다.");
            return;
        }
        String tok = Prefs.getStr(c, K_TOKEN, "");
        if (tok == null || tok.length() == 0) {
            Prefs.putBool(c, K_PENDING, false);
            Log.add(c, "상시 발송 서버 인증값이 없습니다. 라이선스 확인 후 다시 시도합니다.");
            return;
        }
        try {
            JSONObject creds = TokenVault.load(c);
            if (creds == null) {
                Prefs.putBool(c, K_PENDING, false);
                return;
            }
            creds.remove("password");
            creds.remove("passcode");
            boolean owns = serverOwns(c);
            JSONObject body = payload(c, creds, !owns);
            String path = owns ? "/v1/config" : "/v1/session";
            if (owns) body.remove("credentials");
            HttpResult r = post(c, path, body, 60000);
            JSONObject o = new JSONObject(r.body == null ? "{}" : r.body);
            if (r.code == 200 && o.optBoolean("ok", false) && !o.optBoolean("needs_register", false)) {
                Prefs.putBool(c, K_OWNS, true);
                Prefs.putBool(c, K_PENDING, false);
                Prefs.putBool(c, K_REAUTH, false);
                Engine.releaseLocalSession(c);
                Log.add(c, owns
                        ? "설정을 상시 발송 서버에 반영했습니다."
                        : "카카오 세션을 상시 발송 서버에 넘겼습니다. 폰을 꺼도 발송이 계속됩니다.");
                return;
            }
            if (o.optBoolean("needs_register", false) || "reauth".equals(o.optString("error", ""))) {
                applyReauth(c, o.optString("reason", o.optString("error", "reauth")));
                return;
            }
            Prefs.putBool(c, K_PENDING, false);
            Prefs.putBool(c, K_OWNS, false);
            Log.add(c, "상시 발송 서버에 세션을 넘기지 못했습니다. 폰이 켜져 있는 동안만 발송합니다. ("
                    + r.code + " " + clip(o.optString("error", "")) + ")");
        } catch (Throwable t) {
            Prefs.putBool(c, K_PENDING, false);
            Prefs.putBool(c, K_OWNS, false);
            Log.add(c, "상시 발송 서버에 연결하지 못했습니다. 폰이 켜져 있는 동안만 발송합니다. (" + t + ")");
        }
    }

    private static JSONObject payload(Context c, JSONObject creds, boolean withCreds) throws Exception {
        JSONObject body = new JSONObject();
        body.put("device_id", Device.deviceId(c));
        if (withCreds) body.put("credentials", creds);
        Settings s = Settings.load(c);
        body.put("config", new JSONObject(s.toJson()));
        JSONObject features = new JSONObject();
        features.put("macro", License.allowed(c, Features.MACRO));
        features.put("roombot", License.allowed(c, Features.ROOMBOT));
        features.put("minigame", License.allowed(c, Features.MINIGAME));
        body.put("features", features);
        JSONArray rooms = new JSONArray();
        Map<String, RoomLinks.Link> links = RoomLinks.all(c);
        for (RoomLinks.Link l : links.values()) {
            if (l == null) continue;
            JSONObject one = new JSONObject();
            one.put("key", l.roomKey);
            one.put("chat_id", l.chatId);
            one.put("name", l.kakaoName);
            one.put("kind", l.kind);
            rooms.put(one);
        }
        body.put("rooms", rooms);
        body.put("images", imagePayload(c, s));
        return body;
    }

    private static JSONArray imagePayload(Context c, Settings s) {
        JSONArray out = new JSONArray();
        if (s == null || s.macro == null || s.macro.images == null || s.macro.images.isEmpty()) return out;
        List<File> files = null;
        try {
            files = ImagePrep.prepare(c, s.macro.images);
            for (int i = 0; i < files.size(); i++) out.put(b64(files.get(i)));
        } catch (Throwable t) {
            Log.add(c, "첨부 이미지를 상시 발송 서버에 넣지 못했습니다. (" + t + ")");
        } finally {
            ImagePrep.cleanup(files);
        }
        return out;
    }

    private static void applyReauth(Context c, String reason) {
        Prefs.putBool(c, K_OWNS, false);
        Prefs.putBool(c, K_PENDING, false);
        Prefs.putBool(c, K_REAUTH, true);
        TokenVault.setFlag(c, TokenVault.FLAG_REAUTH);
        Log.add(c, "카카오 로그인이 끊겼습니다. 계정을 다시 등록하십시오."
                + ((reason == null || reason.length() == 0) ? "" : " (" + reason + ")"));
    }

    private static JSONObject readOk(HttpResult r) throws EngineException {
        if (r == null || r.err != null) throw new EngineException("network", r == null ? "no response" : r.err);
        JSONObject o;
        try {
            o = new JSONObject(r.body == null ? "{}" : r.body);
        } catch (Throwable t) {
            throw new EngineException("bad_response", "상시 발송 서버 응답을 읽지 못했습니다.");
        }
        if (r.code == 409 || o.optBoolean("needs_register", false)) return o;
        if (r.code != 200 || !o.optBoolean("ok", false)) {
            throw new EngineException("sender", o.optString("error", "HTTP " + r.code));
        }
        return o;
    }

    private static HttpResult post(Context c, String path, JSONObject body, int readMs) {
        return open(c, "POST", base(c) + path, body.toString(), readMs);
    }

    private static HttpResult open(Context c, String method, String url, String json, int readMs) {
        HttpResult out = new HttpResult();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(url).openConnection();
            conn.setConnectTimeout(20000);
            conn.setReadTimeout(readMs);
            conn.setRequestMethod(method);
            String tok = Prefs.getStr(c, K_TOKEN, "");
            if (tok != null && tok.length() > 0) conn.setRequestProperty("x-sender-token", tok);
            if (json != null) {
                conn.setDoOutput(true);
                byte[] bytes = json.getBytes(StandardCharsets.UTF_8);
                conn.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                conn.setFixedLengthStreamingMode(bytes.length);
                OutputStream os = conn.getOutputStream();
                os.write(bytes);
                os.close();
            }
            out.code = conn.getResponseCode();
            InputStream in = (out.code >= 400) ? conn.getErrorStream() : conn.getInputStream();
            out.body = read(in);
        } catch (Throwable t) {
            out.err = String.valueOf(t);
        } finally {
            if (conn != null) conn.disconnect();
        }
        return out;
    }

    private static String b64(File f) throws Exception {
        FileInputStream in = new FileInputStream(f);
        try {
            return Base64.encodeToString(readBytes(in), Base64.NO_WRAP);
        } finally {
            in.close();
        }
    }

    private static byte[] readBytes(InputStream in) throws Exception {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) >= 0) bos.write(buf, 0, n);
        return bos.toByteArray();
    }

    private static String read(InputStream in) throws Exception {
        if (in == null) return "";
        try {
            return new String(readBytes(in), StandardCharsets.UTF_8);
        } finally {
            in.close();
        }
    }

    private static long toMillis(long v) {
        if (v <= 0) return 0L;
        return (v < 100000000000L) ? v * 1000L : v;
    }

    private static String trimSlash(String s) {
        if (s == null) return "";
        String t = s.trim();
        while (t.endsWith("/")) t = t.substring(0, t.length() - 1);
        return t;
    }

    private static String enc(String s) {
        try {
            return java.net.URLEncoder.encode(s == null ? "" : s, "UTF-8");
        } catch (Throwable t) {
            return "";
        }
    }

    private static String clip(String s) {
        if (s == null) return "";
        return s.length() > 180 ? s.substring(0, 180) : s;
    }

    private static final class HttpResult {
        int code;
        String body;
        String err;
    }
}
