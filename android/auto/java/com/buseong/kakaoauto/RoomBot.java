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
import java.util.regex.Pattern;

/**
 * 방 관리봇 엔진 (SPEC 8.5).
 *
 * ★ 카톡의 한계 — 이건 코드로 못 넘는다
 *   외부 앱(우리 앱)은 카톡 방에서 사람을 **강제퇴장**시킬 수 없다. 방장 권한은 카톡 안에만 있고,
 *   알림 답장창(RemoteInput)으로는 "메시지 보내기" 딱 하나만 할 수 있다.
 *   그래서 이 봇은 강퇴 대신 **경고 메시지 + 관리자 호출**로 대응한다.
 *   초대 차단·강퇴·방 설정 변경은 방장이 카톡 안에서 직접 해야 한다.
 *   (이 문장은 {@link #LIMIT_NOTE} 로도 노출된다 — 설정 화면이 그대로 보여준다)
 *
 * 하는 일
 *   - 금지어 감지 → 경고 + 발신자별 누적 횟수 표시, 3회 이상이면 관리자 호출 문구 추가
 *   - 도배 감지 (floodSecs 초 안에 floodCount 개 초과) → 경고 (같은 사람 60초 쿨다운)
 *   - 링크/카톡 초대링크 감지 → 경고
 *   - 입장/퇴장 안내 → 환영/작별 메시지 (한국어 변형 여러 개 대응)
 *   - 명령: {접두사}공지 · {접두사}규칙 · {접두사}도움 · {접두사}경고 · {접두사}경고초기화
 *
 * 무한루프 차단 (이게 제일 중요하다)
 *   1) 리스너가 내 메시지(fromMe)는 아예 안 넘긴다.
 *   2) 그래도 알림이 메아리로 돌아오는 경우가 있어서, **내가 최근 60초 안에 보낸 문구와 같으면 무시**한다.
 *   3) 방별 쿨다운 {@link #ROOM_COOLDOWN_MS} 와 하루 한도(RoomBotCfg.dailyLimit)로 발송 자체를 묶는다.
 *
 * 상태(경고 누적 · 오늘 발송 수)는 민감정보가 아니라 평문 Prefs 에 JSON 으로 백업한다.
 * 호출은 KakaoListener 의 BG 스레드 한 줄기에서만 오지만, 상태 접근은 전부 잠근다.
 */
public final class RoomBot {
    private RoomBot() {}

    /** 경고 누적이 이만큼 쌓이면 관리자 호출 문구를 붙인다 */
    public static final int ADMIN_CALL_AT = 3;

    /** 설정 화면이 그대로 보여주는 한계 안내문 (SPEC 8.5) */
    public static final String LIMIT_NOTE =
            "카톡은 외부 앱이 방에서 사람을 강제로 내보낼 수 없어. "
          + "그래서 이 봇은 강퇴 대신 경고 메시지를 보내고, 경고가 " + ADMIN_CALL_AT
          + "회 이상 쌓이면 관리자를 호출해. "
          + "강퇴·초대 차단·방 설정 변경은 방장이 카톡 안에서 직접 해야 해.";

    /** 경고 누적/오늘 발송 수 백업 슬롯 (평문) */
    private static final String K_STATE = "K_ROOMBOT_STATE";

    /** 방별 발송 최소 간격 (RoomBotCfg 에 쿨다운 필드가 없어서 여기 상수로 둔다) */
    public static final long ROOM_COOLDOWN_MS = 3000L;

    /** 같은 사람에게 도배 경고를 다시 보내기까지 최소 간격 */
    public static final long FLOOD_WARN_MS = 60000L;

    /** 경고 누적은 이 기간이 지나면 0으로 되돌린다 (7일) */
    public static final long WARN_TTL_MS = 7L * 24 * 3600 * 1000L;

    /** 내가 보낸 문구를 "내 말"로 취급하는 창 (무한루프 차단) */
    private static final long ECHO_MS = 60000L;

    /** 같은 입/퇴장 알림이 겹쳐 올 때 한 번만 처리하는 창 */
    private static final long JOIN_DEDUP_MS = 10000L;

    /** 같은 경고 로그를 도배하지 않는 간격 */
    private static final long WARN_LOG_MS = 5 * 60 * 1000L;

    /** 경고 기록 최대 보관 수 (사람 단위) */
    private static final int MAX_WARN_KEYS = 400;

    /** 방별로 기억하는 "내가 보낸 문구" 최대 개수 */
    private static final int MAX_SAID = 6;

    // ── 입/퇴장 문구 변형 (카톡 버전·기기마다 다르다) ──────────────────────────
    private static final String[] JOIN_WORDS = {
            "들어왔습니다", "들어왔어요", "입장했습니다", "입장하셨습니다", "입장했어요",
            "참여했습니다", "참여하셨습니다", "들어왔네요"
    };
    private static final String[] LEAVE_WORDS = {
            "나갔습니다", "나갔어요", "나가셨습니다", "퇴장했습니다", "퇴장하셨습니다",
            "퇴장했어요", "떠났습니다"
    };

