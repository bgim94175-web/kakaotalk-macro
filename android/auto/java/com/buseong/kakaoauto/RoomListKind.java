package com.buseong.kakaoauto;

import com.buseong.kakaoauto.engine.RoomKind;

import java.util.Locale;

/**
 * 알림 답장 매크로의 방 종류.
 * 카카오 서버 방 목록(LOCO)은 보지 않는다.
 * 오픈채팅은 단체 여부와 상관없이 오픈채팅방이다.
 * 오픈프로필 개인톡만 따로 두고, 보낼 방 화면은 그 칸을 그리지 않는다.
 */
final class RoomListKind {
    private RoomListKind() {}

    static final class Read {
        final String kind;
        final boolean known;

        Read(String kind, boolean known) {
            this.kind = kind;
            this.known = known;
        }
    }

    /**
     * @param blob 채널 id, 바로가기 id, 알림 묶음, 부가 텍스트, 목록 행의 글·설명·view id
     * @param openTab 채팅 목록의 선택된 탭이 오픈채팅이면 그 화면의 방은 오픈채팅방이다
     */
    static Read classify(String blob, boolean openTab) {
        if (openTab) return new Read(RoomKind.OPEN_ROOM, true);
        String raw = blob == null ? "" : blob;
        String low = raw.toLowerCase(Locale.ROOT);
        boolean open = raw.indexOf("오픈채팅") >= 0 || raw.indexOf("오픈챗") >= 0
                || low.indexOf("open_chat") >= 0 || low.indexOf("openchat") >= 0
                || low.indexOf("open-chat") >= 0 || low.indexOf("open_link") >= 0
                || low.indexOf("openlink") >= 0;
        if (open) return new Read(RoomKind.OPEN_ROOM, true);
        boolean profile = raw.indexOf("오픈프로필") >= 0
                || low.indexOf("open_profile") >= 0 || low.indexOf("openprofile") >= 0
                || low.indexOf("opendirect") >= 0 || low.indexOf("open_direct") >= 0;
        if (profile) return new Read(RoomKind.OPEN_DM, true);
        return new Read(RoomKind.NORMAL, false);
    }
}
