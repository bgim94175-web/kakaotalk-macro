package com.buseong.kakaoauto;

import java.util.List;
import java.util.Locale;

/**
 * 내장 비속어 판정 — 방장이 금지어를 하나하나 적지 않아도 흔한 욕설을 잡는다.
 *
 * <h3>왜 필요한가</h3>
 * 방 관리봇의 금지어는 방장이 직접 적은 목록만 본다({@link RoomBot#banHit}). 그래서
 * 「시발」 을 적어 두면 「시1발」 · 「시이발」 · 「ㅅㅂ」 · 「시 발」 은 전부 빠져나간다.
 * 변형 표기를 사람이 손으로 다 적는 것은 불가능하다. 그 변형을 <b>되돌려서</b> 비교하는
 * 것이 이 클래스가 하는 일이다.
 *
 * <h3>어떻게 되돌리나 ({@link #fold})</h3>
 * 순서가 중요하다. 순서를 바꾸면 잡히던 것이 빠진다.
 * <ol>
 *   <li>글자·숫자만 남긴다 — 「시*발」 · 「시 발」 → 「시발」</li>
 *   <li>한글 사이에 끼운 숫자를 뺀다 — 「시1발」 → 「시발」</li>
 *   <li>같은 글자 반복을 하나로 — 「시발발발」 → 「시발」</li>
 *   <li>한글 사이의 「이」 를 뺀다 — 「시이발」 → 「시발」</li>
 * </ol>
 *
 * <h3>오탐은 반드시 난다 — 그래서 예외 목록이 짝으로 있다</h3>
 * 「개 새끼 고양이」 는 공백을 지우면 「개새끼고양이」 가 되어 걸린다. 「시발점」 도 걸린다.
 * 되돌리기를 세게 할수록 오탐이 늘고, 약하게 할수록 우회가 는다 — 둘 중 하나를 고르는
 * 문제가 아니라 <b>예외 목록</b>으로 메우는 문제다. 그래서 기본 예외를 넣어 두고
 * ({@link Settings.RoomBotCfg#swearAllow}) 방장이 더 넣을 수 있게 한다.
 * 예외는 되돌린 글에서 <b>먼저 지운 뒤</b> 비교한다.
 *
 * <h3>걸려도 그 글을 가릴 수는 없다</h3>
 * 외부 앱은 카카오톡 방에서 남의 글을 지우거나 가릴 수 없다({@link RoomBot} 머리말).
 * 이 판정으로 할 수 있는 일은 경고 1건 발송뿐이고, 욕설 자체는 방에 남는다.
 *
 * <h3>경고문에 걸린 단어를 넣지 않는다</h3>
 * {@code {금지어}} 치환에 실제로 걸린 어간을 넣으면 <b>봇이 그 욕을 방에 다시 올린다.</b>
 * 그래서 방에 나가는 값은 {@link #LABEL} 고정이고, 실제 어간은 기기 안 활동 로그에만
 * 남긴다(방장이 예외 목록을 고치려면 무엇에 걸렸는지 알아야 한다).
 */
public final class Profanity {

    private Profanity() {}

    /** 경고문의 {금지어} 자리에 들어가는 값 (실제 어간을 넣으면 봇이 욕을 다시 올린다) */
    public static final String LABEL = "비속어";

    /**
     * 어간 목록. 되돌린 글({@link #fold})에 이 중 하나가 들어 있으면 걸린다.
     *
     * 어간이라서 활용형을 따로 적지 않는다 — 「존나」 하나로 「존나게」 · 「존나서」 가 걸린다.
     * 자음 축약형(ㅅㅂ 등)은 오탐이 비교적 잦은 쪽이므로 예외 목록을 같이 보라.
     */
    private static final String[] STEMS = {
            "씨발", "시발", "씨팔", "시팔", "씨벌", "시벌",
            "병신", "벙신", "병쉰",
            "좆", "좇", "존나", "존내", "지랄",
            "개새끼", "개새기", "개색기", "개색끼", "개쉐", "개자식",
            "니미", "느금",
            "창녀", "창년",
            "미친놈", "미친년", "미친새끼",
            "엿먹", "닥쳐",
            "fuck", "shit", "bitch",
            "ㅅㅂ", "ㅆㅂ", "ㅂㅅ", "ㅈㄹ", "ㅈㄴ",
    };

    /**
     * 기본 예외. 되돌리면 어간이 들어가 버리는 평범한 낱말들이다.
     * 이 목록을 줄이면 바로 오탐이 난다 — 지울 때는 이유를 적어라.
     */
    public static final String[] DEFAULT_ALLOW = {
            "시발점",       // 始發點 — 「시발」
            "시발역",       // 始發驛 — 「시발」
            "시발차",       // 始發車 — 「시발」
            "개새벽",       // 「개새」 … 「개새끼」 까지는 안 가지만 변형 축약에서 걸릴 수 있다
            "존나이스",     // 「존나」
    };

