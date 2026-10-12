package com.buseong.kakaoauto;

import android.content.Context;
import android.service.notification.StatusBarNotification;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 카카오톡 계정(듀얼 메신저) 레지스트리.
 *
 * 한 폰에 카톡이 여러 개 깔린 경우(삼성 듀얼 메신저, 직장 프로필)를 계정 단위로 구분한다.
 * 구분 근거는 알림의 {@code StatusBarNotification.getUser()} — 같은 패키지라도 프로필이 다르면
 * UserHandle 이 다르다. 그 hashCode 를 문자열로 만든 게 계정키다 (직렬화 가능해야 하니까).
 *
 * 저장은 <b>평문 Prefs JSON</b>. 계정 이름은 민감값이 아니고(카톡 프로필 이름 수준),
 * 설정을 못 읽는 상황에서도 계정 구분은 돌아가야 한다 — 봉인 저장을 쓰면 그때는 읽지도 못한다.
 *
 * 스레드 안전: 모든 상태 접근은 {@code synchronized (RECS)} 안에서만 한다.
 * Prefs 쓰기가 섞여 있으니 {@link #seen} 은 BG 스레드에서 부른다 (KakaoListener.dispatch).
 *
 * 이름 우선순위: <b>사용자 지정 → 카톡 프로필 이름(selfName) → 순번</b>
 * (순번은 `기본 계정` / `계정 2` / `계정 3` …)
 */
public final class Accounts {
    private Accounts() {}

    /** 기본 계정(폰 주 사용자 프로필) 키. 구버전 저장값은 전부 이 계정이다. */
    public static final String DEFAULT = RoomRef.DEFAULT_ACC;

    /** 기억할 계정 최대 개수 (넘치면 오래 못 본 계정부터 버린다) */
    public static final int MAX = 8;

    /** 사용자 지정 이름 최대 길이 */
    public static final int NAME_MAX = 20;

    private static final String K_ACC = "K_ACCOUNTS";

    /** 같은 계정 알림이 쏟아질 때 Prefs 를 다시 쓰는 최소 간격 (ms) */
    private static final long SAVE_MS = 60000L;

    /** 화면에 뿌리는 계정 한 건 (불변) */
    public static final class Acc {
        /** 계정키 */
        public final String key;
        /** 표시 이름 (우선순위 적용 결과) */
        public final String name;
        /** 카톡이 알림에 넣어준 내 프로필 이름. 못 읽었으면 "" */
        public final String selfName;
        /** 이 계정 알림을 마지막으로 본 시각 (epoch ms). 0 이면 아직 없음 */
        public final long lastAt;
        /** 사용자가 이름을 직접 지정했나 */
        public final boolean custom;

        Acc(String key, String name, String selfName, long lastAt, boolean custom) {
            this.key = key;
            this.name = name;
            this.selfName = selfName;
            this.lastAt = lastAt;
            this.custom = custom;
        }
    }

    /** 내부 저장 레코드 (가변) */
    private static final class Rec {
        String key;
        /** 사용자 지정 이름 ("" = 지정 안 함) */
        String custom = "";
        /** 카톡 프로필 이름 ("" = 못 읽음) */
        String self = "";
        /** 마지막 감지 시각 (메모리 기준 최신값) */
        long lastAt;
        /** 디스크에 마지막으로 쓴 감지 시각 (Prefs 쓰기 빈도 제한용) */
        long savedAt;
        /** 처음 본 순서 (1 = 기본 계정). 순번 이름에 쓴다 */
        int ord;
    }

    private static final LinkedHashMap<String, Rec> RECS = new LinkedHashMap<String, Rec>();
    private static boolean loaded = false;

    // ── 감지 ──────────────────────────────────────────────────────────────────

    /**
     * 알림이 어느 카톡 계정에서 왔나. 못 읽는 기기는 단일 계정으로 취급한다.
     * UserHandle.hashCode() 는 사용자 ID 라 재부팅해도 값이 유지된다.
     */
    public static String keyOf(StatusBarNotification sbn) {
        if (sbn == null) return DEFAULT;
        try {
            Object u = sbn.getUser();
            if (u == null) return DEFAULT;
            return Integer.toString(u.hashCode());
        } catch (Throwable t) {
            return DEFAULT;   // 기종에 따라 못 읽는다 → 단일 계정
        }
    }

    /**
     * 이 계정 알림을 봤다고 기록한다. 처음 본 계정이면 순번을 매겨 등록한다.
     * Prefs 를 쓰므로 BG 스레드에서 호출한다.
     *
     * @param selfName 카톡이 알림에 넣어준 내 프로필 이름. 없으면 null/"" 을 넘겨도 된다.
     */
    public static void seen(Context c, String accKey, String selfName) {
        if (c == null) return;
        String k = norm(accKey);
        String self = clean(selfName);
        long now = System.currentTimeMillis();
        boolean save;
        synchronized (RECS) {
            load(c);
            Rec r = RECS.get(k);
            if (r == null) {
                r = new Rec();
                r.key = k;
                r.ord = nextOrd(k);
                RECS.put(k, r);
                save = true;
            } else {
                save = false;
            }
            if (self.length() > 0 && !self.equals(r.self)) {
                r.self = self;
                save = true;
            }
            r.lastAt = now;
            if (now - r.savedAt >= SAVE_MS) save = true;
            if (RECS.size() > MAX) trim(k);
            if (!save) return;
            stampSaved();
        }
        save(c);
    }

    // ── 조회 ──────────────────────────────────────────────────────────────────

    /** 감지된 계정 전체. 처음 본 순서(순번)대로 나온다. */
    public static List<Acc> all(Context c) {
        ArrayList<Acc> out = new ArrayList<Acc>();
        synchronized (RECS) {
            load(c);
            Iterator<Map.Entry<String, Rec>> it = RECS.entrySet().iterator();
            while (it.hasNext()) {
                Rec r = it.next().getValue();
                if (r == null) continue;
                out.add(new Acc(r.key, display(r), r.self, r.lastAt, r.custom.length() > 0));
            }
        }
        Collections.sort(out, new Comparator<Acc>() {
            @Override public int compare(Acc a, Acc b) {
                int oa = ord(a.key), ob = ord(b.key);
                if (oa != ob) return (oa < ob) ? -1 : 1;
                return a.key.compareTo(b.key);
            }
        });
        return out;
    }

    /** 그 계정의 표시 이름. 등록되지 않은 키면 기본 계정은 `기본 계정`, 나머지는 `미확인 계정`. */
    public static String nameOf(Context c, String accKey) {
        String k = norm(accKey);
        synchronized (RECS) {
            load(c);
            Rec r = RECS.get(k);
            if (r != null) return display(r);
        }
        return DEFAULT.equals(k) ? ordName(1) : "미확인 계정";
    }

    /** 계정이 2개 이상 감지됐나. 1개면 화면 어디에도 계정 이야기를 꺼내지 않는다. */
    public static boolean multi(Context c) {
        synchronized (RECS) {
            load(c);
            return RECS.size() >= 2;
        }
    }

    /** 감지된 계정 수 */
    public static int count(Context c) {
        synchronized (RECS) {
            load(c);
            return RECS.size();
        }
    }

    /** 등록된 계정인가 */
    public static boolean known(Context c, String accKey) {
        String k = norm(accKey);
        synchronized (RECS) {
            load(c);
            return RECS.containsKey(k);
        }
    }

    // ── 수정 ──────────────────────────────────────────────────────────────────

    /**
     * 계정 이름을 사용자가 직접 지정한다. 빈 값을 넘기면 지정을 해제하고
     * 자동 이름(카톡 프로필 이름 → 순번)으로 되돌린다.
     */
    public static void rename(Context c, String accKey, String name) {
        if (c == null) return;
        String k = norm(accKey);
        String v = clean(name);
        if (v.length() > NAME_MAX) v = v.substring(0, NAME_MAX);
        synchronized (RECS) {
            load(c);
            Rec r = RECS.get(k);
            if (r == null) {
                // 아직 알림을 못 본 계정이라도 이름은 미리 정해둘 수 있다
                r = new Rec();
                r.key = k;
                r.ord = nextOrd(k);
                RECS.put(k, r);
            }
            if (v.equals(r.custom)) return;
            r.custom = v;
        }
        save(c);
    }

    /**
     * 계정 기록을 지운다. 그 계정으로 감지된 대화방·세션도 같이 정리한다
     * (계정을 지우고 방만 남으면 목록에 주인 없는 방이 뜬다).
     */
    public static void forget(Context c, String accKey) {
        if (c == null) return;
        String k = norm(accKey);
        boolean removed;
        synchronized (RECS) {
            load(c);
            removed = (RECS.remove(k) != null);
        }
        if (!removed) return;
        save(c);
        KakaoListener.forgetAccount(c, k);
        Log.add(c, "카카오톡 계정 기록을 삭제했습니다.");
    }

    /** 전체 초기화 (공장초기화용) */
    public static void clear(Context c) {
        synchronized (RECS) {
            RECS.clear();
            loaded = true;
        }
        Prefs.remove(c, K_ACC);
    }

    // ── 이름 규칙 ─────────────────────────────────────────────────────────────

    /** 사용자 지정 → 카톡 프로필 이름 → 순번 */
    private static String display(Rec r) {
        if (r.custom.length() > 0) return r.custom;
        if (r.self.length() > 0) return r.self;
        return ordName(r.ord);
    }

    private static String ordName(int ord) {
        if (ord <= 1) return "기본 계정";
        return "계정 " + ord;
    }

    private static int ord(String key) {
        synchronized (RECS) {
            Rec r = RECS.get(key);
            return (r == null) ? Integer.MAX_VALUE : r.ord;
        }
    }

    /** 다음 순번. 기본 계정은 항상 1번이고, 나머지는 2번부터 붙는다. */
    private static int nextOrd(String key) {
        if (DEFAULT.equals(key)) return 1;
        int max = 1;
        Iterator<Map.Entry<String, Rec>> it = RECS.entrySet().iterator();
        while (it.hasNext()) {
            Rec r = it.next().getValue();
            if (r != null && r.ord > max) max = r.ord;
        }
        return max + 1;
    }

    /** 계정이 너무 쌓이면 오래 못 본 것부터 버린다 (방금 본 계정과 기본 계정은 남긴다) */
    private static void trim(String keep) {
        while (RECS.size() > MAX) {
            String oldest = null;
            long oldestAt = Long.MAX_VALUE;
            Iterator<Map.Entry<String, Rec>> it = RECS.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Rec> e = it.next();
                Rec r = e.getValue();
                if (r == null) { it.remove(); continue; }
                if (e.getKey().equals(keep) || DEFAULT.equals(e.getKey())) continue;
                if (r.lastAt < oldestAt) { oldestAt = r.lastAt; oldest = e.getKey(); }
            }
            if (oldest == null) return;
            RECS.remove(oldest);
        }
    }

    /** 방금 저장한 감지시각을 기록한다 (Prefs 쓰기 간격 제한용). synchronized (RECS) 안에서만. */
    private static void stampSaved() {
        Iterator<Map.Entry<String, Rec>> it = RECS.entrySet().iterator();
        while (it.hasNext()) {
            Rec r = it.next().getValue();
            if (r != null) r.savedAt = r.lastAt;
        }
    }

    // ── 저장 ──────────────────────────────────────────────────────────────────

    /** 호출자가 synchronized (RECS) 안에서만 부른다 */
    private static void load(Context c) {
        if (loaded) return;
        if (c == null) return;          // 컨텍스트가 생기면 다시 시도한다
        loaded = true;
        String raw = Prefs.getStr(c, K_ACC, null);
        if (raw == null || raw.trim().length() == 0) return;
        try {
            JSONObject o = new JSONObject(raw);
            JSONArray arr = o.optJSONArray("a");
            if (arr == null) return;
            for (int i = 0; i < arr.length(); i++) {
                JSONObject j = arr.optJSONObject(i);
                if (j == null) continue;
                String k = norm(j.optString("k", ""));
                if (RECS.containsKey(k)) continue;
                Rec r = new Rec();
                r.key = k;
                r.custom = clean(j.optString("n", ""));
                if (r.custom.length() > NAME_MAX) r.custom = r.custom.substring(0, NAME_MAX);
                r.self = clean(j.optString("s", ""));
                r.lastAt = j.optLong("t", 0L);
                r.savedAt = r.lastAt;
                r.ord = j.optInt("o", 0);
                if (r.ord <= 0) r.ord = nextOrd(k);
                RECS.put(k, r);
            }
        } catch (Throwable t) {
            Log.add(c, "카카오톡 계정 목록을 불러오지 못했습니다: " + t);
        }
    }

    private static void save(Context c) {
        if (c == null) return;
        String out;
        synchronized (RECS) {
            try {
                JSONArray arr = new JSONArray();
                Iterator<Map.Entry<String, Rec>> it = RECS.entrySet().iterator();
                while (it.hasNext()) {
                    Rec r = it.next().getValue();
                    if (r == null) continue;
                    JSONObject j = new JSONObject();
                    j.put("k", r.key);
                    if (r.custom.length() > 0) j.put("n", r.custom);
                    if (r.self.length() > 0) j.put("s", r.self);
                    j.put("t", r.lastAt);
                    j.put("o", r.ord);
                    arr.put(j);
                }
                JSONObject o = new JSONObject();
                o.put("v", 1);
                o.put("a", arr);
                out = o.toString();
            } catch (Throwable t) {
                Log.add(c, "카카오톡 계정 목록을 저장하지 못했습니다: " + t);
                return;
            }
        }
        Prefs.putStr(c, K_ACC, out);
    }

    // ── 문자열 정리 ───────────────────────────────────────────────────────────

    private static String norm(String v) {
        String s = clean(v);
        return (s.length() == 0) ? DEFAULT : s;
    }

    /** 앞뒤 공백 정리 + 제어문자 제거 */
    private static String clean(String v) {
        if (v == null) return "";
        StringBuilder sb = new StringBuilder(v.length());
        for (int i = 0; i < v.length(); i++) {
            char ch = v.charAt(i);
            if (ch >= ' ') sb.append(ch);
        }
        return sb.toString().trim();
    }
}
