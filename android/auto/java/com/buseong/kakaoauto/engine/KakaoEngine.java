package com.buseong.kakaoauto.engine;

import java.io.File;
import java.util.List;

/**
 * 온디바이스 카카오 엔진의 계약. 화면 코드는 이 인터페이스와 값 타입만 쓴다 ({@link Engine#get}).
 *
 * 엔진은 앱 안에 내장된 Node 런타임에서 agent-messenger(kakaotalk) 로 카카오 서버에 직접 붙는다.
 * 서버를 따로 운영하지 않는다. 카카오 토큰은 이 폰에만, AndroidKeyStore 로 봉인해 저장한다.
 *
 * 블로킹 메서드(throws EngineException)는 <b>메인 스레드에서 부르면 안 된다</b> — 네트워크를 탄다.
 * 메인 스레드에서 부르면 {@code EngineException("main_thread")} 를 던진다.
 */
public interface KakaoEngine {

    /** 연결 상태 */
    enum Link {
        /** 이 기기 ABI 용 런타임이 APK 에 없다 (엔진 미포함 빌드) */
        UNAVAILABLE,
        /** 카카오 계정이 연결돼 있지 않다 */
        NONE,
        /** 연결됨 (토큰 보관 중). 세션은 필요할 때 자동으로 붙는다 */
        READY,
        /** 다른 기기가 같은 슬롯(태블릿)으로 로그인해 세션이 끊겼다. 사용자가 다시 연결해야 한다 */
        KICKED,
        /** 저장된 로그인이 만료·거부됐다. 아이디·비밀번호로 다시 연결해야 한다 */
        REAUTH
    }

    /** 즉시 읽는 상태 (네트워크 없음) */
    final class Status {
        public final Link link;
        /** 카카오 사용자 번호 (연결 안 됐으면 "") */
        public final String userId;
        /** 연결할 때 입력한 계정의 가림 표기 (예: ab***@kakao.com) */
        public final String accountHint;
        public final long linkedAt;
        /** 엔진 런타임 설명 (예: "Node v18.20.4 · agent-messenger@2.38.0"). 아직 안 띄웠으면 "" */
        public final String runtime;
        /** 마지막 오류 한 줄 (없으면 "") */
        public final String lastError;

        public Status(Link link, String userId, String accountHint, long linkedAt, String runtime, String lastError) {
            this.link = link;
            this.userId = userId == null ? "" : userId;
            this.accountHint = accountHint == null ? "" : accountHint;
            this.linkedAt = linkedAt;
            this.runtime = runtime == null ? "" : runtime;
            this.lastError = lastError == null ? "" : lastError;
        }
    }

    /** 로그인 한 단계의 결과 */
    final class LoginStep {
        public enum Kind {
            /** 연결 완료 */
            OK,
            /** 폰의 카카오톡에서 {@link #passcode} 를 확인해야 한다 → {@link #awaitPhoneConfirm} */
            CONFIRM_ON_PHONE,
            /** 아직 확인 전. 코드가 유효한 동안 {@link #awaitPhoneConfirm} 을 다시 부른다 */
            WAITING,
            /** 아이디·비밀번호 불일치 */
            BAD_CREDENTIALS,
            /** 태블릿 슬롯을 다른 기기가 쓰고 있다. forceSlot=true 로 다시 시도하면 그 기기가 로그아웃된다 */
            SLOT_OCCUPIED,
            /** 확인 코드 만료 — 처음부터 다시 */
            EXPIRED,
            FAILED
        }

        public final Kind kind;
        public final String pendingId;
        public final String passcode;
        /** 코드 남은 시간(초). 모르면 -1 */
        public final int remainingSeconds;
        public final String message;

        public LoginStep(Kind kind, String pendingId, String passcode, int remainingSeconds, String message) {
            this.kind = kind;
            this.pendingId = pendingId == null ? "" : pendingId;
            this.passcode = passcode == null ? "" : passcode;
            this.remainingSeconds = remainingSeconds;
            this.message = message == null ? "" : message;
        }
    }

    /** 카카오 계정의 대화방 하나 */
    final class KakaoRoom {
        /** 64비트 숫자 방 번호 (문자열) — 이게 발송 대상 식별자다 */
        public final String chatId;
        /** "dm" · "group" · "open" · "unknown" */
        public final String kind;
        public final String title;
        public final String displayName;
        public final int members;
        /** 마지막 메시지 시각 (epoch ms, 모르면 0) */
        public final long lastAt;