    // ── 판정 ────────────────────────────────────────────────────────────────

    /**
     * 걸린 어간을 돌려준다 (안 걸리면 null).
     *
     * @param allow 방장이 정한 예외 목록 (null 이면 기본 예외만 쓴다)
     */
    public static String hit(String body, List<String> allow) {
        String s = fold(body);
        if (s.length() == 0) return null;
        s = strip(s, DEFAULT_ALLOW);
        if (allow != null) {
            for (int i = 0; i < allow.size(); i++) {
                String w = allow.get(i);
                if (w == null) continue;
                String f = fold(w);
                if (f.length() == 0) continue;
                s = replaceAll(s, f);
            }
        }
        if (s.length() == 0) return null;
        for (int i = 0; i < STEMS.length; i++) {
            if (s.contains(STEMS[i])) return STEMS[i];
        }
        return null;
    }

    /** 이 글이 예외 목록에 걸려 통과했는지 확인용 (화면의 「시험해 보기」 에 쓴다) */
    public static String folded(String body, List<String> allow) {
        String s = strip(fold(body), DEFAULT_ALLOW);
        if (allow != null) {
            for (int i = 0; i < allow.size(); i++) {
                String w = allow.get(i);
                if (w == null) continue;
                String f = fold(w);
                if (f.length() > 0) s = replaceAll(s, f);
            }
        }
        return s;
    }

    // ── 되돌리기 ────────────────────────────────────────────────────────────

    /** 우회 표기를 되돌린 글 (머리말의 1~4 순서대로) */
    public static String fold(String in) {
        if (in == null) return "";
        String s = in.toLowerCase(Locale.ROOT);
        s = lettersOnly(s);
        s = dropDigitsInside(s);
        s = collapseRepeats(s);
        s = dropIInside(s);
        return s;
    }

    /** 1) 글자·숫자만 남긴다 (공백·기호·이모지 제거) */
    private static String lettersOnly(String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (Character.isLetterOrDigit(c)) b.append(c);
        }
        return b.toString();
    }

    /** 2) 한글 사이에 끼운 숫자를 뺀다 — 「시1발」 → 「시발」 */
    private static String dropDigitsInside(String s) {
        StringBuilder b = new StringBuilder(s.length());
        int i = 0;
        while (i < s.length()) {
            char c = s.charAt(i);
            b.append(c);
            if (syl(c)) {
                int j = i + 1;
                while (j < s.length() && s.charAt(j) >= '0' && s.charAt(j) <= '9') j++;
                // 숫자가 하나 이상 있고 그 뒤가 또 한글이면 그 숫자들을 버린다
                if (j > i + 1 && j < s.length() && syl(s.charAt(j))) {
                    i = j;
                    continue;
                }
            }
            i++;
        }
        return b.toString();
    }

    /** 3) 같은 글자 반복을 하나로 — 「시발발발」 → 「시발」 (한글·자모만) */
    private static String collapseRepeats(String s) {
        StringBuilder b = new StringBuilder(s.length());
        char prev = 0;
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (i > 0 && c == prev && hangulish(c)) continue;
            b.append(c);
            prev = c;
        }
        return b.toString();
    }

    /** 4) 한글 사이의 「이」 를 뺀다 — 「시이발」 → 「시발」 */
    private static String dropIInside(String s) {
        StringBuilder b = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '이' && b.length() > 0 && syl(b.charAt(b.length() - 1))
                    && i + 1 < s.length() && syl(s.charAt(i + 1))) {
                continue;
            }
            b.append(c);
        }
        return b.toString();
    }

    /** 완성형 한글 한 글자인가 (가~힣) */
    private static boolean syl(char c) {
        return c >= '가' && c <= '힣';
    }

    /** 완성형 한글 또는 자모인가 */
    private static boolean hangulish(char c) {
        return syl(c) || (c >= 'ㄱ' && c <= 'ㅣ');
    }

    // ── 예외 지우기 ─────────────────────────────────────────────────────────

    private static String strip(String s, String[] words) {
        String out = s;
        for (int i = 0; i < words.length; i++) {
            String f = fold(words[i]);
            if (f.length() > 0) out = replaceAll(out, f);
        }
        return out;
    }

    /** {@code String.replace} 와 같지만 정규식을 쓰지 않는다 (어간에 기호가 섞여도 안전) */
    private static String replaceAll(String s, String needle) {
        if (needle.length() == 0) return s;
        StringBuilder b = new StringBuilder(s.length());
        int i = 0;
        while (true) {
            int k = s.indexOf(needle, i);
            if (k < 0) { b.append(s, i, s.length()); break; }
            b.append(s, i, k);
            i = k + needle.length();
        }
        return b.toString();
    }
}
