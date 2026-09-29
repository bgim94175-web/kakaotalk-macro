package com.buseong.kakaoauto.engine;

/**
 * 보낼 방 목록을 세 칸으로 나누는 기준.
 *
 * LOCO 대화방의 {@code type} 을 본다. 오픈 단체({@code OM} 과 숫자 2·13·15)는
 * 오픈채팅방, 오픈 1:1({@code OD} 와 숫자 14·16)은 오픈프로필로 온 갠톡,
 * 그 밖의 일반 1:1·단체·플러스·나와의 채팅은 일반 채팅방이다.
 * 문자 태그 OM/OD 가 프로토콜 이름이다. 숫자 구분은 라이브러리가 오픈으로
 * 묶는 값의 나눔이며, 실계정으로 확인한 값은 아니다.
 * 서버가 {@code list_kind} 를 주면 그 값을 쓴다.
 */
public final class RoomKind {
    public static final String OPEN_ROOM = "open_room";
    public static final String OPEN_DM = "open_dm";
    public static final String NORMAL = "normal";

    private RoomKind() {}

    /**
     * @param hinted 엔진이 준 list_kind. 알면 그걸 쓰고, 없으면 type 으로 가른다.
     *               type 도 없는 옛 캐시에서 kind 가 open 이면 인원으로만 가른다.
     */
    public static String resolve(String chatType, String kind, int members, String hinted) {
        if (OPEN_ROOM.equals(hinted) || OPEN_DM.equals(hinted) || NORMAL.equals(hinted)) return hinted;
        String fromType = fromType(chatType);
        if (fromType != null) return fromType;
        if ("open".equals(kind)) return members > 2 ? OPEN_ROOM : OPEN_DM;
        return NORMAL;
    }

    /** type 이 없으면 null. 있으면 인원 수를 보지 않는다. */
    static String fromType(String chatType) {
        if (chatType == null) return null;
        String s = chatType.trim();
        if (s.length() == 0 || "null".equals(s)) return null;
        if (is(s, "OD") || is(s, "OpenDirect") || is(s, "OpenDirectChat") || is(s, "14") || is(s, "16")) {
            return OPEN_DM;
        }
        if (is(s, "OM") || is(s, "OpenMulti") || is(s, "OpenMultiChat") || is(s, "2") || is(s, "13") || is(s, "15")) {
            return OPEN_ROOM;
        }
        return NORMAL;
    }

    private static boolean is(String a, String b) {
        return a.equalsIgnoreCase(b);
    }
}
