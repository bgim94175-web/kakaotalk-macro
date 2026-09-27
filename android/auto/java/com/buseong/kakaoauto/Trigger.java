package com.buseong.kakaoauto;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Pattern;

/**
 * 메시지 추적 = 키워드 트리거 엔진 (SPEC 8.4 C).
 *
 * 규칙 모델은 {@link Settings.TriggerCfg} 다. 이 클래스는 **판정 + 실행**만 한다.
 *   판정 순서: 활성 → 방 필터 → 내 메시지 필터 → 패턴 매칭 → 1회발동/쿨다운 → 치환 → 랜덤 지연 → 발송
 *
 * 주기 발송 스케줄과 완전히 무관하다. 알림이 도착한 그 순간에 판정하고, 지연을 줬으면 그만큼만 기다렸다 보낸다.
 *
 * 쿨다운·1회발동 기록은 메모리 Map 이 정본이고, 앱이 죽어도 남게 평문 Prefs 에 JSON 으로 백업한다
 * (방 이름이 들어가긴 하지만 KakaoListener 의 방 캐시와 같은 수준의 정보라 평문으로 둔다).
 *
 * 정규식은 미리 컴파일해서 캐시한다. 깨진 정규식은 건너뛰고 Log 로 알린다 — 조용히 삼키지 않는다.
 */
public final class Trigger {
    private Trigger() {}

    /** 쿨다운/1회발동 백업 슬롯 (평문) */
    private static final String K_STATE = "K_TRIG_STATE";

    /** 지연 상한 (SPEC: 0~60000) */
    public static final int MAX_DELAY_MS = 60000;

    /** 트리거 하나가 기억하는 "이미 발동한 방" 최대 개수 */
    private static final int MAX_ONCE_ROOMS = 100;

    /** 같은 경고를 도배하지 않는 간격 */
    private static final long WARN_MS = 5 * 60 * 1000L;

    private static final Random RND = new Random();

    /** 트리거 id → 마지막 발동 시각 */
    private static final ConcurrentHashMap<String, Long> CD = new ConcurrentHashMap<String, Long>();
    /** 트리거 id → 이미 발동한 방 이름들 (oncePerRoom) */
    private static final ConcurrentHashMap<String, Set<String>> ONCE =
            new ConcurrentHashMap<String, Set<String>>();

    /** 정규식 캐시 (플래그+패턴 → Pattern) */
    private static final ConcurrentHashMap<String, Pattern> PAT =
            new ConcurrentHashMap<String, Pattern>();
    /** 컴파일이 깨진 정규식 (다시 시도해서 예외 비용을 또 내지 않게) */
    private static final ConcurrentHashMap<String, Boolean> BAD =
            new ConcurrentHashMap<String, Boolean>();
    /** 경고 로그 도배 방지 */
    private static final ConcurrentHashMap<String, Long> WARNED =
            new ConcurrentHashMap<String, Long>();

    private static volatile boolean loaded = false;

    // ── 판정 ──────────────────────────────────────────────────────────────────

    /**
     * 이 메시지가 규칙에 걸리나. 정규식은 컴파일 캐시를 쓰고, 깨져 있으면 false.
     * (Settings.TriggerCfg.matches 와 판정 결과는 같다. 여기 건 알림마다 불려도 되게 캐시가 붙어있는 버전이다)
     */
    public static boolean matches(Settings.TriggerCfg t, String text) {
        if (t == null || text == null) return false;
        String p = t.pattern;
        if (p == null || p.length() == 0) return false;

        if (Settings.MODE_REGEX.equals(t.mode)) {
            Pattern pat = compiled(p, t.ignoreCase);
            if (pat == null) return false;
            try {
                return pat.matcher(text).find();
            } catch (Throwable e) {
                return false;
            }
        }

        String m = text;
        String q = p;
        if (t.ignoreCase) {
            m = m.toLowerCase(Locale.getDefault());
            q = q.toLowerCase(Locale.getDefault());
        }
        if (Settings.MODE_EXACT.equals(t.mode)) return m.trim().equals(q.trim());
        if (Settings.MODE_STARTS.equals(t.mode)) return m.startsWith(q);
        return m.contains(q);
    }

    // ── 실행 ──────────────────────────────────────────────────────────────────

