package com.buseong.kakaoauto;

import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;

/**
 * 카카오톡 채팅 목록에서 지금 화면에 보이는 방 이름만 읽는다.
 * 누르거나, 스크롤하거나, 글을 넣지 않는다. 답장 알림이 없어도 방 이름은 남긴다.
 */
final class ChatListScan {
    private ChatListScan() {}

    private static final int MAX_NODES = 800;
    private static final String[] TITLE_IDS = { "name", "title", "tv_name", "chat_room_name" };
    private static final String[] COMPOSER_IDS = {
            "message_edit_text", "chat_edit_text", "edit_text"
    };

    static final class Hit {
        final String name;
        final String kind;
        final boolean kindKnown;

        Hit(String name, String kind, boolean kindKnown) {
            this.name = name;
            this.kind = kind;
            this.kindKnown = kindKnown;
        }
    }

    static List<Hit> read(List<AccessibilityNodeInfo> roots, int screenH, String className) {
        ArrayList<Hit> out = new ArrayList<Hit>();
        if (roots == null || roots.isEmpty()) return out;
        int h = screenH > 0 ? screenH : 2000;
        boolean chatTab = false;
        boolean openTab = false;
        boolean otherTab = false;
        boolean composer = false;
        ArrayList<AccessibilityNodeInfo> titles = new ArrayList<AccessibilityNodeInfo>();
        ArrayList<AccessibilityNodeInfo> extra = new ArrayList<AccessibilityNodeInfo>();
        Walk w = new Walk();
        for (int i = 0; i < roots.size(); i++) {
            walk(roots.get(i), 0, w, h, titles, extra, new Flags());
        }
        for (int i = 0; i < titles.size(); i++) {
            AccessibilityNodeInfo n = titles.get(i);
            String label = KakaoAccessibility.textOnly(n).trim();
            if (label.length() > 0 && label.length() <= 8) {
                Tab t = tabOf(n, h, extra);
                if (t == Tab.OPEN) openTab = true;
                else if (t == Tab.CHAT) chatTab = true;
                else if (t == Tab.OTHER) otherTab = true;
            }
            if (composerId(n) && shown(n)) {
                Rect r = bounds(n);
                if (r.top > h * 45 / 100) composer = true;
            }
        }
        titles.clear();
        w.visited = 0;
        w.truncated = false;
        for (int i = 0; i < roots.size() && !w.truncated; i++) {
            walk(roots.get(i), 0, w, h, titles, extra, null);
        }

        boolean inRoom = composer || classLooksLikeRoom(className);
        boolean openList = openTab && !chatTab;
        boolean listOk = (chatTab || openTab) && !otherTab;
        boolean openRoom = classLooksOpen(className);
        LinkedHashMap<String, Hit> uniq = new LinkedHashMap<String, Hit>();
        if (inRoom) {
            Hit one = toolbar(titles, extra, h, openRoom);
            if (one != null) uniq.put(one.name, one);
        } else if (openList) {
            addTitles(titles, extra, uniq, false, true);
        } else if (listOk) {
            addTitles(titles, extra, uniq, false, false);
        } else if (!otherTab) {
            addTitles(titles, extra, uniq, true, false);
        }
        recycle(extra, roots);
        return new ArrayList<Hit>(uniq.values());
    }

    private static void addTitles(List<AccessibilityNodeInfo> titles,
                                  List<AccessibilityNodeInfo> extra,
                                  LinkedHashMap<String, Hit> uniq, boolean needTime,
                                  boolean openTab) {
        for (int i = 0; i < titles.size(); i++) {
            AccessibilityNodeInfo n = titles.get(i);
            if (!titleId(n) || !shown(n)) continue;
            String blob = rowBlob(n, extra);
            if (needTime && !hasTime(blob)) continue;
            Hit hit = hitOf(n, blob, openTab);
            if (hit != null && !uniq.containsKey(hit.name)) uniq.put(hit.name, hit);
        }
    }

    private static Hit toolbar(List<AccessibilityNodeInfo> titles,
                               List<AccessibilityNodeInfo> extra, int screenH, boolean openRoom) {
        Hit best = null;
        int bestW = 0;
        int limit = screenH * 22 / 100;
        for (int i = 0; i < titles.size(); i++) {
            AccessibilityNodeInfo n = titles.get(i);
            if (!titleId(n) || !shown(n)) continue;
            Rect r = bounds(n);
            if (r.top > limit) continue;
            Hit hit = hitOf(n, rowBlob(n, extra), openRoom);
            if (hit == null) continue;
            int w = r.width();
            if (best == null || w > bestW) { best = hit; bestW = w; }
        }
        return best;
    }

    private static Hit hitOf(AccessibilityNodeInfo n, String blob, boolean openTab) {
        String name = KakaoAccessibility.textOnly(n).trim();
        if (name.length() == 0) {
            String d = KakaoAccessibility.desc(n).trim();
            int comma = d.indexOf(',');
            name = comma > 0 ? d.substring(0, comma).trim() : d;
        }
        name = name.replace('\n', ' ').trim();
        if (!roomName(name)) return null;
        RoomListKind.Read read = RoomListKind.classify(blob, openTab);
        return new Hit(name, read.kind, read.known);
    }

