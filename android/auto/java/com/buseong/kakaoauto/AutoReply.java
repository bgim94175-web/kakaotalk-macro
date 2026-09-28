package com.buseong.kakaoauto;

import android.content.Context;

import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;

/**
 * 오픈프로필 개인톡 자동응답 (SPEC 8.4 B).
 *
 * 오픈프로필로 모르는 사람이 1:1 톡을 보내면, 사용자가 직접 써둔 메시지로 한 번 답해준다.
 * 판정은 전부 여기서 하고, 실제 발송은 {@link KakaoListener#sendTo} 가 한다.
 *
 * 걸러내는 조건 (하나라도 걸리면 안 보낸다)
 *   - 매크로 기능 미보유 / 자동응답 꺼짐 / 응답 메시지 비어있음
 *   - 그룹방 · 내가 보낸 메시지
 *   - 적용 대상(모든 1:1 / 모르는 사람만 / 특정 방 제외) 밖
 *   - 운영시간 밖 (자정 넘김 처리)
 *   - 같은 사람 쿨다운 (기본 6시간) · 「첫 메시지에만」 이면 이미 응답한 사람
 *   - 하루 한도 초과 (자정 리셋)
 *
 * 상태(사람별 마지막 응답 시각 · 오늘 응답 수)는 민감정보가 아니라 평문 Prefs 에 JSON 으로 둔다.
 * 호출은 전부 KakaoListener 의 BG 스레드 한 줄기에서 오지만, 그래도 상태 접근은 다 잠근다.
 */
public final class AutoReply {
    private AutoReply() {}

    /** 응답 이력 백업 슬롯 (평문) */
    private static final String K_STATE = "K_AUTOREPLY_STATE";

    /** 랜덤 지연 상한의 상한 */
    public static final int MAX_DELAY_MS = 120000;

    /** 사람별 이력 최대 보관 수 */
    private static final int MAX_PEOPLE = 300;

    /** 같은 경고를 도배하지 않는 간격 */
    private static final long WARN_MS = 30 * 60 * 1000L;

    private static final Random RND = new Random();

    /** 발신자 키(계정+이름) → 마지막 응답 시각 */
    private static final HashMap<String, Long> LAST = new HashMap<String, Long>();
    /** 오늘 날짜 (yyyyMMdd) */
    private static String today = "";
    /** 오늘 응답 수 */
    private static int sentToday = 0;
    private static boolean loaded = false;

    private static final HashMap<String, Long> WARNED = new HashMap<String, Long>();

    // ── 진입점 ────────────────────────────────────────────────────────────────