        public KakaoRoom(String chatId, String kind, String title, String displayName, int members, long lastAt) {
            this.chatId = chatId == null ? "" : chatId;
            this.kind = kind == null ? "unknown" : kind;
            this.title = title == null ? "" : title;
            this.displayName = displayName == null ? "" : displayName;
            this.members = members;
            this.lastAt = lastAt;
        }

        /** 화면·매칭에 쓰는 이름: 방 제목 → 표시 이름 → "대화방 <번호>" */
        public String name() {
            if (title.trim().length() > 0) return title.trim();
            if (displayName.trim().length() > 0) return displayName.trim();
            return "대화방 " + chatId;
        }

        public boolean isGroup() {
            return "group".equals(kind) || "open".equals(kind);
        }
    }

    /** 발송 결과 */
    final class SendResult {
        /** "photo" · "multiphoto" · "text" */
        public final String kind;
        public final String logId;
        public final long sentAt;

        public SendResult(String kind, String logId, long sentAt) {
            this.kind = kind == null ? "" : kind;
            this.logId = logId == null ? "" : logId;
            this.sentAt = sentAt;
        }
    }

    /** 방의 최근 활동 — 매크로의 "남의 새 메시지 N개 이상" 판정용 */
    final class ChatActivity {
        /** 내 마지막 메시지 뒤에 쌓인 남의 메시지 수 (조회 범위 안에 내 메시지가 없으면 범위 전체 수) */
        public final int othersSinceMine;
        public final boolean mineInWindow;
        public final long lastMineAt;

        public ChatActivity(int othersSinceMine, boolean mineInWindow, long lastMineAt) {
            this.othersSinceMine = othersSinceMine;
            this.mineInWindow = mineInWindow;
            this.lastMineAt = lastMineAt;
        }
    }

    /** 엔진 상태가 바뀔 때 (메인 스레드가 아닐 수 있다) */
    interface Listener {
        void onStatus(Status s);
    }

    Status status();

    /**
     * 아이디(이메일·전화번호)와 비밀번호로 연결을 시작한다. 비밀번호는 엔진 메모리에서만 쓰이고 저장되지 않는다.
     * @param forceSlot 태블릿 슬롯을 다른 기기가 쓰고 있어도 가져온다 (그 기기의 카카오톡이 로그아웃된다)
     */
    LoginStep beginLogin(String account, String password, boolean forceSlot) throws EngineException;

    /** 폰에서 코드를 확인할 때까지 최대 약 1분 기다린다. WAITING 이면 다시 부른다. */
    LoginStep awaitPhoneConfirm(String pendingId) throws EngineException;

    void cancelLogin(String pendingId);

    /** 연결 해제. 이 폰의 토큰·방 연결을 지운다 (카카오톡 기기 관리에서 기기 삭제는 사용자가 한다). */
    void unlink();

    /** 계정의 대화방 목록. refresh=false 면 마지막으로 받은 목록(없으면 빈 목록) */
    List<KakaoRoom> rooms(boolean refresh) throws EngineException;

    /** 이미지 1~5장 발송. 1장은 사진, 2~5장은 묶음 사진 한 건. 파일은 JPEG/PNG/WebP */
    SendResult sendImages(String chatId, List<File> images) throws EngineException;

    SendResult sendText(String chatId, String text) throws EngineException;

    ChatActivity activity(String chatId) throws EngineException;

    /** 연결된 방에 새로 올라온 메시지. sinceLogId 보다 큰 것만. 알림이 아니라 LOCO 기록이다. */
    final class Inbound {
        public final String logId;
        public final String authorName;
        public final String text;
        public final boolean mine;
        public final long sentAt;

        public Inbound(String logId, String authorName, String text, boolean mine, long sentAt) {
            this.logId = logId == null ? "" : logId;
            this.authorName = authorName == null ? "" : authorName;
            this.text = text == null ? "" : text;
            this.mine = mine;
            this.sentAt = sentAt;
        }
    }

    java.util.List<Inbound> recent(String chatId, String sinceLogId) throws EngineException;

    void addListener(Listener l);

    void removeListener(Listener l);
}
