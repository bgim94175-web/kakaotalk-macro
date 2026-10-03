package com.buseong.kakaoauto;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Random;
import java.util.Set;

/**
 * 미니게임봇 엔진 (SPEC 8.6).
 *
 * 방마다 게임 하나가 돌아간다({@link Game}). 상태는 메모리가 정본이고 평문 Prefs 에 JSON 으로 백업한다
 * (점수·진행중 단어는 민감정보가 아니다. 방 이름은 KakaoListener 의 방 캐시와 같은 수준이라 평문으로 둔다).
 *
 * 명령 (접두사는 설정값, 기본 "!")
 *   !끝말잇기 · !숫자야구 · !주사위 [면수] · !가위바위보 [가위|바위|보] · !퀴즈
 *   !힌트 · !정답 · !포기 · !점수 · !랭킹 · !게임도움(=!도움)
 *
 * 무한루프 차단
 *   1) 리스너가 내 메시지(fromMe)는 안 넘긴다.
 *   2) 봇이 최근 60초 안에 보낸 문구와 같으면 무시한다.
 *   3) 방별 쿨다운(MiniGameCfg.cooldownMs)·하루 한도(dailyLimit)로 발송을 묶는다.
 *
 * 끝말잇기 판정은 {@link WordDict}, 퀴즈 문제는 {@link QuizBank} 가 들고 있다.
 */
public final class MiniGame {

    /**
     * 같은 대화방 재응답 최소 간격. 0 을 허용하면 명령이 올라올 때마다 즉시 발송해
     * 카카오톡 쪽에서 비정상 사용으로 판정될 수 있다. 화면에서도 3초 미만은 받지 않는다.
     */
    public static final long MIN_COOLDOWN_MS = 3000L;
    private MiniGame() {}

    /** 게임 상태 백업 슬롯 (평문) */
    private static final String K_STATE = "K_MINIGAME_STATE";

    /** 끝말잇기 한 턴 제한 (다음 메시지가 올 때 판정한다 — 알람을 걸지 않는다) */
    public static final long WORD_TURN_MS = 30000L;

    /** 숫자야구 최대 시도 */
    public static final int BASEBALL_TRIES = 10;

    /** 오래 방치된 게임을 스스로 접는 시간 */
    private static final long BASEBALL_TTL_MS = 15 * 60 * 1000L;
    private static final long QUIZ_TTL_MS = 5 * 60 * 1000L;

    /** 봇이 보낸 문구를 "내 말"로 취급하는 창 */
    private static final long ECHO_MS = 60000L;

    /** 같은 안내 로그를 도배하지 않는 간격 */
    private static final long WARN_LOG_MS = 5 * 60 * 1000L;

    /** 점수: 끝말잇기 한 단어 / 봇 항복 / 숫자야구 성공 / 가위바위보 승 / 퀴즈 정답 */
    public static final int P_WORD = 1;
    public static final int P_WORD_WIN = 3;
    public static final int P_BASEBALL = 5;
    public static final int P_RPS = 1;
    public static final int P_QUIZ = 2;

    private static final int MAX_ROOMS = 30;
    private static final int MAX_PLAYERS = 60;
    private static final int MAX_USED = 120;
    private static final int MAX_SAID = 6;

    private static final Random RND = new Random();

    /** 방 하나의 게임 상태 */
    public static final class Game {
        /** "" = 진행중인 게임 없음, 아니면 Settings.G_WORD / G_BASEBALL / G_QUIZ */
        public String kind = "";
        /** 마지막 진행 시각 */
        public long at;
        /** 게임을 시작한 사람 (안내문에만 쓴다) */
        public String owner = "";
        // 끝말잇기
        public String word = "";
        public final HashSet<String> used = new HashSet<String>();
        // 숫자야구
        public String secret = "";
        public int tries;
        // 퀴즈
        public int quiz = -1;

        boolean none() { return kind == null || kind.length() == 0; }
    }

    /** 방키(RoomRef.key()) → 게임 */
    private static final HashMap<String, Game> GAMES = new HashMap<String, Game>();
    /** 방키 → (이름 → 점수) */
    private static final HashMap<String, HashMap<String, Integer>> SCORE =
            new HashMap<String, HashMap<String, Integer>>();
    /** 방키 → 최근 낸 퀴즈 번호 */
    private static final HashMap<String, HashSet<Integer>> ASKED = new HashMap<String, HashSet<Integer>>();
    /** 방키 → 봇이 마지막으로 보낸 시각 (계정별로 분리된다) */
    private static final HashMap<String, Long> LAST_BOT = new HashMap<String, Long>();
    /** 방키 → 봇이 최근 보낸 문구들 */
    private static final HashMap<String, ArrayList<Said>> SAID = new HashMap<String, ArrayList<Said>>();
    /** 로그 도배 방지 */
    private static final HashMap<String, Long> LOGGED = new HashMap<String, Long>();

    private static String today = "";
    private static int sentToday = 0;
    private static boolean loaded = false;

    private static final class Said {
        final String norm;
        final long at;
        Said(String norm, long at) { this.norm = norm; this.at = at; }
    }

    // ── 진입점 ────────────────────────────────────────────────────────────────