    /**
     * 알림 하나를 모든 활성 트리거에 물려본다. KakaoListener 의 BG 스레드에서 호출된다.
     *
     * @param room   메시지가 올라온 방
     * @param sender 발신자 (모르면 "")
     * @param text   본문
     * @param fromMe 내가 보낸 메시지인가
     */
    public static void onMessage(final Context c, String room, String sender, String text, boolean fromMe) {
        if (c == null || text == null || text.length() == 0) return;
        // 게이트는 여기서도 한 번 더 본다 (이 메서드가 공개 진입점이라서)
        if (!License.allowed(c, Features.MACRO)) return;

        List<Settings.TriggerCfg> list = Settings.triggers(c);
        if (list == null || list.isEmpty()) return;

        final String r = (room == null) ? "" : room.trim();
        final String who = (sender == null) ? "" : sender.trim();
        final long now = System.currentTimeMillis();

        load(c);
        boolean dirty = false;

        for (int i = 0; i < list.size(); i++) {
            Settings.TriggerCfg t = list.get(i);
            if (t == null || !t.enabled) continue;
            if (t.id == null || t.id.length() == 0) continue;
            if (!t.coversRoom(r)) continue;
            if (fromMe && !t.fromMe) continue;

            // 정규식이 깨진 트리거는 건너뛰되 사용자에게 알린다
            if (Settings.MODE_REGEX.equals(t.mode) && compiled(t.pattern, t.ignoreCase) == null) {
                warn(c, "regex:" + t.id,
                        "메시지추적 「" + t.title() + "」 정규식이 잘못돼서 건너뛰었어 — 설정에서 고쳐줘");
                continue;
            }

            if (!matches(t, text)) continue;

            // 방마다 한 번만
            if (t.oncePerRoom && firedIn(t.id, r)) continue;

            // 트리거별 쿨다운
            long cool = (t.cooldownMs < 0) ? 0L : t.cooldownMs;
            Long last = CD.get(t.id);
            if (last != null && now - last.longValue() < cool) continue;

            // 보낼 곳 결정
            String tgt = (t.target == null) ? "" : t.target.trim();
            final String dest = (tgt.length() > 0) ? tgt : r;
            if (dest.length() == 0) {
                warn(c, "dest:" + t.id,
                        "메시지추적 「" + t.title() + "」 보낼 방을 못 정했어 (방 이름이 비어있음)");
                continue;
            }
            // 다른 방으로 보내는 트리거는 그 방 세션이 살아있어야 한다 (SPEC 8.4 C).
            // 쿨다운을 소모하지 않고 넘겨서, 그 방 알림이 오면 다음에 정상 발동하게 한다.
            if (tgt.length() > 0 && !KakaoListener.hasSession(dest)) {
                warn(c, "sess:" + t.id + ":" + dest,
                        "메시지추적 「" + t.title() + "」 대상 방 세션 없음 — 「" + dest
                                + "」 카톡 알림이 와야 보낼 수 있어");
                continue;
            }

            final String msg = t.render(r, who, text, now);
            if (msg == null || msg.trim().length() == 0) {
                warn(c, "empty:" + t.id,
                        "메시지추적 「" + t.title() + "」 보낼 메시지가 비어서 건너뛰었어");
                continue;
            }

            // 상태를 먼저 찍는다 — 지연 중에 같은 트리거가 또 걸리는 걸 막는다
            CD.put(t.id, Long.valueOf(now));
            if (t.oncePerRoom) markFired(t.id, r);
            dirty = true;

            final long wait = delayOf(t.delayMs);
            final String name = t.title();
            KakaoListener.post(new Runnable() {
                @Override public void run() {
                    boolean ok = KakaoListener.sendTo(c, dest, msg);
                    if (!ok) Log.add(c, "메시지추적 「" + name + "」 발송이 실패했어 (대상 방: " + dest + ")");
                }
            }, wait);

            Log.add(c, "메시지추적 「" + name + "」 감지 — 「" + r + "」 → 「" + dest + "」 "
                    + (wait <= 0 ? "즉시" : (wait / 1000) + "초 뒤") + " 발송 예약");
        }

        if (dirty) {
            prune(list);
            save(c);
        }
    }

