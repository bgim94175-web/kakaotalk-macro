package com.buseong.kakaoauto;

import android.content.Context;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * 방 공지 — 각 대화방에 방장·부방장이 올려 둔 공지사항을 앱에서 그대로 보여준다.
 *
 * <h3>공지는 알림으로 오지 않는다</h3>
 * 카카오톡의 공지는 대화방 화면 위쪽에 고정되는 <b>화면 요소</b>다. 알림에 들어오는 것은
 * 방 이름 · 보낸 사람 · 메시지 본문뿐이고 공지 칸은 들어오지 않는다. 그래서 공지를
 * 가져오는 길은 둘뿐이고, 둘 다 한계가 분명하다.
 *
 * <p><b>(1) 메시지로 포착</b> — 공지는 거의 항상 방에 올린 메시지를 「공지로 등록」 해서
 * 만든다. 그 메시지는 알림으로 들어오므로 그때 저장할 수 있다. 등록 안내 문구
 * ({@link #REG_WORDS})가 보이면 <b>그 방의 직전 메시지</b>를 공지로 올리고, 안내 문구가
 * 오지 않는 기기에서는 공지처럼 쓰인 메시지({@link #looksLikeNotice})를 공지로 본다.
 * 한계: 앱을 설치하기 <b>전에</b> 이미 등록돼 있던 공지는 이 방법으로 가져오지 못한다.
 *
 * <p><b>(2) 화면에서 읽기</b> — 사장이 「지금 가져오기」 를 누르면 그 대화방을 열고
 * ({@link KakaoListener#openIntentFor}) 공지 칸의 글자를 읽는다. 아무것도 누르지 않고
 * <b>읽기만</b> 한다. 한계: 카카오톡 화면 구성이 바뀌면 못 읽는다. 그래서 실패하면 화면
 * 구성 기록을 남긴다({@link #dump}).
 *
 * <h3>엉뚱한 방의 공지를 저장하지 않는다</h3>
 * (2)는 화면에 떠 있는 대화방 이름이 가져오려는 방 이름과 <b>같을 때만</b> 저장한다.
 * 이름이 다르거나 못 읽으면 실패로 끝낸다. 추측해서 저장하면 A 방 공지가 B 방 공지로
 * 보이는데, 그건 발송 대상을 추측했다가 난 오발송 사고와 같은 종류의 실수다.
 *
 * <h3>발송과 무관하다</h3>
 * 이 기능은 <b>읽어서 보여주기만</b> 한다. 공지를 어느 방에도 보내지 않는다.
 * (방 관리봇의 「공지문」 은 사장이 직접 적어 두고 명령으로 뿌리는 별개 기능이다.)
 *
 * <h3>저장</h3>
 * 암호화하지 않은 Prefs 에 JSON 으로 둔다. 라이선스 인증이 풀렸을 때도 보여야 하기
 * 때문이다. 사람이 쓴 글이 들어가므로 기기 안에만 두고 방 {@link #MAX_ROOMS} 개 ·
 * 1건 {@link #MAX_LEN} 자로 제한한다.
 */
public final class RoomNotice {

    private RoomNotice() {}

    /** 메시지로 포착 */
    public static final int SRC_MSG = 1;
    /** 카카오톡 화면에서 읽음 */
    public static final int SRC_SCREEN = 2;
    /** 사장이 직접 입력 */
    public static final int SRC_TYPED = 3;

    /** 공지를 보관할 최대 방 개수 */
    public static final int MAX_ROOMS = 200;
    /** 공지 1건의 최대 길이 */
    public static final int MAX_LEN = 2000;

    /** 메시지 포착을 쓸지 (끄면 (1) 이 멈춘다. (2) 와 직접 입력은 영향 없다) */
    private static final String K_AUTO = "room_notice_auto";
    private static final String K_DATA = "room_notice";
    private static final String K_DUMP = "room_notice_dump";

    // ── 공지 등록 안내 문구 (카톡 버전·기기마다 다르다) ───────────────────────
    //
    // 이 문구가 오면 **직전 메시지**가 공지다. 안내 문구 자체를 공지로 저장하면
    // "홍길동님이 공지를 등록했습니다" 가 공지로 보인다 → 반드시 직전 것을 올린다.
    private static final String[] REG_WORDS = {
            "공지를 등록했습니다", "공지를 등록하였습니다", "공지가 등록되었습니다",
            "공지사항을 등록했습니다", "공지를 수정했습니다", "공지를 등록했어요",
            "공지로 등록했습니다"
    };

    /** 공지처럼 쓰인 메시지의 앞글자 */
    private static final String[] NOTICE_HEADS = {
            "[공지]", "[공지", "(공지)", "(공지", "공지]", "공지)",
            "■공지", "▶공지", "★공지", "공지사항", "공지 :", "공지:", "공지 -", "공지-",
            "[필독]", "[필독", "필독]"
    };

    /** {@link #looksLikeNotice} 로 볼 최소 길이 — 짧은 글은 "공지 뭐야?" 같은 잡담이다 */
    private static final int MIN_NOTICE_LEN = 15;

    /** 한 건 */
    public static final class Entry {
        /** 대화방 ({@code RoomRef.key()}) */
        public final String roomKey;
        /** 공지 전문 */
        public final String text;
        /** 저장 시각 (epoch ms) */
        public final long at;
        /** {@link #SRC_MSG} / {@link #SRC_SCREEN} / {@link #SRC_TYPED} */
        public final int src;

        Entry(String roomKey, String text, long at, int src) {
            this.roomKey = roomKey;
            this.text = text;
            this.at = at;
            this.src = src;
        }

        /** 목록에 한 줄로 보여줄 요약 */
        public String oneLine() { return firstLine(text); }

        /** 「카카오톡 화면에서 읽음 · 10/05 14:32」 */
        public String where() { return srcLabel(src) + " · " + JoinLog.kst(at); }
    }

    // ── 상태 ────────────────────────────────────────────────────────────────

    private static final LinkedHashMap<String, Entry> ROWS = new LinkedHashMap<String, Entry>();
    private static boolean loaded = false;

    /** 방키 → 그 방의 직전 메시지 (등록 안내가 오면 이걸 공지로 올린다) */
    private static final HashMap<String, String> LAST_MSG = new HashMap<String, String>();
    /** LAST_MSG 를 들고 있는 최대 방 수 (메모리만 쓰는 값이라 저장하지 않는다) */
    private static final int MAX_LAST = 120;

    // ── 설정 ────────────────────────────────────────────────────────────────

    public static boolean autoOn(Context c) {
        if (c == null) return false;
        try { return Prefs.getBool(c, K_AUTO, true); } catch (Throwable t) { return true; }
    }

    public static void setAutoOn(Context c, boolean on) {
        if (c == null) return;
        try { Prefs.putBool(c, K_AUTO, on); } catch (Throwable ignore) { }
    }

    // ── 읽기 ────────────────────────────────────────────────────────────────

    /** 그 방의 공지 (없으면 null) */
    public static Entry get(Context c, RoomRef ref) {
        if (c == null || ref == null || !ref.valid()) return null;
        synchronized (RoomNotice.class) {
            load(c);
            return ROWS.get(ref.key());
        }
    }

    /** 공지가 있는 방 전부 (최근 저장 순) */
    public static List<Entry> all(Context c) {
        ArrayList<Entry> out = new ArrayList<Entry>();
        synchronized (RoomNotice.class) {
            load(c);
            out.addAll(ROWS.values());
        }
        Collections.sort(out, new Comparator<Entry>() {
            @Override public int compare(Entry x, Entry y) {
                if (x.at != y.at) return (x.at > y.at) ? -1 : 1;
                return x.roomKey.compareTo(y.roomKey);
            }
        });
        return out;
    }

    public static int count(Context c) {
        synchronized (RoomNotice.class) {
            load(c);
            return ROWS.size();
        }
    }

    // ── 쓰기 ────────────────────────────────────────────────────────────────

    /**
     * 공지를 저장한다. 같은 글이 이미 저장돼 있으면 시각만 그대로 두고 아무것도 하지 않는다
     * (같은 공지가 반복 포착될 때 '방금 바뀐 공지' 로 보이지 않게 한다).
     *
     * @return 실제로 바뀌었나
     */
    public static boolean put(Context c, RoomRef ref, String text, int src) {
        if (c == null || ref == null || !ref.valid()) return false;
        String t = clean(text);
        if (t.length() == 0) return false;
        String k = ref.key();
        synchronized (RoomNotice.class) {
            load(c);
            Entry old = ROWS.get(k);
            if (old != null && old.text.equals(t) && old.src == src) return false;
            ROWS.remove(k);                 // 넣기 전에 빼서 '최근' 순서를 다시 매긴다
            ROWS.put(k, new Entry(k, t, System.currentTimeMillis(), src));
            trim();
            save(c);
        }
        return true;
    }

    /** 그 방의 공지를 지운다 */
    public static boolean remove(Context c, RoomRef ref) {
        if (c == null || ref == null || !ref.valid()) return false;
        synchronized (RoomNotice.class) {
            load(c);
            if (ROWS.remove(ref.key()) == null) return false;
            save(c);
        }
        return true;
    }

    /** 전부 지운다. 지운 건수를 돌려준다. */
    public static int clear(Context c) {
        synchronized (RoomNotice.class) {
            load(c);
            int n = ROWS.size();
            ROWS.clear();
            LAST_MSG.clear();
            save(c);
            return n;
        }
    }

    // ── (1) 메시지로 포착 ────────────────────────────────────────────────────

    /**
     * 들어온 메시지 하나를 본다. {@link KakaoListener} 가 모든 단체방 메시지에 대해 부른다.
     *
     * 발송하지 않고 저장만 하므로 실패해도 조용히 넘어간다 — 포착이 틀렸으면 사장이
     * 공지 화면에서 고치거나 지우면 된다.
     */
    public static void observe(Context c, RoomRef ref, String body) {
        if (c == null || ref == null || !ref.valid()) return;
        if (!autoOn(c)) return;
        // 라이선스 인증 전에는 아무것도 쌓지 않는다. 남의 글이 들어오는 기록이라,
        // 쓰지도 않을 기기에 모아 두지 않는다. (저장해 둔 공지는 인증이 풀려도 보인다 —
        // 그때 필요한 건 '지금 받는 것' 이 아니라 '이미 있는 것' 이다.)
        if (!Settings.canSave(c)) return;
        String b = clean(body);
        if (b.length() == 0) return;
        String k = ref.key();

        // 등록 안내 문구 → 직전 메시지가 공지다
        if (hasAny(b, REG_WORDS)) {
            String prev;
            synchronized (RoomNotice.class) { prev = LAST_MSG.get(k); }
            if (prev != null && prev.length() > 0 && !hasAny(prev, REG_WORDS)) {
                if (put(c, ref, prev, SRC_MSG)) {
                    Log.add(c, "방 공지 저장 · 「" + ref.label(c) + "」 (공지 등록 안내로 포착)");
                }
            }
            return;
        }

        synchronized (RoomNotice.class) {
            if (LAST_MSG.size() >= MAX_LAST && !LAST_MSG.containsKey(k)) {
                // 오래된 것을 가릴 방법이 없으니 통째로 비운다 (다음 메시지부터 다시 쌓인다)
                LAST_MSG.clear();
            }
            LAST_MSG.put(k, b);
        }

        // 등록 안내가 오지 않는 기기 — 공지처럼 쓰인 메시지면 공지로 본다
        if (looksLikeNotice(b)) {
            if (put(c, ref, b, SRC_MSG)) {
                Log.add(c, "방 공지 저장 · 「" + ref.label(c) + "」 (공지 형식 메시지로 포착)");
            }
        }
    }

    /** 「[공지] …」 처럼 공지로 쓰인 메시지인가 */
    public static boolean looksLikeNotice(String body) {
        String b = clean(body);
        if (b.length() < MIN_NOTICE_LEN) return false;
        if (b.endsWith("?") || b.endsWith("？")) return false;   // 질문은 공지가 아니다
        String head = b.length() > 12 ? b.substring(0, 12) : b;
        String squashed = head.replace(" ", "");
        for (int i = 0; i < NOTICE_HEADS.length; i++) {
            if (squashed.startsWith(NOTICE_HEADS[i])) return true;
        }
        return false;
    }

    // ── (2) 화면에서 읽기 ────────────────────────────────────────────────────

    /** 가져오기 결과 */
    public interface Result {
        /**
         * @param ok   저장했나
         * @param text 읽은 공지 (실패면 null)
         * @param why  사람이 읽을 실패 사유 (성공이면 null)
         */
        void done(boolean ok, String text, String why);
    }

    /**
     * 그 대화방을 열어 공지 칸을 읽는다. 아무것도 누르지 않는다.
     * 접근성 권한이 없거나 대화방 열기 정보가 없으면 즉시 실패로 끝낸다.
     */
    public static void fetch(final Context c, final RoomRef ref, final Result cb) {
        if (c == null || ref == null || !ref.valid()) {
            fail(cb, "대화방 정보가 올바르지 않습니다.");
            return;
        }
        if (!KakaoAccessibility.connected()) {
            fail(cb, "접근성 권한이 비활성 상태입니다. 권한을 설정한 뒤 다시 시도하십시오.");
            return;
        }
        if (KakaoListener.openIntentFor(ref) == null) {
            fail(cb, "대화방을 여는 정보가 없습니다. 「" + ref.name + "」 의 카카오톡 알림을 "
                    + "1회 받은 뒤 다시 시도하십시오.");
            return;
        }
        KakaoAccessibility.readNotice(c, ref, new KakaoAccessibility.NoticeResult() {
            @Override public void done(boolean ok, String text, String why) {
                if (!ok) {
                    fail(cb, why);
                    return;
                }
                put(c, ref, text, SRC_SCREEN);
                Log.add(c, "방 공지 저장 · 「" + ref.label(c) + "」 (카카오톡 화면에서 읽음)");
                if (cb != null) {
                    try { cb.done(true, clean(text), null); } catch (Throwable ignore) { }
                }
            }
        });
    }

    private static void fail(Result cb, String why) {
        if (cb == null) return;
        try { cb.done(false, null, (why == null) ? "공지를 읽지 못했습니다." : why); } catch (Throwable ignore) { }
    }

    /** 마지막 실패의 화면 구성 기록 (없으면 null) */
    public static String dump(Context c) {
        if (c == null) return null;
        try { return Prefs.getStr(c, K_DUMP, null); } catch (Throwable t) { return null; }
    }

    static void saveDump(Context c, String s) {
        if (c == null) return;
        try {
            if (s == null || s.length() == 0) Prefs.remove(c, K_DUMP);
            else Prefs.putStr(c, K_DUMP, s.length() > 20000 ? s.substring(0, 20000) : s);
        } catch (Throwable ignore) { }
    }

    // ── 공용 ────────────────────────────────────────────────────────────────

    public static String srcLabel(int src) {
        if (src == SRC_SCREEN) return "카카오톡 화면에서 읽음";
        if (src == SRC_TYPED) return "직접 입력";
        return "메시지로 포착";
    }

    /** 첫 줄만 (목록에 한 줄로 보여줄 때) */
    public static String firstLine(String s) {
        String t = clean(s);
        if (t.length() == 0) return "";
        int nl = t.indexOf('\n');
        String head = (nl < 0) ? t : t.substring(0, nl);
        head = head.trim();
        if (head.length() > 60) head = head.substring(0, 60) + "…";
        if (nl >= 0 && head.length() > 0) head = head + " …";
        return head;
    }

    private static String clean(String s) {
        if (s == null) return "";
        String t = s.replace("\r\n", "\n").replace('\r', '\n').trim();
        if (t.length() > MAX_LEN) t = t.substring(0, MAX_LEN);
        return t;
    }

    private static boolean hasAny(String body, String[] words) {
        if (body == null) return false;
        for (int i = 0; i < words.length; i++) {
            if (body.contains(words[i])) return true;
        }
        return false;
    }

    // ── 저장 ────────────────────────────────────────────────────────────────

    private static void trim() {
        while (ROWS.size() > MAX_ROOMS) {
            String oldest = ROWS.keySet().iterator().next();   // LinkedHashMap = 넣은 순서
            ROWS.remove(oldest);
        }
    }

    private static void load(Context c) {
        if (loaded || c == null) return;
        loaded = true;
        String raw;
        try {
            raw = Prefs.getStr(c, K_DATA, null);
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
                String tx = clean(o.optString("t", ""));
                if (rk.length() == 0 || tx.length() == 0) continue;
                ROWS.put(rk, new Entry(rk, tx, o.optLong("a", 0L), o.optInt("s", SRC_MSG)));
            }
            trim();
        } catch (Throwable t) {
            ROWS.clear();   // 깨진 값이면 통째로 버린다 (다시 가져올 수 있다)
        }
    }

    private static void save(Context c) {
        if (c == null) return;
        try {
            JSONArray arr = new JSONArray();
            for (Entry e : ROWS.values()) {
                if (e == null) continue;
                JSONObject o = new JSONObject();
                o.put("r", e.roomKey);
                o.put("t", e.text);
                o.put("a", e.at);
                o.put("s", e.src);
                arr.put(o);
            }
            Prefs.putStr(c, K_DATA, arr.toString());
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "방 공지 저장 실패", t);
        }
    }
}