    /**
     * 메시지 한 건을 미니게임봇에 물린다. KakaoListener 의 BG 스레드에서 호출된다.
     *
     * @param room   방 (계정 + 방 이름)
     * @param sender 발신자 (모르면 "")
     * @param text   본문
     * @param group  그룹방인가
     */
    public static void onMessage(Context c, RoomRef room, String sender, String text, boolean group) {
        if (c == null || room == null || text == null) return;
        final String body = text.trim();
        if (body.length() == 0) return;

        if (!License.allowed(c, Features.MINIGAME)) return;

        Settings set;
        try {
            set = Settings.load(c);
        } catch (Throwable t) {
            return;
        }
        // 대상 계정이 아니면 동작하지 않는다 (Settings.accounts 가 비어 있으면 모든 계정이 대상)
        if (!set.accountOn(room.acc)) return;

        Settings.MiniGameCfg cfg = set.minigame;
        if (cfg == null || !cfg.enabled) return;

        if (!room.valid()) return;
        final RoomRef r = room;
        if (!covers(cfg, r)) return;

        final String who = nameOf(sender);
        final long now = System.currentTimeMillis();

        // 무한루프 차단 — 내 메시지 / 봇이 방금 보낸 문구
        String me = KakaoListener.selfName(room.acc);
        if (sender != null && me.length() > 0 && sender.trim().equals(me)) return;
        if (saidRecently(r, body, now)) return;

        synchronized (MiniGame.class) {
            load(c);
            rollDay(now);
        }

        String prefix = prefixOf(cfg);
        if (body.startsWith(prefix) && body.length() > prefix.length()) {
            command(c, cfg, r, who, body.substring(prefix.length()).trim(), prefix, now);
            return;
        }
        // 명령이 아니면 진행중인 게임의 입력으로 본다
        play(c, cfg, r, who, body, prefix, now);
    }

    /**
     * 이 방에서 봇이 돌아야 하나.
     * Settings.MiniGameCfg.coversRoom 은 rooms 가 비어있으면 false(=동작 안 함)다. 그 판정을 따른다.
     */
    public static boolean covers(Settings.MiniGameCfg cfg, RoomRef room) {
        if (cfg == null) return false;
        return cfg.coversRoom(room);
    }

    // ── 명령 ──────────────────────────────────────────────────────────────────

    private static void command(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                                 String line, String prefix, long now) {
        if (line.length() == 0) return;
        String cmd = line;
        String arg = "";
        int sp = firstSpace(line);
        if (sp > 0) {
            cmd = line.substring(0, sp);
            arg = line.substring(sp).trim();
        }

        if (cmd.equals("끝말잇기")) {
            if (!on(cfg, Settings.G_WORD)) { offMsg(c, cfg, r, "끝말잇기", now); return; }
            startWord(c, cfg, r, who, prefix, now);
            return;
        }
        if (cmd.equals("숫자야구") || cmd.equals("야구")) {
            if (!on(cfg, Settings.G_BASEBALL)) { offMsg(c, cfg, r, "숫자야구", now); return; }
            startBaseball(c, cfg, r, who, prefix, now);
            return;
        }
        if (cmd.equals("주사위")) {
            if (!on(cfg, Settings.G_DICE)) { offMsg(c, cfg, r, "주사위", now); return; }
            dice(c, cfg, r, who, arg, now);
            return;
        }
        if (cmd.equals("가위바위보") || cmd.equals("묵찌빠")) {
            if (!on(cfg, Settings.G_RPS)) { offMsg(c, cfg, r, "가위바위보", now); return; }
            rps(c, cfg, r, who, arg, prefix, now);
            return;
        }
        if (cmd.equals("퀴즈")) {
            if (!on(cfg, Settings.G_QUIZ)) { offMsg(c, cfg, r, "퀴즈", now); return; }
            startQuiz(c, cfg, r, who, prefix, now);
            return;
        }
        if (cmd.equals("힌트")) { hint(c, cfg, r, now); return; }
        if (cmd.equals("정답")) { reveal(c, cfg, r, now); return; }
        if (cmd.equals("포기")) { giveUp(c, cfg, r, who, now); return; }
        if (cmd.equals("점수")) {
            send(c, cfg, r, nameOf(who) + "님 누적 점수 " + scoreOf(r, who) + "점입니다.", now);
            return;
        }
        if (cmd.equals("랭킹") || cmd.equals("순위")) {
            send(c, cfg, r, rankingText(c, r), now);
            return;
        }
        if (cmd.equals("게임도움") || cmd.equals("게임")) {
            send(c, cfg, r, helpText(c, cfg, prefix), now);
            return;
        }
        if (cmd.equals("도움") || cmd.equals("명령")) {
            // 방 관리봇이 같은 접두사로 같은 방에서 돌고 있으면 그쪽이 답한다 (두 번 보내지 않게)
            if (roomBotOwnsHelp(c, r, prefix)) return;
            send(c, cfg, r, helpText(c, cfg, prefix), now);
            return;
        }
        // 모르는 명령은 조용히 넘긴다
    }

    /** 방 관리봇이 같은 방·같은 접두사로 돌고 있나 (!도움 중복 응답 방지) */
    private static boolean roomBotOwnsHelp(Context c, RoomRef r, String prefix) {
        try {
            Settings.RoomBotCfg rb = Settings.roombot(c);
            if (rb == null || !rb.enabled) return false;
            if (!rb.coversRoom(r)) return false;
            if (!License.allowed(c, Features.ROOMBOT)) return false;
            return RoomBot.prefixOf(rb).equals(prefix);
        } catch (Throwable t) {
            return false;
        }
    }

    private static void offMsg(Context c, Settings.MiniGameCfg cfg, RoomRef r, String name, long now) {
        send(c, cfg, r, "「" + name + "」는 사용 중지 상태입니다. 앱의 봇 탭에서 활성화할 수 있습니다.", now);
    }

    private static boolean on(Settings.MiniGameCfg cfg, String id) {
        return cfg != null && cfg.gameOn(id);
    }

    // ── 끝말잇기 ──────────────────────────────────────────────────────────────

