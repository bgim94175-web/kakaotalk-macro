package com.buseong.kakaoauto;

import com.buseong.kakaoauto.engine.EngineException;
import com.buseong.kakaoauto.engine.KakaoEngine;

/**
 * 카카오 계정 등록이 실패했을 때 고객에게 보여줄 문장.
 * 카카오가 문장을 주면 그 문장을 그대로 쓰고, 상태 코드만 오면 그 코드에 대응하는 카카오 문구를 쓴다.
 */
public final class AuthText {
    private AuthText() {}

    public static String of(KakaoEngine.LoginStep step) {
        if (step == null) return "카카오 서버가 실패 원인을 주지 않았습니다.";
        int st = step.kakaoStatus;
        if (st == Integer.MIN_VALUE) st = statusIn(step.message);
        String sentence = sentenceFor(step.message, st);
        if (sentence == null && step.kind == KakaoEngine.LoginStep.Kind.EXPIRED) {
            sentence = "인증번호 입력 시간이 지났습니다. 처음부터 다시 로그인해 주세요.";
        }
        if (sentence == null && step.kind == KakaoEngine.LoginStep.Kind.BAD_CREDENTIALS) {
            sentence = "카카오계정 또는 비밀번호가 일치하지 않습니다.";
        }
        return withFacts(sentence, st, step.deviceName, step.deviceModel);
    }

    public static String of(EngineException e) {
        if (e == null) return "카카오 서버가 실패 원인을 주지 않았습니다.";
        int st = e.serverStatus;
        if (st == Integer.MIN_VALUE) st = statusIn(e.getMessage());
        String sentence = sentenceFor(e.getMessage(), st);
        if (sentence == null && ("network".equals(e.code) || "timeout".equals(e.code))) {
            sentence = "네트워크 연결을 확인해 주세요.";
        }
        if (sentence == null) {
            String text = e.userText();
            if (text != null && text.trim().length() > 0) sentence = text.trim();
        }
        return withFacts(sentence, st, "", "");
    }

    /** 카카오 문장 또는 상태 코드 문구. 상태 번호와 기기 이름은 붙이지 않는다. */
    static String fromRaw(String message, int status) {
        int st = status;
        if (st == Integer.MIN_VALUE) st = statusIn(message);
        return sentenceFor(message, st);
    }

    /**
     * -111 에는 이용자 보호조치 문장을 붙이지 않는다.
     * 카카오가 다른 문장을 주면 그 문장을 쓴다.
     */
    private static String sentenceFor(String message, int status) {
        String sentence = kakaoSentence(message);
        if (status == -111) {
            if (sentence != null && sentence.indexOf("이용자 보호조치") >= 0) return null;
            return sentence;
        }
        if (sentence != null) return sentence;
        String mapped = mapStatus(status);
        if (mapped != null) return mapped;
        if ("registration_timeout".equals(codeOf(message))) {
            return "인증번호 입력 시간이 지났습니다. 처음부터 다시 로그인해 주세요.";
        }
        return null;
    }

    /** 문장 아래에 상태 번호와 이번 시도의 태블릿 이름을 붙인다. */
    private static String withFacts(String sentence, int status, String deviceName, String deviceModel) {
        StringBuilder sb = new StringBuilder();
        if (sentence != null && sentence.trim().length() > 0) sb.append(sentence.trim());
        if (status != Integer.MIN_VALUE) {
            if (sb.length() > 0) sb.append('\n');
            sb.append("카카오 상태 ").append(status);
        }
        String device = deviceLine(deviceName, deviceModel);
        if (device.length() > 0) {
            if (sb.length() > 0) sb.append('\n');
            sb.append(device);
        }
        if (sb.length() == 0) return "카카오 서버가 실패 원인을 주지 않았습니다.";
        return sb.toString();
    }

    private static String deviceLine(String name, String model) {
        String n = name == null ? "" : name.trim();
        String m = model == null ? "" : model.trim();
        if (n.length() == 0 && m.length() == 0) return "";
        if (m.length() == 0 || m.equals(n)) return "기기 " + n;
        if (n.length() == 0) return "기기 " + m;
        return "기기 " + n + " (" + m + ")";
    }

    private static String kakaoSentence(String message) {
        if (message == null) return null;
        String s = message.trim();
        if (s.startsWith("Login failed:")) s = s.substring("Login failed:".length()).trim();
        if (!hasHangul(s)) return null;
        if (isTemplate(s)) return null;
        return s;
    }

    private static boolean hasHangul(String s) {
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch >= 0xAC00 && ch <= 0xD7A3) return true;
        }
        return false;
    }

    private static boolean isTemplate(String s) {
        return s.startsWith("Login failed")
                || s.startsWith("Passcode request failed")
                || s.startsWith("Device registration failed")
                || s.startsWith("HTTP ");
    }

    private static int statusIn(String message) {
        if (message == null) return Integer.MIN_VALUE;
        int at = message.indexOf("status ");
        if (at < 0) return Integer.MIN_VALUE;
        int i = at + "status ".length();
        int end = i;
        if (end < message.length() && message.charAt(end) == '-') end++;
        while (end < message.length() && message.charAt(end) >= '0' && message.charAt(end) <= '9') end++;
        if (end == i || (end == i + 1 && message.charAt(i) == '-')) return Integer.MIN_VALUE;
        try {
            return Integer.parseInt(message.substring(i, end));
        } catch (Throwable t) {
            return Integer.MIN_VALUE;
        }
    }

    private static String codeOf(String message) {
        return message == null ? "" : message.trim();
    }

    /**
     * 커뮤니티 클라이언트와 카카오 계정 로그인에서 확인된 상태 코드.
     * -328 만 이용자 보호조치 문장을 쓴다. -111 은 그 문장으로 바꾸지 않는다.
     */
    private static String mapStatus(int status) {
        switch (status) {
            case 12:
            case 30:
                return "카카오계정 또는 비밀번호가 일치하지 않습니다.";
            case 8:
            case 13:
                return "로그인 시도 횟수를 초과하여 제한되었습니다.";
            case 31:
                return "등록할 수 있는 기기 수를 초과했습니다.";
            case 32:
            case -997:
                return "이용이 제한된 계정입니다.";
            case -101:
                return "인증번호가 올바르지 않습니다.";
            case -102:
                return "인증번호 입력 시간이 지났습니다. 처음부터 다시 로그인해 주세요.";
            case -328:
                return "이용자 보호조치로 인해 서브디바이스 로그인이 제한되었습니다.";
            case -444:
                return "접속이 제한되어 본인 확인이 필요합니다.";
            case -445:
                return "백그라운드 로그인이 제한되었습니다.";
            case -950:
                return "로그인이 만료되었습니다. 다시 로그인해 주세요.";
            case -998:
                return "추가 인증이 필요합니다.";
            case -999:
                return "카카오톡을 최신 버전으로 맞춘 뒤 다시 시도해 주세요.";
            case 99:
                return "일시적인 오류입니다. 잠시 후 다시 시도해 주세요.";
            default:
                return null;
        }
    }
}
