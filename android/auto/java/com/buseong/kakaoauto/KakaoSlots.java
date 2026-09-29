package com.buseong.kakaoauto;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * 한 라이선스에 등록한 카카오 계정 목록.
 *
 * 알림으로 계정을 찾지 않는다. 고객이 아이디와 비밀번호로 등록한 계정만 들어온다.
 * 계정마다 방, 매크로, 이미지, 쿨타임, 자동응답, 경쟁사 저격, 켜짐 상태가 따로 있다.
 * 상시 발송 서버의 행 키는 {@link Slot#senderKey} 다. 첫 계정은 기기 ID 그대로라
 * 예전 한 계정 세션을 덮어쓰지 않고, 추가 계정은 {@code 기기ID.슬롯} 이다.
 */
public final class KakaoSlots {
    private KakaoSlots() {}

    public static final int MAX = 8;

    private static final String K_LIST = "kk_slots";
    private static final String K_SEL = "kk_sel";

    /** 등록이 끝나기 전의 슬롯. 목록에는 아직 없다. */
    private static Slot writing;

    public static final class Slot {
        public final String id;
        /** 상시 발송 서버 kakao_sessions.device_id */
        public final String senderKey;
        public final String hint;
        public final String userId;
        public final String deviceUuid;

        Slot(String id, String senderKey, String hint, String userId, String deviceUuid) {
            this.id = id == null ? "" : id;
            this.senderKey = senderKey == null ? "" : senderKey;
            this.hint = hint == null ? "" : hint;
            this.userId = userId == null ? "" : userId;
            this.deviceUuid = deviceUuid == null ? "" : deviceUuid;
        }
    }

    public static List<Slot> all(Context c) {
        ensure(c);
        return read(c);
    }

    public static int count(Context c) {
        return all(c).size();
    }

    public static Slot selected(Context c) {
        ensure(c);
        String id = Prefs.getStr(c, K_SEL, "");
        List<Slot> list = read(c);
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).id.equals(id)) return list.get(i);
        }
        return list.isEmpty() ? null : list.get(0);
    }

    public static String selectedId(Context c) {
        Slot s = selected(c);
        return s == null ? "" : s.id;
    }

    public static Slot byId(Context c, String id) {
        if (id == null) return null;
        List<Slot> list = all(c);
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).id.equals(id)) return list.get(i);
        }
        return null;
    }

    public static Slot bySenderKey(Context c, String key) {
        if (key == null) return null;
        List<Slot> list = all(c);
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).senderKey.equals(key)) return list.get(i);
        }
        return null;
    }

    /** 새 계정 등록을 시작한다. 성공하기 전에는 목록에 넣지 않는다. */
    public static Slot armNew(Context c) {
        ensure(c);
        if (count(c) >= MAX) return null;
        String device = Device.deviceId(c);
        boolean bare = bySenderKey(c, device) != null;
        String id = bare ? ("a" + Crypto.randomHex(4)) : "main";
        String key = bare ? (device + "." + id) : device;
        writing = new Slot(id, key, "", "", "");
        return writing;
    }

    /** 이미 있는 계정을 다시 로그인한다. */
    public static Slot arm(Context c, String id) {
        Slot s = byId(c, id);
        writing = s;
        return s;
    }

    public static String writingId() {
        return writing == null ? "" : writing.id;
    }

    public static String armedUuid() {
        return writing == null ? "" : writing.deviceUuid;
    }

    public static void abandon() {
        writing = null;
    }

    /**
     * 로그인이 끝난 슬롯을 목록에 넣고 선택한다.
     * 다른 슬롯에 같은 카카오 사용자 번호가 있으면 false.
     */
    public static boolean commit(Context c, String id, String hint, String userId, String deviceUuid) {
        if (c == null || id == null || id.length() == 0) return false;
        ensure(c);
        List<Slot> list = read(c);
        String uid = userId == null ? "" : userId.trim();
        for (int i = 0; i < list.size(); i++) {
            Slot s = list.get(i);
            if (s.id.equals(id)) continue;
            if (uid.length() > 0 && uid.equals(s.userId)) return false;
        }
        Slot base = writing != null && writing.id.equals(id) ? writing : byId(c, id);
        if (base == null) return false;
        Slot next = new Slot(id, base.senderKey, hint == null ? "" : hint, uid,
                deviceUuid == null ? "" : deviceUuid);
        boolean found = false;
        for (int i = 0; i < list.size(); i++) {
            if (list.get(i).id.equals(id)) {
                list.set(i, next);
                found = true;
                break;
            }
        }
        if (!found) {
            if (list.size() >= MAX) return false;
            list.add(next);
        }
        write(c, list);
        Prefs.putStr(c, K_SEL, id);
        writing = null;
        if ("main".equals(id) || Device.deviceId(c).equals(next.senderKey)) {
            Settings.adoptLegacy(c, id);
            com.buseong.kakaoauto.engine.RoomLinks.adoptLegacy(c, id);
        }
        Settings.invalidate();
        com.buseong.kakaoauto.engine.RoomLinks.invalidate();
        return true;
    }

    public static void select(Context c, String id) {
        if (byId(c, id) == null) return;
        Prefs.putStr(c, K_SEL, id);
        Settings.invalidate();
        com.buseong.kakaoauto.engine.RoomLinks.invalidate();
        try { com.buseong.kakaoauto.engine.Engine.releaseLocalSession(c); } catch (Throwable ignore) { }
    }

    /** 선택한 계정만 지운다. 다른 계정의 설정과 서버 세션은 남긴다. */
    public static Slot removeSelected(Context c) {
        Slot s = selected(c);
        if (s == null) return null;
        List<Slot> list = read(c);
        ArrayList<Slot> next = new ArrayList<Slot>();
        for (int i = 0; i < list.size(); i++) {
            if (!list.get(i).id.equals(s.id)) next.add(list.get(i));
        }
        write(c, next);
        Settings.dropSlot(c, s.id);
        com.buseong.kakaoauto.engine.RoomLinks.dropSlot(c, s.id);
        if (next.isEmpty()) {
            Prefs.remove(c, K_SEL);
            KakaoAccount.clear(c);
        } else {
            Prefs.putStr(c, K_SEL, next.get(0).id);
        }
        Settings.invalidate();
        com.buseong.kakaoauto.engine.RoomLinks.invalidate();
        try { com.buseong.kakaoauto.engine.Engine.releaseLocalSession(c); } catch (Throwable ignore) { }
        return s;
    }

    public static void clearAll(Context c) {
        if (c == null) return;
        List<Slot> list = read(c);
        for (int i = 0; i < list.size(); i++) {
            Settings.dropSlot(c, list.get(i).id);
            com.buseong.kakaoauto.engine.RoomLinks.dropSlot(c, list.get(i).id);
        }
        Prefs.remove(c, K_LIST);
        Prefs.remove(c, K_SEL);
        writing = null;
        Settings.invalidate();
        com.buseong.kakaoauto.engine.RoomLinks.invalidate();
    }

    private static void ensure(Context c) {
        if (c == null) return;
        if (Prefs.getStr(c, K_LIST, null) != null) return;
        boolean legacy = Prefs.getBool(c, "kakao_reg_ok", false);
        String tok = Prefs.getStr(c, "kk_tok", "");
        if (!legacy && (tok == null || tok.length() == 0)) {
            Prefs.putStr(c, K_LIST, "[]");
            return;
        }
        String hint = Prefs.getStr(c, "kk_hint", "");
        if (hint == null || hint.length() == 0) hint = Prefs.getStr(c, "kakao_reg_id", "");
        Slot main = new Slot("main", Device.deviceId(c), hint == null ? "" : hint,
                Prefs.getStr(c, "kk_user", ""), Prefs.getStr(c, "kk_duuid", ""));
        ArrayList<Slot> list = new ArrayList<Slot>();
        list.add(main);
        write(c, list);
        Prefs.putStr(c, K_SEL, "main");
        com.buseong.kakaoauto.engine.Engine.adoptLegacyTokens(c, "main");
    }

    private static List<Slot> read(Context c) {
        ArrayList<Slot> out = new ArrayList<Slot>();
        String raw = Prefs.getStr(c, K_LIST, "");
        if (raw == null || raw.length() == 0) return out;
        try {
            JSONArray a = new JSONArray(raw);
            for (int i = 0; i < a.length(); i++) {
                JSONObject o = a.optJSONObject(i);
                if (o == null) continue;
                String id = o.optString("id", "");
                String key = o.optString("key", "");
                if (id.length() == 0 || key.length() == 0) continue;
                out.add(new Slot(id, key, o.optString("hint", ""), o.optString("uid", ""), o.optString("du", "")));
            }
        } catch (Throwable ignore) { }
        return out;
    }

    private static void write(Context c, List<Slot> list) {
        JSONArray a = new JSONArray();
        try {
            for (int i = 0; i < list.size(); i++) {
                Slot s = list.get(i);
                JSONObject o = new JSONObject();
                o.put("id", s.id);
                o.put("key", s.senderKey);
                o.put("hint", s.hint);
                o.put("uid", s.userId);
                o.put("du", s.deviceUuid);
                a.put(o);
            }
        } catch (Throwable ignore) { }
        Prefs.putStr(c, K_LIST, a.toString());
    }
}