    private static void startWord(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                                   String prefix, long now) {
        String first;
        synchronized (MiniGame.class) {
            Game g = game(r);
            if (!g.none() && !Settings.G_WORD.equals(g.kind)) {
                String busy = Settings.gameLabel(g.kind);
                sendLater(c, cfg, r, "「" + busy + "」가 진행 중입니다. " + prefix
                        + "포기 입력 후 시작하십시오.", now);
                return;
            }
            g.kind = Settings.G_WORD;
            g.owner = who;
            g.used.clear();
            g.tries = 0;
            g.at = now;
            first = WordDict.startWord(g.used);
            if (first == null) {
                g.kind = "";
                sendLater(c, cfg, r, "사전을 읽지 못해 끝말잇기를 시작할 수 없습니다.", now);
                return;
            }
            g.word = first;
            g.used.add(first);
            save(c);
        }
        send(c, cfg, r, "끝말잇기를 시작합니다. 첫 단어 → 「" + first + "」\n'"
                + WordDict.variantsText(WordDict.tail(first)) + "' 로 시작하는 단어를 "
                + (WORD_TURN_MS / 1000) + "초 내에 입력하십시오. (사전 " + WordDict.size() + "단어 · 종료 "
                + prefix + "포기)", now);
        Log.add(c, "미니게임 끝말잇기 시작 · 「" + r.label(c) + "」 첫 단어 " + first);
    }

    /** 끝말잇기 입력 판정. 처리했으면 true. */
    private static boolean wordTurn(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                                    String body, String prefix, long now) {
        // 단어처럼 보이는 것만 판정한다 (일반 대화까지 물면 봇이 시끄러워진다)
        if (!WordDict.hangul(body) || body.length() < 2 || body.length() > 4) return false;

        String cur;
        String reply = null;
        String botWord = null;
        int add = 0;
        boolean end = false;

        synchronized (MiniGame.class) {
            Game g = game(r);
            if (!Settings.G_WORD.equals(g.kind)) return false;
            cur = g.word;

            if (g.used.contains(body)) {
                reply = "「" + body + "」는 이미 사용된 단어입니다. 다른 단어를 입력하십시오.";
            } else if (!WordDict.has(body)) {
                reply = "「" + body + "」는 사전에 없는 단어입니다. 다른 단어를 입력하십시오.";
            } else if (!WordDict.linkable(cur, body)) {
                reply = "「" + cur + "」 다음 단어는 '" + WordDict.variantsText(WordDict.tail(cur))
                        + "' 로 시작해야 합니다.";
            } else {
                g.used.add(body);
                g.word = body;
                g.at = now;
                add = P_WORD;
                botWord = WordDict.nextStarting(WordDict.tail(body), g.used);
                if (botWord == null) {
                    end = true;
                    g.kind = "";
                } else {
                    g.used.add(botWord);
                    g.word = botWord;
                    trimUsed(g);
                }
            }
            save(c);
        }

        if (reply != null) {
            send(c, cfg, r, reply, now);
            return true;
        }

        int total = bump(c, r, who, add + (end ? P_WORD_WIN : 0));
        if (end) {
            send(c, cfg, r, "이을 단어가 없습니다. " + nameOf(who) + "님 승리 (+"
                    + (P_WORD + P_WORD_WIN) + "점, 누적 " + total + "점)\n재시작 "
                    + prefix + "끝말잇기", now);
            Log.add(c, "미니게임 끝말잇기 종료(봇 패배) · 「" + r.label(c) + "」 " + nameOf(who));
        } else {
            send(c, cfg, r, "통과. 「" + botWord + "」\n다음 시작 글자 '"
                    + WordDict.variantsText(WordDict.tail(botWord)) + "' (" + nameOf(who)
                    + "님 " + total + "점)", now);
        }
        return true;
    }

    private static void trimUsed(Game g) {
        if (g.used.size() <= MAX_USED) return;
        // 오래된 걸 고를 방법이 없으니(순서 없는 Set) 지금 단어만 남기고 비운다
        String keep = g.word;
        g.used.clear();
        if (keep != null && keep.length() > 0) g.used.add(keep);
    }

    // ── 숫자야구 ──────────────────────────────────────────────────────────────

    private static void startBaseball(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                                       String prefix, long now) {
        synchronized (MiniGame.class) {
            Game g = game(r);
            if (!g.none() && !Settings.G_BASEBALL.equals(g.kind)) {
                sendLater(c, cfg, r, "「" + Settings.gameLabel(g.kind) + "」가 진행 중입니다. "
                        + prefix + "포기 입력 후 시작하십시오.", now);
                return;
            }
            g.kind = Settings.G_BASEBALL;
            g.owner = who;
            g.secret = secret3();
            g.tries = 0;
            g.at = now;
            save(c);
        }
        send(c, cfg, r, "숫자야구를 시작합니다. 서로 다른 3자리 숫자를 입력하십시오 (첫 자리 0 제외).\n"
                + "자리와 숫자 일치 S, 숫자만 일치 B. 기회 " + BASEBALL_TRIES + "회 · 종료 "
                + prefix + "포기", now);
        Log.add(c, "미니게임 숫자야구 시작 · 「" + r.label(c) + "」");
    }

    /** 3자리 서로 다른 숫자 (맨 앞은 0 제외) */
    private static String secret3() {
        int[] d = new int[10];
        for (int i = 0; i < 10; i++) d[i] = i;
        for (int i = 9; i > 0; i--) {
            int j = RND.nextInt(i + 1);
            int t = d[i]; d[i] = d[j]; d[j] = t;
        }
        int a = d[0], b = d[1], e = d[2];
        if (a == 0) { int t = a; a = b; b = t; }
        return "" + a + b + e;
    }

