package com.buseong.kakaoauto.engine;

import android.content.Context;
import android.os.Looper;

import com.buseong.kakaoauto.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/** {@link KakaoEngine} 구현: {@link NodeHost} 위에서 엔진 스크립트(android/engine/src/main.mjs)를 부른다. */
final class NodeEngine implements KakaoEngine {

    private static final long T_QUICK = 15000L;
    private static final long T_LOGIN = 45000L;
    private static final long T_CONFIRM = 120000L;
    private static final long T_ROOMS = 90000L;
    private static final long T_ACTIVITY = 30000L;
    private static final long T_RECENT = 30000L;
    private static final long T_TEXT = 30000L;
    private static final long T_IMAGES = 240000L;
    /** 엔진 쪽 LOCO 세션을 쉬게 두는 시간. 매크로 주기(기본 20~40분)보다 길게 잡아 세션을 재사용한다 */
    private static final long IDLE_MS = 50 * 60 * 1000L;

    private final Context app;
    private final NodeHost host;
    private final CopyOnWriteArrayList<Listener> listeners = new CopyOnWriteArrayList<Listener>();
    private final Object sessionLock = new Object();
    private int sessionGen = -1;
    private volatile String lastError = "";

    NodeEngine(Context app) {
        this.app = app;
        this.host = new NodeHost(app, new NodeHost.Events() {
            @Override public void onEvent(String name, JSONObject d) { handleEvent(name, d); }
            @Override public void onExit(int generation) { notifyStatus(); }
        });
    }

    NodeHost host() {
        return host;
    }

    // ── 상태 ────────────────────────────────────────────────────────────────

    @Override public Status status() {
        Link link;
        if (!NodeHost.packaged(app)) link = Link.UNAVAILABLE;
        else if (!TokenVault.linked(app)) link = Link.NONE;
        else if (TokenVault.FLAG_KICKED.equals(TokenVault.flag(app))) link = Link.KICKED;
        else if (TokenVault.FLAG_REAUTH.equals(TokenVault.flag(app))) link = Link.REAUTH;
        else link = Link.READY;
        JSONObject ri = host.readyInfo();
        String runtime = (ri == null) ? "" : ("Node " + ri.optString("node") + " · " + ri.optString("lib"));
        return new Status(link, TokenVault.userId(app), TokenVault.hint(app), TokenVault.linkedAt(app),
                runtime, lastError);
    }

    @Override public void addListener(Listener l) { if (l != null) listeners.addIfAbsent(l); }

    @Override public void removeListener(Listener l) { listeners.remove(l); }

    private void notifyStatus() {
        Status s = status();
        for (Listener l : listeners) {
            try { l.onStatus(s); } catch (Throwable ignore) { }
        }
    }

    private void handleEvent(String name, JSONObject d) {
        if ("credentials".equals(name)) {
            // 엔진이 토큰을 갱신했다 → 바로 봉인해 둔다 (안 하면 다음 실행에서 만료된 토큰을 들고 간다)
            JSONObject cur = TokenVault.load(app);
            if (cur != null) {
                try {
                    cur.put("access_token", d.optString("access_token", cur.optString("access_token")));
                    cur.put("refresh_token", d.optString("refresh_token", cur.optString("refresh_token")));
                    TokenVault.save(app, cur);
                } catch (Throwable t) {
                    android.util.Log.w("KakaoEngine", "token update failed", t);
                }
            }
            return;
        }
        if ("session".equals(name) && "kicked".equals(d.optString("type"))) {
            TokenVault.setFlag(app, TokenVault.FLAG_KICKED);
            lastError = "다른 기기가 같은 로그인 슬롯을 사용하여 연결이 해제되었습니다.";
            Log.add(app, "카카오 연결이 해제되었습니다. 다른 기기가 같은 로그인 슬롯(태블릿)으로 로그인했습니다."
                    + " 카카오 계정 연결 화면에서 다시 연결하십시오.");
            notifyStatus();
        }
    }