    /** 제목의 부모와 그 자식·손자. 오픈채팅 배지는 제목의 형제가 아니라 손자인 경우가 있다. */
    private static String rowBlob(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> extra) {
        StringBuilder sb = new StringBuilder();
        appendNode(sb, n);
        AccessibilityNodeInfo p = null;
        try { p = n.getParent(); } catch (Throwable ignore) { }
        if (p == null) return sb.toString();
        extra.add(p);
        appendNode(sb, p);
        int cc = childCount(p, 12);
        for (int i = 0; i < cc; i++) {
            AccessibilityNodeInfo ch = childAt(p, i);
            if (ch == null) continue;
            extra.add(ch);
            appendNode(sb, ch);
            int gc = childCount(ch, 8);
            for (int j = 0; j < gc; j++) {
                AccessibilityNodeInfo g = childAt(ch, j);
                if (g == null) continue;
                extra.add(g);
                appendNode(sb, g);
            }
        }
        return sb.toString();
    }

    private static void appendNode(StringBuilder sb, AccessibilityNodeInfo n) {
        append(sb, KakaoAccessibility.textOnly(n));
        append(sb, KakaoAccessibility.desc(n));
        append(sb, idTail(n));
    }

    private static String idTail(AccessibilityNodeInfo n) {
        String id = KakaoAccessibility.viewId(n);
        int slash = id.lastIndexOf('/');
        return slash >= 0 ? id.substring(slash + 1) : id;
    }

    private static int childCount(AccessibilityNodeInfo n, int cap) {
        int cc = 0;
        try { cc = n.getChildCount(); } catch (Throwable ignore) { }
        if (cc > cap) cc = cap;
        return cc;
    }

    private static AccessibilityNodeInfo childAt(AccessibilityNodeInfo n, int i) {
        try { return n.getChild(i); } catch (Throwable ignore) { return null; }
    }

    private static boolean hasTime(String blob) {
        if (blob == null || blob.length() == 0) return false;
        if (blob.indexOf("오전") >= 0 || blob.indexOf("오후") >= 0 || blob.indexOf("어제") >= 0) return true;
        for (int i = 0; i + 2 < blob.length(); i++) {
            char c = blob.charAt(i);
            if (c < '0' || c > '9') continue;
            int j = i;
            while (j < blob.length() && blob.charAt(j) >= '0' && blob.charAt(j) <= '9') j++;
            if (j >= blob.length() || blob.charAt(j) != ':') continue;
            int k = j + 1;
            int digits = 0;
            while (k < blob.length() && blob.charAt(k) >= '0' && blob.charAt(k) <= '9') {
                digits++;
                k++;
            }
            if (digits == 2) return true;
            i = j;
        }
        return false;
    }

    private static boolean roomName(String t) {
        if (t == null) return false;
        int n = t.length();
        if (n < 1 || n > 50) return false;
        if (chrome(t)) return false;
        boolean digit = true;
        for (int i = 0; i < n; i++) {
            char c = t.charAt(i);
            if (c < '0' || c > '9') digit = false;
        }
        if (digit) return false;
        if (t.indexOf(':') >= 0 && n <= 8) return false;
        if (t.startsWith("오전") || t.startsWith("오후")) return false;
        return true;
    }

    private static boolean chrome(String t) {
        return "채팅".equals(t) || "채팅방".equals(t) || "오픈채팅".equals(t) || "친구".equals(t)
                || "더보기".equals(t) || "쇼핑".equals(t) || "통화".equals(t) || "설정".equals(t)
                || "검색".equals(t) || "홈".equals(t) || "알림".equals(t) || "전송".equals(t)
                || "보내기".equals(t) || "확인".equals(t) || "취소".equals(t) || "닫기".equals(t)
                || "사진".equals(t) || "동영상".equals(t) || "이모티콘".equals(t) || "공지".equals(t)
                || "전체".equals(t) || "편집".equals(t) || "완료".equals(t) || "광고".equals(t)
                || "오픈프로필".equals(t) || "메시지".equals(t) || "읽음".equals(t) || "안읽음".equals(t)
                || "안 읽음".equals(t) || "새로운 채팅".equals(t) || "선물하기".equals(t)
                || "보이스톡".equals(t) || "페이스톡".equals(t) || "프로필".equals(t)
                || "내 프로필".equals(t) || "지금 뜨는".equals(t) || "추천".equals(t)
                || "Chats".equals(t) || "Friends".equals(t);
    }

    private enum Tab { NONE, CHAT, OPEN, OTHER }