    /** 숫자야구 입력 판정. 처리했으면 true. */
    private static boolean baseballTurn(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                                         String body, long now) {
        if (body.length() != 3) return false;
        for (int i = 0; i < 3; i++) {
            if (body.charAt(i) < '0' || body.charAt(i) > '9') return false;
        }

        // 판정 전에 게임이 도는지만 먼저 본다 (잠금을 잡은 채로 발송하지 않게)
        boolean active;
        synchronized (MiniGame.class) {
            Game g = GAMES.get(r.key());
            active = (g != null) && Settings.G_BASEBALL.equals(g.kind);
        }
        if (!active) return false;
        if (dup(body)) {
            send(c, cfg, r, "숫자 3개는 서로 달라야 합니다.", now);
            return true;
        }

        String reply;
        int add = 0;
        boolean win = false;
        synchronized (MiniGame.class) {
            Game g = game(r);
            if (!Settings.G_BASEBALL.equals(g.kind)) return false;
            g.at = now;
            g.tries = g.tries + 1;
            int s = 0, b = 0;
            for (int i = 0; i < 3; i++) {
                char ch = body.charAt(i);
                int at = g.secret.indexOf(ch);
                if (at < 0) continue;
                if (at == i) s++; else b++;
            }
            if (s == 3) {
                reply = "정답입니다. " + body + " · " + g.tries + "회 시도. " + nameOf(who) + "님 +"
                        + P_BASEBALL + "점";
                add = P_BASEBALL;
                win = true;
                g.kind = "";
            } else if (g.tries >= BASEBALL_TRIES) {
                reply = body + " → " + s + "S " + b + "B\n기회를 모두 사용했습니다. 정답 " + g.secret;
                g.kind = "";
            } else {
                reply = body + " → " + s + "S " + b + "B (" + g.tries + "/" + BASEBALL_TRIES + ")";
            }
            save(c);
        }
        if (add > 0) {
            int total = bump(c, r, who, add);
            reply = reply + " (누적 " + total + "점)";
        }
        send(c, cfg, r, reply, now);
        if (win) Log.add(c, "미니게임 숫자야구 정답 · 「" + r.label(c) + "」 " + nameOf(who));
        return true;
    }

    private static boolean dup(String s) {
        return s.charAt(0) == s.charAt(1) || s.charAt(1) == s.charAt(2) || s.charAt(0) == s.charAt(2);
    }

    // ── 주사위 / 가위바위보 ───────────────────────────────────────────────────

    private static void dice(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                              String arg, long now) {
        int faces = 6;
        if (arg.length() > 0) {
            int n = intOf(arg, -1);
            if (n < 1 || n > 100) {
                send(c, cfg, r, "주사위 면 수는 1~100 범위로 입력하십시오. (예: 주사위 20)", now);
                return;
            }
            faces = n;
        }
        int v = 1 + RND.nextInt(faces);
        send(c, cfg, r, nameOf(who) + "님 " + faces + "면 주사위 결과 → " + v, now);
    }

    private static void rps(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                             String arg, String prefix, long now) {
        int mine = handOf(arg);
        if (mine < 0) {
            send(c, cfg, r, "「" + prefix + "가위바위보 가위」 형식으로 입력하십시오. (가위 · 바위 · 보)", now);
            return;
        }
        int bot = RND.nextInt(3);
        String[] name = { "가위", "바위", "보" };
        int diff = (mine - bot + 3) % 3;
        String out = "봇 " + name[bot] + " · " + nameOf(who) + "님 " + name[mine] + " → ";
        if (diff == 0) {
            send(c, cfg, r, out + "무승부", now);
            return;
        }
        if (diff == 1) {
            int total = bump(c, r, who, P_RPS);
            send(c, cfg, r, out + nameOf(who) + "님 승리 (+" + P_RPS + "점, 누적 " + total + "점)", now);
            return;
        }
        send(c, cfg, r, out + "봇 승리", now);
    }

    /** 0=가위 1=바위 2=보, 모르면 -1 */
    private static int handOf(String s) {
        if (s == null) return -1;
        String v = s.trim();
        if (v.startsWith("가위")) return 0;
        if (v.startsWith("바위") || v.startsWith("묵")) return 1;
        if (v.startsWith("보")) return 2;
        return -1;
    }

    // ── 퀴즈 ──────────────────────────────────────────────────────────────────

    private static void startQuiz(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                                   String prefix, long now) {
        int idx;
        synchronized (MiniGame.class) {
            Game g = game(r);
            if (!g.none() && !Settings.G_QUIZ.equals(g.kind)) {
                sendLater(c, cfg, r, "「" + Settings.gameLabel(g.kind) + "」가 진행 중입니다. "
                        + prefix + "포기 입력 후 시작하십시오.", now);
                return;
            }
            HashSet<Integer> asked = ASKED.get(r.key());
            if (asked == null) { asked = new HashSet<Integer>(); ASKED.put(r.key(), asked); }
            if (asked.size() >= QuizBank.size()) asked.clear();
            idx = QuizBank.randomIndex(asked);
            if (!QuizBank.valid(idx)) {
                sendLater(c, cfg, r, "퀴즈 문제를 불러오지 못했습니다.", now);
                return;
            }
            asked.add(Integer.valueOf(idx));
            g.kind = Settings.G_QUIZ;
            g.owner = who;
            g.quiz = idx;
            g.at = now;
            save(c);
        }
        send(c, cfg, r, "[퀴즈] " + QuizBank.question(idx) + "\n정답을 채팅으로 입력하십시오. (힌트 "
                + prefix + "힌트 · 정답 공개 " + prefix + "정답)", now);
    }