    /**
     * 1:1 개인톡 한 건을 받아서 자동응답 여부를 판단하고, 보낼 거면 예약한다.
     * KakaoListener 는 그룹방·내 메시지를 걸러서 넘겨주지만, 여기서도 한 번 더 확인한다.
     *
     * @param room 메시지가 온 방 (계정 + 상대 이름)
     */
    public static void onDirectMessage(final Context c, final RoomRef room, String sender, String text) {
        if (c == null || room == null || text == null || text.trim().length() == 0) return;
        if (!License.allowed(c, Features.MACRO)) return;

        Settings set;
        try {
            set = Settings.load(c);
        } catch (Throwable t) {
            return;
        }
        // 대상 계정이 아니면 응답하지 않는다 (Settings.accounts 가 비어 있으면 모든 계정이 대상)
        if (!set.accountOn(room.acc)) return;

        Settings.AutoReplyCfg cfg = set.autoreply;
        if (cfg == null || !cfg.enabled) return;

        if (!room.valid()) return;
        final String who = (sender == null) ? "" : sender.trim();
        final String label = room.label(c);

        // 그룹방이면 자동응답 대상이 아니다 (리스너가 본 방 정보로 한 번 더 확인)
        KakaoListener.Session s = KakaoListener.session(room);
        if (s != null && s.group) return;

        // 내 메시지면 무시
        String me = KakaoListener.selfName(room.acc);
        if (who.length() > 0 && me.length() > 0 && who.equals(me)) return;

        if (cfg.message == null || cfg.message.trim().length() == 0) {
            warn(c, "empty", "자동응답이 활성 상태이나 응답 메시지가 비어 있습니다. 매크로 탭에서 메시지를 입력하십시오.");
            return;
        }

        // 「모르는 사람만」 판정: 이 방을 전에 본 적이 없으면 모르는 사람.
        // (KakaoListener 는 디스패치가 끝난 뒤에 방을 캐시하니까 첫 메시지는 여기서 unknown 으로 잡힌다)
        boolean unknown = !KakaoListener.isKnownRoom(room);
        if (!cfg.coversRoom(room, unknown)) return;

        final long now = System.currentTimeMillis();
        if (!cfg.inHours(now)) {
            warn(c, "hours", "자동응답 운영시간(" + cfg.hourFrom + "시~" + cfg.hourTo
                    + "시)이 아니므로 응답하지 않았습니다.");
            return;
        }

        // 쿨다운·첫메시지 판정 키는 계정까지 포함한다 (같은 이름이 두 계정에 있을 수 있다)
        final String key = personKey(room, who);
        final long stamp;
        synchronized (AutoReply.class) {
            load(c);
            rollDay(now);

            Long last = LAST.get(key);
            if (cfg.firstOnly && last != null) return;      // 첫 메시지에만
            long cool = (cfg.cooldownMs < 0) ? 0L : cfg.cooldownMs;
            if (last != null && now - last.longValue() < cool) return;

            if (cfg.dailyLimit > 0 && sentToday >= cfg.dailyLimit) {
                warn(c, "limit", "자동응답 일일 한도(" + cfg.dailyLimit
                        + "건)를 모두 사용했습니다. 자정에 초기화됩니다.");
                return;
            }

            // 지연 중에 같은 사람이 또 보내도 두 번 안 가게, 보낼 걸 먼저 찍어둔다
            stamp = now;
            LAST.put(key, Long.valueOf(stamp));
            sentToday = sentToday + 1;
            trim();
            save(c);
        }

        final String msg = cfg.render(who.length() > 0 ? who : room.name, now);
        if (msg == null || msg.trim().length() == 0) {
            refund(c, key, stamp);
            warn(c, "render", "자동응답 메시지가 치환 후 비어 있습니다. 메시지 내용을 확인하십시오.");
            return;
        }

        final long wait = delayOf(cfg.delayMaxMs);
        KakaoListener.post(new Runnable() {
            @Override public void run() {
                boolean ok = KakaoListener.sendTo(c, room, msg);
                if (ok) {
                    Log.add(c, "자동응답 발송 · 「" + label + "」 (금일 " + count() + "건)");
                } else {
                    refund(c, key, stamp);
                    Log.add(c, "자동응답 발송에 실패했습니다. 「" + label + "」 (일일 한도는 복구했습니다.)");
                }
            }
        }, wait);

        if (wait > 0) {
            Log.add(c, "자동응답 예약 · 「" + label + "」 " + (wait / 1000) + "초 후 발송");
        }
    }

    /**
     * 사람별 상태 키. 계정 + 상대 이름으로 만든다 (상대 이름을 모르면 방 키).
     * {@link RoomRef#key()} 와 같은 형식이라 옛 평문 기록도 {@link RoomRef#parse} 로 올려 쓸 수 있다.
     */
    private static String personKey(RoomRef room, String who) {
        if (room == null) return (who == null) ? "" : who.trim();
        if (who == null || who.trim().length() == 0) return room.key();
        RoomRef r = RoomRef.of(room.acc, who.trim());
        return (r == null) ? room.key() : r.key();
    }

    /** 0 ~ delayMaxMs 사이 랜덤 */
    private static long delayOf(int delayMaxMs) {
        int d = delayMaxMs;
        if (d <= 0) return 0L;
        if (d > MAX_DELAY_MS) d = MAX_DELAY_MS;
        return RND.nextInt(d + 1);
    }

    // ── 조회 / 초기화 (설정 화면용) ───────────────────────────────────────────

    /** 오늘 보낸 자동응답 수 */
    public static synchronized int count() {
        return sentToday;
    }

    /** 오늘 보낸 자동응답 수 (날짜 넘어갔으면 0 으로 정리하고 반환) */
    public static synchronized int today(Context c) {
        load(c);
        rollDay(System.currentTimeMillis());
        return sentToday;
    }

    /**
     * 이 사람에게 마지막으로 응답한 시각 (없으면 0).
     * 계정 구분자가 없는 이름을 넘기면 기본 계정("0")의 기록을 본다.
     */
    public static synchronized long lastRepliedAt(Context c, String who) {
        if (who == null || who.trim().length() == 0) return 0L;
        load(c);
        RoomRef r = RoomRef.parse(who.trim());
        Long v = LAST.get((r == null) ? who.trim() : r.key());
        return (v == null) ? 0L : v.longValue();
    }

    /** 이 계정의 이 사람에게 마지막으로 응답한 시각 (없으면 0) */
    public static synchronized long lastRepliedAt(Context c, RoomRef room, String who) {
        if (room == null) return lastRepliedAt(c, who);
        load(c);
        Long v = LAST.get(personKey(room, who));
        return (v == null) ? 0L : v.longValue();
    }

    /** 지금까지 응답한 사람 수 */
    public static synchronized int peopleCount(Context c) {
        load(c);
        return LAST.size();
    }

