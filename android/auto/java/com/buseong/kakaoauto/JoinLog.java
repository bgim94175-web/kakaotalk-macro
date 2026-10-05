package com.buseong.kakaoauto;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * 입·퇴장 기록 — 누가 언제 들어오고 나갔는지 사람별로 남긴다.
 *
 * <h3>왜 필요한가</h3>
 * 들낙 명단은 "몇 번" 만 보여준다. 방장이 실제로 판단하려면 <b>언제</b> 들어오고 나갔는지
 * 시각이 보여야 한다 — 10분 사이에 네 번인지, 하루에 걸쳐 네 번인지는 전혀 다른 얘기다.
 *
 * <h3>이름이 유일한 단서다</h3>
 * 카카오톡 입·퇴장 안내는 시스템 문구다. 그 알림에는 들어온 사람의 {@code Person} 객체가
 * 없고(발신자는 그 사람이 아니다) 오픈프로필 링크도 없다. 즉 알림만으로 얻을 수 있는
 * 식별 정보는 <b>이름 문자열뿐</b>이다. 그래서 이름을 바꾸면 집계가 끊긴다.
 *
 * 이 기록이 그 한계를 메우는 현실적인 수단이다 — 이름이 바뀌어도 시각이 남아 있으면
 * 방장이 "나간 직후 다른 이름으로 들어왔다" 를 눈으로 짚을 수 있다.
 *
 * <h3>시각은 한국시간으로 고정한다</h3>
 * 기기 표준시를 따르면 PC 에뮬레이터(기본이 UTC 인 경우가 많다)에서 9시간 어긋난 시각이
 * 찍힌다. 들낙 판정은 "몇 분 사이" 를 보는 일이라 시각이 어긋나면 기록이 쓸모없어진다.
 * 그래서 표시는 항상 서울 기준이다. 계산은 벽시계 밀리초로 하므로 표준시와 무관하다.
 *
 * <h3>저장</h3>
 * 암호화하지 않은 Prefs 에 JSON 한 줄로 둔다. 설정(암호화)에 넣으면 라이선스 인증이
 * 풀렸을 때 읽히지 않는데, 이 기록은 그때도 방장이 봐야 한다. 사람 이름이 들어가므로
 * 기기 안에만 두고 {@link #MAX} 건 · {@link #TTL_MS} 기간으로 제한한다.
 */
public final class JoinLog {

    private JoinLog() {}

    /** 들어옴 */
    public static final int JOIN = 1;
    /** 나감 */
    public static final int LEAVE = 2;

    /** 보관할 최대 건수 (넘으면 오래된 것부터 버린다) */
    public static final int MAX = 800;
    /** 보관 기간 */
    public static final long TTL_MS = 7L * 24 * 3600 * 1000L;

    private static final String K = "roombot_joinlog";

    /** 한 건 */
    public static final class Entry {
        /** 대화방 ({@code RoomRef.key()}) */
        public final String roomKey;
        /** 입·퇴장 안내에서 뽑은 이름 (못 뽑았으면 "") */
        public final String who;
        /** {@link #JOIN} 또는 {@link #LEAVE} */
        public final int kind;
        /** 발생 시각 (epoch ms) */
        public final long at;

        Entry(String roomKey, String who, int kind, long at) {
            this.roomKey = roomKey;
            this.who = who;
            this.kind = kind;
            this.at = at;
        }

        public boolean join() { return kind == JOIN; }
    }

    private static final ArrayList<Entry> ROWS = new ArrayList<Entry>();
    private static boolean loaded = false;

    // ── 한국시간 ────────────────────────────────────────────────────────────

    private static final TimeZone SEOUL = TimeZone.getTimeZone("Asia/Seoul");

    /** "10/05 14:32:07" — 항상 한국시간 */
    public static String kst(long at) {
        if (at <= 0) return "-";
        SimpleDateFormat f = new SimpleDateFormat("MM/dd HH:mm:ss", Locale.KOREA);
        f.setTimeZone(SEOUL);
        return f.format(new Date(at));
    }

    /** "14:32:07" — 항상 한국시간 (같은 날 안에서 비교할 때) */
    public static String kstTime(long at) {
        if (at <= 0) return "-";
        SimpleDateFormat f = new SimpleDateFormat("HH:mm:ss", Locale.KOREA);
        f.setTimeZone(SEOUL);
        return f.format(new Date(at));
    }

    /** 기기 표준시가 한국이 아닌가 (화면에 알려 혼동을 막는다) */
    public static boolean deviceNotKst() {
        try {
            long now = System.currentTimeMillis();
            return TimeZone.getDefault().getOffset(now) != SEOUL.getOffset(now);
        } catch (Throwable t) {
            return false;
        }
    }

    // ── 기록 ────────────────────────────────────────────────────────────────

    /**
     * 한 건 남긴다. 이름을 못 뽑았어도 남긴다 — 그 사실 자체가 단서다
     * (카카오톡 문구 형식이 바뀌었는지 방장이 확인할 수 있다).
     */
    public static void add(Context c, RoomRef room, String who, int kind, long at) {
        if (c == null || room == null) return;
        String rk = room.key();
        if (rk == null || rk.length() == 0) return;
        String w = (who == null) ? "" : who.trim();
        synchronized (JoinLog.class) {
            load(c);
            ROWS.add(new Entry(rk, w, (kind == LEAVE) ? LEAVE : JOIN,
                    (at > 0) ? at : System.currentTimeMillis()));
            prune();
            save(c);
        }
    }

    /** 그 대화방의 그 사람 기록 (최신이 앞) */
    public static List<Entry> of(Context c, RoomRef room, String who) {
        ArrayList<Entry> out = new ArrayList<Entry>();
        if (room == null) return out;
        String rk = room.key();
        String w = (who == null) ? "" : who.trim();
        synchronized (JoinLog.class) {
            load(c);
            prune();
            for (int i = ROWS.size() - 1; i >= 0; i--) {
                Entry e = ROWS.get(i);
                if (e == null || !rk.equals(e.roomKey)) continue;
                if (!w.equals(e.who)) continue;
                out.add(e);
            }
        }
        return out;
    }

    /** 전체 기록 (최신이 앞). limit 이하로 돌려준다. */
    public static List<Entry> recent(Context c, int limit) {
        ArrayList<Entry> out = new ArrayList<Entry>();
        int cap = (limit <= 0) ? MAX : limit;
        synchronized (JoinLog.class) {
            load(c);
            prune();
            for (int i = ROWS.size() - 1; i >= 0 && out.size() < cap; i--) {
                Entry e = ROWS.get(i);
                if (e != null) out.add(e);
            }
        }
        return out;
    }

    /** 보관 건수 */
    public static int count(Context c) {
        synchronized (JoinLog.class) {
            load(c);
            prune();
            return ROWS.size();
        }
    }

    /** 전부 삭제. 지운 건수를 돌려준다. */
    public static int clear(Context c) {
        synchronized (JoinLog.class) {
            load(c);
            int n = ROWS.size();
            ROWS.clear();
            save(c);
            return n;
        }
    }

    // ── 저장 ────────────────────────────────────────────────────────────────

    private static void prune() {
        long now = System.currentTimeMillis();
        for (int i = ROWS.size() - 1; i >= 0; i--) {
            Entry e = ROWS.get(i);
            if (e == null || now - e.at > TTL_MS) ROWS.remove(i);
        }
        while (ROWS.size() > MAX) ROWS.remove(0);
    }

    private static void load(Context c) {
        if (loaded) return;
        if (c == null) return;
        loaded = true;
        String raw;
        try {
            raw = Prefs.getStr(c, K, null);
        } catch (Throwable t) {
            return;
        }
        if (raw == null || raw.length() == 0) return;
        try {
            JSONArray arr = new JSONArray(raw);
            for (int i = 0; i < arr.length(); i++) {
                JSONObject o = arr.optJSONObject(i);
                if (o == null) continue;
                String rk = o.optString("r", "");
                if (rk.length() == 0) continue;
                ROWS.add(new Entry(rk, o.optString("w", ""),
                        (o.optInt("k", JOIN) == LEAVE) ? LEAVE : JOIN, o.optLong("t", 0L)));
            }
            prune();
        } catch (Throwable t) {
            ROWS.clear();   // 깨진 값이면 통째로 버린다 (기록이라 복구 가치가 없다)
        }
    }

    private static void save(Context c) {
        if (c == null) return;
        try {
            JSONArray arr = new JSONArray();
            for (int i = 0; i < ROWS.size(); i++) {
                Entry e = ROWS.get(i);
                if (e == null) continue;
                JSONObject o = new JSONObject();
                o.put("r", e.roomKey);
                if (e.who.length() > 0) o.put("w", e.who);
                o.put("k", e.kind);
                o.put("t", e.at);
                arr.put(o);
            }
            Prefs.putStr(c, K, arr.toString());
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "입·퇴장 기록 저장 실패", t);
        }
    }
}