    /** 퀴즈 정답 판정. 처리했으면 true. */
    private static boolean quizTurn(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                                     String body, String prefix, long now) {
        int idx;
        synchronized (MiniGame.class) {
            Game g = game(r);
            if (!Settings.G_QUIZ.equals(g.kind)) return false;
            idx = g.quiz;
            if (!QuizBank.correct(idx, body)) return false;   // 틀린 답엔 반응하지 않는다 (시끄러워진다)
            g.kind = "";
            g.quiz = -1;
            g.at = now;
            save(c);
        }
        int total = bump(c, r, who, P_QUIZ);
        send(c, cfg, r, "정답입니다. 「" + QuizBank.answer(idx) + "」 · " + nameOf(who) + "님 +" + P_QUIZ
                + "점 (누적 " + total + "점)\n다음 문제 " + prefix + "퀴즈", now);
        return true;
    }

    private static void hint(Context c, Settings.MiniGameCfg cfg, RoomRef r, long now) {
        String msg;
        synchronized (MiniGame.class) {
            Game g = game(r);
            if (Settings.G_QUIZ.equals(g.kind) && QuizBank.valid(g.quiz)) {
                msg = "힌트 · " + QuizBank.hint(g.quiz);
            } else if (Settings.G_WORD.equals(g.kind)) {
                String cand = WordDict.nextStarting(WordDict.tail(g.word), g.used);
                msg = (cand == null)
                        ? "봇이 이을 수 있는 단어가 없습니다. 먼저 입력하면 승리합니다."
                        : "힌트 · " + cand.charAt(0) + "…로 시작하는 " + cand.length() + "글자 단어";
            } else if (Settings.G_BASEBALL.equals(g.kind)) {
                msg = "힌트 · 숫자는 서로 다르며 첫 자리는 0이 아닙니다. 현재 "
                        + g.tries + "회 시도.";
            } else {
                msg = "진행 중인 게임이 없습니다.";
            }
        }
        send(c, cfg, r, msg, now);
    }

    private static void reveal(Context c, Settings.MiniGameCfg cfg, RoomRef r, long now) {
        String msg;
        synchronized (MiniGame.class) {
            Game g = game(r);
            if (Settings.G_QUIZ.equals(g.kind) && QuizBank.valid(g.quiz)) {
                msg = "정답 「" + QuizBank.answer(g.quiz) + "」";
                g.kind = "";
                g.quiz = -1;
            } else if (Settings.G_BASEBALL.equals(g.kind)) {
                msg = "정답 " + g.secret;
                g.kind = "";
            } else if (Settings.G_WORD.equals(g.kind)) {
                msg = "현재 이어야 하는 단어는 「" + g.word + "」 입니다.";
            } else {
                msg = "진행 중인 게임이 없습니다.";
            }
            save(c);
        }
        send(c, cfg, r, msg, now);
    }

    private static void giveUp(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who, long now) {
        String msg;
        synchronized (MiniGame.class) {
            Game g = game(r);
            if (g.none()) {
                msg = "진행 중인 게임이 없습니다.";
            } else {
                String label = Settings.gameLabel(g.kind);
                StringBuilder sb = new StringBuilder();
                sb.append("「").append(label).append("」를 종료했습니다.");
                if (Settings.G_BASEBALL.equals(g.kind)) sb.append(" 정답 ").append(g.secret).append(".");
                if (Settings.G_QUIZ.equals(g.kind) && QuizBank.valid(g.quiz)) {
                    sb.append(" 정답 「").append(QuizBank.answer(g.quiz)).append("」.");
                }
                if (Settings.G_WORD.equals(g.kind)) {
                    sb.append(" 마지막 단어 「").append(g.word).append("」.");
                }
                msg = sb.toString();
                reset(g);
            }
            save(c);
        }
        send(c, cfg, r, msg, now);
    }

    private static void reset(Game g) {
        g.kind = "";
        g.word = "";
        g.secret = "";
        g.quiz = -1;
        g.tries = 0;
        g.used.clear();
    }

    // ── 진행중인 게임에 입력 물리기 ───────────────────────────────────────────

    private static void play(Context c, Settings.MiniGameCfg cfg, RoomRef r, String who,
                              String body, String prefix, long now) {
        String kind;
        boolean timedOut = false;
        String timeoutMsg = null;
        synchronized (MiniGame.class) {
            Game g = GAMES.get(r.key());
            if (g == null || g.none()) return;
            kind = g.kind;
            // 시간 초과 판정은 "다음 메시지가 올 때" 한다 (알람을 걸지 않는다 — SPEC 8.6)
            if (Settings.G_WORD.equals(kind) && now - g.at > WORD_TURN_MS) {
                timeoutMsg = "시간 초과. 「" + g.word + "」 에서 끝말잇기를 종료했습니다. 재시작 "
                        + prefix + "끝말잇기";
                timedOut = true;
            } else if (Settings.G_BASEBALL.equals(kind) && now - g.at > BASEBALL_TTL_MS) {
                timeoutMsg = "장시간 입력이 없어 숫자야구를 종료했습니다. 정답 " + g.secret;
                timedOut = true;
            } else if (Settings.G_QUIZ.equals(kind) && now - g.at > QUIZ_TTL_MS) {
                timeoutMsg = "퀴즈 제한 시간이 지났습니다. 정답 「" + QuizBank.answer(g.quiz) + "」";
                timedOut = true;
            }
            if (timedOut) {
                reset(g);
                save(c);
            }
        }
        if (timedOut) {
            send(c, cfg, r, timeoutMsg, now);
            return;
        }

        if (Settings.G_WORD.equals(kind)) {
            if (!on(cfg, Settings.G_WORD)) return;
            wordTurn(c, cfg, r, who, body, prefix, now);
            return;
        }
        if (Settings.G_BASEBALL.equals(kind)) {
            if (!on(cfg, Settings.G_BASEBALL)) return;
            baseballTurn(c, cfg, r, who, body, now);
            return;
        }
        if (Settings.G_QUIZ.equals(kind)) {
            if (!on(cfg, Settings.G_QUIZ)) return;
            quizTurn(c, cfg, r, who, body, prefix, now);
        }
    }