    /** 링크 / 카톡 초대링크 패턴 */
    private static final Pattern LINK = Pattern.compile(
            "(?i)(https?://|open\\.kakao\\.com|kakao\\.com/o/|www\\.|"
          + "[a-z0-9\\-]{2,}\\.(com|net|org|kr|me|io|tv|cc|gg|xyz|link|shop|site|club|top|info|biz)"
          + "(?![a-z0-9]))");

    // ── 상태 ──────────────────────────────────────────────────────────────────

    /** "방\u0001이름" → 누적 경고 횟수 */
    private static final HashMap<String, Integer> WARNS = new HashMap<String, Integer>();
    /** "방\u0001이름" → 마지막 경고 시각 (TTL·정리용) */
    private static final HashMap<String, Long> WARN_AT = new HashMap<String, Long>();
    /** "방\u0001이름" → 최근 메시지 시각들 (도배 판정) */
    private static final HashMap<String, ArrayList<Long>> FLOOD = new HashMap<String, ArrayList<Long>>();
    /** "방\u0001이름" → 마지막 도배 경고 시각 */
    private static final HashMap<String, Long> FLOOD_WARN = new HashMap<String, Long>();
    /** 방 → 봇이 마지막으로 보낸 시각 (방별 쿨다운) */
    private static final HashMap<String, Long> LAST_BOT = new HashMap<String, Long>();
    /** 방 → 봇이 최근에 보낸 문구들 (메아리 차단) */
    private static final HashMap<String, ArrayList<Said>> SAID = new HashMap<String, ArrayList<Said>>();
    /** "방\u0001본문" → 마지막 입/퇴장 처리 시각 */
    private static final HashMap<String, Long> JOIN_SEEN = new HashMap<String, Long>();
    /** 로그 도배 방지 */
    private static final HashMap<String, Long> LOGGED = new HashMap<String, Long>();

    private static String today = "";
    private static int sentToday = 0;
    private static boolean loaded = false;

    /** 봇이 보낸 문구 하나 */
    private static final class Said {
        final String norm;
        final long at;
        Said(String norm, long at) { this.norm = norm; this.at = at; }
    }

    // ── 진입점 ────────────────────────────────────────────────────────────────

    /**
     * 메시지 한 건을 방 관리봇에 물린다. KakaoListener 의 BG 스레드에서 호출된다.
     * (리스너는 내 메시지를 걸러서 넘겨준다 — 그래도 여기서 한 번 더 막는다)
     *
     * @param room   방 이름
     * @param sender 발신자 (모르면 "")
     * @param text   본문
     * @param group  그룹방인가
     */
    public static void onMessage(Context c, String room, String sender, String text, boolean group) {
        if (c == null || text == null) return;
        final String body = text.trim();
        if (body.length() == 0) return;

        // 게이트는 여기서도 한 번 더 본다 (공개 진입점이라서)
        if (!License.allowed(c, Features.ROOMBOT)) return;

        Settings.RoomBotCfg cfg = Settings.roombot(c);
        if (cfg == null || !cfg.enabled) return;

        final String r = (room == null) ? "" : room.trim();
        if (r.length() == 0) return;
        if (!covers(cfg, r)) return;

        final String who = (sender == null) ? "" : sender.trim();
        final long now = System.currentTimeMillis();

        // 무한루프 차단 1 — 내 이름으로 온 메시지
        String me = KakaoListener.selfName();
        if (who.length() > 0 && me.length() > 0 && who.equals(me)) return;
        // 무한루프 차단 2 — 내가 방금 보낸 문구가 알림으로 돌아온 경우
        if (saidRecently(r, body, now)) return;

        // 1) 입장/퇴장 안내 (시스템 문구라서 금지어·도배 검사 전에 처리하고 끝낸다)
        int kind = joinLeaveKind(body);
        if (kind != 0) {
            // 1:1 방에는 입/퇴장 시스템 문구가 없다 (방 이름 = 상대 이름). 흉내낸 문장이니 무시한다.
            if (!group && who.length() > 0 && who.equals(r)) return;
            if (dupJoin(r, body, now)) return;
            handleJoinLeave(c, cfg, r, body, kind, now);
            return;
        }

        // 2) 명령
        String prefix = prefixOf(cfg);
        if (body.startsWith(prefix) && body.length() > prefix.length()) {
            handleCommand(c, cfg, r, who, body.substring(prefix.length()).trim(), prefix, now);
            return;
        }

        // 3) 금지어 (대소문자·공백 무시 포함 검사)
        String ban = banHit(cfg, body);
        if (ban != null) {
            int n = bumpWarn(c, r, who, now);
            String msg = warnText(cfg, r, who, ban, n, now);
            if (send(c, cfg, r, msg, now)) {
                Log.add(c, "방관리봇 금지어 감지 — 「" + r + "」 " + nameOf(who) + " (경고 " + n + "회, 단어: " + ban + ")");
            }
            return;
        }

        // 4) 링크 / 초대링크
        if (cfg.blockLinks && LINK.matcher(body).find()) {
            int n = bumpWarn(c, r, who, now);
            String msg = linkText(cfg, r, who, n, now);
            if (send(c, cfg, r, msg, now)) {
                Log.add(c, "방관리봇 링크 감지 — 「" + r + "」 " + nameOf(who) + " (경고 " + n + "회)");
            }
            return;
        }

        // 5) 도배
        if (flood(cfg, r, who, now)) {
            String msg = floodText(cfg, r, who, now);
            if (send(c, cfg, r, msg, now)) {
                Log.add(c, "방관리봇 도배 감지 — 「" + r + "」 " + nameOf(who)
                        + " (" + cfg.floodSecs + "초에 " + cfg.floodCount + "개 초과)");
            }
        }
    }

