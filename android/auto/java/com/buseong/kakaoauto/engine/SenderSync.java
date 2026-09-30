package com.buseong.kakaoauto.engine;

import android.content.Context;
import android.util.Base64;

import com.buseong.kakaoauto.Device;
import com.buseong.kakaoauto.Features;
import com.buseong.kakaoauto.KakaoAccount;
import com.buseong.kakaoauto.KakaoSlots;
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
    private static final String K_STATE = "sender_accounts";

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
        return c != null && owns(c, senderKey(c));
    }

    public static boolean needsRegister(Context c) {
        return c != null && reauthReason(c, senderKey(c)) != null;
    }

    public static boolean needsRegister(Context c, String senderKey) {
        return c != null && senderKey != null && reauthReason(c, senderKey) != null;
    }

    /** 지금 고른 계정의 폰 LOCO 를 열면 그 계정의 서버 세션과 슬롯이 겹친다. */
    public static boolean blocksPhoneFeatures(Context c) {
        if (c == null) return false;
        String key = senderKey(c);
        return owns(c, key) || key.equals(pendingKey(c));
    }

    static String senderKey(Context c) {
        KakaoSlots.Slot s = KakaoSlots.selected(c);
        if (s != null && s.senderKey.length() > 0) return s.senderKey;
        return Device.deviceId(c);
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
        String key = senderKey(c);
        setPending(c, key);
        setReauth(c, key, null);
        schedule(c);
    }

    public static void onSettingsSaved(Context c) {
        if (c == null || !KakaoAccount.ready(c)) return;
        setPending(c, senderKey(c));
        schedule(c);
    }

    public static void onUnlink(Context c) {
        unlinkKey(c, senderKey(c));
    }

    public static void unlinkKey(Context c, final String key) {
        if (c == null || key == null || key.length() == 0) return;
        final Context app = c.getApplicationContext();
        setOwns(app, key, false);
        setReauth(app, key, null);
        if (key.equals(pendingKey(app))) setPending(app, "");
        Q.execute(new Runnable() {
            @Override public void run() {
                try {
                    if (!hasBase(app)) return;
                    JSONObject body = new JSONObject();
                    body.put("device_id", key);
                    post(app, "/v1/unlink", body, 20000);
                } catch (Throwable t) {
                    Log.add(app, "상시 발송 등록 해제 알림에 실패했습니다. (" + t + ")");
                }
            }
        });
    }

    public static void unlinkAll(Context c) {
        if (c == null) return;
        java.util.List<KakaoSlots.Slot> slots = KakaoSlots.all(c);
        for (int i = 0; i < slots.size(); i++) unlinkKey(c, slots.get(i).senderKey);
    }

    public static void refreshStatus(final Context c) {
        if (c == null || !KakaoAccount.ready(c) || !hasBase(c)) return;
        Q.execute(new Runnable() {
            @Override public void run() {
                java.util.List<KakaoSlots.Slot> slots = KakaoSlots.all(c);
                for (int i = 0; i < slots.size(); i++) {
                    String key = slots.get(i).senderKey;
                    try {
                        String url = base(c) + "/v1/status?device_id=" + enc(key);
                        HttpResult r = open(c, "GET", url, null, 20000);
                        if (r.code != 200 || r.body == null) continue;
                        JSONObject o = new JSONObject(r.body);
                        if (!o.optBoolean("ok", false)) continue;
                        if (o.optBoolean("needs_register", false)) applyReauth(c, key, o.optString("reason", "reauth"));
                        else if (o.optBoolean("linked", false)) {
                            setOwns(c, key, true);
                            setReauth(c, key, null);
                            if (key.equals(pendingKey(c))) setPending(c, "");
                        }
                        noteGuard(c, key, o.optJSONArray("notices"));
                    } catch (Throwable ignore) { }
                }
            }
        });
    }

    /** 상시 발송이 남긴 방 관리봇 알림을 활동 로그에 한 번씩 옮긴다. */
    private static void noteGuard(Context c, String key, org.json.JSONArray notes) {
        if (c == null || key == null || notes == null) return;
        String slot = "guard_seen." + key;
        long seen = Prefs.getLong(c, slot, 0L);
        long max = seen;
        for (int i = 0; i < notes.length(); i++) {
            org.json.JSONObject one = notes.optJSONObject(i);
            if (one == null) continue;
            long at = one.optLong("at", 0L);
            String text = one.optString("text", "").trim();
            if (at <= seen || text.length() == 0) continue;
            Log.add(c, text);
            if (at > max) max = at;
        }
        if (max > seen) Prefs.putLong(c, slot, max);
    }

    public static void awaitHandoff(Context c, long timeoutMs) {
        long until = System.currentTimeMillis() + timeoutMs;
        String key = senderKey(c);
        while (System.currentTimeMillis() < until) {
            if (owns(c, key) || !key.equals(pendingKey(c))) return;
            try { Thread.sleep(200L); } catch (InterruptedException e) { return; }
        }
    }

    public static List<KakaoEngine.KakaoRoom> fetchRooms(Context c) throws EngineException {
        HttpResult r = open(c, "GET", base(c) + "/v1/chats?device_id=" + enc(senderKey(c)), null, 90000);
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
                    toMillis(one.optLong("last_at")),
                    NodeEngine.wireType(one),
                    one.optString("list_kind", "")));
        }
        RoomLinks.saveRooms(c, out);
        return out;
    }

    public static KakaoEngine.SendResult sendText(Context c, String chatId, String text) throws EngineException {
        JSONObject body = new JSONObject();
        try {
            body.put("device_id", senderKey(c));
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

    /** 상시 발송 세션의 최근 글. 보내기 전에 메시지 번호를 확인하고, 알림 답장 뒤에 다시 읽는다. */
    public static List<KakaoEngine.Inbound> recent(Context c, String chatId) throws EngineException {
        HttpResult r = open(c, "GET", base(c) + "/v1/recent?device_id=" + enc(senderKey(c))
                + "&chat_id=" + enc(chatId), null, 30000);
        JSONObject o = readOk(r);
        if (o.optBoolean("needs_register", false)) {
            applyReauth(c, o.optString("reason", "reauth"));
            throw new EngineException("reauth_required", "카카오 로그인이 끊겼습니다. 계정을 다시 등록하십시오.");
        }
        JSONArray a = o.optJSONArray("messages");
        ArrayList<KakaoEngine.Inbound> out = new ArrayList<KakaoEngine.Inbound>();
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            JSONObject one = a.optJSONObject(i);
            if (one == null) continue;
            String id = one.optString("log_id", "");
            if (!NodeEngine.isMessageId(id)) continue;
            out.add(new KakaoEngine.Inbound(id, "", one.optString("message", ""),
                    one.optBoolean("mine"), toMillis(one.optLong("sent_at"))));
        }
        return out;
    }

    public static KakaoEngine.SendResult sendImages(Context c, String chatId, List<File> files) throws EngineException {
        JSONObject body = new JSONObject();
        try {
            body.put("device_id", senderKey(c));
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
        String key = pendingKey(c);
        KakaoSlots.Slot slot = key.length() == 0 ? KakaoSlots.selected(c) : KakaoSlots.bySenderKey(c, key);
        if (slot == null) slot = KakaoSlots.selected(c);
        if (slot == null || !TokenVault.linked(c, slot.id)) {
            if (key.length() > 0) setPending(c, "");
            return;
        }
        key = slot.senderKey;
        if (!hasBase(c)) {
            setPending(c, "");
            setOwns(c, key, false);
            Log.add(c, "상시 발송 서버 주소가 없습니다. 폰을 끄면 발송이 멈춥니다.");
            return;
        }
        String tok = Prefs.getStr(c, K_TOKEN, "");
        if (tok == null || tok.length() == 0) {
            setPending(c, "");
            Log.add(c, "상시 발송 서버 인증값이 없습니다. 라이선스 확인 후 다시 시도합니다.");
            return;
        }
        try {
            JSONObject creds = TokenVault.load(c, slot.id);
            if (creds == null) {
                setPending(c, "");
                return;
            }
            creds.remove("password");
            creds.remove("passcode");
            boolean already = owns(c, key);
            JSONObject body = payload(c, slot, creds, !already);
            String path = already ? "/v1/config" : "/v1/session";
            if (already) body.remove("credentials");
            HttpResult r = post(c, path, body, 60000);
            JSONObject o = new JSONObject(r.body == null ? "{}" : r.body);
            if (r.code == 200 && o.optBoolean("ok", false) && !o.optBoolean("needs_register", false)) {
                setOwns(c, key, true);
                setReauth(c, key, null);
                if (key.equals(pendingKey(c))) setPending(c, "");
                if (key.equals(senderKey(c))) Engine.releaseLocalSession(c);
                Log.add(c, already
                        ? "설정을 상시 발송 서버에 반영했습니다."
                        : "카카오 세션을 상시 발송 서버에 넘겼습니다. 폰을 꺼도 발송이 계속됩니다.");
                return;
            }
            if (o.optBoolean("needs_register", false) || "reauth".equals(o.optString("error", ""))) {
                applyReauth(c, key, o.optString("reason", o.optString("error", "reauth")));
                return;
            }
            if (key.equals(pendingKey(c))) setPending(c, "");
            setOwns(c, key, false);
            Log.add(c, "상시 발송 서버에 세션을 넘기지 못했습니다. 폰이 켜져 있는 동안만 발송합니다. ("
                    + r.code + " " + clip(o.optString("error", "")) + ")");
        } catch (Throwable t) {
            if (key.equals(pendingKey(c))) setPending(c, "");
            setOwns(c, key, false);
            Log.add(c, "상시 발송 서버에 연결하지 못했습니다. 폰이 켜져 있는 동안만 발송합니다. (" + t + ")");
        }
    }

    private static JSONObject payload(Context c, KakaoSlots.Slot slot, JSONObject creds, boolean withCreds) throws Exception {
        JSONObject body = new JSONObject();
        body.put("device_id", slot.senderKey);
        if (withCreds) body.put("credentials", creds);
        Settings s = Settings.readSlot(c, slot.id);
        body.put("config", new JSONObject(s.toJson()));
        JSONObject features = new JSONObject();
        features.put("macro", License.allowed(c, Features.MACRO));
        features.put("roombot", License.allowed(c, Features.ROOMBOT));
        features.put("minigame", License.allowed(c, Features.MINIGAME));
        body.put("features", features);
        JSONArray rooms = new JSONArray();
        Map<String, RoomLinks.Link> links = linksOf(c, slot);
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

    private static Map<String, RoomLinks.Link> linksOf(Context c, KakaoSlots.Slot slot) {
        if (slot != null && slot.id.equals(KakaoSlots.selectedId(c))) return RoomLinks.all(c);
        return RoomLinks.linksFor(c, slot == null ? "" : slot.id);
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
        applyReauth(c, senderKey(c), reason);
    }

    private static void applyReauth(Context c, String key, String reason) {
        setOwns(c, key, false);
        setReauth(c, key, (reason == null || reason.length() == 0) ? "reauth" : reason);
        if (key.equals(pendingKey(c))) setPending(c, "");
        KakaoSlots.Slot slot = KakaoSlots.bySenderKey(c, key);
        if (slot != null) TokenVault.setFlag(c, slot.id, TokenVault.FLAG_REAUTH);
        String who = (slot == null || slot.hint.length() == 0) ? "" : (" (" + slot.hint + ")");
        Log.add(c, "카카오 로그인이 끊겼습니다. 그 계정을 다시 등록하십시오." + who
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

    private static JSONObject loadState(Context c) {
        String raw = Prefs.getStr(c, K_STATE, "");
        JSONObject o = null;
        if (raw != null && raw.length() > 0) {
            try { o = new JSONObject(raw); } catch (Throwable ignore) { o = null; }
        }
        if (o == null) {
            o = new JSONObject();
            try {
                o.put("owns", new JSONObject());
                o.put("reauth", new JSONObject());
                o.put("pending", "");
                if (Prefs.getBool(c, K_OWNS, false)) o.getJSONObject("owns").put(Device.deviceId(c), true);
                if (Prefs.getBool(c, K_REAUTH, false)) o.getJSONObject("reauth").put(Device.deviceId(c), "reauth");
                if (Prefs.getBool(c, K_PENDING, false)) o.put("pending", Device.deviceId(c));
            } catch (Throwable ignore) { }
        }
        if (o.optJSONObject("owns") == null) try { o.put("owns", new JSONObject()); } catch (Throwable ignore) { }
        if (o.optJSONObject("reauth") == null) try { o.put("reauth", new JSONObject()); } catch (Throwable ignore) { }
        return o;
    }

    private static void saveState(Context c, JSONObject o) {
        Prefs.putStr(c, K_STATE, o.toString());
    }

    private static boolean owns(Context c, String key) {
        if (c == null || key == null || key.length() == 0) return false;
        JSONObject owns = loadState(c).optJSONObject("owns");
        return owns != null && owns.optBoolean(key, false);
    }

    private static void setOwns(Context c, String key, boolean on) {
        if (c == null || key == null || key.length() == 0) return;
        JSONObject o = loadState(c);
        try {
            JSONObject owns = o.getJSONObject("owns");
            if (on) owns.put(key, true);
            else owns.remove(key);
            saveState(c, o);
        } catch (Throwable ignore) { }
    }

    private static String reauthReason(Context c, String key) {
        if (c == null || key == null || key.length() == 0) return null;
        JSONObject re = loadState(c).optJSONObject("reauth");
        if (re == null || !re.has(key) || re.isNull(key)) return null;
        return re.optString(key, "reauth");
    }

    private static void setReauth(Context c, String key, String reason) {
        if (c == null || key == null || key.length() == 0) return;
        JSONObject o = loadState(c);
        try {
            JSONObject re = o.getJSONObject("reauth");
            if (reason == null || reason.length() == 0) re.remove(key);
            else re.put(key, reason);
            saveState(c, o);
        } catch (Throwable ignore) { }
    }

    private static String pendingKey(Context c) {
        if (c == null) return "";
        String v = loadState(c).optString("pending", "");
        return v == null ? "" : v;
    }

    private static void setPending(Context c, String key) {
        if (c == null) return;
        JSONObject o = loadState(c);
        try {
            o.put("pending", key == null ? "" : key);
            saveState(c, o);
        } catch (Throwable ignore) { }
    }

    private static final class HttpResult {
        int code;
        String body;
        String err;
    }
}