    // ── 점수 / 랭킹 ───────────────────────────────────────────────────────────

    /** 점수를 더하고 누적 점수를 돌려준다 */
    private static int bump(Context c, RoomRef r, String who, int add) {
        String w = nameOf(who);
        synchronized (MiniGame.class) {
            String rk = r.key();
            HashMap<String, Integer> board = SCORE.get(rk);
            if (board == null) { board = new HashMap<String, Integer>(); SCORE.put(rk, board); }
            Integer cur = board.get(w);
            int v = ((cur == null) ? 0 : cur.intValue()) + add;
            if (v < 0) v = 0;
            board.put(w, Integer.valueOf(v));
            trimBoard(board);
            trimRooms(rk);
            save(c);
            return v;
        }
    }

    /** 그 사람의 방 점수 */
    public static int scoreOf(RoomRef room, String who) {
        if (room == null) return 0;
        synchronized (MiniGame.class) {
            HashMap<String, Integer> board = SCORE.get(room.key());
            if (board == null) return 0;
            Integer v = board.get(nameOf(who));
            return (v == null) ? 0 : v.intValue();
        }
    }

    /** 방 상위 점수 (최대 max명). "1. 이름 12점" 형태 문자열 목록. */
    public static List<String> ranking(Context c, RoomRef room, int max) {
        ArrayList<String> out = new ArrayList<String>();
        if (room == null) return out;
        String r = room.key();
        synchronized (MiniGame.class) {
            load(c);
            HashMap<String, Integer> board = SCORE.get(r);
            if (board == null || board.isEmpty()) return out;
            ArrayList<Map.Entry<String, Integer>> all =
                    new ArrayList<Map.Entry<String, Integer>>(board.entrySet());
            java.util.Collections.sort(all, new java.util.Comparator<Map.Entry<String, Integer>>() {
                @Override public int compare(Map.Entry<String, Integer> a, Map.Entry<String, Integer> b) {
                    int d = b.getValue().intValue() - a.getValue().intValue();
                    if (d != 0) return d;
                    return a.getKey().compareTo(b.getKey());
                }
            });
            for (int i = 0; i < all.size() && (max <= 0 || out.size() < max); i++) {
                Map.Entry<String, Integer> e = all.get(i);
                if (e.getValue().intValue() <= 0) continue;
                out.add((out.size() + 1) + ". " + e.getKey() + " " + e.getValue() + "점");
            }
        }
        return out;
    }

    /** {접두사}랭킹 으로 나가는 문장 (상위 10명) */
    public static String rankingText(Context c, RoomRef room) {
        List<String> rows = ranking(c, room, 10);
        if (rows.isEmpty()) return "등록된 점수가 없습니다. 게임을 시작하면 점수가 기록됩니다.";
        StringBuilder sb = new StringBuilder("[랭킹] 상위 " + rows.size() + "명");
        for (int i = 0; i < rows.size(); i++) sb.append('\n').append(rows.get(i));
        return sb.toString();
    }

    /** 점수 초기화. 방을 지정하면 그 방만, null 이면 전부. */
    public static void clearScores(Context c, RoomRef room) {
        synchronized (MiniGame.class) {
            load(c);
            if (room == null) SCORE.clear();
            else SCORE.remove(room.key());
            save(c);
        }
    }

    /** 진행중인 게임 접기 (설정 화면의 "게임 초기화"). room 이 null 이면 전부. */
    public static void resetGames(Context c, RoomRef room) {
        synchronized (MiniGame.class) {
            load(c);
            if (room == null) {
                Iterator<Game> it = GAMES.values().iterator();
                while (it.hasNext()) reset(it.next());
            } else {
                Game g = GAMES.get(room.key());
                if (g != null) reset(g);
            }
            save(c);
        }
    }

    private static void trimBoard(HashMap<String, Integer> board) {
        if (board.size() <= MAX_PLAYERS) return;
        ArrayList<Map.Entry<String, Integer>> all =
                new ArrayList<Map.Entry<String, Integer>>(board.entrySet());
        java.util.Collections.sort(all, new java.util.Comparator<Map.Entry<String, Integer>>() {
            @Override public int compare(Map.Entry<String, Integer> a, Map.Entry<String, Integer> b) {
                return a.getValue().intValue() - b.getValue().intValue();
            }
        });
        int drop = board.size() - MAX_PLAYERS;
        for (int i = 0; i < drop && i < all.size(); i++) board.remove(all.get(i).getKey());
    }

    private static void trimRooms(String keep) {
        Iterator<String> it = SCORE.keySet().iterator();
        while (it.hasNext() && SCORE.size() > MAX_ROOMS) {
            String k = it.next();
            if (k.equals(keep)) continue;
            it.remove();
        }
        Iterator<String> it2 = GAMES.keySet().iterator();
        while (it2.hasNext() && GAMES.size() > MAX_ROOMS) {
            String k = it2.next();
            if (k.equals(keep)) continue;
            it2.remove();
        }
    }

    // ── 안내문 (설정 화면도 쓴다) ─────────────────────────────────────────────

    public static String helpText(Context c) {
        Settings.MiniGameCfg cfg = Settings.minigame(c);
        return helpText(c, cfg, prefixOf(cfg));
    }