    /**
     * 이 방에서 봇이 돌아야 하나.
     *
     * Settings.RoomBotCfg.coversRoom 은 **rooms 가 비어있으면 false**(=동작 안 함)다.
     * 실수로 모든 방에 봇이 도는 걸 막으려는 의도라서 그 판정을 그대로 따른다.
     * (SPEC 본문의 "비어있으면 모든 방" 과는 반대다 — 통합 때 하나로 정할 것)
     */
    public static boolean covers(Settings.RoomBotCfg cfg, String room) {
        if (cfg == null) return false;
        return cfg.coversRoom(room);
    }

    // ── 입/퇴장 ───────────────────────────────────────────────────────────────

    /** 1 = 입장, 2 = 퇴장, 0 = 해당 없음 */
    public static int joinLeaveKind(String body) {
        if (body == null) return 0;
        if (tailWord(body, JOIN_WORDS) >= 0) return 1;
        if (tailWord(body, LEAVE_WORDS) >= 0) return 2;
        return 0;
    }

    /** 문장 끝쪽에 그 낱말이 있으면 그 시작 위치, 없으면 -1 */
    private static int tailWord(String body, String[] words) {
        for (int i = 0; i < words.length; i++) {
            int at = body.lastIndexOf(words[i]);
            if (at < 0) continue;
            // 문장 끝(마침표·이모지 두 글자 정도 허용)에 있어야 시스템 문구로 본다
            int rest = body.length() - (at + words[i].length());
            if (rest <= 2) return at;
        }
        return -1;
    }

    /** "홍길동님이 들어왔습니다." → "홍길동" (못 뽑으면 "") */
    public static String personOf(String body) {
        if (body == null) return "";
        int at = tailWord(body, JOIN_WORDS);
        if (at < 0) at = tailWord(body, LEAVE_WORDS);
        if (at < 0) return "";
        String head = body.substring(0, at).trim();
        int nim = head.lastIndexOf('님');
        if (nim > 0) head = head.substring(0, nim).trim();
        // 뒤에 남는 기호/공백 정리 (이름 자체는 건드리지 않는다)
        while (head.length() > 0) {
            char last = head.charAt(head.length() - 1);
            if (last == ',' || last == '·' || Character.isWhitespace(last)) {
                head = head.substring(0, head.length() - 1).trim();
                continue;
            }
            break;
        }
        return head;
    }

    private static void handleJoinLeave(Context c, Settings.RoomBotCfg cfg, String r,
                                        String body, int kind, long now) {
        boolean join = (kind == 1);
        boolean on = join ? cfg.welcomeOn : cfg.leaveOn;
        if (!on) return;
        String tpl = join ? cfg.welcomeMsg : cfg.leaveMsg;
        String label = join ? "환영" : "작별";
        if (tpl == null || tpl.trim().length() == 0) {
            note(c, "jl:" + (join ? "w" : "l"),
                    "방관리봇 " + label + " 인사가 켜져 있는데 메시지가 비어있어 — 봇 탭에서 채워줘");
            return;
        }
        String person = personOf(body);
        String msg = render(tpl, r, person, now, 0, "");
        if (msg.trim().length() == 0) {
            note(c, "jl-empty:" + (join ? "w" : "l"),
                    "방관리봇 " + label + " 인사가 치환 후 비어버렸어 — 메시지를 확인해줘");
            return;
        }
        if (send(c, cfg, r, msg, now)) {
            Log.add(c, "방관리봇 " + label + " 인사 — 「" + r + "」 " + nameOf(person));
        }
    }

    // ── 명령 ──────────────────────────────────────────────────────────────────