    // ── 로그인 ──────────────────────────────────────────────────────────────

    @Override public LoginStep beginLogin(String account, String password, boolean forceSlot) throws EngineException {
        return beginLogin(account, password, forceSlot, null);
    }

    @Override public LoginStep beginLogin(String account, String password, boolean forceSlot, String deviceUuid)
            throws EngineException {
        offMain();
        if (account == null || account.trim().length() == 0 || password == null || password.length() == 0) {
            throw new EngineException("bad_request", "카카오 계정과 비밀번호를 입력하십시오.");
        }
        JSONObject p = new JSONObject();
        try {
            p.put("email", account.trim());
            p.put("password", password);
            p.put("forced", forceSlot);
            p.put("device_type", "tablet");
            // deviceUuid is ignored. auth.begin always mints a new device.
        } catch (Throwable t) {
            throw new EngineException("bad_request", String.valueOf(t));
        }
        JSONObject r = rpc("auth.begin", p, T_LOGIN);
        return loginStep(r, account);
    }

    @Override public LoginStep awaitPhoneConfirm(String pendingId) throws EngineException {
        offMain();
        JSONObject p = new JSONObject();
        try { p.put("pending_id", pendingId); } catch (Throwable ignore) { }
        return loginStep(rpc("auth.confirm", p, T_CONFIRM), pendingAccount);
    }

    @Override public void cancelLogin(final String pendingId) {
        pendingAccount = null;
        if (pendingId == null || pendingId.length() == 0 || !host.alive()) return;
        new Thread(new Runnable() {
            @Override public void run() {
                try {
                    JSONObject p = new JSONObject();
                    p.put("pending_id", pendingId);
                    host.call("auth.cancel", p, T_QUICK);
                } catch (Throwable ignore) { }
            }
        }, "engine-cancel").start();
    }

    /** 확인 코드 단계 사이에 계정 표기를 들고 있는다 (비밀번호는 엔진 메모리에만 있다) */
    private volatile String pendingAccount;

    private LoginStep loginStep(JSONObject r, String account) throws EngineException {
        String st = r.optString("state", "failed");
        String msg = r.optString("message", "");
        switch (st) {
            case "ok": {
                JSONObject creds = r.optJSONObject("credentials");
                if (creds == null) throw new EngineException("upstream_error", "로그인 응답에 토큰이 없습니다.");
                String slot = com.buseong.kakaoauto.KakaoSlots.writingId();
                if (slot.length() == 0) slot = com.buseong.kakaoauto.KakaoSlots.selectedId(app);
                String hint = TokenVault.mask(account);
                if (!TokenVault.save(app, slot, creds)) {
                    throw new EngineException("upstream_error", "이 기기의 보안 키저장소를 사용할 수 없어 로그인을 보관하지 못했습니다.");
                }
                boolean kept = com.buseong.kakaoauto.KakaoSlots.commit(app, slot, hint,
                        creds.optString("user_id", ""), creds.optString("device_uuid", ""));
                if (!kept) {
                    TokenVault.clear(app, slot);
                    com.buseong.kakaoauto.KakaoSlots.abandon();
                    return new LoginStep(LoginStep.Kind.FAILED, null, null, -1,
                            "이 카카오 계정은 이미 등록되어 있습니다.", statusOf(r));
                }
                TokenVault.markLinked(app, slot, hint);
                pendingAccount = null;
                synchronized (sessionLock) { sessionGen = -1; }
                lastError = "";
                Log.add(app, "카카오 계정을 연결했습니다. (" + hint + ")");
                EngineService.sync(app);
                notifyStatus();
                return new LoginStep(LoginStep.Kind.OK, null, null, -1, "");
            }
            case "confirm_on_phone":
                pendingAccount = account;
                return new LoginStep(LoginStep.Kind.CONFIRM_ON_PHONE, r.optString("pending_id"),
                        r.optString("passcode"), r.isNull("remaining_seconds") ? -1 : r.optInt("remaining_seconds", -1), msg);
            case "waiting":
                return new LoginStep(LoginStep.Kind.WAITING, null, null, -1, msg);
            case "bad_credentials":
                return failedStep(LoginStep.Kind.BAD_CREDENTIALS, msg, r);
            case "slot_occupied":
                return failedStep(LoginStep.Kind.SLOT_OCCUPIED, msg, r);
            case "expired":
                pendingAccount = null;
                return failedStep(LoginStep.Kind.EXPIRED, msg, r);
            default:
                pendingAccount = null;
                String code = r.optString("code", "");
                return failedStep(LoginStep.Kind.FAILED, (msg.length() > 0) ? msg : code, r);
        }
    }