    public static String helpText(Context c, Settings.MiniGameCfg cfg, String prefix) {
        StringBuilder sb = new StringBuilder("[미니게임 명령]");
        if (on(cfg, Settings.G_WORD)) sb.append('\n').append(prefix).append("끝말잇기 — 사전 단어 이어가기");
        if (on(cfg, Settings.G_BASEBALL)) sb.append('\n').append(prefix).append("숫자야구 — 3자리 숫자 맞히기");
        if (on(cfg, Settings.G_DICE)) sb.append('\n').append(prefix).append("주사위 [면수] — 기본 6면");
        if (on(cfg, Settings.G_RPS)) sb.append('\n').append(prefix).append("가위바위보 가위|바위|보");
        if (on(cfg, Settings.G_QUIZ)) sb.append('\n').append(prefix).append("퀴즈 — 상식 문제 ")
                .append(QuizBank.size()).append("개");
        sb.append('\n').append(prefix).append("힌트 · ").append(prefix).append("정답 · ")
          .append(prefix).append("포기");
        sb.append('\n').append(prefix).append("점수 · ").append(prefix).append("랭킹");
        return sb.toString();
    }

    /** 설정 화면용 한 줄 요약 (목록 행의 값 칸에 그대로 쓴다) */
    public static String summary(Context c) {
        Settings.MiniGameCfg cfg = Settings.minigame(c);
        if (cfg == null) return "설정 확인 불가";
        if (!cfg.enabled) return "꺼짐";
        if (cfg.rooms == null || cfg.rooms.isEmpty()) return "설정 필요 · 대상 대화방 없음";
        int n = 0;
        for (int i = 0; i < Settings.GAMES.length; i++) if (cfg.gameOn(Settings.GAMES[i])) n++;
        return "켜짐 · 대화방 " + cfg.rooms.size() + "개 · 게임 " + n + "종 · 금일 " + today(c) + "건";
    }

    /** 저장 전 점검. 문제없으면 null. */
    public static String validate(Settings.MiniGameCfg cfg) {
        if (cfg == null) return "설정 내용이 비어 있습니다.";
        if (cfg.enabled && (cfg.rooms == null || cfg.rooms.isEmpty())) {
            return "봇이 동작할 대화방을 1개 이상 선택하십시오.";
        }
        if (cfg.cmdPrefix == null || cfg.cmdPrefix.trim().length() == 0) return "명령어 앞글자를 입력하십시오.";
        if (cfg.cooldownMs < MIN_COOLDOWN_MS) {
            return "쿨타임은 " + (MIN_COOLDOWN_MS / 1000L) + "초 이상으로 입력하십시오.";
        }
        if (cfg.dailyLimit < 0) return "일일 한도는 0 이상으로 입력하십시오.";
        boolean any = false;
        for (int i = 0; i < Settings.GAMES.length; i++) if (cfg.gameOn(Settings.GAMES[i])) any = true;
        if (cfg.enabled && !any) return "게임을 1개 이상 활성화하십시오.";
        return null;
    }

    /** 오늘 봇이 보낸 메시지 수 */
    public static int today(Context c) {
        synchronized (MiniGame.class) {
            load(c);
            rollDay(System.currentTimeMillis());
            return sentToday;
        }
    }

    /** 그 방에서 지금 돌고 있는 게임 이름 (없으면 "") */
    public static String currentGame(RoomRef room) {
        if (room == null) return "";
        synchronized (MiniGame.class) {
            Game g = GAMES.get(room.key());
            if (g == null || g.none()) return "";
            return Settings.gameLabel(g.kind);
        }
    }

    // ── 발송 ──────────────────────────────────────────────────────────────────

    /** 쿨다운으로 막히면 그냥 버린다 (게임은 늦게 오는 답이 더 이상하다) */
    private static boolean send(Context c, Settings.MiniGameCfg cfg, RoomRef r, String msg, long now) {
        if (msg == null || msg.trim().length() == 0) return false;
        if (r == null) return false;
        int limit = (cfg == null) ? 0 : cfg.dailyLimit;
        long cool = (cfg == null) ? MIN_COOLDOWN_MS : Math.max(MIN_COOLDOWN_MS, cfg.cooldownMs);
        final String rk = r.key();
        final String label = r.label(c);
        synchronized (MiniGame.class) {
            load(c);
            rollDay(now);
            if (limit > 0 && sentToday >= limit) {
                note(c, "limit", "미니게임봇 일일 한도(" + limit + "건)를 모두 사용했습니다. 자정에 초기화됩니다.");
                return false;
            }
            Long last = LAST_BOT.get(rk);
            if (last != null && now - last.longValue() < cool) {
                note(c, "cool:" + rk, "미니게임봇 「" + label + "」 쿨타임(" + (cool / 1000)
                        + "초) 중이므로 1건을 건너뛰었습니다.");
                return false;
            }
            LAST_BOT.put(rk, Long.valueOf(now));
            sentToday = sentToday + 1;
            remember(rk, msg, now);
            save(c);
        }
        int rr = KakaoListener.send(c, r, msg, SendGuard.MINIGAME);
        if (rr == KakaoListener.SEND_HELD) {
            // 다른 계정의 봇이 방금 답했다. 같은 명령에 두 번 답하지 않는다.
            KakaoListener.noteHeld(c, r, SendGuard.MINIGAME, 0L, true);
            return false;
        }
        boolean ok = (rr == KakaoListener.SEND_OK);
        if (!ok) {
            synchronized (MiniGame.class) {
                if (sentToday > 0) sentToday = sentToday - 1;
                save(c);
            }
            Log.add(c, "미니게임봇 발송에 실패했습니다. 「" + label + "」");
        }
        return ok;
    }