    private static void handleCommand(Context c, Settings.RoomBotCfg cfg, String r, String who,
                                       String line, String prefix, long now) {
        if (line.length() == 0) return;
        String cmd = line;
        String arg = "";
        int sp = firstSpace(line);
        if (sp > 0) {
            cmd = line.substring(0, sp);
            arg = line.substring(sp).trim();
        }

        if (cmd.equals("공지")) {
            if (arg.length() == 0) {
                String n = (cfg.notice == null) ? "" : cfg.notice.trim();
                if (n.length() == 0) {
                    send(c, cfg, r, "아직 등록된 공지가 없어. 관리자가 「" + prefix + "공지 내용」 으로 등록할 수 있어.", now);
                } else {
                    send(c, cfg, r, "[공지]\n" + n, now);
                }
                return;
            }
            if (!cfg.isAdmin(who)) {
                send(c, cfg, r, "공지는 관리자만 등록할 수 있어." + adminTail(cfg), now);
                return;
            }
            cfg.notice = arg;
            Settings.flush(c);
            send(c, cfg, r, "공지를 등록했어. 이제 「" + prefix + "공지」 로 볼 수 있어.", now);
            Log.add(c, "방관리봇 공지 등록 — 「" + r + "」 " + nameOf(who));
            return;
        }

        if (cmd.equals("규칙")) {
            send(c, cfg, r, rulesText(c, cfg, prefix), now);
            return;
        }

        if (cmd.equals("도움") || cmd.equals("명령") || cmd.equals("방도움")) {
            send(c, cfg, r, helpText(c, cfg, prefix), now);
            return;
        }

        if (cmd.equals("경고")) {
            String target = (arg.length() > 0) ? arg : who;
            if (arg.length() > 0 && !cfg.isAdmin(who)) {
                // 남의 경고 횟수를 아무나 캐는 건 막고, 자기 것만 보여준다
                target = who;
            }
            int n = warnCount(c, r, target);
            send(c, cfg, r, nameOf(target) + "님 누적 경고는 " + n + "회야."
                    + (n >= ADMIN_CALL_AT ? " 관리자 확인이 필요한 상태야." : ""), now);
            return;
        }

        if (cmd.equals("경고초기화")) {
            if (!cfg.isAdmin(who)) {
                send(c, cfg, r, "경고 초기화는 관리자만 할 수 있어." + adminTail(cfg), now);
                return;
            }
            int cleared = clearWarns(c, r);
            send(c, cfg, r, "이 방의 경고 기록 " + cleared + "건을 지웠어.", now);
            Log.add(c, "방관리봇 경고 초기화 — 「" + r + "」 " + cleared + "건 (" + nameOf(who) + ")");
            return;
        }

        // 모르는 명령은 조용히 넘긴다 (미니게임봇과 접두사가 같을 수 있다)
    }