    private static LoginStep failedStep(LoginStep.Kind kind, String msg, JSONObject r) {
        return new LoginStep(kind, null, null, -1, msg, statusOf(r),
                r == null ? "" : r.optString("device_name", ""),
                r == null ? "" : r.optString("device_model", ""));
    }

    /** failBody 의 status, 없으면 server_status. 0 은 성공이라 빠진 값을 0 으로 읽지 않는다. */
    private static int statusOf(JSONObject r) {
        if (r == null) return Integer.MIN_VALUE;
        if (r.has("status") && !r.isNull("status")) return r.optInt("status", Integer.MIN_VALUE);
        if (r.has("server_status") && !r.isNull("server_status")) {
            return r.optInt("server_status", Integer.MIN_VALUE);
        }
        return Integer.MIN_VALUE;
    }

    @Override public void unlink() {
        if (host.alive()) {
            new Thread(new Runnable() {
                @Override public void run() {
                    try { host.call("session.close", new JSONObject(), T_QUICK); } catch (Throwable ignore) { }
                }
            }, "engine-unlink").start();
        }
        com.buseong.kakaoauto.KakaoSlots.Slot gone = com.buseong.kakaoauto.KakaoSlots.selected(app);
        if (gone != null) TokenVault.clear(app, gone.id);
        RoomLinks.clearAll(app);
        try {
            if (gone != null) SenderSync.unlinkKey(app, gone.senderKey);
            else SenderSync.onUnlink(app);
        } catch (Throwable ignore) { }
        com.buseong.kakaoauto.KakaoSlots.removeSelected(app);
        synchronized (sessionLock) { sessionGen = -1; }
        lastError = "";
        EngineService.sync(app);
        Log.add(app, "선택한 카카오 계정만 해제했습니다. 다른 계정은 그대로입니다.");
        notifyStatus();
    }

    void wipe() {
        try { SenderSync.unlinkAll(app); } catch (Throwable ignore) { }
        TokenVault.wipe(app);
        com.buseong.kakaoauto.KakaoSlots.clearAll(app);
        host.stop();
    }

    // ── 조회·발송 ───────────────────────────────────────────────────────────

