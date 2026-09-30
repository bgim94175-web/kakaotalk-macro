package com.buseong.kakaoauto.engine;

import android.content.Context;

import com.buseong.kakaoauto.Prefs;
import com.buseong.kakaoauto.RoomRef;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * 앱의 대화방 참조({@link RoomRef}, 알림에서 배운 "계정 + 방 이름") ↔ 카카오 방 번호(chat_id) 연결표.
 *
 * 연결은 <b>사용자가 확인한 것만</b> 저장한다. 이름이 같다고 자동으로 묶지 않는다 —
 * 이름이 같은 방이 여럿일 수 있고, 엉뚱한 방으로 사진이 나가면 되돌릴 수 없다.
 * {@link #suggest} 가 이름 일치 후보를 내고, 화면이 한 번 확인받은 뒤 {@link #put} 한다.
 * 카카오 방 목록에서 직접 고른 방은 그 자체가 확인이다 (알림이 한 번도 안 온 방도 대상으로 쓸 수 있다).
 *
 * 방 이름이 들어 있어서 설정과 같은 봉인 저장소(Prefs.secPut, 라이선스 설정키)를 쓴다.
 */
public final class RoomLinks {
    private RoomLinks() {}

    private static final String SLOT_LINKS = "kakao_links";
    private static final String SLOT_ROOMS = "kakao_rooms";

    static String linksKey(Context c) {
        String id = com.buseong.kakaoauto.KakaoSlots.selectedId(c);
        if (id == null || id.length() == 0) return SLOT_LINKS;
        return SLOT_LINKS + "." + id;
    }

    static String roomsKey(Context c) {
        String id = com.buseong.kakaoauto.KakaoSlots.selectedId(c);
        if (id == null || id.length() == 0) return SLOT_ROOMS;
        return SLOT_ROOMS + "." + id;
    }

    /** 계정을 바꾸면 메모리 목록을 버린다. */
    public static void invalidate() {
        synchronized (LOCK) {
            cache = null;
            cacheSlot = null;
        }
    }

    /** 첫 계정의 예전 방 연결을 그 슬롯으로 옮긴다. 옛 키는 지우지 않는다. */
    public static void adoptLegacy(Context c, String slotId) {
        if (c == null || slotId == null || slotId.length() == 0) return;
        copyIfEmpty(c, SLOT_LINKS, SLOT_LINKS + "." + slotId);
        copyIfEmpty(c, SLOT_ROOMS, SLOT_ROOMS + "." + slotId);
    }

    public static void dropSlot(Context c, String slotId) {
        if (c == null || slotId == null || slotId.length() == 0) return;
        Prefs.secRemove(c, SLOT_LINKS + "." + slotId);
        Prefs.secRemove(c, SLOT_ROOMS + "." + slotId);
    }

    private static void copyIfEmpty(Context c, String from, String to) {
        String have = Prefs.secGet(c, to);
        if (have != null && have.length() > 0) return;
        String old = Prefs.secGet(c, from);
        if (old != null && old.length() > 0) Prefs.secPut(c, to, old);
    }

    /** 연결 1건 */
    public static final class Link {
        public final String roomKey;
        public final String chatId;
        public final String kakaoName;
        public final String kind;
        public final long confirmedAt;

        Link(String roomKey, String chatId, String kakaoName, String kind, long confirmedAt) {
            this.roomKey = roomKey;
            this.chatId = chatId;
            this.kakaoName = kakaoName == null ? "" : kakaoName;
            this.kind = kind == null ? "" : kind;
            this.confirmedAt = confirmedAt;
        }
    }

    /** 이름 일치 제안 1건 */
    public static final class Suggestion {
        public final RoomRef ref;
        /** 이름이 정확히 같은 카카오 방 (0개면 후보 없음, 2개 이상이면 사용자가 골라야 한다) */
        public final List<KakaoEngine.KakaoRoom> candidates;

        Suggestion(RoomRef ref, List<KakaoEngine.KakaoRoom> candidates) {
            this.ref = ref;
            this.candidates = candidates;
        }

        public boolean unique() { return candidates.size() == 1; }
    }

    private static final Object LOCK = new Object();
    private static Map<String, Link> cache;
    private static String cacheSlot;

    public static Link get(Context c, RoomRef ref) {
        if (c == null || ref == null || !ref.valid()) return null;
        return all(c).get(ref.key());
    }

    public static String chatIdFor(Context c, RoomRef ref) {
        Link l = get(c, ref);
        return (l == null) ? null : l.chatId;
    }

    /** 선택 계정과 다른 슬롯의 연결표. 화면 캐시는 바꾸지 않는다. */
    static Map<String, Link> linksFor(Context c, String slotId) {
        LinkedHashMap<String, Link> m = new LinkedHashMap<String, Link>();
        if (c == null || slotId == null || slotId.length() == 0) return m;
        String key = SLOT_LINKS + "." + slotId;
        String raw = Prefs.secGet(c, key);
        if ((raw == null || raw.length() == 0) && "main".equals(slotId)) raw = Prefs.secGet(c, SLOT_LINKS);
        if (raw == null) return m;
        try {
            JSONObject o = new JSONObject(raw);
            Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                JSONObject v = o.getJSONObject(k);
                m.put(k, new Link(k, v.optString("id"), v.optString("n"), v.optString("k"), v.optLong("at")));
            }
        } catch (Throwable ignore) { }
        return m;
    }

    public static Map<String, Link> all(Context c) {
        synchronized (LOCK) {
            String slot = linksKey(c);
            if (cache == null || !slot.equals(cacheSlot)) {
                cache = read(c);
                cacheSlot = slot;
            }
            return new LinkedHashMap<String, Link>(cache);
        }
    }

    /** 사용자가 확인한 연결을 저장한다. 저장소가 잠겨 있으면(라이선스 인증 전) false */
    public static boolean put(Context c, RoomRef ref, KakaoEngine.KakaoRoom room) {
        if (c == null || ref == null || !ref.valid() || room == null || room.chatId.length() == 0) return false;
        if (!Prefs.secReady(c)) return false;
        synchronized (LOCK) {
            Map<String, Link> m = read(c);
            m.put(ref.key(), new Link(ref.key(), room.chatId, room.name(), room.kind, System.currentTimeMillis()));
            write(c, m);
            cache = m;
            cacheSlot = linksKey(c);
        }
        return true;
    }

    public static void remove(Context c, RoomRef ref) {
        if (c == null || ref == null) return;
        synchronized (LOCK) {
            Map<String, Link> m = read(c);
            if (m.remove(ref.key()) == null) return;
            write(c, m);
            cache = m;
            cacheSlot = linksKey(c);
        }
    }

    /** 지금 고른 계정의 연결표와 방 목록만 비운다. */
    static void clearAll(Context c) {
        synchronized (LOCK) {
            Prefs.secRemove(c, linksKey(c));
            Prefs.secRemove(c, roomsKey(c));
            cache = new LinkedHashMap<String, Link>();
            cacheSlot = linksKey(c);
        }
    }

    /** 그 chat_id 에 연결된 방 참조 (없으면 null) */
    public static RoomRef refFor(Context c, String chatId) {
        if (chatId == null) return null;
        for (Link l : all(c).values()) {
            if (chatId.equals(l.chatId)) return RoomRef.parse(l.roomKey);
        }
        return null;
    }

    /**
     * 아직 연결 안 된 방마다 이름이 정확히 같은 카카오 방을 찾는다 (공백·대소문자만 무시).
     * 이미 연결된 방은 건너뛴다.
     */
    public static List<Suggestion> suggest(Context c, List<RoomRef> refs, List<KakaoEngine.KakaoRoom> rooms) {
        ArrayList<Suggestion> out = new ArrayList<Suggestion>();
        if (refs == null || rooms == null) return out;
        Map<String, Link> have = all(c);
        for (int i = 0; i < refs.size(); i++) {
            RoomRef r = refs.get(i);
            if (r == null || !r.valid() || have.containsKey(r.key())) continue;
            String want = norm(r.name);
            ArrayList<KakaoEngine.KakaoRoom> cand = new ArrayList<KakaoEngine.KakaoRoom>();
            for (int j = 0; j < rooms.size(); j++) {
                KakaoEngine.KakaoRoom k = rooms.get(j);
                if (want.equals(norm(k.name())) || (k.displayName.length() > 0 && want.equals(norm(k.displayName)))) {
                    cand.add(k);
                }
            }
            out.add(new Suggestion(r, cand));
        }
        return out;
    }

    static String norm(String s) {
        if (s == null) return "";
        return s.trim().replaceAll("\\s+", " ").toLowerCase(Locale.ROOT);
    }

    // ── 카카오 방 목록 캐시 ────────────────────────────────────────────────

    static void saveRooms(Context c, List<KakaoEngine.KakaoRoom> rooms) {
        if (!Prefs.secReady(c)) return;
        JSONArray a = new JSONArray();
        try {
            for (int i = 0; i < rooms.size(); i++) {
                KakaoEngine.KakaoRoom r = rooms.get(i);
                JSONObject o = new JSONObject();
                o.put("id", r.chatId);
                o.put("k", r.kind);
                o.put("t", r.title);
                o.put("d", r.displayName);
                o.put("n", r.members);
                o.put("at", r.lastAt);
                o.put("ty", r.chatType);
                o.put("lk", r.listKind);
                a.put(o);
            }
        } catch (Throwable t) {
            return;
        }
        Prefs.secPut(c, roomsKey(c), a.toString());
    }

    static List<KakaoEngine.KakaoRoom> cachedRooms(Context c) {
        ArrayList<KakaoEngine.KakaoRoom> out = new ArrayList<KakaoEngine.KakaoRoom>();
        String raw = Prefs.secGet(c, roomsKey(c));
        if ((raw == null || raw.length() == 0) && !SLOT_ROOMS.equals(roomsKey(c))) raw = Prefs.secGet(c, SLOT_ROOMS);
        if (raw == null) return out;
        try {
            JSONArray a = new JSONArray(raw);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.getJSONObject(i);
                out.add(new KakaoEngine.KakaoRoom(o.optString("id"), o.optString("k"), o.optString("t"),
                        o.optString("d"), o.optInt("n"), o.optLong("at"),
                        o.optString("ty", ""), o.optString("lk", "")));
            }
        } catch (Throwable ignore) { }
        return out;
    }

    // ── 저장 ────────────────────────────────────────────────────────────────

    private static Map<String, Link> read(Context c) {
        LinkedHashMap<String, Link> m = new LinkedHashMap<String, Link>();
        String key = (c == null) ? SLOT_LINKS : linksKey(c);
        String raw = (c == null) ? null : Prefs.secGet(c, key);
        if ((raw == null || raw.length() == 0) && c != null && !SLOT_LINKS.equals(key)) raw = Prefs.secGet(c, SLOT_LINKS);
        if (raw == null) return m;
        try {
            JSONObject o = new JSONObject(raw);
            Iterator<String> it = o.keys();
            while (it.hasNext()) {
                String k = it.next();
                JSONObject v = o.getJSONObject(k);
                m.put(k, new Link(k, v.optString("id"), v.optString("n"), v.optString("k"), v.optLong("at")));
            }
        } catch (Throwable ignore) { }
        return m;
    }

    private static void write(Context c, Map<String, Link> m) {
        JSONObject o = new JSONObject();
        try {
            for (Link l : m.values()) {
                JSONObject v = new JSONObject();
                v.put("id", l.chatId);
                v.put("n", l.kakaoName);
                v.put("k", l.kind);
                v.put("at", l.confirmedAt);
                o.put(l.roomKey, v);
            }
        } catch (Throwable t) {
            return;
        }
        Prefs.secPut(c, linksKey(c), o.toString());
    }
}