    private static int firstSpace(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (Character.isWhitespace(s.charAt(i))) return i;
        }
        return -1;
    }

    private static String adminTail(Settings.RoomBotCfg cfg) {
        String names = adminNames(cfg);
        return (names.length() == 0) ? "" : (" (관리자: " + names + ")");
    }

    private static String adminNames(Settings.RoomBotCfg cfg) {
        if (cfg == null || cfg.adminNames == null) return "";
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < cfg.adminNames.size(); i++) {
            String n = cfg.adminNames.get(i);
            if (n == null) continue;
            n = n.trim();
            if (n.length() == 0) continue;
            if (sb.length() > 0) sb.append(", ");
            sb.append(n);
        }
        return sb.toString();
    }

    // ── 안내문 (설정 화면도 그대로 쓴다) ──────────────────────────────────────

    /** {접두사}규칙 으로 나가는 문장 */
    public static String rulesText(Context c) {
        Settings.RoomBotCfg cfg = Settings.roombot(c);
        return rulesText(c, cfg, prefixOf(cfg));
    }

    public static String rulesText(Context c, Settings.RoomBotCfg cfg, String prefix) {
        StringBuilder sb = new StringBuilder();
        sb.append("[방 규칙]");
        int bans = countWords(cfg);
        if (bans > 0) sb.append("\n· 금지어 ").append(bans).append("개 감지 시 경고가 누적돼");
        if (cfg != null && cfg.blockLinks) sb.append("\n· 링크·초대링크 공유 금지");
        if (cfg != null && cfg.floodCount > 0 && cfg.floodSecs > 0) {
            sb.append("\n· ").append(cfg.floodSecs).append("초 안에 ")
              .append(cfg.floodCount).append("개를 넘겨 보내면 도배 경고");
        }
        sb.append("\n· 경고가 ").append(ADMIN_CALL_AT).append("회 쌓이면 관리자를 호출해");
        String n = (cfg == null || cfg.notice == null) ? "" : cfg.notice.trim();
        if (n.length() > 0) sb.append("\n\n[공지]\n").append(n);
        sb.append("\n\n※ 강제퇴장은 카톡 제약으로 봇이 할 수 없어. 경고와 관리자 호출로만 관리해.");
        return sb.toString();
    }

    /** {접두사}도움 으로 나가는 문장 */
    public static String helpText(Context c) {
        Settings.RoomBotCfg cfg = Settings.roombot(c);
        return helpText(c, cfg, prefixOf(cfg));
    }

    public static String helpText(Context c, Settings.RoomBotCfg cfg, String prefix) {
        StringBuilder sb = new StringBuilder();
        sb.append("[방 관리봇 명령]");
        sb.append("\n").append(prefix).append("공지 — 등록된 공지 보기");
        sb.append("\n").append(prefix).append("공지 내용 — 공지 등록 (관리자만)");
        sb.append("\n").append(prefix).append("규칙 — 방 규칙 보기");
        sb.append("\n").append(prefix).append("경고 — 내 누적 경고 횟수");
        sb.append("\n").append(prefix).append("경고초기화 — 이 방 경고 기록 지우기 (관리자만)");
        sb.append("\n").append(prefix).append("도움 — 이 안내");
        String names = adminNames(cfg);
        if (names.length() > 0) sb.append("\n\n관리자: ").append(names);
        return sb.toString();
    }

    /** 설정 화면용 한 줄 요약 */
    public static String summary(Context c) {
        Settings.RoomBotCfg cfg = Settings.roombot(c);
        if (cfg == null) return "설정을 읽지 못했어";
        if (!cfg.enabled) return "꺼져 있어";
        if (cfg.rooms == null || cfg.rooms.isEmpty()) return "켜져 있지만 방을 아직 안 골랐어 — 방을 추가해야 돌아";
        return "방 " + cfg.rooms.size() + "곳 · 금지어 " + countWords(cfg) + "개 · 오늘 " + today(c) + "회 발송";
    }

    /** 저장 전 점검. 문제없으면 null, 있으면 사용자에게 그대로 보여줄 한국어 문장. */
    public static String validate(Settings.RoomBotCfg cfg) {
        if (cfg == null) return "설정이 비어있어";
        if (cfg.enabled && (cfg.rooms == null || cfg.rooms.isEmpty())) {
            return "봇이 돌 방을 최소 한 곳은 골라줘 (카톡 알림에 뜨는 방 이름과 똑같이)";
        }
        if (cfg.welcomeOn && (cfg.welcomeMsg == null || cfg.welcomeMsg.trim().length() == 0)) {
            return "환영 인사 메시지를 입력해줘";
        }
        if (cfg.leaveOn && (cfg.leaveMsg == null || cfg.leaveMsg.trim().length() == 0)) {
            return "작별 인사 메시지를 입력해줘";
        }
        if (cfg.floodSecs < 1 || cfg.floodSecs > 600) return "도배 판정 시간은 1~600초 사이여야 해";
        if (cfg.floodCount < 2 || cfg.floodCount > 100) return "도배 판정 개수는 2~100개 사이여야 해";
        if (cfg.dailyLimit < 0) return "하루 한도는 0 이상이어야 해";
        if (cfg.cmdPrefix == null || cfg.cmdPrefix.trim().length() == 0) return "명령 접두사를 입력해줘";
        if (cfg.notice != null && cfg.notice.length() > 2000) return "공지가 너무 길어 (2000자 이하)";
        return null;
    }

    private static int countWords(Settings.RoomBotCfg cfg) {
        if (cfg == null || cfg.banWords == null) return 0;
        int n = 0;
        for (int i = 0; i < cfg.banWords.size(); i++) {
            String w = cfg.banWords.get(i);
            if (w != null && w.trim().length() > 0) n++;
        }
        return n;
    }

    // ── 경고문 만들기 ─────────────────────────────────────────────────────────

    private static String warnText(Settings.RoomBotCfg cfg, String r, String who,
                                    String ban, int n, long now) {
        String tpl = (cfg.warnMsg == null) ? "" : cfg.warnMsg.trim();
        String out;
        if (tpl.length() == 0) {
            out = nameOf(who) + "님 금지어 감지 (경고 " + n + "회)";
        } else {
            out = render(tpl, r, who, now, n, ban);
            // 사용자 문구에 횟수 표시가 없으면 뒤에 붙여준다 (누적을 꼭 보여줘야 한다)
            if (!tpl.contains("{횟수}")) out = out + " (경고 " + n + "회)";
        }
        return out + adminCall(cfg, n);
    }

    private static String linkText(Settings.RoomBotCfg cfg, String r, String who, int n, long now) {
        String tpl = (cfg.linkMsg == null) ? "" : cfg.linkMsg.trim();
        String out;
        if (tpl.length() == 0) {
            out = nameOf(who) + "님 링크·초대링크는 올릴 수 없어 (경고 " + n + "회)";
        } else {
            out = render(tpl, r, who, now, n, "");
            if (!tpl.contains("{횟수}")) out = out + " (경고 " + n + "회)";
        }
        return out + adminCall(cfg, n);
    }

    private static String floodText(Settings.RoomBotCfg cfg, String r, String who, long now) {
        String tpl = (cfg.floodMsg == null) ? "" : cfg.floodMsg.trim();
        if (tpl.length() == 0) {
            return nameOf(who) + "님 도배는 자제해줘 (" + cfg.floodSecs + "초에 "
                    + cfg.floodCount + "개 초과)";
        }
        return render(tpl, r, who, now, 0, "");
    }

    /** 경고가 쌓였으면 관리자 호출 문구 (강퇴가 안 되는 이유도 짧게 붙인다) */
    private static String adminCall(Settings.RoomBotCfg cfg, int n) {
        if (n < ADMIN_CALL_AT) return "";
        String names = adminNames(cfg);
        StringBuilder sb = new StringBuilder();
        sb.append("\n경고가 ").append(n).append("회 쌓였어. ");
        if (names.length() > 0) sb.append("관리자 ").append(names).append(" 확인 부탁해.");
        else sb.append("관리자 확인이 필요해.");
        sb.append(" (봇은 강제퇴장을 못 해)");
        return sb.toString();
    }

    /** {방} {이름} {시간} {날짜} {횟수} {금지어} 치환 */
    public static String render(String tpl, String room, String who, long at, int count, String word) {
        String out = (tpl == null) ? "" : tpl;
        out = out.replace("{방}", (room == null) ? "" : room);
        out = out.replace("{이름}", nameOf(who));
        out = out.replace("{시간}", clock(at));
        out = out.replace("{날짜}", date(at));
        out = out.replace("{횟수}", String.valueOf(count));
        out = out.replace("{금지어}", (word == null) ? "" : word);
        return out;
    }

    private static String nameOf(String who) {
        if (who == null) return "";
        String n = who.trim();
        return (n.length() == 0) ? "누군가" : n;
    }

    // ── 금지어 / 도배 판정 ────────────────────────────────────────────────────

    /**
     * 걸린 금지어를 돌려준다(없으면 null).
     * 대소문자와 **공백을 양쪽 다 지우고** 비교하기 때문에 "ㅂ ㅅ" 처럼 띄어 쓴 우회도 잡는다.
     */
    public static String banHit(Settings.RoomBotCfg cfg, String body) {
        if (cfg == null || cfg.banWords == null || body == null) return null;
        String m = squash(body);
        if (m.length() == 0) return null;
        for (int i = 0; i < cfg.banWords.size(); i++) {
            String raw = cfg.banWords.get(i);
            if (raw == null) continue;
            String w = squash(raw);
            if (w.length() == 0) continue;
            if (m.contains(w)) return raw.trim();
        }
        return null;
    }

    /** 공백 전부 제거 + 소문자 */
    private static String squash(String s) {
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (Character.isWhitespace(ch)) continue;
            sb.append(ch);
        }
        return sb.toString().toLowerCase(Locale.getDefault());
    }

    /** 도배인가. 경고를 보낼 상황이면 true (쿨다운도 여기서 소모한다) */
    private static boolean flood(Settings.RoomBotCfg cfg, String r, String who, long now) {
        int limit = cfg.floodCount;
        int secs = cfg.floodSecs;
        if (limit < 2 || secs < 1) return false;
        String k = key(r, who);
        synchronized (RoomBot.class) {
            ArrayList<Long> hist = FLOOD.get(k);
            if (hist == null) { hist = new ArrayList<Long>(); FLOOD.put(k, hist); }
            long from = now - (long) secs * 1000L;
            for (int i = hist.size() - 1; i >= 0; i--) {
                if (hist.get(i).longValue() < from) hist.remove(i);
            }
            hist.add(Long.valueOf(now));
            while (hist.size() > 200) hist.remove(0);
            if (FLOOD.size() > MAX_WARN_KEYS) trimFlood(k);
            if (hist.size() <= limit) return false;

            Long last = FLOOD_WARN.get(k);
            if (last != null && now - last.longValue() < FLOOD_WARN_MS) return false;
            FLOOD_WARN.put(k, Long.valueOf(now));
            hist.clear();     // 경고를 보냈으면 다시 세기 시작한다
            return true;
        }
    }

    private static void trimFlood(String keep) {
        Iterator<Map.Entry<String, ArrayList<Long>>> it = FLOOD.entrySet().iterator();
        while (it.hasNext() && FLOOD.size() > MAX_WARN_KEYS) {
            Map.Entry<String, ArrayList<Long>> e = it.next();
            if (e.getKey().equals(keep)) continue;
            it.remove();
        }
    }

    // ── 경고 누적 ─────────────────────────────────────────────────────────────

    /** 경고 +1 하고 누적 횟수를 돌려준다 */
    private static int bumpWarn(Context c, String r, String who, long now) {
        String k = key(r, who);
        synchronized (RoomBot.class) {
            load(c);
            int n = warnOf(k, now) + 1;
            WARNS.put(k, Integer.valueOf(n));
            WARN_AT.put(k, Long.valueOf(now));
            trimWarns();
            save(c);
            return n;
        }
    }

    /** TTL 을 넘긴 경고는 0으로 본다 */
    private static int warnOf(String k, long now) {
        Integer v = WARNS.get(k);
        if (v == null) return 0;
        Long at = WARN_AT.get(k);
        if (at != null && now - at.longValue() > WARN_TTL_MS) return 0;
        return v.intValue();
    }

    /** 그 사람의 누적 경고 횟수 */
    public static int warnCount(Context c, String room, String who) {
        synchronized (RoomBot.class) {
            load(c);
            return warnOf(key(room, who), System.currentTimeMillis());
        }
    }

    /** 경고 기록 전부 삭제. 지운 건수를 돌려준다. */
    public static int clearWarns(Context c) {
        synchronized (RoomBot.class) {
            load(c);
            int n = WARNS.size();
            WARNS.clear();
            WARN_AT.clear();
            FLOOD.clear();
            FLOOD_WARN.clear();
            save(c);
            return n;
        }
    }

    /** 그 방의 경고 기록만 삭제. 지운 건수를 돌려준다. */
    public static int clearWarns(Context c, String room) {
        String r = (room == null) ? "" : room.trim();
        if (r.length() == 0) return 0;
        String head = r + "\u0001";
        synchronized (RoomBot.class) {
            load(c);
            int n = 0;
            Iterator<Map.Entry<String, Integer>> it = WARNS.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Integer> e = it.next();
                if (e.getKey().startsWith(head)) { it.remove(); n++; }
            }
            Iterator<String> it2 = WARN_AT.keySet().iterator();
            while (it2.hasNext()) { if (it2.next().startsWith(head)) it2.remove(); }
            Iterator<String> it3 = FLOOD.keySet().iterator();
            while (it3.hasNext()) { if (it3.next().startsWith(head)) it3.remove(); }
            Iterator<String> it4 = FLOOD_WARN.keySet().iterator();
            while (it4.hasNext()) { if (it4.next().startsWith(head)) it4.remove(); }
            save(c);
            return n;
        }
    }

    /** 경고가 많이 쌓인 사람들 (설정 화면 표시용). "방 · 이름 · N회" 문자열 목록 */
    public static List<String> topWarned(Context c, int max) {
        ArrayList<String> out = new ArrayList<String>();
        synchronized (RoomBot.class) {
            load(c);
            long now = System.currentTimeMillis();
            ArrayList<Map.Entry<String, Integer>> all =
                    new ArrayList<Map.Entry<String, Integer>>(WARNS.entrySet());
            java.util.Collections.sort(all, new java.util.Comparator<Map.Entry<String, Integer>>() {
                @Override public int compare(Map.Entry<String, Integer> a, Map.Entry<String, Integer> b) {
                    return b.getValue().intValue() - a.getValue().intValue();
                }
            });
            for (int i = 0; i < all.size() && (max <= 0 || out.size() < max); i++) {
                String k = all.get(i).getKey();
                int n = warnOf(k, now);
                if (n <= 0) continue;
                int p = k.indexOf('\u0001');
                String room = (p > 0) ? k.substring(0, p) : k;
                String who = (p >= 0) ? k.substring(p + 1) : "";
                out.add(room + " · " + nameOf(who) + " · " + n + "회");
            }
        }
        return out;
    }

    private static void trimWarns() {
        if (WARNS.size() <= MAX_WARN_KEYS) return;
        ArrayList<Map.Entry<String, Long>> all =
                new ArrayList<Map.Entry<String, Long>>(WARN_AT.entrySet());
        java.util.Collections.sort(all, new java.util.Comparator<Map.Entry<String, Long>>() {
            @Override public int compare(Map.Entry<String, Long> a, Map.Entry<String, Long> b) {
                return Long.compare(a.getValue().longValue(), b.getValue().longValue());
            }
        });
        int drop = WARNS.size() - MAX_WARN_KEYS;
        for (int i = 0; i < drop && i < all.size(); i++) {
            String k = all.get(i).getKey();
            WARNS.remove(k);
            WARN_AT.remove(k);
        }
    }

    // ── 발송 ──────────────────────────────────────────────────────────────────

    /**
     * 봇 메시지 발송. 방별 쿨다운·하루 한도를 여기서 다 본다.
     * 발송한 문구는 기억해둔다 — 알림으로 되돌아와도 봇이 자기 말에 반응하지 않게.
     */
    private static boolean send(Context c, Settings.RoomBotCfg cfg, String r, String msg, long now) {
        if (msg == null || msg.trim().length() == 0) return false;
        int limit = (cfg == null) ? 0 : cfg.dailyLimit;
        synchronized (RoomBot.class) {
            load(c);
            rollDay(now);
            if (limit > 0 && sentToday >= limit) {
                note(c, "limit", "방관리봇 하루 한도(" + limit + "개)를 다 썼어 — 자정에 초기화돼");
                return false;
            }
            Long last = LAST_BOT.get(r);
            if (last != null && now - last.longValue() < ROOM_COOLDOWN_MS) {
                note(c, "cool:" + r, "방관리봇 「" + r + "」 쿨다운("
                        + (ROOM_COOLDOWN_MS / 1000) + "초) 중이라 한 건 넘겼어");
                return false;
            }
            LAST_BOT.put(r, Long.valueOf(now));
            sentToday = sentToday + 1;
            remember(r, msg, now);
            save(c);
        }
        boolean ok = KakaoListener.sendTo(c, r, msg);
        if (!ok) {
            synchronized (RoomBot.class) {
                if (sentToday > 0) sentToday = sentToday - 1;
                save(c);
            }
            Log.add(c, "방관리봇 발송이 실패했어 — 「" + r + "」");
        }
        return ok;
    }

    /** 오늘 봇이 보낸 메시지 수 */
    public static int today(Context c) {
        synchronized (RoomBot.class) {
            load(c);
            rollDay(System.currentTimeMillis());
            return sentToday;
        }
    }

    // ── 메아리 차단 ───────────────────────────────────────────────────────────

    private static void remember(String r, String msg, long now) {
        ArrayList<Said> list = SAID.get(r);
        if (list == null) { list = new ArrayList<Said>(); SAID.put(r, list); }
        list.add(new Said(flat(msg), now));
        while (list.size() > MAX_SAID) list.remove(0);
        if (SAID.size() > 120) {
            Iterator<String> it = SAID.keySet().iterator();
            while (it.hasNext() && SAID.size() > 120) {
                String k = it.next();
                if (k.equals(r)) continue;
                it.remove();
            }
        }
    }

    /** 내가 최근 60초 안에 보낸 문구인가 (여러 줄 메시지는 알림에서 잘려 오니 앞부분도 본다) */
    private static boolean saidRecently(String r, String body, long now) {
        String b = flat(body);
        if (b.length() == 0) return false;
        synchronized (RoomBot.class) {
            ArrayList<Said> list = SAID.get(r);
            if (list == null) return false;
            for (int i = list.size() - 1; i >= 0; i--) {
                Said s = list.get(i);
                if (now - s.at > ECHO_MS) continue;
                if (s.norm.equals(b)) return true;
                if (s.norm.length() > b.length() && b.length() >= 6 && s.norm.startsWith(b)) return true;
            }
        }
        return false;
    }

    /** 줄바꿈·연속 공백을 한 칸으로 (비교용) */
    private static String flat(String s) {
        if (s == null) return "";
        StringBuilder sb = new StringBuilder(s.length());
        boolean sp = false;
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (Character.isWhitespace(ch)) { sp = true; continue; }
            if (sp && sb.length() > 0) sb.append(' ');
            sp = false;
            sb.append(ch);
        }
        return sb.toString().trim();
    }

    private static boolean dupJoin(String r, String body, long now) {
        String k = r + "\u0001" + flat(body);
        synchronized (RoomBot.class) {
            Long last = JOIN_SEEN.get(k);
            if (last != null && now - last.longValue() < JOIN_DEDUP_MS) return true;
            JOIN_SEEN.put(k, Long.valueOf(now));
            if (JOIN_SEEN.size() > 200) {
                Iterator<Map.Entry<String, Long>> it = JOIN_SEEN.entrySet().iterator();
                while (it.hasNext() && JOIN_SEEN.size() > 200) {
                    Map.Entry<String, Long> e = it.next();
                    if (now - e.getValue().longValue() < JOIN_DEDUP_MS) continue;
                    it.remove();
                }
            }
            return false;
        }
    }

    // ── 잡동사니 ──────────────────────────────────────────────────────────────

    public static String prefixOf(Settings.RoomBotCfg cfg) {
        if (cfg == null) return "!";
        String p = (cfg.cmdPrefix == null) ? "" : cfg.cmdPrefix.trim();
        return (p.length() == 0) ? "!" : p;
    }

    private static String key(String room, String who) {
        String r = (room == null) ? "" : room.trim();
        String w = (who == null) ? "" : who.trim();
        return r + "\u0001" + w;
    }

    /** 같은 안내를 로그에 도배하지 않는다 */
    private static void note(Context c, String k, String msg) {
        long now = System.currentTimeMillis();
        synchronized (LOGGED) {
            Long last = LOGGED.get(k);
            if (last != null && now - last.longValue() < WARN_LOG_MS) return;
            LOGGED.put(k, Long.valueOf(now));
            if (LOGGED.size() > 200) LOGGED.clear();
        }
        Log.add(c, msg);
    }

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

    private static String clock(long at) {
        try {
            return new SimpleDateFormat("HH:mm", Locale.KOREA).format(new Date(at));
        } catch (Throwable t) {
            return "";
        }
    }

    private static String date(long at) {
        try {
            return new SimpleDateFormat("M월 d일", Locale.KOREA).format(new Date(at));
        } catch (Throwable t) {
            return "";
        }
    }

    // ── 저장 / 불러오기 (평문 JSON) ───────────────────────────────────────────

    private static void load(Context c) {
        if (loaded) return;
        if (c == null) return;
        loaded = true;
        today = dayOf(System.currentTimeMillis());
        String raw = Prefs.getStr(c, K_STATE, null);
        if (raw == null || raw.length() == 0) return;
        try {
            JSONObject o = new JSONObject(raw);
            String day = o.optString("day", "");
            int n = o.optInt("n", 0);
            if (day.equals(today)) sentToday = (n < 0) ? 0 : n;
            JSONObject w = o.optJSONObject("warn");
            if (w != null) {
                Iterator<String> it = w.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    int v = w.optInt(k, 0);
                    if (v > 0) WARNS.put(k, Integer.valueOf(v));
                }
            }
            JSONObject a = o.optJSONObject("warnAt");
            if (a != null) {
                Iterator<String> it = a.keys();
                while (it.hasNext()) {
                    String k = it.next();
                    long v = a.optLong(k, 0L);
                    if (v > 0) WARN_AT.put(k, Long.valueOf(v));
                }
            }
            trimWarns();
        } catch (Throwable t) {
            Log.add(c, "방관리봇 기록이 깨져 있어서 초기화했어: " + t);
            WARNS.clear();
            WARN_AT.clear();
            sentToday = 0;
        }
    }

    private static void save(Context c) {
        if (c == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("day", today);
            o.put("n", sentToday);
            JSONObject w = new JSONObject();
            Iterator<Map.Entry<String, Integer>> it = WARNS.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, Integer> e = it.next();
                w.put(e.getKey(), e.getValue().intValue());
            }
            o.put("warn", w);
            JSONObject a = new JSONObject();
            Iterator<Map.Entry<String, Long>> it2 = WARN_AT.entrySet().iterator();
            while (it2.hasNext()) {
                Map.Entry<String, Long> e = it2.next();
                a.put(e.getKey(), e.getValue().longValue());
            }
            o.put("warnAt", a);
            Prefs.putStr(c, K_STATE, o.toString());
        } catch (Throwable t) {
            Log.add(c, "방관리봇 기록을 저장하지 못했어: " + t);
        }
    }
}