    /** 0 ~ delayMs 사이 랜덤. 상한은 60초. */
    private static long delayOf(int delayMs) {
        int d = delayMs;
        if (d <= 0) return 0L;
        if (d > MAX_DELAY_MS) d = MAX_DELAY_MS;
        return RND.nextInt(d + 1);
    }

    // ── 저장 전 검증 (설정 화면이 쓴다) ───────────────────────────────────────

    /** 문제가 없으면 null, 있으면 사용자에게 그대로 보여줄 한국어 설명. */
    public static String validate(Settings.TriggerCfg t) {
        if (t == null) return "트리거가 비어있어";
        if (t.pattern == null || t.pattern.trim().length() == 0) return "감지할 문자열을 입력해줘";
        if (t.reply == null || t.reply.trim().length() == 0) return "보낼 메시지를 입력해줘";
        if (!validMode(t.mode)) return "비교 방식이 잘못됐어 (포함·정확히·시작·정규식 중에 골라줘)";

        if (Settings.MODE_REGEX.equals(t.mode)) {
            try {
                Pattern.compile(t.pattern);
            } catch (Throwable e) {
                String why = e.getMessage();
                return "정규식이 잘못됐어" + ((why == null) ? "" : (" — " + why.replace('\n', ' ')));
            }
            // 고쳐서 저장하는 경우가 많으니 "깨진 정규식" 표시를 풀어준다
            forget(t.pattern);
        }

        if (t.delayMs < 0 || t.delayMs > MAX_DELAY_MS) return "지연은 0~60초 사이여야 해";
        if (t.cooldownMs < 0) return "재발동 간격은 0 이상이어야 해";
        if (t.rooms != null && t.rooms.size() > 50) return "방은 최대 50개까지 지정할 수 있어";
        if (t.reply.length() > 2000) return "보낼 메시지가 너무 길어 (2000자 이하)";
        return null;
    }

    private static boolean validMode(String mode) {
        if (mode == null) return false;
        for (int i = 0; i < Settings.MODES.length; i++) {
            if (Settings.MODES[i].equals(mode)) return true;
        }
        return false;
    }

    // ── 상태 조회 / 초기화 (설정 화면용) ──────────────────────────────────────

    /** 이 트리거가 마지막으로 발동한 시각 (없으면 0) */
    public static long lastFiredAt(Context c, String triggerId) {
        if (triggerId == null) return 0L;
        load(c);
        Long v = CD.get(triggerId);
        return (v == null) ? 0L : v.longValue();
    }

    /** oncePerRoom 로 이미 발동한 방 목록 */
    public static List<String> firedRooms(Context c, String triggerId) {
        load(c);
        ArrayList<String> out = new ArrayList<String>();
        if (triggerId == null) return out;
        Set<String> set = ONCE.get(triggerId);
        if (set == null) return out;
        synchronized (set) { out.addAll(set); }
        Collections.sort(out);
        return out;
    }

    /** 트리거 하나의 쿨다운·1회발동 기록을 지운다 (다시 발동하게) */
    public static void resetState(Context c, String triggerId) {
        if (triggerId == null) return;
        load(c);
        CD.remove(triggerId);
        ONCE.remove(triggerId);
        save(c);
    }

    /** 모든 발동 기록 초기화 */
    public static void clearState(Context c) {
        CD.clear();
        ONCE.clear();
        loaded = true;
        Prefs.remove(c, K_STATE);
    }

