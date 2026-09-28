package com.buseong.kakaoauto.engine;

/**
 * 엔진 호출 실패. {@link #code} 는 엔진이 준 기계 판독용 코드다:
 *   not_packaged · main_thread · engine_start_failed · engine_died · timeout ·
 *   not_linked · kicked · reauth_required · rejected · network · upstream_error · bad_request
 */
public final class EngineException extends Exception {
    public final String code;
    public final boolean retryable;

    public EngineException(String code, String message, boolean retryable) {
        super(message == null ? code : message);
        this.code = code == null ? "upstream_error" : code;
        this.retryable = retryable;
    }

    public EngineException(String code, String message) {
        this(code, message, false);
    }

    /** 사용자에게 보여줄 한 줄 (합니다체) */
    public String userText() {
        switch (code) {
            case "not_packaged": return "이 기기용 카카오 엔진이 앱에 포함되어 있지 않습니다.";
            case "engine_start_failed": return "카카오 엔진을 시작하지 못했습니다. (" + getMessage() + ")";
            case "engine_died": return "카카오 엔진이 중단되었습니다. 다음 발송에서 다시 시작합니다.";
            case "timeout": return "카카오 서버 응답 시간이 초과되었습니다.";
            case "not_linked": return "카카오 계정이 연결되어 있지 않습니다.";
            case "kicked": return "다른 기기가 같은 로그인 슬롯을 사용하여 연결이 해제되었습니다. 카카오 계정을 다시 연결하십시오.";
            case "reauth_required": return "저장된 카카오 로그인이 만료되었습니다. 카카오 계정을 다시 연결하십시오.";
            case "rejected": return "카카오 서버가 전송을 거부했습니다. (" + getMessage() + ")";
            case "network": return "네트워크 연결을 확인하십시오. (" + getMessage() + ")";
            default: return getMessage();
        }
    }
}
