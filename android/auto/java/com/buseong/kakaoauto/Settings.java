package com.buseong.kakaoauto;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * 앱의 모든 사용자 설정. 단일 모델이다 — 화면·리스너·봇 엔진이 전부 이걸 읽고 쓴다.
 *
 * 저장은 **무조건 암호화**(Prefs.secPut). 방 목록·발송 메시지·트리거·자동응답문이 곧 앱의 가치다.
 * 라이선스 인증을 통과한 적 없는 기기는 설정키가 없어서 이걸 못 읽는다 → 보낼 메시지가 없다.
 * (SPEC 6.1 의 핵심 방어. 평문으로 저장하면 이 방어가 통째로 무너진다.)
 *
 * 쓰는 법
 *   Settings s = Settings.load(ctx);
 *   s.macro.message = "안녕";
 *   s.save(ctx);                     // 암호화 저장 + 캐시 갱신
 * 또는
 *   Settings.macro(ctx).enabled = true;
 *   Settings.flush(ctx);             // 캐시에 들어있는 걸 그대로 저장
 *
 * JSON 은 필드 추가에 안전하다 — 없는 키는 기본값을 유지한다(opt*). 옛 설정이 깨지지 않는다.
 *
 * ★ 방 목록은 전부 {@link RoomRef#key()} 문자열이다 ("계정키\u0001방이름").
 *   저장 타입은 List&lt;String&gt; 그대로라서 옛 설정 파일이 그냥 읽힌다 —
 *   구분자가 없는 옛 값은 {@link RoomRef#parse} 가 기본 계정("0")으로 해석한다.
 *   코드에서는 {@code roomRefs()} / {@code setRoomRefs(...)} 로 다뤄라.
 */
public final class Settings {

    /** 암호화 저장 슬롯 이름 */
    public static final String SLOT = "settings";

    /** 스키마 버전 (읽을 때 참고용. 모르는 값이어도 opt* 라서 안 깨진다) */
    public static final int VERSION = 2;

    public static final int MAX_IMAGES = 5;
    public static final int MAX_TRIGGERS = 30;

    // ── 이미지 첨부 모드 (SPEC 8.4 A) ─────────────────────────────────────────
    /** 예전 저장값. 화면에는 없다. 이미지가 있으면 매번으로, 없으면 보내지 않는다. */
    public static final String IMG_NEVER = "NEVER";
    public static final String IMG_EVERY = "EVERY";      // 매 발송마다
    public static final String IMG_EVERY_N = "EVERY_N";  // N번째 발송마다
    public static final String IMG_MANUAL = "MANUAL";    // 수동 전송만
    public static final String[] IMG_MODES = { IMG_EVERY, IMG_EVERY_N, IMG_MANUAL };

    // ── 자동응답 적용 대상 (SPEC 8.4 B) ───────────────────────────────────────
    public static final String SCOPE_ALL = "ALL";          // 모든 1:1
    public static final String SCOPE_UNKNOWN = "UNKNOWN";  // 모르는 사람만
    public static final String SCOPE_EXCEPT = "EXCEPT";    // 특정 방 제외
    public static final String[] SCOPES = { SCOPE_ALL, SCOPE_UNKNOWN, SCOPE_EXCEPT };

    // ── 트리거 비교 방식 (SPEC 8.4 C) ─────────────────────────────────────────
    public static final String MODE_CONTAINS = "contains";
    public static final String MODE_EXACT = "exact";
    public static final String MODE_STARTS = "startsWith";
    public static final String MODE_REGEX = "regex";
    public static final String[] MODES = { MODE_CONTAINS, MODE_EXACT, MODE_STARTS, MODE_REGEX };

    // ── 미니게임 종류 (SPEC 8.6) ──────────────────────────────────────────────
    public static final String G_WORD = "word";          // 끝말잇기
    public static final String G_BASEBALL = "baseball";  // 숫자야구
    public static final String G_DICE = "dice";          // 주사위
    public static final String G_RPS = "rps";            // 가위바위보
    public static final String G_QUIZ = "quiz";          // 퀴즈
    public static final String[] GAMES = { G_WORD, G_BASEBALL, G_DICE, G_RPS, G_QUIZ };

    // ── v1.8 평문 키 (마이그레이션 원본. 옮긴 뒤엔 지운다) ─────────────────────
    private static final String L_MSG = "K_MSG";
    private static final String L_ROOMS = "K_ROOMS";
    private static final String L_INTERVAL = "K_INTERVAL";
    private static final String L_INTERVAL_MAX = "K_INTERVAL_MAX";
    private static final String L_MINMSG = "K_MINMSG";
    private static final String L_ENABLED = "K_ENABLED";
    private static final String L_NEXT = "K_NEXT";
    private static final String[] LEGACY = {
            L_MSG, L_ROOMS, L_INTERVAL, L_INTERVAL_MAX, L_MINMSG, L_ENABLED, L_NEXT
    };

    // ── 방 키 도구 (RoomRef) ──────────────────────────────────────────────────

    /**
     * 저장된 방 키 목록 → RoomRef 목록.
     * 구분자가 없는 옛 값은 {@link RoomRef#parse} 가 기본 계정("0")으로 채워준다.
     */
    public static ArrayList<RoomRef> refsOf(List<String> keys) {
        ArrayList<RoomRef> out = new ArrayList<RoomRef>();
        if (keys == null) return out;
        HashSet<String> seen = new HashSet<String>();
        for (int i = 0; i < keys.size(); i++) {
            String k = keys.get(i);
            if (k == null || k.trim().length() == 0) continue;
            RoomRef r = RoomRef.parse(k);
            if (r == null) continue;
            String norm = r.key();
            if (norm == null || norm.length() == 0 || !seen.add(norm)) continue;
            out.add(r);
        }
        return out;
    }

    /** RoomRef 목록 → 저장용 키 목록 (중복 제거) */
    public static ArrayList<String> keysOf(List<RoomRef> refs) {
        ArrayList<String> out = new ArrayList<String>();
        if (refs == null) return out;
        for (int i = 0; i < refs.size(); i++) {
            RoomRef r = refs.get(i);
            if (r == null) continue;
            String k = r.key();
            if (k == null || k.length() == 0 || out.contains(k)) continue;
            out.add(k);
        }
        return out;
    }

    /** 저장된 키 목록 안에 이 방이 있나. 구분자 없는 옛 값도 같은 방으로 본다. */
    public static boolean hasRoom(List<String> keys, RoomRef room) {
        if (keys == null || room == null) return false;
        String want = room.key();
        if (want == null) return false;
        for (int i = 0; i < keys.size(); i++) {
            String k = keys.get(i);
            if (k == null || k.trim().length() == 0) continue;
            RoomRef r = RoomRef.parse(k);
            if (r != null && want.equals(r.key())) return true;
        }
        return false;
    }

    // ── 모델 ──────────────────────────────────────────────────────────────────

    /** 자동발송 매크로 (SPEC 8.4 A) */
    public static final class Macro {
        public boolean enabled = false;
        /** 보낼 메시지. 여러 줄 허용. */
        public String message = "";
        /**
         * 발송 대상 방 — {@link RoomRef#key()} 목록.
         * 구분자 없는 옛 값(방 이름만)은 기본 계정("0")으로 읽힌다.
         */
        public List<String> rooms = new ArrayList<String>();
        /** 기본 발송 간격(분). 방별 값이 없을 때 이 값을 쓴다. 화면에는 ~N분 으로 표시한다. */
        public int baseMin = 1;
        /** 기본 간격에 더하는 랜덤 쿨타임(분). 0 이면 더하지 않는다. 실제 대기는 0분부터 이 값까지. */
        public int randomMin = 0;
        /**
         * 방별 쿨타임(분). 키는 {@link RoomRef#key()}.
         * 없거나 0 이면 {@link #baseMin} 에 {@link #randomMin} 을 더한 간격을 쓴다.
         */
        public Map<String, Integer> roomCooldownMin = new HashMap<String, Integer>();
        /**
         * 방별 다음 발송 가능 시각 (epoch ms). 키는 {@link RoomRef#key()}.
         * 0 이거나 없으면 아직 쿨타임이 시작되지 않은 것이다.
         */
        public Map<String, Long> roomDueAt = new HashMap<String, Long>();
        /** 방별 마지막 발송 시각 (epoch ms). 쿨타임을 바꾸면 이 시각부터 다시 계산한다. */
        public Map<String, Long> roomLastSent = new HashMap<String, Long>();
        /** 마지막 발송 뒤 방에 새 메시지가 이만큼 올라와야 다시 보낸다 (도배 방지) */
        public int minMessages = 1;
        /** 다음 알람 시각 (epoch ms). 방별 쿨타임 중 가장 빠른 시각. 0 이면 아직 안 잡힘. */
        public long nextAt = 0L;
        /** 이미지 첨부 모드 — IMG_MODES 중 하나. 이미지가 없으면 보내지 않는다. */
        public String sendImages = IMG_EVERY;
        /** EVERY_N 일 때 몇 번째 발송마다 붙일지 */
        public int imageEveryN = 3;
        /** 첨부 이미지 URI (최대 5장) */
        public List<String> images = new ArrayList<String>();
        /** 방해금지 시작/끝 "HH:mm". 빈 값이면 없음. */
        public String quietFrom = "";
        public String quietTo = "";
        /** 하루 최대 발송 수 */
        public int dailyLimit = 200;

        /** 발송 대상 방 (RoomRef 목록) */
        public List<RoomRef> roomRefs() {
            return refsOf(rooms);
        }

        /** 발송 대상 방을 통째로 교체. 목록에서 빠진 방의 쿨타임도 함께 지운다. */
        public void setRoomRefs(List<RoomRef> list) {
            rooms = keysOf(list);
            HashSet<String> keep = new HashSet<String>();
            for (int i = 0; i < rooms.size(); i++) keep.add(rooms.get(i));
            dropMissing(roomCooldownMin, keep);
            dropMissing(roomDueAt, keep);
            dropMissing(roomLastSent, keep);
        }

        /** 이 방에 마지막으로 발송한 시각. 0 이면 아직 없다. */
        public long lastSent(RoomRef room) {
            if (room == null) return 0L;
            Long v = roomLastSent.get(room.key());
            return (v == null) ? 0L : v.longValue();
        }

        public void setLastSent(RoomRef room, long at) {
            if (room == null || !room.valid()) return;
            if (at <= 0L) roomLastSent.remove(room.key());
            else roomLastSent.put(room.key(), Long.valueOf(at));
        }

        /** 이 방의 지정 쿨타임(분). 0 이면 기본 간격을 쓴다. */
        public int cooldownMin(RoomRef room) {
            if (room == null) return 0;
            Integer v = roomCooldownMin.get(room.key());
            if (v == null || v.intValue() < 1) return 0;
            return v.intValue();
        }

        /** 방별 쿨타임을 저장한다. 1분 미만이면 기본 간격으로 되돌린다. */
        public void setCooldownMin(RoomRef room, int minutes) {
            if (room == null || !room.valid()) return;
            if (minutes < 1) roomCooldownMin.remove(room.key());
            else roomCooldownMin.put(room.key(), Integer.valueOf(Math.min(1440, minutes)));
        }

        /** 이 방을 다시 보낼 수 있는 시각. 0 이면 쿨타임이 없다. */
        public long dueAt(RoomRef room) {
            if (room == null) return 0L;
            Long v = roomDueAt.get(room.key());
            return (v == null) ? 0L : v.longValue();
        }

        /** 방별 다음 발송 시각을 기록한다. 0 이하면 지운다. */
        public void setDueAt(RoomRef room, long at) {
            if (room == null || !room.valid()) return;
            if (at <= 0L) roomDueAt.remove(room.key());
            else roomDueAt.put(room.key(), Long.valueOf(at));
        }

        /** 목록에 보여줄 쿨타임. 방 값이 없으면 기본 발송 쿨타임을 쓴다고 적는다. */
        public String cooldownLabel(RoomRef room) {
            int own = cooldownMin(room);
            if (own > 0) return "이 방 " + own + "분";
            return "기본 발송 쿨타임 " + baseText();
        }

        /** 기본 간격 표시. 예: ~1분 */
        public String baseText() {
            return "~" + Math.max(1, baseMin) + "분";
        }

        /** 랜덤 쿨타임 표시. 0분이면 더하지 않는다. */
        public String randomText() {
            return Math.max(0, randomMin) + "분";
        }

        /**
         * 이 발송 뒤에 적용할 쿨타임.
         * 방에 값이 있으면 그 분 수. 없으면 기본 간격에 0분부터 랜덤 쿨타임까지를 더한다.
         */
        public long cooldownMs(RoomRef room) {
            int own = cooldownMin(room);
            if (own > 0) return (long) own * 60000L;
            int base = Math.max(1, baseMin);
            int extra = 0;
            int span = Math.max(0, randomMin);
            if (span > 0) extra = (int) Math.floor(Math.random() * (span + 1));
            return (long) (base + extra) * 60000L;
        }

        /** 목록에 없는 방의 저장값을 지운다. */
        private static void dropMissing(Map<String, ?> map, HashSet<String> keep) {
            Iterator<String> it = map.keySet().iterator();
            while (it.hasNext()) {
                if (!keep.contains(it.next())) it.remove();
            }
        }

        /** 이 방이 발송 대상인가 */
        public boolean coversRoom(RoomRef room) {
            return hasRoom(rooms, room);
        }

        /** 이미지 추가. 5장 넘거나 중복이면 false. */
        public boolean addImage(String uri) {
            if (uri == null || uri.trim().length() == 0) return false;
            String u = uri.trim();
            if (images.contains(u)) return false;
            if (images.size() >= MAX_IMAGES) return false;
            images.add(u);
            return true;
        }

        /** 목록 통째로 교체. 5장까지만 남긴다. */
        public void setImages(List<String> list) {
            images = clampStrings(list, MAX_IMAGES);
        }

        /** 이번 발송(sendCount 번째, 1부터)에 이미지를 붙여야 하나 */
        public boolean imagesThisTime(int sendCount) {
            if (images.isEmpty()) return false;
            String mode = IMG_NEVER.equals(sendImages) ? IMG_EVERY : sendImages;
            if (IMG_EVERY.equals(mode)) return true;
            if (IMG_EVERY_N.equals(mode)) {
                int n = (imageEveryN < 1) ? 1 : imageEveryN;
                return sendCount > 0 && sendCount % n == 0;
            }
            return false;   // MANUAL
        }

        /** 방해금지 시간대인가 (자정 넘김도 처리). 설정이 없으면 항상 false. */
        public boolean inQuiet(long atMillis) {
            int from = hhmm(quietFrom);
            int to = hhmm(quietTo);
            if (from < 0 || to < 0 || from == to) return false;
            int now = minuteOfDay(atMillis);
            if (from < to) return now >= from && now < to;
            return now >= from || now < to;    // 22:00 ~ 07:00
        }

        /** 기본 간격으로 다음 시각을 잡는다. 방별 쿨타임이 있으면 {@link #cooldownMs} 를 쓴다. */
        public long pickNextAt(long fromMillis) {
            return fromMillis + cooldownMs(null);
        }
    }

    /** 오픈프로필 개인톡 자동응답 (SPEC 8.4 B) */
    public static final class AutoReplyCfg {
        public boolean enabled = false;
        /** 응답 메시지. 여러 줄 허용. {이름} {시간} {날짜} 치환. */
        public String message = "";
        /** SCOPE_* 중 하나 */
        public String scope = SCOPE_ALL;
        /** scope=EXCEPT 일 때 제외할 방(사람) — {@link RoomRef#key()} 목록 */
        public List<String> exceptRooms = new ArrayList<String>();
        /** 같은 사람에게 다시 응답하기까지 최소 간격 (기본 6시간) */
        public long cooldownMs = 6 * 3600 * 1000L;
        /** 하루 최대 응답 수 */
        public int dailyLimit = 100;
        /** 운영시간 (시 단위). 0~24 면 24시간. */
        public int hourFrom = 0;
        public int hourTo = 24;
        /** 그 사람의 첫 메시지에만 응답 */
        public boolean firstOnly = false;
        /** 랜덤 지연 상한 (ms). 봇처럼 안 보이게. */
        public int delayMaxMs = 30000;

        /** 지금(시각 hour) 응답해도 되는 시간인가 */
        public boolean inHours(int hour) {
            int f = clamp(hourFrom, 0, 24);
            int t = clamp(hourTo, 0, 24);
            if (f == t) return true;                       // 0~0, 9~9 → 제한 없음
            if (f == 0 && t == 24) return true;
            if (f < t) return hour >= f && hour < t;
            return hour >= f || hour < t;                  // 22시~6시
        }

        public boolean inHours(long atMillis) {
            return inHours(hourOf(atMillis));
        }

        /** 제외 방 (RoomRef 목록) */
        public List<RoomRef> exceptRoomRefs() {
            return refsOf(exceptRooms);
        }

        /** 제외 방을 통째로 교체 */
        public void setExceptRoomRefs(List<RoomRef> list) {
            exceptRooms = keysOf(list);
        }

        /** 이 방(사람)에게 응답 대상인가. unknown = 내 방 목록에 없는 상대. */
        public boolean coversRoom(RoomRef room, boolean unknown) {
            if (SCOPE_UNKNOWN.equals(scope)) return unknown;
            if (SCOPE_EXCEPT.equals(scope)) {
                if (room == null) return true;
                return !hasRoom(exceptRooms, room);
            }
            return true;   // ALL
        }

        /** {이름} {시간} {날짜} 치환 */
        public String render(String name, long atMillis) {
            String out = (message == null) ? "" : message;
            out = out.replace("{이름}", (name == null) ? "" : name);
            out = out.replace("{시간}", clock(atMillis));
            out = out.replace("{날짜}", date(atMillis));
            return out;
        }
    }

    /** 경쟁사 저격 = 키워드 트리거 (SPEC 8.4 C) */
    public static final class TriggerCfg {
        /** 목록에서 이 규칙을 가리키는 고정 id (쿨다운 상태 저장 키로도 쓴다) */
        public String id = Crypto.randomHex(5);
        public String name = "";
        /** 감지 문자열 */
        public String pattern = "";
        /** MODE_* 중 하나 */
        public String mode = MODE_CONTAINS;
        public boolean ignoreCase = true;
        /** 빈 목록 = 모든 방. 값은 {@link RoomRef#key()}. */
        public List<String> rooms = new ArrayList<String>();
        /** 내 메시지도 감지할지 */
        public boolean fromMe = false;
        /** 보낼 메시지. {방} {이름} {메시지} {시간} 치환. */
        public String reply = "";
        /**
         * 빈 값 = 감지된 방으로 / 지정하면 그 방으로.
         * {@link RoomRef#key()} 를 넣으면 그 계정의 방으로, 방 이름만 넣으면 감지된 방과 같은 계정으로 보낸다.
         */
        public String target = "";
        /** 0~60000 랜덤 지연 상한 */
        public int delayMs = 0;
        /** 같은 트리거 재발동 최소 간격 */
        public long cooldownMs = 60000L;
        /** 방마다 한 번만 발동 */
        public boolean oncePerRoom = false;
        public boolean enabled = true;

        /** 감지 대상 방 (RoomRef 목록). 빈 목록이면 모든 방. */
        public List<RoomRef> roomRefs() {
            return refsOf(rooms);
        }

        /** 감지 대상 방을 통째로 교체 */
        public void setRoomRefs(List<RoomRef> list) {
            rooms = keysOf(list);
        }

        /** 이 방에서 감지 대상인가 (빈 목록 = 모든 방) */
        public boolean coversRoom(RoomRef room) {
            if (rooms.isEmpty()) return true;
            if (room == null) return false;
            return hasRoom(rooms, room);
        }

        /** 메시지가 이 규칙에 걸리나. 정규식이 깨져 있으면 false. */
        public boolean matches(String msg) {
            if (msg == null || pattern == null || pattern.length() == 0) return false;
            String m = msg;
            String p = pattern;
            if (MODE_REGEX.equals(mode)) {
                try {
                    int flags = ignoreCase ? (Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE) : 0;
                    return Pattern.compile(p, flags).matcher(m).find();
                } catch (Throwable t) {
                    return false;
                }
            }
            if (ignoreCase) {
                m = m.toLowerCase(Locale.getDefault());
                p = p.toLowerCase(Locale.getDefault());
            }
            if (MODE_EXACT.equals(mode)) return m.trim().equals(p.trim());
            if (MODE_STARTS.equals(mode)) return m.startsWith(p);
            return m.contains(p);
        }

        /** 저장 전 검사. 문제가 없으면 null, 있으면 사용자에게 보여줄 한국어 문장. */
        public String validate() {
            if (pattern == null || pattern.trim().length() == 0) return "감지할 문자열을 입력하십시오.";
            if (reply == null || reply.trim().length() == 0) return "발송할 메시지를 입력하십시오.";
            if (MODE_REGEX.equals(mode)) {
                try {
                    Pattern.compile(pattern);
                } catch (Throwable t) {
                    String why = t.getMessage();
                    return "정규식 형식이 올바르지 않습니다."
                            + ((why == null) ? "" : (" (" + why.replace('\n', ' ') + ")"));
                }
            }
            if (delayMs < 0 || delayMs > 60000) return "지연 시간은 0~60초 범위로 입력하십시오.";
            return null;
        }

        /** {방} {이름} {메시지} {시간} 치환 */
        public String render(String room, String name, String msg, long atMillis) {
            String out = (reply == null) ? "" : reply;
            out = out.replace("{방}", (room == null) ? "" : room);
            out = out.replace("{이름}", (name == null) ? "" : name);
            out = out.replace("{메시지}", (msg == null) ? "" : msg);
            out = out.replace("{시간}", clock(atMillis));
            return out;
        }

        /** 표시용 이름 (비어있으면 패턴으로 대체) */
        public String title() {
            if (name != null && name.trim().length() > 0) return name.trim();
            if (pattern != null && pattern.trim().length() > 0) return pattern.trim();
            return "이름 없음";
        }
    }

    /** 방 관리봇 (SPEC 8.5). 카톡은 외부 앱이 강제퇴장을 못 한다 → 경고 + 관리자 호출만 한다. */
    public static final class RoomBotCfg {
        public boolean enabled = false;
        /**
         * 빈 목록 = 동작 안 함 (실수로 모든 방에 봇이 도는 걸 막는다).
         * 값은 {@link RoomRef#key()}.
         */
        public List<String> rooms = new ArrayList<String>();
        public boolean welcomeOn = false;
        public String welcomeMsg = "";
        public boolean leaveOn = false;
        public String leaveMsg = "";
        /** 금지어 목록 */
        public List<String> banWords = new ArrayList<String>();
        /** 금지어 걸렸을 때 보낼 경고 */
        public String warnMsg = "";
        /** floodSecs 초 안에 floodCount 개를 넘기면 도배로 본다 */
        public int floodCount = 5;
        public int floodSecs = 10;
        public String floodMsg = "";
        /** 링크/초대 차단 */
        public boolean blockLinks = false;
        public String linkMsg = "";
        /** !공지 로 뿌릴 공지문 */
        public String notice = "";
        /** 명령 접두사 */
        public String cmdPrefix = "!";
        /** 관리자 이름 (경고 누적 시 호출) */
        public List<String> adminNames = new ArrayList<String>();
        /** 하루 최대 봇 발송 수 */
        public int dailyLimit = 300;

        /** 봇이 도는 방 (RoomRef 목록) */
        public List<RoomRef> roomRefs() {
            return refsOf(rooms);
        }

        /** 봇이 도는 방을 통째로 교체 */
        public void setRoomRefs(List<RoomRef> list) {
            rooms = keysOf(list);
        }

        public boolean coversRoom(RoomRef room) {
            return hasRoom(rooms, room);
        }

        /** 걸린 금지어를 돌려준다. 없으면 null. */
        public String hitBanWord(String msg) {
            if (msg == null || banWords.isEmpty()) return null;
            String m = msg.toLowerCase(Locale.getDefault());
            for (int i = 0; i < banWords.size(); i++) {
                String w = banWords.get(i);
                if (w == null) continue;
                w = w.trim();
                if (w.length() == 0) continue;
                if (m.contains(w.toLowerCase(Locale.getDefault()))) return w;
            }
            return null;
        }

        public boolean isAdmin(String name) {
            if (name == null) return false;
            String n = name.trim();
            for (int i = 0; i < adminNames.size(); i++) {
                if (n.equals(adminNames.get(i).trim())) return true;
            }
            return false;
        }
    }

    /** 미니게임봇 (SPEC 8.6) */
    public static final class MiniGameCfg {
        public boolean enabled = false;
        /** 빈 목록 = 동작 안 함. 값은 {@link RoomRef#key()}. */
        public List<String> rooms = new ArrayList<String>();
        public String cmdPrefix = "!";
        public boolean word = true;       // 끝말잇기
        public boolean baseball = true;   // 숫자야구
        public boolean dice = true;       // 주사위
        public boolean rps = true;        // 가위바위보
        public boolean quiz = true;       // 퀴즈
        /** 봇 응답 최소 간격 */
        public long cooldownMs = 3000L;
        /** 하루 최대 봇 발송 수 */
        public int dailyLimit = 300;

        /** 봇이 도는 방 (RoomRef 목록) */
        public List<RoomRef> roomRefs() {
            return refsOf(rooms);
        }

        /** 봇이 도는 방을 통째로 교체 */
        public void setRoomRefs(List<RoomRef> list) {
            rooms = keysOf(list);
        }

        public boolean coversRoom(RoomRef room) {
            return hasRoom(rooms, room);
        }

        public boolean gameOn(String id) {
            if (G_WORD.equals(id)) return word;
            if (G_BASEBALL.equals(id)) return baseball;
            if (G_DICE.equals(id)) return dice;
            if (G_RPS.equals(id)) return rps;
            if (G_QUIZ.equals(id)) return quiz;
            return false;
        }

        public void setGame(String id, boolean on) {
            if (G_WORD.equals(id)) word = on;
            else if (G_BASEBALL.equals(id)) baseball = on;
            else if (G_DICE.equals(id)) dice = on;
            else if (G_RPS.equals(id)) rps = on;
            else if (G_QUIZ.equals(id)) quiz = on;
        }
    }

    /** 게임 id → 한글 이름 */
    public static String gameLabel(String id) {
        if (G_WORD.equals(id)) return "끝말잇기";
        if (G_BASEBALL.equals(id)) return "숫자야구";
        if (G_DICE.equals(id)) return "주사위";
        if (G_RPS.equals(id)) return "가위바위보";
        if (G_QUIZ.equals(id)) return "퀴즈";
        return "";
    }

    /** 게임 id → 명령어 (접두사 제외) */
    public static String gameCmd(String id) {
        return gameLabel(id);
    }

    // ── 최상위 필드 ───────────────────────────────────────────────────────────

    /** 방 관리봇. 고른 방에서만 동작하고, 항목마다 켜짐이 따로다. */
    public static final class GuardCfg {
        public List<String> rooms = new ArrayList<String>();
        public boolean presenceOn = false;
        public int presenceMin = 30;
        public boolean kickOn = false;
        public int kickCount = 5;
        public int kickSecs = 30;
        public boolean floodOn = false;
        public int floodCount = 8;
        public int floodSecs = 10;
        public int floodSlowSecs = 60;
        public String floodText = "";
        public boolean churnOn = false;
        public int churnCount = 8;
        public int churnSecs = 20;
        public int churnQuietSecs = 120;
        public String churnText = "";
        public boolean welcomeOn = false;
        public String welcomeText = "";
        public boolean noticeOn = false;
        public String noticeText = "";
        public int noticeMin = 60;

        public List<RoomRef> roomRefs() { return refsOf(rooms); }

        public void setRoomRefs(List<RoomRef> list) { rooms = keysOf(list); }

        public int enabledCount() {
            int n = 0;
            if (presenceOn) n++;
            if (kickOn) n++;
            if (floodOn) n++;
            if (churnOn) n++;
            if (welcomeOn) n++;
            if (noticeOn) n++;
            return n;
        }
    }

    public Macro macro = new Macro();
    public AutoReplyCfg autoreply = new AutoReplyCfg();
    public List<TriggerCfg> triggers = new ArrayList<TriggerCfg>();
    public RoomBotCfg roombot = new RoomBotCfg();
    public MiniGameCfg minigame = new MiniGameCfg();
    public GuardCfg guard = new GuardCfg();

    /**
     * 대상 카카오톡 계정 키 목록 (듀얼 메신저 등 다중 계정).
     *
     * <b>비어 있으면 모든 계정이 대상이다.</b> 기존 사용자는 이 값이 없으니 자동으로 전부 포함된다 —
     * 계정 축을 추가했다고 발송이 멈추면 안 된다. 사용자가 계정을 골라야 목록이 채워진다.
     */
    public List<String> accounts = new ArrayList<String>();

    /**
     * 이 계정이 발송·봇 대상인가. 목록이 비어 있으면 항상 true (전체 계정).
     * 계정 키를 못 읽는 기기는 기본 계정 "0" 으로 취급한다.
     */
    public boolean accountOn(String acc) {
        if (accounts == null || accounts.isEmpty()) return true;
        String a = (acc == null || acc.trim().length() == 0) ? "0" : acc.trim();
        for (int i = 0; i < accounts.size(); i++) {
            String k = accounts.get(i);
            if (k == null) continue;
            if (a.equals(k.trim())) return true;
        }
        return false;
    }

    /** 지름길 — 설정을 읽어서 계정 사용 여부만 본다 */
    public static boolean accountOn(Context c, String acc) {
        try {
            return load(c).accountOn(acc);
        } catch (Throwable t) {
            return true;
        }
    }

    /** 대상 계정 목록을 통째로 교체 (빈 목록 = 전체 계정) */
    public void setAccounts(List<String> list) {
        accounts = clampStrings(list, 32);
    }

    // ── 캐시 + 불러오기/저장 ──────────────────────────────────────────────────

    /** 리스너 서비스가 알림마다 읽으니까 매번 복호화하지 않고 캐시한다 */
    private static volatile Settings cached;
    private static volatile String cachedFor;

    /** 기본값 인스턴스 */
    public static Settings defaults() {
        return new Settings();
    }

    /** 캐시를 버린다. 다른 곳에서 설정을 갈아치웠거나 설정키가 바뀌었으면 호출. */
    public static void invalidate() {
        cached = null;
        cachedFor = null;
    }

    /** 지금 고른 카카오 계정의 설정 슬롯. */
    public static String slotName(Context c) {
        String id = KakaoSlots.selectedId(c);
        if (id == null || id.length() == 0) return SLOT;
        return SLOT + "." + id;
    }

    /** 계정을 바꾸기 전의 설정 파일을 그 계정 슬롯으로 옮긴다. 옛 키는 지우지 않는다. */
    public static void adoptLegacy(Context c, String slotId) {
        if (c == null || slotId == null || slotId.length() == 0) return;
        String key = SLOT + "." + slotId;
        String have = Prefs.secGet(c, key);
        if (have != null && have.length() > 0) return;
        String old = Prefs.secGet(c, SLOT);
        if (old != null && old.length() > 0) Prefs.secPut(c, key, old);
    }

    public static void dropSlot(Context c, String slotId) {
        if (c == null || slotId == null || slotId.length() == 0) return;
        try { Prefs.secRemove(c, SLOT + "." + slotId); } catch (Throwable ignore) { }
    }

    /** 화면 캐시를 건드리지 않고 그 계정의 설정만 읽는다. */
    public static Settings readSlot(Context c, String slotId) {
        String sel = KakaoSlots.selectedId(c);
        if (slotId != null && slotId.equals(sel)) return load(c);
        String key = (slotId == null || slotId.length() == 0) ? SLOT : (SLOT + "." + slotId);
        try {
            String raw = Prefs.secGet(c, key);
            if (raw != null && raw.length() > 0) {
                Settings out = fromJson(raw);
                if (out != null) return out;
            }
        } catch (Throwable ignore) { }
        return defaults();
    }

    /**
     * 설정을 읽는다. 복호화 실패/없음이면 기본값.
     * 암호화 설정이 없고 v1.8 평문 설정이 남아있으면 그걸 옮겨온다.
     */
    public static Settings load(Context c) {
        String slot = (c == null) ? SLOT : slotName(c);
        Settings s = cached;
        if (s != null && slot.equals(cachedFor)) return s;
        if (c == null) return defaults();
        synchronized (Settings.class) {
            if (cached != null && slot.equals(cachedFor)) return cached;
            Settings out = null;
            try {
                String raw = Prefs.secGet(c, slot);
                if ((raw == null || raw.length() == 0) && !SLOT.equals(slot)) raw = Prefs.secGet(c, SLOT);
                if (raw != null && raw.length() > 0) {
                    out = fromJson(raw);
                    if (out == null) Log.add(c, "설정 파일이 손상되어 기본값으로 시작합니다.");
                }
            } catch (Throwable t) {
                Log.add(c, "설정 읽기에 실패했습니다. 기본값으로 시작합니다. (" + t + ")");
                out = null;
            }
            if (out == null) out = migrate(c);
            cached = out;
            cachedFor = slot;
            return out;
        }
    }

    /** 설정을 저장할 수 있는 상태인가 (= 라이선스 인증을 통과해 설정키가 있는가) */
    public static boolean canSave(Context c) {
        if (c == null) return false;
        try {
            return Prefs.secReady(c);
        } catch (Throwable t) {
            return false;
        }
    }

    /**
     * 이 인스턴스를 암호화 저장하고 캐시로 올린다.
     * 설정키가 없으면 저장이 안 된다 — 조용히 넘기지 않고 로그로 알린다.
     * (secHas 만 보면 예전 blob 이 남아있을 때 "저장됨"으로 착각한다 → 반드시 다시 읽어서 확인)
     */
    /**
     * 설정을 저장한다. 저장에 성공했으면 true.
     *
     * 라이선스 인증 전에는 설정키가 없어 저장이 불가능한데, 예전에는 로그만 남기고 조용히 넘어가서
     * 화면에는 바뀐 값이 그대로 보였다. 프로세스가 죽으면 그대로 사라진다.
     * 호출부는 반환값을 보고 사용자에게 알려야 한다.
     */
    public boolean save(Context c) {
        if (c == null) return false;
        cached = this;
        try {
            if (!Prefs.secReady(c)) {
                Log.add(c, "설정을 저장하지 못했습니다. 설정키가 없습니다 — 내정보 탭에서 라이선스 인증을 먼저 진행하십시오.");
                return false;
            }
            String json = toJson();
            String slot = slotName(c);
            Prefs.secPut(c, slot, json);
            cachedFor = slot;
            String back = Prefs.secGet(c, slot);
            if (back == null || !back.equals(json)) {
                Log.add(c, "설정 저장을 확인하지 못했습니다. 다시 저장하십시오.");
                return false;
            }
            try { com.buseong.kakaoauto.engine.SenderSync.onSettingsSaved(c); } catch (Throwable ignore) { }
            return true;
        } catch (Throwable t) {
            Log.add(c, "설정 저장에 실패했습니다. (" + t + ")");
        }
        return false;
    }

    /** 캐시에 들어있는 설정을 그대로 저장 (Settings.macro(ctx) 로 고친 뒤 부르면 된다) */
    public static void flush(Context c) {
        Settings s = cached;
        if (s == null) s = load(c);
        if (s != null) s.save(c);
        try { com.buseong.kakaoauto.engine.LocoInbox.ensure(c); } catch (Throwable ignore) { }
    }

    /** 라이선스 인증 직후 호출: 설정키가 생겼으니 옛 평문 설정을 옮기고 암호화 저장해둔다. */
    public static void afterLicense(Context c) {
        if (c == null) return;
        invalidate();
        Settings s = load(c);
        if (!Prefs.secHas(c, SLOT)) s.save(c);
    }

    // 자주 쓰는 지름길 (리스너/엔진에서 한 줄로 읽게)
    public static Macro macro(Context c) { return load(c).macro; }
    public static AutoReplyCfg autoreply(Context c) { return load(c).autoreply; }
    public static RoomBotCfg roombot(Context c) { return load(c).roombot; }
    public static MiniGameCfg minigame(Context c) { return load(c).minigame; }
    public static List<TriggerCfg> triggers(Context c) { return load(c).triggers; }

    // 카멜케이스로 부르는 쪽도 있을 테니 같은 걸 이름만 바꿔서 하나 더
    public static AutoReplyCfg autoReply(Context c) { return load(c).autoreply; }
    public static RoomBotCfg roomBot(Context c) { return load(c).roombot; }
    public static MiniGameCfg miniGame(Context c) { return load(c).minigame; }

    /** 트리거 추가. 30개를 넘으면 안내문을 돌려준다(성공이면 null). */
    public String addTrigger(TriggerCfg t) {
        if (t == null) return "규칙 내용이 비어 있습니다.";
        if (triggers.size() >= MAX_TRIGGERS) return "규칙은 최대 " + MAX_TRIGGERS + "개까지 등록됩니다.";
        String bad = t.validate();
        if (bad != null) return bad;
        triggers.add(t);
        return null;
    }

    public TriggerCfg triggerById(String id) {
        if (id == null) return null;
        for (int i = 0; i < triggers.size(); i++) {
            TriggerCfg t = triggers.get(i);
            if (t != null && id.equals(t.id)) return t;
        }
        return null;
    }

    public boolean removeTrigger(String id) {
        if (id == null) return false;
        for (int i = 0; i < triggers.size(); i++) {
            TriggerCfg t = triggers.get(i);
            if (t != null && id.equals(t.id)) { triggers.remove(i); return true; }
        }
        return false;
    }

    // ── JSON ──────────────────────────────────────────────────────────────────

    public String toJson() {
        try {
            JSONObject o = new JSONObject();
            o.put("v", VERSION);
            o.put("accounts", arr(accounts));

            JSONObject m = new JSONObject();
            m.put("enabled", macro.enabled);
            m.put("message", macro.message);
            m.put("rooms", arr(macro.rooms));
            m.put("baseMin", macro.baseMin);
            m.put("randomMin", macro.randomMin);
            m.put("minMessages", macro.minMessages);
            m.put("nextAt", macro.nextAt);
            m.put("sendImages", macro.sendImages);
            m.put("imageEveryN", macro.imageEveryN);
            m.put("images", arr(macro.images));
            m.put("quietFrom", macro.quietFrom);
            m.put("quietTo", macro.quietTo);
            m.put("dailyLimit", macro.dailyLimit);
            m.put("roomCooldownMin", intMap(macro.roomCooldownMin));
            m.put("roomDueAt", longMap(macro.roomDueAt));
            m.put("roomLastSent", longMap(macro.roomLastSent));
            o.put("macro", m);

            JSONObject a = new JSONObject();
            a.put("enabled", autoreply.enabled);
            a.put("message", autoreply.message);
            a.put("scope", autoreply.scope);
            a.put("exceptRooms", arr(autoreply.exceptRooms));
            a.put("cooldownMs", autoreply.cooldownMs);
            a.put("dailyLimit", autoreply.dailyLimit);
            a.put("hourFrom", autoreply.hourFrom);
            a.put("hourTo", autoreply.hourTo);
            a.put("firstOnly", autoreply.firstOnly);
            a.put("delayMaxMs", autoreply.delayMaxMs);
            o.put("autoreply", a);

            JSONArray ta = new JSONArray();
            for (int i = 0; i < triggers.size(); i++) {
                TriggerCfg t = triggers.get(i);
                if (t == null) continue;
                JSONObject j = new JSONObject();
                j.put("id", t.id);
                j.put("name", t.name);
                j.put("pattern", t.pattern);
                j.put("mode", t.mode);
                j.put("ignoreCase", t.ignoreCase);
                j.put("rooms", arr(t.rooms));
                j.put("fromMe", t.fromMe);
                j.put("reply", t.reply);
                j.put("target", t.target);
                j.put("delayMs", t.delayMs);
                j.put("cooldownMs", t.cooldownMs);
                j.put("oncePerRoom", t.oncePerRoom);
                j.put("enabled", t.enabled);
                ta.put(j);
            }
            o.put("triggers", ta);

            JSONObject r = new JSONObject();
            r.put("enabled", roombot.enabled);
            r.put("rooms", arr(roombot.rooms));
            r.put("welcomeOn", roombot.welcomeOn);
            r.put("welcomeMsg", roombot.welcomeMsg);
            r.put("leaveOn", roombot.leaveOn);
            r.put("leaveMsg", roombot.leaveMsg);
            r.put("banWords", arr(roombot.banWords));
            r.put("warnMsg", roombot.warnMsg);
            r.put("floodCount", roombot.floodCount);
            r.put("floodSecs", roombot.floodSecs);
            r.put("floodMsg", roombot.floodMsg);
            r.put("blockLinks", roombot.blockLinks);
            r.put("linkMsg", roombot.linkMsg);
            r.put("notice", roombot.notice);
            r.put("cmdPrefix", roombot.cmdPrefix);
            r.put("adminNames", arr(roombot.adminNames));
            r.put("dailyLimit", roombot.dailyLimit);
            o.put("roombot", r);

            JSONObject g = new JSONObject();
            g.put("enabled", minigame.enabled);
            g.put("rooms", arr(minigame.rooms));
            g.put("cmdPrefix", minigame.cmdPrefix);
            g.put("word", minigame.word);
            g.put("baseball", minigame.baseball);
            g.put("dice", minigame.dice);
            g.put("rps", minigame.rps);
            g.put("quiz", minigame.quiz);
            g.put("cooldownMs", minigame.cooldownMs);
            g.put("dailyLimit", minigame.dailyLimit);
            o.put("minigame", g);

            JSONObject gd = new JSONObject();
            gd.put("rooms", arr(guard.rooms));
            gd.put("presenceOn", guard.presenceOn);
            gd.put("presenceMin", guard.presenceMin);
            gd.put("kickOn", guard.kickOn);
            gd.put("kickCount", guard.kickCount);
            gd.put("kickSecs", guard.kickSecs);
            gd.put("floodOn", guard.floodOn);
            gd.put("floodCount", guard.floodCount);
            gd.put("floodSecs", guard.floodSecs);
            gd.put("floodSlowSecs", guard.floodSlowSecs);
            gd.put("floodText", guard.floodText);
            gd.put("churnOn", guard.churnOn);
            gd.put("churnCount", guard.churnCount);
            gd.put("churnSecs", guard.churnSecs);
            gd.put("churnQuietSecs", guard.churnQuietSecs);
            gd.put("churnText", guard.churnText);
            gd.put("welcomeOn", guard.welcomeOn);
            gd.put("welcomeText", guard.welcomeText);
            gd.put("noticeOn", guard.noticeOn);
            gd.put("noticeText", guard.noticeText);
            gd.put("noticeMin", guard.noticeMin);
            o.put("guard", gd);

            return o.toString();
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "설정 직렬화 실패", t);
            return "{}";
        }
    }

    /** JSON → 설정. 없는 키는 기본값을 유지한다. 해석 자체가 안 되면 null. */
    public static Settings fromJson(String json) {
        if (json == null || json.trim().length() == 0) return null;
        JSONObject o;
        try {
            o = new JSONObject(json);
        } catch (Throwable t) {
            return null;
        }
        Settings s = new Settings();

        // 키가 없으면 빈 목록 그대로 = 전체 계정 대상 (기존 사용자가 자동으로 전부 포함된다)
        s.accounts = list(o, "accounts");

        JSONObject m = o.optJSONObject("macro");
        if (m != null) {
            s.macro.enabled = m.optBoolean("enabled", s.macro.enabled);
            s.macro.message = str(m, "message", s.macro.message);
            s.macro.rooms = list(m, "rooms");
            if (m.has("baseMin") || m.has("randomMin")) {
                s.macro.baseMin = clamp(m.optInt("baseMin", s.macro.baseMin), 1, 1440);
                s.macro.randomMin = clamp(m.optInt("randomMin", s.macro.randomMin), 0, 1440);
            } else if (m.has("intervalMinMin") || m.has("intervalMaxMin")) {
                int lo = clamp(m.optInt("intervalMinMin", 1), 1, 1440);
                int hi = clamp(m.optInt("intervalMaxMin", lo), 1, 1440);
                if (hi < lo) hi = lo;
                s.macro.baseMin = lo;
                s.macro.randomMin = hi - lo;
            }
            s.macro.minMessages = clamp(m.optInt("minMessages", s.macro.minMessages), 0, 999);
            s.macro.nextAt = m.optLong("nextAt", s.macro.nextAt);
            String imgMode = str(m, "sendImages", s.macro.sendImages);
            if (IMG_NEVER.equals(imgMode)) imgMode = IMG_EVERY;
            s.macro.sendImages = oneOf(imgMode, IMG_MODES, IMG_EVERY);
            s.macro.imageEveryN = clamp(m.optInt("imageEveryN", s.macro.imageEveryN), 1, 99);
            s.macro.images = clampStrings(list(m, "images"), MAX_IMAGES);
            s.macro.quietFrom = hhmmOrEmpty(str(m, "quietFrom", ""));
            s.macro.quietTo = hhmmOrEmpty(str(m, "quietTo", ""));
            s.macro.dailyLimit = clamp(m.optInt("dailyLimit", s.macro.dailyLimit), 0, 9999);
            readIntMap(m, "roomCooldownMin", s.macro.roomCooldownMin);
            readLongMap(m, "roomDueAt", s.macro.roomDueAt);
            readLongMap(m, "roomLastSent", s.macro.roomLastSent);
        }

        JSONObject a = o.optJSONObject("autoreply");
        if (a != null) {
            s.autoreply.enabled = a.optBoolean("enabled", s.autoreply.enabled);
            s.autoreply.message = str(a, "message", s.autoreply.message);
            s.autoreply.scope = oneOf(str(a, "scope", s.autoreply.scope), SCOPES, SCOPE_ALL);
            s.autoreply.exceptRooms = list(a, "exceptRooms");
            s.autoreply.cooldownMs = Math.max(0L, a.optLong("cooldownMs", s.autoreply.cooldownMs));
            s.autoreply.dailyLimit = clamp(a.optInt("dailyLimit", s.autoreply.dailyLimit), 0, 9999);
            s.autoreply.hourFrom = clamp(a.optInt("hourFrom", s.autoreply.hourFrom), 0, 24);
            s.autoreply.hourTo = clamp(a.optInt("hourTo", s.autoreply.hourTo), 0, 24);
            s.autoreply.firstOnly = a.optBoolean("firstOnly", s.autoreply.firstOnly);
            s.autoreply.delayMaxMs = clamp(a.optInt("delayMaxMs", s.autoreply.delayMaxMs), 0, 120000);
        }

        JSONArray ta = o.optJSONArray("triggers");
        if (ta != null) {
            for (int i = 0; i < ta.length() && s.triggers.size() < MAX_TRIGGERS; i++) {
                JSONObject j = ta.optJSONObject(i);
                if (j == null) continue;
                TriggerCfg t = new TriggerCfg();
                t.id = str(j, "id", t.id);
                t.name = str(j, "name", "");
                t.pattern = str(j, "pattern", "");
                t.mode = oneOf(str(j, "mode", MODE_CONTAINS), MODES, MODE_CONTAINS);
                t.ignoreCase = j.optBoolean("ignoreCase", true);
                t.rooms = list(j, "rooms");
                t.fromMe = j.optBoolean("fromMe", false);
                t.reply = str(j, "reply", "");
                t.target = str(j, "target", "");
                t.delayMs = clamp(j.optInt("delayMs", 0), 0, 60000);
                t.cooldownMs = Math.max(0L, j.optLong("cooldownMs", 60000L));
                t.oncePerRoom = j.optBoolean("oncePerRoom", false);
                t.enabled = j.optBoolean("enabled", true);
                s.triggers.add(t);
            }
        }

        JSONObject r = o.optJSONObject("roombot");
        if (r != null) {
            s.roombot.enabled = r.optBoolean("enabled", s.roombot.enabled);
            s.roombot.rooms = list(r, "rooms");
            s.roombot.welcomeOn = r.optBoolean("welcomeOn", s.roombot.welcomeOn);
            s.roombot.welcomeMsg = str(r, "welcomeMsg", s.roombot.welcomeMsg);
            s.roombot.leaveOn = r.optBoolean("leaveOn", s.roombot.leaveOn);
            s.roombot.leaveMsg = str(r, "leaveMsg", s.roombot.leaveMsg);
            s.roombot.banWords = list(r, "banWords");
            s.roombot.warnMsg = str(r, "warnMsg", s.roombot.warnMsg);
            s.roombot.floodCount = clamp(r.optInt("floodCount", s.roombot.floodCount), 2, 99);
            s.roombot.floodSecs = clamp(r.optInt("floodSecs", s.roombot.floodSecs), 1, 600);
            s.roombot.floodMsg = str(r, "floodMsg", s.roombot.floodMsg);
            s.roombot.blockLinks = r.optBoolean("blockLinks", s.roombot.blockLinks);
            s.roombot.linkMsg = str(r, "linkMsg", s.roombot.linkMsg);
            s.roombot.notice = str(r, "notice", s.roombot.notice);
            s.roombot.cmdPrefix = prefix(str(r, "cmdPrefix", s.roombot.cmdPrefix));
            s.roombot.adminNames = list(r, "adminNames");
            s.roombot.dailyLimit = clamp(r.optInt("dailyLimit", s.roombot.dailyLimit), 0, 9999);
        }

        JSONObject g = o.optJSONObject("minigame");
        if (g != null) {
            s.minigame.enabled = g.optBoolean("enabled", s.minigame.enabled);
            s.minigame.rooms = list(g, "rooms");
            s.minigame.cmdPrefix = prefix(str(g, "cmdPrefix", s.minigame.cmdPrefix));
            s.minigame.word = g.optBoolean("word", s.minigame.word);
            s.minigame.baseball = g.optBoolean("baseball", s.minigame.baseball);
            s.minigame.dice = g.optBoolean("dice", s.minigame.dice);
            s.minigame.rps = g.optBoolean("rps", s.minigame.rps);
            s.minigame.quiz = g.optBoolean("quiz", s.minigame.quiz);
            s.minigame.cooldownMs = Math.max(0L, g.optLong("cooldownMs", s.minigame.cooldownMs));
            s.minigame.dailyLimit = clamp(g.optInt("dailyLimit", s.minigame.dailyLimit), 0, 9999);
        }

        JSONObject gd = o.optJSONObject("guard");
        if (gd != null) {
            s.guard.rooms = list(gd, "rooms");
            s.guard.presenceOn = gd.optBoolean("presenceOn", s.guard.presenceOn);
            s.guard.presenceMin = clamp(gd.optInt("presenceMin", s.guard.presenceMin), 10, 240);
            s.guard.kickOn = gd.optBoolean("kickOn", s.guard.kickOn);
            s.guard.kickCount = clamp(gd.optInt("kickCount", s.guard.kickCount), 3, 30);
            s.guard.kickSecs = clamp(gd.optInt("kickSecs", s.guard.kickSecs), 5, 300);
            s.guard.floodOn = gd.optBoolean("floodOn", s.guard.floodOn);
            s.guard.floodCount = clamp(gd.optInt("floodCount", s.guard.floodCount), 3, 50);
            s.guard.floodSecs = clamp(gd.optInt("floodSecs", s.guard.floodSecs), 3, 120);
            s.guard.floodSlowSecs = clamp(gd.optInt("floodSlowSecs", s.guard.floodSlowSecs), 10, 600);
            s.guard.floodText = str(gd, "floodText", s.guard.floodText);
            s.guard.churnOn = gd.optBoolean("churnOn", s.guard.churnOn);
            s.guard.churnCount = clamp(gd.optInt("churnCount", s.guard.churnCount), 3, 50);
            s.guard.churnSecs = clamp(gd.optInt("churnSecs", s.guard.churnSecs), 5, 300);
            s.guard.churnQuietSecs = clamp(gd.optInt("churnQuietSecs", s.guard.churnQuietSecs), 30, 600);
            s.guard.churnText = str(gd, "churnText", s.guard.churnText);
            s.guard.welcomeOn = gd.optBoolean("welcomeOn", s.guard.welcomeOn);
            s.guard.welcomeText = str(gd, "welcomeText", s.guard.welcomeText);
            s.guard.noticeOn = gd.optBoolean("noticeOn", s.guard.noticeOn);
            s.guard.noticeText = str(gd, "noticeText", s.guard.noticeText);
            s.guard.noticeMin = clamp(gd.optInt("noticeMin", s.guard.noticeMin), 5, 1440);
        }
        return s;
    }

    // ── v1.8 → v2.0 마이그레이션 ──────────────────────────────────────────────

    /**
     * 암호화 설정이 없을 때만 부른다.
     * v1.8 평문 키가 남아있으면 그 값으로 Macro 를 채우고, 암호화 저장이 가능하면 저장 후 옛 키를 지운다.
     * (설정키가 아직 없으면 지우지 않는다 — 인증 전에 지워버리면 값이 영구히 날아간다)
     */
    private static Settings migrate(Context c) {
        Settings s = defaults();
        boolean found = false;
        for (int i = 0; i < LEGACY.length; i++) {
            if (Prefs.has(c, LEGACY[i])) { found = true; break; }
        }
        if (!found) return s;

        s.macro.message = nz(legacyStr(c, L_MSG, ""));
        s.macro.rooms = splitLines(legacyStr(c, L_ROOMS, ""));
        int lo = clamp(legacyInt(c, L_INTERVAL, s.macro.baseMin), 1, 1440);
        int hi = clamp(legacyInt(c, L_INTERVAL_MAX, lo), 1, 1440);
        if (hi < lo) hi = lo;
        s.macro.baseMin = lo;
        s.macro.randomMin = hi - lo;
        s.macro.minMessages = clamp(legacyInt(c, L_MINMSG, s.macro.minMessages), 0, 999);
        s.macro.enabled = legacyBool(c, L_ENABLED, false);
        s.macro.nextAt = legacyLong(c, L_NEXT, 0L);

        if (Prefs.secReady(c)) {
            // 암호화 저장이 진짜 됐는지 확인한 뒤에만 옛 키를 지운다 (실패하면 값이 영구히 날아간다)
            String json = s.toJson();
            Prefs.secPut(c, SLOT, json);
            String back = Prefs.secGet(c, SLOT);
            if (back != null && back.equals(json)) {
                for (int i = 0; i < LEGACY.length; i++) Prefs.remove(c, LEGACY[i]);
                Log.add(c, "이전 버전 설정을 이전하여 암호화 저장했습니다. (방 " + s.macro.rooms.size() + "개)");
            } else {
                Log.add(c, "이전 버전 설정의 저장에 실패했습니다. 기존 설정은 삭제하지 않고 보존했습니다.");
            }
        } else {
            Log.add(c, "이전 버전 설정이 확인되었습니다. 라이선스 인증 후 암호화하여 이전됩니다.");
        }
        return s;
    }

    // ── 도구 ──────────────────────────────────────────────────────────────────

    private static JSONObject intMap(Map<String, Integer> map) {
        JSONObject o = new JSONObject();
        if (map == null) return o;
        try {
            for (Map.Entry<String, Integer> e : map.entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                if (e.getValue().intValue() < 1) continue;
                o.put(e.getKey(), e.getValue().intValue());
            }
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "방별 쿨타임 저장 실패", t);
        }
        return o;
    }

    private static JSONObject longMap(Map<String, Long> map) {
        JSONObject o = new JSONObject();
        if (map == null) return o;
        try {
            for (Map.Entry<String, Long> e : map.entrySet()) {
                if (e.getKey() == null || e.getValue() == null) continue;
                if (e.getValue().longValue() <= 0L) continue;
                o.put(e.getKey(), e.getValue().longValue());
            }
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "방별 예약 시각 저장 실패", t);
        }
        return o;
    }

    private static void readIntMap(JSONObject parent, String key, Map<String, Integer> into) {
        if (parent == null || into == null) return;
        JSONObject o = parent.optJSONObject(key);
        if (o == null) return;
        JSONArray names = o.names();
        if (names == null) return;
        for (int i = 0; i < names.length(); i++) {
            String k = names.optString(i, "");
            if (k.length() == 0) continue;
            int v = o.optInt(k, 0);
            if (v > 0) into.put(k, Integer.valueOf(Math.max(1, Math.min(1440, v))));
        }
    }

    private static void readLongMap(JSONObject parent, String key, Map<String, Long> into) {
        if (parent == null || into == null) return;
        JSONObject o = parent.optJSONObject(key);
        if (o == null) return;
        JSONArray names = o.names();
        if (names == null) return;
        for (int i = 0; i < names.length(); i++) {
            String k = names.optString(i, "");
            if (k.length() == 0) continue;
            long v = o.optLong(k, 0L);
            if (v > 0L) into.put(k, Long.valueOf(v));
        }
    }

    private static JSONArray arr(List<String> v) {
        JSONArray a = new JSONArray();
        if (v == null) return a;
        for (int i = 0; i < v.size(); i++) {
            String s = v.get(i);
            if (s == null) continue;
            s = s.trim();
            if (s.length() == 0) continue;
            a.put(s);
        }
        return a;
    }

    private static ArrayList<String> list(JSONObject o, String k) {
        ArrayList<String> out = new ArrayList<String>();
        if (o == null) return out;
        JSONArray a = o.optJSONArray(k);
        if (a == null) return out;
        for (int i = 0; i < a.length(); i++) {
            String s = a.optString(i, null);
            if (s == null) continue;
            s = s.trim();
            if (s.length() == 0 || out.contains(s)) continue;
            out.add(s);
        }
        return out;
    }

    private static ArrayList<String> clampStrings(List<String> in, int max) {
        ArrayList<String> out = new ArrayList<String>();
        if (in == null) return out;
        for (int i = 0; i < in.size() && out.size() < max; i++) {
            String s = in.get(i);
            if (s == null) continue;
            s = s.trim();
            if (s.length() == 0 || out.contains(s)) continue;
            out.add(s);
        }
        return out;
    }

    private static String str(JSONObject o, String k, String def) {
        if (o == null) return def;
        String v = o.optString(k, null);
        return (v == null) ? def : v;
    }

    private static String oneOf(String v, String[] allowed, String def) {
        if (v != null) {
            for (int i = 0; i < allowed.length; i++) if (allowed[i].equals(v)) return v;
        }
        return def;
    }

    private static int clamp(int v, int lo, int hi) {
        if (v < lo) return lo;
        if (v > hi) return hi;
        return v;
    }

    /** 명령 접두사는 1글자. 비어있으면 "!" */
    private static String prefix(String v) {
        if (v == null) return "!";
        String s = v.trim();
        if (s.length() == 0) return "!";
        return s.substring(0, 1);
    }

    /** "HH:mm" 이면 그대로, 아니면 "" */
    private static String hhmmOrEmpty(String v) {
        return (hhmm(v) < 0) ? "" : v.trim();
    }

    /** "HH:mm" → 자정부터의 분. 형식이 틀리면 -1. */
    public static int hhmm(String v) {
        if (v == null) return -1;
        String s = v.trim();
        int i = s.indexOf(':');
        if (i <= 0 || i >= s.length() - 1) return -1;
        try {
            int h = Integer.parseInt(s.substring(0, i).trim());
            int m = Integer.parseInt(s.substring(i + 1).trim());
            if (h < 0 || h > 23 || m < 0 || m > 59) return -1;
            return h * 60 + m;
        } catch (Throwable t) {
            return -1;
        }
    }

    private static int minuteOfDay(long atMillis) {
        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.setTimeInMillis(atMillis);
        return cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + cal.get(java.util.Calendar.MINUTE);
    }

    private static int hourOf(long atMillis) {
        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.setTimeInMillis(atMillis);
        return cal.get(java.util.Calendar.HOUR_OF_DAY);
    }

    private static String clock(long atMillis) {
        try {
            return new java.text.SimpleDateFormat("HH:mm", Locale.KOREA).format(new java.util.Date(atMillis));
        } catch (Throwable t) {
            return "";
        }
    }

    private static String date(long atMillis) {
        try {
            return new java.text.SimpleDateFormat("M월 d일", Locale.KOREA).format(new java.util.Date(atMillis));
        } catch (Throwable t) {
            return "";
        }
    }

    private static ArrayList<String> splitLines(String v) {
        ArrayList<String> out = new ArrayList<String>();
        if (v == null) return out;
        String[] parts = v.replace("\r\n", "\n").replace('\r', '\n').split("\n");
        for (int i = 0; i < parts.length; i++) {
            String s = parts[i].trim();
            if (s.length() == 0 || out.contains(s)) continue;
            out.add(s);
        }
        return out;
    }

    private static String nz(String s) { return (s == null) ? "" : s; }

    // v1.8 이 값을 어떤 타입으로 넣었는지 확실하지 않다 → 숫자로 먼저 읽고 실패하면 문자열로 읽는다
    private static String legacyStr(Context c, String k, String def) {
        String v = Prefs.getStr(c, k, null);
        return (v == null) ? def : v;
    }

    private static int legacyInt(Context c, String k, int def) {
        int v = Prefs.getInt(c, k, Integer.MIN_VALUE);
        if (v != Integer.MIN_VALUE) return v;
        String s = Prefs.getStr(c, k, null);
        if (s != null) {
            try { return Integer.parseInt(s.trim()); } catch (Throwable t) { /* 아래로 */ }
        }
        return def;
    }

    private static long legacyLong(Context c, String k, long def) {
        long v = Prefs.getLong(c, k, Long.MIN_VALUE);
        if (v != Long.MIN_VALUE) return v;
        int i = Prefs.getInt(c, k, Integer.MIN_VALUE);
        if (i != Integer.MIN_VALUE) return i;
        String s = Prefs.getStr(c, k, null);
        if (s != null) {
            try { return Long.parseLong(s.trim()); } catch (Throwable t) { /* 아래로 */ }
        }
        return def;
    }

    private static boolean legacyBool(Context c, String k, boolean def) {
        if (!Prefs.has(c, k)) return def;
        boolean t1 = Prefs.getBool(c, k, false);
        boolean t2 = Prefs.getBool(c, k, true);
        if (t1 == t2) return t1;              // 진짜 boolean 으로 저장돼 있다
        String s = Prefs.getStr(c, k, null);  // 문자열로 저장된 경우
        if (s != null) {
            String v = s.trim().toLowerCase(Locale.US);
            if ("true".equals(v) || "1".equals(v) || "on".equals(v)) return true;
            if ("false".equals(v) || "0".equals(v) || "off".equals(v)) return false;
        }
        int i = Prefs.getInt(c, k, Integer.MIN_VALUE);
        if (i != Integer.MIN_VALUE) return i != 0;
        return def;
    }
}