    // ── 정규식 캐시 ───────────────────────────────────────────────────────────

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
        if (PAT.size() > 128) PAT.clear();   // 트리거 30개 한도면 절대 안 닿지만 안전장치
        PAT.put(key, p);
        return p;
    }

    /** 이 패턴에 대한 캐시(정상/깨짐)를 버린다. 사용자가 고쳐서 저장할 때 호출. */
    private static void forget(String pattern) {
        if (pattern == null) return;
        String suffix = "\u0000" + pattern;
        Iterator<String> a = BAD.keySet().iterator();
        while (a.hasNext()) { if (a.next().endsWith(suffix)) a.remove(); }
        Iterator<String> b = PAT.keySet().iterator();
        while (b.hasNext()) { if (b.next().endsWith(suffix)) b.remove(); }
    }

    // ── 1회발동 기록 ──────────────────────────────────────────────────────────

    private static boolean firedIn(String id, String room) {
        Set<String> set = ONCE.get(id);
        if (set == null) return false;
        synchronized (set) { return set.contains(room); }
    }

    private static void markFired(String id, String room) {
        Set<String> set = ONCE.get(id);
        if (set == null) {
            Set<String> fresh = new HashSet<String>();
            Set<String> prev = ONCE.putIfAbsent(id, fresh);
            set = (prev != null) ? prev : fresh;
        }
        synchronized (set) {
            if (set.size() >= MAX_ONCE_ROOMS) {
                // 넘치면 통째로 비운다 — 어느 걸 버릴지 고를 근거가 없다
                set.clear();
            }
            set.add(room);
        }
    }

    /** 지금 없는 트리거의 기록은 버린다 */
    private static void prune(List<Settings.TriggerCfg> list) {
        HashSet<String> alive = new HashSet<String>();
        for (int i = 0; i < list.size(); i++) {
            Settings.TriggerCfg t = list.get(i);
            if (t != null && t.id != null) alive.add(t.id);
        }
        Iterator<String> a = CD.keySet().iterator();
        while (a.hasNext()) { if (!alive.contains(a.next())) a.remove(); }
        Iterator<String> b = ONCE.keySet().iterator();
        while (b.hasNext()) { if (!alive.contains(b.next())) b.remove(); }
    }

    // ── 경고 로그 (도배 방지) ─────────────────────────────────────────────────

    private static void warn(Context c, String key, String msg) {
        long now = System.currentTimeMillis();
        Long last = WARNED.get(key);
        if (last != null && now - last.longValue() < WARN_MS) return;
        WARNED.put(key, Long.valueOf(now));
        if (WARNED.size() > 200) WARNED.clear();
        Log.add(c, msg);
    }

    // ── 백업 저장/복구 ────────────────────────────────────────────────────────

    private static void load(Context c) {
        if (loaded) return;
        synchronized (Trigger.class) {
            if (loaded) return;
            loaded = true;
            if (c == null) { loaded = false; return; }
            String raw = Prefs.getStr(c, K_STATE, null);
            if (raw == null || raw.length() == 0) return;
            try {
                JSONObject o = new JSONObject(raw);
                JSONObject cd = o.optJSONObject("cd");
                if (cd != null) {
                    Iterator<String> it = cd.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        long v = cd.optLong(k, 0L);
                        if (v > 0) CD.put(k, Long.valueOf(v));
                    }
                }
                JSONObject once = o.optJSONObject("once");
                if (once != null) {
                    Iterator<String> it = once.keys();
                    while (it.hasNext()) {
                        String k = it.next();
                        JSONArray arr = once.optJSONArray(k);
                        if (arr == null) continue;
                        HashSet<String> set = new HashSet<String>();
                        for (int i = 0; i < arr.length() && set.size() < MAX_ONCE_ROOMS; i++) {
                            String room = arr.optString(i, "");
                            if (room.length() > 0) set.add(room);
                        }
                        if (!set.isEmpty()) ONCE.put(k, set);
                    }
                }
            } catch (Throwable t) {
                Log.add(c, "메시지추적 발동 기록이 깨져 있어서 초기화했어: " + t);
                CD.clear();
                ONCE.clear();
            }
        }
    }

    private static void save(Context c) {
        if (c == null) return;
        try {
            JSONObject o = new JSONObject();
            JSONObject cd = new JSONObject();
            Iterator<Map.Entry<String, Long>> it = CD.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Long> e = it.next();
                cd.put(e.getKey(), e.getValue().longValue());
            }
            o.put("cd", cd);

            JSONObject once = new JSONObject();
            Iterator<Map.Entry<String, Set<String>>> it2 = ONCE.entrySet().iterator();
            while (it2.hasNext()) {
                Map.Entry<String, Set<String>> e = it2.next();
                Set<String> set = e.getValue();
                if (set == null) continue;
                JSONArray arr = new JSONArray();
                synchronized (set) {
                    Iterator<String> r = set.iterator();
                    while (r.hasNext()) arr.put(r.next());
                }
                if (arr.length() > 0) once.put(e.getKey(), arr);
            }
            o.put("once", once);

            Prefs.putStr(c, K_STATE, o.toString());
        } catch (Throwable t) {
            Log.add(c, "메시지추적 발동 기록을 저장하지 못했어: " + t);
        }
    }
}