    /** 최근 응답한 사람들 (최신 순, 최대 n명. 표시용 이름) */
    public static synchronized List<String> recentPeople(Context c, int n) {
        load(c);
        ArrayList<Map.Entry<String, Long>> all =
                new ArrayList<Map.Entry<String, Long>>(LAST.entrySet());
        java.util.Collections.sort(all, new java.util.Comparator<Map.Entry<String, Long>>() {
            @Override public int compare(Map.Entry<String, Long> a, Map.Entry<String, Long> b) {
                return Long.compare(b.getValue().longValue(), a.getValue().longValue());
            }
        });
        ArrayList<String> out = new ArrayList<String>();
        for (int i = 0; i < all.size() && (n <= 0 || out.size() < n); i++) {
            String k = all.get(i).getKey();
            RoomRef r = RoomRef.parse(k);
            out.add((r == null) ? k : r.label());
        }
        return out;
    }

    /** 응답 이력 전부 초기화 (쿨다운·첫메시지 판정·하루 카운트 다 리셋) */
    public static synchronized void clearState(Context c) {
        LAST.clear();
        sentToday = 0;
        today = dayOf(System.currentTimeMillis());
        loaded = true;
        Prefs.remove(c, K_STATE);
    }

    // ── 내부 ──────────────────────────────────────────────────────────────────

    /** 발송이 실패했으면 소모한 한도와 쿨다운을 되돌린다 */
    private static synchronized void refund(Context c, String key, long stamp) {
        Long v = LAST.get(key);
        if (v != null && v.longValue() == stamp) LAST.remove(key);
        if (sentToday > 0) sentToday = sentToday - 1;
        save(c);
    }

    /** 자정이 지났으면 오늘 카운트를 리셋한다 (사람별 이력은 유지) */
    private static void rollDay(long now) {
        String d = dayOf(now);
        if (!d.equals(today)) {
            today = d;
            sentToday = 0;
        }
    }

    private static String dayOf(long at) {
        try {
            return new SimpleDateFormat("yyyyMMdd", Locale.KOREA).format(new Date(at));
        } catch (Throwable t) {
            return "00000000";
        }
    }

    /** 이력이 너무 쌓이면 오래된 것부터 버린다 */
    private static void trim() {
        if (LAST.size() <= MAX_PEOPLE) return;
        ArrayList<Map.Entry<String, Long>> all =
                new ArrayList<Map.Entry<String, Long>>(LAST.entrySet());
        java.util.Collections.sort(all, new java.util.Comparator<Map.Entry<String, Long>>() {
            @Override public int compare(Map.Entry<String, Long> a, Map.Entry<String, Long> b) {
                return Long.compare(a.getValue().longValue(), b.getValue().longValue());
            }
        });
        int drop = LAST.size() - MAX_PEOPLE;
        for (int i = 0; i < drop && i < all.size(); i++) LAST.remove(all.get(i).getKey());
    }

    private static void warn(Context c, String key, String msg) {
        long now = System.currentTimeMillis();
        synchronized (WARNED) {
            Long last = WARNED.get(key);
            if (last != null && now - last.longValue() < WARN_MS) return;
            WARNED.put(key, Long.valueOf(now));
        }
        Log.add(c, msg);
    }

    private static void load(Context c) {
        if (loaded) return;
        loaded = true;
        if (c == null) { loaded = false; return; }
        today = dayOf(System.currentTimeMillis());
        String raw = Prefs.getStr(c, K_STATE, null);
        if (raw == null || raw.length() == 0) return;
        try {
            JSONObject o = new JSONObject(raw);
            String day = o.optString("day", "");
            int n = o.optInt("n", 0);
            if (day.equals(today)) sentToday = (n < 0) ? 0 : n;
            JSONObject last = o.optJSONObject("last");
            if (last != null) {
                Iterator<String> it = last.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    long v = last.optLong(k, 0L);
                    if (k.length() == 0 || v <= 0) continue;
                    // 옛 기록은 계정 구분자가 없는 이름이다 → 기본 계정 키로 올려준다
                    RoomRef r = RoomRef.parse(k);
                    LAST.put((r == null) ? k : r.key(), Long.valueOf(v));
                }
            }
            trim();
        } catch (Throwable t) {
            Log.add(c, "자동응답 이력이 손상되어 초기화했습니다. (" + t + ")");
            LAST.clear();
            sentToday = 0;
        }
    }

    private static void save(Context c) {
        if (c == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("day", today);
            o.put("n", sentToday);
            JSONObject last = new JSONObject();
            Iterator<Map.Entry<String, Long>> it = LAST.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Long> e = it.next();
                last.put(e.getKey(), e.getValue().longValue());
            }
            o.put("last", last);
            Prefs.putStr(c, K_STATE, o.toString());
        } catch (Throwable t) {
            Log.add(c, "자동응답 이력을 저장하지 못했습니다. (" + t + ")");
        }
    }
}