    private static Tab tabOf(AccessibilityNodeInfo n, int screenH, List<AccessibilityNodeInfo> extra) {
        if (n == null || !shown(n)) return Tab.NONE;
        Rect r = bounds(n);
        int bar = screenH > 0 ? screenH : 2000;
        boolean edge = r.top < bar * 25 / 100 || r.top > bar * 68 / 100;
        if (!edge || r.height() > bar * 30 / 100) return Tab.NONE;
        String text = KakaoAccessibility.textOnly(n).trim();
        String desc = KakaoAccessibility.desc(n).trim();
        if (!picked(n, desc, extra)) return Tab.NONE;
        String descLow = desc.toLowerCase();
        if ("오픈채팅".equals(text) || "오픈챗".equals(text) || "Open Chat".equals(text)
                || desc.startsWith("오픈채팅") || descLow.startsWith("open chat")) return Tab.OPEN;
        if ("채팅".equals(text) || "Chats".equals(text) || desc.startsWith("채팅")) return Tab.CHAT;
        if ("친구".equals(text) || "더보기".equals(text) || "쇼핑".equals(text) || "통화".equals(text)
                || "Friends".equals(text) || desc.startsWith("친구") || desc.startsWith("쇼핑")) {
            return Tab.OTHER;
        }
        return Tab.NONE;
    }

    private static boolean picked(AccessibilityNodeInfo n, String desc, List<AccessibilityNodeInfo> extra) {
        try { if (n.isSelected()) return true; } catch (Throwable ignore) { }
        if (desc != null && (desc.indexOf("선택") >= 0 || desc.toLowerCase().indexOf("selected") >= 0)) {
            return true;
        }
        AccessibilityNodeInfo p = null;
        try { p = n.getParent(); } catch (Throwable ignore) { }
        if (p == null) return false;
        if (extra != null) extra.add(p);
        try { if (p.isSelected()) return true; } catch (Throwable ignore) { }
        String pd = KakaoAccessibility.desc(p);
        return pd.indexOf("선택") >= 0 || pd.toLowerCase().indexOf("selected") >= 0;
    }

    private static boolean classLooksLikeRoom(String className) {
        if (className == null) return false;
        String s = className.toLowerCase();
        return s.indexOf("chatroom") >= 0 || s.indexOf("chat_room") >= 0 || classLooksOpen(className);
    }

    private static boolean classLooksOpen(String className) {
        if (className == null) return false;
        String s = className.toLowerCase();
        return s.indexOf("openchat") >= 0 || s.indexOf("open_chat") >= 0 || s.indexOf("openlink") >= 0;
    }

    private static boolean titleId(AccessibilityNodeInfo n) {
        return idEnds(n, TITLE_IDS);
    }

    private static boolean composerId(AccessibilityNodeInfo n) {
        return idEnds(n, COMPOSER_IDS);
    }

    private static boolean idEnds(AccessibilityNodeInfo n, String[] shorts) {
        String id = KakaoAccessibility.viewId(n);
        if (id.length() == 0) return false;
        int slash = id.lastIndexOf('/');
        String tail = slash >= 0 ? id.substring(slash + 1) : id;
        for (int i = 0; i < shorts.length; i++) {
            if (shorts[i].equals(tail)) return true;
        }
        return false;
    }

    private static boolean shown(AccessibilityNodeInfo n) {
        if (n == null) return false;
        try {
            if (!n.isVisibleToUser()) return false;
        } catch (Throwable ignore) { }
        Rect r = bounds(n);
        return r.width() > 0 && r.height() > 0;
    }

    private static Rect bounds(AccessibilityNodeInfo n) {
        return KakaoAccessibility.boundsOf(n);
    }

    private static void append(StringBuilder sb, String s) {
        if (s == null || s.length() == 0) return;
        if (sb.length() > 0) sb.append(' ');
        sb.append(s);
    }

    private static void recycle(List<AccessibilityNodeInfo> extra, List<AccessibilityNodeInfo> roots) {
        for (int i = 0; i < extra.size(); i++) {
            AccessibilityNodeInfo n = extra.get(i);
            if (n == null || isRoot(n, roots)) continue;
            try { n.recycle(); } catch (Throwable ignore) { }
        }
        extra.clear();
    }

    private static boolean isRoot(AccessibilityNodeInfo n, List<AccessibilityNodeInfo> roots) {
        if (roots == null) return false;
        for (int i = 0; i < roots.size(); i++) {
            AccessibilityNodeInfo r = roots.get(i);
            if (r == null) continue;
            try {
                if (n.equals(r)) return true;
            } catch (Throwable ignore) { }
        }
        return false;
    }

    private static final class Flags { }

    private static final class Walk {
        int visited;
        boolean truncated;
    }

    private static void walk(AccessibilityNodeInfo n, int depth, Walk w, int screenH,
                             List<AccessibilityNodeInfo> titles, List<AccessibilityNodeInfo> extra,
                             Flags mark) {
        if (n == null || w.truncated) return;
        if (w.visited >= MAX_NODES) { w.truncated = true; return; }
        w.visited++;
        if (mark != null) {
            titles.add(n);
        } else if (titleId(n) || composerId(n)) {
            titles.add(n);
        }
        if (depth >= 40) return;
        int cc = 0;
        try { cc = n.getChildCount(); } catch (Throwable ignore) { }
        for (int i = 0; i < cc; i++) {
            AccessibilityNodeInfo ch = null;
            try { ch = n.getChild(i); } catch (Throwable ignore) { }
            if (ch == null) continue;
            extra.add(ch);
            walk(ch, depth + 1, w, screenH, titles, extra, mark);
        }
    }
}