    @Override public List<KakaoRoom> rooms(boolean refresh) throws EngineException {
        if (!refresh) return RoomLinks.cachedRooms(app);
        offMain();
        if (SenderSync.blocksPhoneFeatures(app)) {
            SenderSync.awaitHandoff(app, 20000L);
            if (SenderSync.serverOwns(app)) return SenderSync.fetchRooms(app);
            if (SenderSync.blocksPhoneFeatures(app)) {
                throw new EngineException("sender_pending", "상시 발송 서버에 세션을 넘기는 중입니다.");
            }
        }
        JSONObject r = session("chats.list", new JSONObject(), T_ROOMS);
        JSONArray a = r.optJSONArray("chats");
        ArrayList<KakaoRoom> out = new ArrayList<KakaoRoom>();
        if (a != null) {
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                out.add(new KakaoRoom(o.optString("chat_id"), o.optString("kind"),
                        o.isNull("title") ? "" : o.optString("title"),
                        o.isNull("display_name") ? "" : o.optString("display_name"),
                        o.optInt("members"), toMillis(o.optLong("last_at")),
                        wireType(o), o.optString("list_kind", "")));
            }
        }
        RoomLinks.saveRooms(app, out);
        return out;
    }

    @Override public SendResult sendImages(String chatId, List<File> images) throws EngineException {
        offMain();
        if (images == null || images.isEmpty() || images.size() > 5) {
            throw new EngineException("bad_request", "이미지는 1~5장이어야 합니다.");
        }
        if (SenderSync.serverOwns(app)) return SenderSync.sendImages(app, chatId, images);
        JSONObject p = new JSONObject();
        try {
            p.put("chat_id", chatId);
            JSONArray paths = new JSONArray();
            for (int i = 0; i < images.size(); i++) paths.put(images.get(i).getAbsolutePath());
            p.put("paths", paths);
        } catch (Throwable t) {
            throw new EngineException("bad_request", String.valueOf(t));
        }
        return sendResult(session("send.images", p, T_IMAGES));
    }

    @Override public SendResult sendText(String chatId, String text) throws EngineException {
        offMain();
        if (SenderSync.serverOwns(app)) return SenderSync.sendText(app, chatId, text);
        JSONObject p = new JSONObject();
        try {
            p.put("chat_id", chatId);
            p.put("text", text);
        } catch (Throwable t) {
            throw new EngineException("bad_request", String.valueOf(t));
        }
        return sendResult(session("send.text", p, T_TEXT));
    }

    @Override public java.util.List<Inbound> recent(String chatId, String sinceLogId) throws EngineException {
        offMain();
        JSONObject p = new JSONObject();
        try {
            p.put("chat_id", chatId);
            if (sinceLogId != null && sinceLogId.length() > 0) p.put("since_log_id", sinceLogId);
            p.put("count", 20);
        } catch (Throwable ignore) { }
        JSONObject r = session("chat.recent", p, T_RECENT);
        ArrayList<Inbound> out = new ArrayList<Inbound>();
        JSONArray a = r.optJSONArray("messages");
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            JSONObject o = a.optJSONObject(i);
            if (o == null) continue;
            String id = o.optString("log_id", "");
            if (!isMessageId(id)) continue;
            out.add(new Inbound(id, o.optString("author_name", ""), o.optString("message", ""),
                    o.optBoolean("mine"), toMillis(o.optLong("sent_at"))));
        }
        return out;
    }

    @Override public ChatActivity activity(String chatId) throws EngineException {
        offMain();
        JSONObject p = new JSONObject();
        try {
            p.put("chat_id", chatId);
            p.put("count", 30);
        } catch (Throwable ignore) { }
        JSONObject r = session("chat.activity", p, T_ACTIVITY);
        return new ChatActivity(r.optInt("others_since_mine"), r.optBoolean("mine_in_window"),
                toMillis(r.optLong("last_mine_at")));
    }

    /**
     * 카카오 메시지 번호. 양의 십진수만 인정한다.
     * {@code "0"} · 빈 값 · 숫자가 아닌 값은 전달이 아니다
     * (라이브러리가 없는 logId 를 {@code "0"} 으로 바꾸고 success 를 세우는 경우가 있다).
     */
    static boolean isMessageId(String id) {
        if (id == null || id.length() == 0 || id.charAt(0) == '0') return false;
        for (int i = 0; i < id.length(); i++) {
            char c = id.charAt(i);
            if (c < '0' || c > '9') return false;
        }
        return true;
    }

    private static String messageId(JSONObject r) {
        if (r == null || !r.has("log_id") || r.isNull("log_id")) return "";
        Object raw = r.opt("log_id");
        String s;
        if (raw instanceof Number) {
            if (raw instanceof Double || raw instanceof Float) {
                double d = ((Number) raw).doubleValue();
                if (!Double.isFinite(d) || d <= 0 || d != Math.rint(d) || d > Long.MAX_VALUE) return "";
                s = Long.toString((long) d);
            } else {
                long n = ((Number) raw).longValue();
                if (n <= 0) return "";
                s = Long.toString(n);
            }
        } else {
            s = String.valueOf(raw).trim();
        }
        return isMessageId(s) ? s : "";
    }

    private static SendResult sendResult(JSONObject r) throws EngineException {
        String logId = messageId(r);
        if (!isMessageId(logId)) {
            throw new EngineException("undelivered", "missing log_id");
        }
        return new SendResult(r.optString("kind"), logId, toMillis(r.optLong("sent_at")));
    }

    /** 카카오는 초 단위를 준다 */
    private static long toMillis(long v) {
        if (v <= 0) return 0L;
        return (v < 100000000000L) ? v * 1000L : v;
    }

    /** type 은 숫자일 수도 문자일 수도 있다. optString 은 숫자를 문자열로 바꾼다. */
    static String wireType(JSONObject o) {
        if (o == null || !o.has("type") || o.isNull("type")) return "";
        return o.optString("type", "");
    }

    // ── 내부 ────────────────────────────────────────────────────────────────

    /** 엔진 세션이 필요한 호출. 프로세스가 새로 떴으면 봉인된 토큰으로 세션부터 연다. */
    private JSONObject session(String method, JSONObject p, long timeout) throws EngineException {
        if (SenderSync.blocksPhoneFeatures(app)) {
            throw new EngineException("sender_owned", "이 계정은 상시 발송 서버에서 동작합니다.");
        }
        String flag = TokenVault.flag(app);
        if (TokenVault.FLAG_KICKED.equals(flag)) throw new EngineException("kicked", "슬롯 빼앗김");
        if (TokenVault.FLAG_REAUTH.equals(flag)) throw new EngineException("reauth_required", "재로그인 필요");
        openSessionIfNeeded();
        try {
            return rpc(method, p, timeout);
        } catch (EngineException e) {
            if ("not_linked".equals(e.code)) {
                // 엔진이 재시작돼 세션 정보를 잃었다 → 한 번만 다시 연다
                synchronized (sessionLock) { sessionGen = -1; }
                openSessionIfNeeded();
                return rpc(method, p, timeout);
            }
            throw e;
        }
    }

    private void openSessionIfNeeded() throws EngineException {
        int gen = host.ensureStarted();
        synchronized (sessionLock) {
            if (sessionGen == gen) return;
            JSONObject creds = TokenVault.load(app);
            if (creds == null) {
                throw new EngineException("not_linked", TokenVault.linked(app)
                        ? "저장된 로그인을 열 수 없습니다. 카카오 계정을 다시 연결하십시오." : "연결 안 됨");
            }
            JSONObject p = new JSONObject();
            try {
                p.put("credentials", creds);
                p.put("idle_ms", IDLE_MS);
                p.put("connect", false);
            } catch (Throwable ignore) { }
            rpc("session.open", p, T_QUICK);
            sessionGen = gen;
        }
    }

    private JSONObject rpc(String method, JSONObject p, long timeout) throws EngineException {
        try {
            JSONObject r = host.call(method, p, timeout);
            if (lastError.length() > 0 && !method.startsWith("auth.")) lastError = "";
            return r;
        } catch (EngineException e) {
            if ("reauth_required".equals(e.code)) {
                TokenVault.setFlag(app, TokenVault.FLAG_REAUTH);
                Log.add(app, "저장된 카카오 로그인이 만료되었습니다. 카카오 계정 연결 화면에서 다시 연결하십시오.");
                notifyStatus();
            } else if ("kicked".equals(e.code)) {
                TokenVault.setFlag(app, TokenVault.FLAG_KICKED);
                notifyStatus();
            }
            lastError = e.userText();
            throw e;
        }
    }

    private static void offMain() throws EngineException {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            throw new EngineException("main_thread", "메인 스레드에서 엔진을 호출했습니다.");
        }
    }
}
