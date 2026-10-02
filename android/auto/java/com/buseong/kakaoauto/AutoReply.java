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
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * 오픈프로필 개인톡 자동응답 (SPEC 8.4 B).
 *
 * 오픈프로필로 모르는 사람이 1:1 톡을 보내면, 사용자가 써둔 메시지로 답해준다.
 * 판정은 전부 여기서 하고, 실제 발송은 {@link KakaoListener#sendTo} 가 한다.
 *
 * v4 부터 두 갈래로 응답한다.
 *   1) 키워드 규칙({@link Settings.KeywordRule}) — 특정 문자열이 오면 그 규칙의 답장을 보낸다.
 *      온 메시지를 규칙 목록 순서대로 보고, 매치되는 첫 규칙이 메시지를 처리하고 끝난다.
 *   2) 모든 갠톡 응답({@link Settings.AutoReplyCfg#enabled}) — 매치되는 규칙이 없을 때만 넘어온다.
 *
 * 걸러내는 조건 (하나라도 걸리면 안 보낸다)
 *   - 매크로 기능 미보유 / 일반 응답·키워드 규칙 모두 꺼짐
 *   - 그룹방 · 내가 보낸 메시지 · 대상 계정 아님
 *   - 적용 대상(모든 1:1 / 모르는 사람만 / 특정 방 제외) 밖
 *   - 운영시간 밖 (자정 넘김 처리)
 *   - 같은 사람 쿨다운 (일반: cooldownMs, 규칙: 규칙별 cooldownMs) · 「첫 메시지에만」 이면 이미 응답한 사람
 *
 * scope(ALL/UNKNOWN/EXCEPT)·운영시간·랜덤지연은 키워드 규칙과 일반 응답에 공통으로 적용한다.
 * v4 에서 일일 한도(dailyLimit)는 제거했다. 금일 발송 수는 표시용으로만 센다(제한 없음).
 *
 * 상태(사람별 마지막 응답 시각 · 규칙별 쿨다운 · 금일 응답 수)는 민감정보가 아니라 평문 Prefs 에 JSON 으로 둔다.
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

    /** 규칙×발신자 쿨다운 이력 최대 보관 수 */
    private static final int MAX_RULE_STATES = 600;

    /** 같은 경고를 도배하지 않는 간격 */
    private static final long WARN_MS = 30 * 60 * 1000L;

    private static final Random RND = new Random();

    /** 발신자 키(계정+이름) → 마지막 일반 응답 시각 */
    private static final HashMap<String, Long> LAST = new HashMap<String, Long>();
    /** (규칙id|패턴)+발신자 키 → 마지막 규칙 응답 시각 */
    private static final HashMap<String, Long> RULE_LAST = new HashMap<String, Long>();
    /** 오늘 날짜 (yyyyMMdd) */
    private static String today = "";
    /** 오늘 응답 수 (표시용. v4 에서 제한은 없다) */
    private static int sentToday = 0;
    private static boolean loaded = false;

    private static final HashMap<String, Long> WARNED = new HashMap<String, Long>();

    /** 정규식 캐시 (플래그+패턴 → Pattern). 알림마다 불려도 되게 미리 컴파일해 둔다. */
    private static final ConcurrentHashMap<String, Pattern> PAT =
            new ConcurrentHashMap<String, Pattern>();
    /** 컴파일이 깨진 정규식 (다시 시도해 예외 비용을 또 내지 않게) */
    private static final ConcurrentHashMap<String, Boolean> BAD =
            new ConcurrentHashMap<String, Boolean>();

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
        if (cfg == null) return;
        // 일반 응답(enabled)과 키워드 규칙 중 하나라도 동작 가능해야 진행한다
        final boolean anyRule = hasActiveRule(cfg);
        if (!cfg.enabled && !anyRule) return;

        if (!room.valid()) return;
        final String who = (sender == null) ? "" : sender.trim();
        final String label = room.label(c);

        // 그룹방이면 자동응답 대상이 아니다 (리스너가 본 방 정보로 한 번 더 확인)
        KakaoListener.Session s = KakaoListener.session(room);
        if (s != null && s.group) return;

        // 내 메시지면 무시
        String me = KakaoListener.selfName(room.acc);
        if (who.length() > 0 && me.length() > 0 && who.equals(me)) return;

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

        // 1) 키워드 규칙을 먼저 순회 — 매치되는 첫 규칙이 메시지를 처리하고 종료한다.
        if (anyRule) {
            List<Settings.KeywordRule> rules = cfg.rules;
            for (int i = 0; i < rules.size(); i++) {
                Settings.KeywordRule rule = rules.get(i);
                if (rule == null || !rule.enabled) continue;
                if (rule.pattern == null || rule.pattern.length() == 0) continue;
                // 정규식이 깨진 규칙은 건너뛰되 사용자에게 알린다 (조용히 삼키지 않는다)
                if (Settings.MODE_REGEX.equals(rule.mode) && compiled(rule.pattern, rule.ignoreCase) == null) {
                    warn(c, "ruleregex:" + rule.id, "자동응답 키워드 규칙 「" + rule.title()
                            + "」 정규식이 올바르지 않아 건너뛰었습니다. 설정에서 수정하십시오.");
                    continue;
                }
                if (!ruleMatches(rule, text)) continue;
                fireRule(c, cfg, rule, room, who, label, now);
                return;   // 매치된 첫 규칙이 메시지를 처리했다
            }
        }

        // 2) 매치되는 규칙이 없으면 '모든 갠톡 응답'(enabled)으로 넘어간다.
        if (!cfg.enabled) return;
        fireGeneral(c, cfg, room, who, label, now);
    }

    /** 활성(enabled + 패턴 있음) 키워드 규칙이 하나라도 있나 */
    private static boolean hasActiveRule(Settings.AutoReplyCfg cfg) {
        if (cfg == null || cfg.rules == null) return false;
        for (int i = 0; i < cfg.rules.size(); i++) {
            Settings.KeywordRule k = cfg.rules.get(i);
            if (k != null && k.enabled && k.pattern != null && k.pattern.length() > 0) return true;
        }
        return false;
    }

    // ── 발송 (키워드 규칙 / 일반) ──────────────────────────────────────────────

    /**
     * 키워드 규칙 한 건을 발송 예약한다. 쿨다운은 규칙별 + 발신자별로 묶는다.
     * 쿨다운 중이면 아무것도 하지 않는다 (매치된 규칙이 메시지를 이미 '처리'한 것으로 본다).
     */
    private static void fireRule(final Context c, final Settings.AutoReplyCfg cfg,
                                 final Settings.KeywordRule rule, final RoomRef room,
                                 final String who, final String label, final long now) {
        final String rkey = ruleKey(rule, room, who);
        final long stamp;
        synchronized (AutoReply.class) {
            load(c);
            rollDay(now);

            Long last = RULE_LAST.get(rkey);
            long cool = (rule.cooldownMs < 0) ? 0L : rule.cooldownMs;
            if (last != null && now - last.longValue() < cool) return;   // 규칙 쿨다운 중

            // 지연 중에 같은 사람이 또 보내도 두 번 안 가게, 보낼 걸 먼저 찍어둔다
            stamp = now;
            RULE_LAST.put(rkey, Long.valueOf(stamp));
            sentToday = sentToday + 1;
            trimRules();
            save(c);
        }

        final String msg = rule.render(who.length() > 0 ? who : room.name, now);
        if (msg == null || msg.trim().length() == 0) {
            refundRule(c, rkey, stamp);
            warn(c, "rulerender:" + rule.id,
                    "자동응답 키워드 규칙 「" + rule.title() + "」 메시지가 치환 후 비어 있습니다. 규칙 내용을 확인하십시오.");
            return;
        }

        final long wait = delayOf(cfg.delayMaxMs);
        final String title = rule.title();
        KakaoListener.post(new Runnable() {
            @Override public void run() {
                boolean ok = KakaoListener.sendTo(c, room, msg);
                if (ok) {
                    Log.add(c, "자동응답 발송 · 「" + label + "」 규칙 「" + title + "」 (금일 " + count() + "건)");
                } else {
                    refundRule(c, rkey, stamp);
                    Log.add(c, "자동응답 발송에 실패했습니다. 「" + label + "」 규칙 「" + title + "」");
                }
            }
        }, wait);

        if (wait > 0) {
            Log.add(c, "자동응답 예약 · 「" + label + "」 규칙 「" + title + "」 " + (wait / 1000) + "초 후 발송");
        }
    }

    /**
     * '모든 갠톡 응답' 한 건을 발송 예약한다. 쿨다운은 발신자별(cooldownMs)로 묶고,
     * 「첫 메시지에만」(firstOnly) 이면 이미 응답한 사람에게는 보내지 않는다.
     */
    private static void fireGeneral(final Context c, final Settings.AutoReplyCfg cfg,
                                    final RoomRef room, final String who,
                                    final String label, final long now) {
        if (cfg.message == null || cfg.message.trim().length() == 0) {
            warn(c, "empty", "자동응답이 활성 상태이나 응답 메시지가 비어 있습니다. 매크로 탭에서 메시지를 입력하십시오.");
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
                    Log.add(c, "자동응답 발송에 실패했습니다. 「" + label + "」");
                }
            }
        }, wait);

        if (wait > 0) {
            Log.add(c, "자동응답 예약 · 「" + label + "」 " + (wait / 1000) + "초 후 발송");
        }
    }

    /** 규칙 쿨다운 상태키 = (규칙id 또는 패턴) + 발신자 키 */
    private static String ruleKey(Settings.KeywordRule rule, RoomRef room, String who) {
        String rid = (rule.id != null && rule.id.length() > 0)
                ? rule.id
                : ((rule.pattern == null) ? "" : rule.pattern);
        return rid + "\u0001" + personKey(room, who);
    }

    /** 이 메시지가 규칙에 걸리나. 정규식은 컴파일 캐시를 쓰고, 깨져 있으면 false. */
    private static boolean ruleMatches(Settings.KeywordRule rule, String text) {
        if (rule == null || text == null) return false;
        String p = rule.pattern;
        if (p == null || p.length() == 0) return false;

        if (Settings.MODE_REGEX.equals(rule.mode)) {
            Pattern pat = compiled(p, rule.ignoreCase);
            if (pat == null) return false;
            try {
                return pat.matcher(text).find();
            } catch (Throwable e) {
                return false;
            }
        }

        String m = text;
        String q = p;
        if (rule.ignoreCase) {
            m = m.toLowerCase(Locale.getDefault());
            q = q.toLowerCase(Locale.getDefault());
        }
        if (Settings.MODE_EXACT.equals(rule.mode)) return m.trim().equals(q.trim());
        if (Settings.MODE_STARTS.equals(rule.mode)) return m.startsWith(q);
        return m.contains(q);
    }

    // ── 사람별 상태 키 ────────────────────────────────────────────────────────

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

    // ── 정규식 캐시 (Trigger 와 동일 방식) ─────────────────────────────────────

    private static Pattern compiled(String pattern, boolean ignoreCase) {
        if (pattern == null || pattern.length() == 0) return null;
        int flags = ignoreCase ? (Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE) : 0;
        String key = flags + "\u0000" + pattern;
        Pattern p = PAT.get(key);
        if (p != null) return p;
        if (BAD.containsKey(key)) return null;
        try {
            p = Pattern.compile(pattern, flags);
        } catch (Throwable e) {
            BAD.put(key, Boolean.TRUE);
            return null;
        }
        if (PAT.size() > 128) PAT.clear();   // 규칙 30개 한도면 안 닿지만 안전장치
        PAT.put(key, p);
        return p;
    }

    // ── 조회 / 초기화 (설정 화면용) ───────────────────────────────────────────

    /** 금일 보낸 자동응답 수 (표시용) */
    public static synchronized int count() {
        return sentToday;
    }

    /** 금일 보낸 자동응답 수 (날짜 넘어갔으면 0 으로 정리하고 반환) */
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

    /** 응답 이력 전부 초기화 (일반·규칙 쿨다운·첫메시지 판정·금일 카운트 다 리셋) */
    public static synchronized void clearState(Context c) {
        LAST.clear();
        RULE_LAST.clear();
        sentToday = 0;
        today = dayOf(System.currentTimeMillis());
        loaded = true;
        Prefs.remove(c, K_STATE);
    }

    // ── 내부 ──────────────────────────────────────────────────────────────────

    /** 일반 응답 발송이 실패했으면 소모한 쿨다운·카운트를 되돌린다 */
    private static synchronized void refund(Context c, String key, long stamp) {
        Long v = LAST.get(key);
        if (v != null && v.longValue() == stamp) LAST.remove(key);
        if (sentToday > 0) sentToday = sentToday - 1;
        save(c);
    }

    /** 규칙 응답 발송이 실패했으면 소모한 쿨다운·카운트를 되돌린다 */
    private static synchronized void refundRule(Context c, String key, long stamp) {
        Long v = RULE_LAST.get(key);
        if (v != null && v.longValue() == stamp) RULE_LAST.remove(key);
        if (sentToday > 0) sentToday = sentToday - 1;
        save(c);
    }

    /** 자정이 지났으면 금일 카운트를 리셋한다 (사람별 이력은 유지) */
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
        trimMap(LAST, MAX_PEOPLE);
    }

    /** 규칙 쿨다운 이력이 너무 쌓이면 오래된 것부터 버린다 */
    private static void trimRules() {
        trimMap(RULE_LAST, MAX_RULE_STATES);
    }

    private static void trimMap(HashMap<String, Long> map, int max) {
        if (map.size() <= max) return;
        ArrayList<Map.Entry<String, Long>> all =
                new ArrayList<Map.Entry<String, Long>>(map.entrySet());
        java.util.Collections.sort(all, new java.util.Comparator<Map.Entry<String, Long>>() {
            @Override public int compare(Map.Entry<String, Long> a, Map.Entry<String, Long> b) {
                return Long.compare(a.getValue().longValue(), b.getValue().longValue());
            }
        });
        int drop = map.size() - max;
        for (int i = 0; i < drop && i < all.size(); i++) map.remove(all.get(i).getKey());
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
            JSONObject rules = o.optJSONObject("rules");
            if (rules != null) {
                Iterator<String> it = rules.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    long v = rules.optLong(k, 0L);
                    if (k.length() == 0 || v <= 0) continue;
                    RULE_LAST.put(k, Long.valueOf(v));
                }
            }
            trim();
            trimRules();
        } catch (Throwable t) {
            Log.add(c, "자동응답 이력이 손상되어 초기화했습니다. (" + t + ")");
            LAST.clear();
            RULE_LAST.clear();
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
            JSONObject rules = new JSONObject();
            Iterator<Map.Entry<String, Long>> it2 = RULE_LAST.entrySet().iterator();
            while (it2.hasNext()) {
                Map.Entry<String, Long> e = it2.next();
                rules.put(e.getKey(), e.getValue().longValue());
            }
            o.put("rules", rules);
            Prefs.putStr(c, K_STATE, o.toString());
        } catch (Throwable t) {
            Log.add(c, "자동응답 이력을 저장하지 못했습니다. (" + t + ")");
        }
    }
}