    /** 잠금 안에서 부를 수 있는 발송 (잠금을 잡은 채로 네트워크·발송을 하지 않게 뒤로 미룬다) */
    private static void sendLater(final Context c, final Settings.MiniGameCfg cfg, final RoomRef r,
                                   final String msg, final long now) {
        KakaoListener.post(new Runnable() {
            @Override public void run() {
                send(c, cfg, r, msg, System.currentTimeMillis());
            }
        }, 0);
    }

    private static Game game(RoomRef r) {
        String k = r.key();
        Game g = GAMES.get(k);
        if (g == null) { g = new Game(); GAMES.put(k, g); }
        return g;
    }

    // ── 메아리 차단 ───────────────────────────────────────────────────────────

    private static void remember(String rk, String msg, long now) {
        final String r = rk;
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

    private static boolean saidRecently(RoomRef room, String body, long now) {
        String b = flat(body);
        if (b.length() == 0 || room == null) return false;
        synchronized (MiniGame.class) {
            ArrayList<Said> list = SAID.get(room.key());
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

    // ── 잡동사니 ──────────────────────────────────────────────────────────────

    public static String prefixOf(Settings.MiniGameCfg cfg) {
        if (cfg == null) return "!";
        String p = (cfg.cmdPrefix == null) ? "" : cfg.cmdPrefix.trim();
        return (p.length() == 0) ? "!" : p;
    }

    private static String nameOf(String who) {
        if (who == null) return "누군가";
        String n = who.trim();
        return (n.length() == 0) ? "누군가" : n;
    }

    private static int firstSpace(String s) {
        for (int i = 0; i < s.length(); i++) {
            if (Character.isWhitespace(s.charAt(i))) return i;
        }
        return -1;
    }

    private static int intOf(String s, int def) {
        try {
            return Integer.parseInt(s.trim());
        } catch (Throwable t) {
            return def;
        }
    }

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

            JSONObject sc = o.optJSONObject("score");
            if (sc != null) {
                Iterator<String> rooms = sc.keys();
                while (rooms.hasNext()) {
                    String room = rooms.next();
                    JSONObject board = sc.optJSONObject(room);
                    if (board == null) continue;
                    HashMap<String, Integer> m = new HashMap<String, Integer>();
                    Iterator<String> names = board.keys();
                    while (names.hasNext()) {
                        String name = names.next();
                        int v = board.optInt(name, 0);
                        if (v > 0) m.put(name, Integer.valueOf(v));
                    }
                    if (m.isEmpty()) continue;
                    // 옛 기록은 계정 구분자가 없는 방 이름이다 → 기본 계정 키로 올려준다
                    RoomRef ref = RoomRef.parse(room);
                    SCORE.put((ref == null) ? room : ref.key(), m);
                }
            }

            JSONObject gs = o.optJSONObject("games");
            if (gs != null) {
                Iterator<String> rooms = gs.keys();
                while (rooms.hasNext()) {
                    String room = rooms.next();
                    JSONObject j = gs.optJSONObject(room);
                    if (j == null) continue;
                    Game g = new Game();
                    g.kind = j.optString("kind", "");
                    g.at = j.optLong("at", 0L);
                    g.owner = j.optString("owner", "");
                    g.word = j.optString("word", "");
                    g.secret = j.optString("secret", "");
                    g.tries = j.optInt("tries", 0);
                    g.quiz = j.optInt("quiz", -1);
                    JSONArray used = j.optJSONArray("used");
                    if (used != null) {
                        for (int i = 0; i < used.length() && i < MAX_USED; i++) {
                            String w = used.optString(i, "");
                            if (w.length() > 0) g.used.add(w);
                        }
                    }
                    if (g.none()) continue;
                    RoomRef gref = RoomRef.parse(room);
                    GAMES.put((gref == null) ? room : gref.key(), g);
                }
            }
        } catch (Throwable t) {
            Log.add(c, "미니게임 기록이 손상되어 초기화했습니다. (" + t + ")");
            GAMES.clear();
            SCORE.clear();
            sentToday = 0;
        }
    }

    private static void save(Context c) {
        if (c == null) return;
        try {
            JSONObject o = new JSONObject();
            o.put("day", today);
            o.put("n", sentToday);

            JSONObject sc = new JSONObject();
            Iterator<Map.Entry<String, HashMap<String, Integer>>> it = SCORE.entrySet().iterator();
            while (it.hasNext()) {
                Map.Entry<String, HashMap<String, Integer>> e = it.next();
                JSONObject board = new JSONObject();
                Iterator<Map.Entry<String, Integer>> it2 = e.getValue().entrySet().iterator();
                while (it2.hasNext()) {
                    Map.Entry<String, Integer> p = it2.next();
                    board.put(p.getKey(), p.getValue().intValue());
                }
                sc.put(e.getKey(), board);
            }
            o.put("score", sc);

            JSONObject gs = new JSONObject();
            Iterator<Map.Entry<String, Game>> it3 = GAMES.entrySet().iterator();
            while (it3.hasNext()) {
                Map.Entry<String, Game> e = it3.next();
                Game g = e.getValue();
                if (g == null || g.none()) continue;
                JSONObject j = new JSONObject();
                j.put("kind", g.kind);
                j.put("at", g.at);
                j.put("owner", g.owner);
                j.put("word", g.word);
                j.put("secret", g.secret);
                j.put("tries", g.tries);
                j.put("quiz", g.quiz);
                JSONArray used = new JSONArray();
                Iterator<String> it4 = g.used.iterator();
                int count = 0;
                while (it4.hasNext() && count < MAX_USED) { used.put(it4.next()); count++; }
                j.put("used", used);
                gs.put(e.getKey(), j);
            }
            o.put("games", gs);

            Prefs.putStr(c, K_STATE, o.toString());
        } catch (Throwable t) {
            Log.add(c, "미니게임 기록을 저장하지 못했습니다. (" + t + ")");
        }
    }
}
