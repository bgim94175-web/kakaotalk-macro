package com.buseong.kakaoauto;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.KeyFactory;
import java.security.PublicKey;
import java.security.Signature;
import java.security.spec.X509EncodedKeySpec;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 라이선스 상태머신 + 서버 통신. 앱에서 "이 기능 써도 되나?" 를 묻는 곳은 여기 하나뿐이다.
 *
 * 핵심 규칙
 *  - 기능이 켜졌는지는 서버 응답의 features 맵만이 진실이다. 앱이 자체 판단으로 기능을 열지 않는다.
 *  - 모든 응답은 Ed25519 서명을 확인한다. 원문에서 ,"sig":"..." 만 떼어낸 문자열이 서명 대상이다.
 *  - 키 1개는 기기 1대. 다른 기기가 인증하면 이쪽 세션이 죽고(session_superseded) 이 기기는 잠긴다.
 *  - 오프라인은 grace_ms 까지만 버틴다. 기기 시간을 되돌리면 즉시 잠근다.
 *  - config_key(설정 암호화 키 재료)는 평문으로 저장하지 않는다 — Keystore 로 넘긴다.
 *
 * 스레드: 네트워크는 전부 새 Thread, 콜백은 메인 루퍼로 돌려준다 (라이브러리 의존성 0).
 */
public final class License {
    private License() {}

    // ── 계약 상수 ─────────────────────────────────────────────────────────────

    /** 서버 응답 서명 검증용 공개키 (Ed25519 SPKI base64). 서버의 SIGNING_PRIVATE_KEY 와 짝이다. */
    public static final String PUBLIC_KEY_B64 =
            "MCowBQYDK2VwAyEAcoFrR7SpOov/AURAxp35+uWBSQTE12WKdWYgXwRWrF8=";

    /**
     * 라이선스 서버 주소. <b>앱에 고정이며 화면에서 바꿀 수 없다.</b>
     * 손님이 주소를 바꿀 수 있으면 지원 문의만 늘고 (가짜 주소를 넣어 앱이 멈춘다)
     * 변조 시도의 발판이 된다. 주소를 옮겨야 하면 앱을 다시 배포한다.
     */
    public static final String SERVER = "https://kakaotalk-macro.onrender.com";

    /** 구버전이 서버 주소를 덮어쓰던 평문 Prefs 키. 지금은 읽지 않고 지우기만 한다. */
    private static final String OLD_PREF_SERVER = "server";

    /**
     * 응답 검증 실패는 전부 이 한 문구로 적는다. 서명 없음 · 서명 불일치 · 해석 실패 ·
     * 확인값 불일치를 구분해 적으면 "무엇을 바꿨을 때 어느 검사가 걸리는지" 를 알려주는
     * 지표가 되고, 손님이 할 수 있는 조치는 어느 쪽이든 같다. 구분은 logcat 에만 남는다.
     */
    private static final String BAD_RESP = "서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도하십시오.";

    private static final int TIMEOUT_MS = 15000;          // connect/read 둘 다 15초
    private static final long TS_SKEW_MS = 10 * 60 * 1000L;   // 응답 ts 허용 오차 ±10분
    private static final long CLOCK_SLACK_MS = 60 * 1000L;    // 시계 되돌리기 판정 여유 60초
    private static final long DEF_RECHECK_MS = 6 * 3600 * 1000L;   // 6시간
    private static final long DEF_GRACE_MS = 3 * 86400 * 1000L;    // 3일
    private static final long DAY_MS = 86400000L;
    private static final int MAX_BODY = 512 * 1024;

    /** API 33+ 는 "Ed25519", 그 아래 기기는 소문자 별칭만 먹는 경우가 있다 */
    private static final String[] SIG_ALGS = { "Ed25519", "ed25519" };

    /** 응답 원문에서 떼어낼 서명 필드 */
    private static final Pattern SIG_PAT = Pattern.compile(",\"sig\":\"([A-Za-z0-9+/=]*)\"");

    // ── 평문 캐시 키 (민감정보 아님. config_key 는 절대 여기 안 들어간다) ────────
    private static final String K_KEY = "lic_key";
    private static final String K_DEVICE = "lic_device";
    private static final String K_EXPIRES = "lic_expires";
    private static final String K_LASTOK = "lic_lastok";
    private static final String K_RECHECK = "lic_recheck";
    private static final String K_GRACE = "lic_grace";
    private static final String K_SESSION = "lic_session";
    private static final String K_FEATS = "lic_feats";
    private static final String K_REASON = "lic_reason";
    private static final String K_LOCKED = "lic_locked";
    private static final String K_OK = "lic_ok";
    private static final String K_PLAN = "lic_plan";

    /** signOut 에서 지울 평문 키 전부 */
    private static final String[] OWN_KEYS = {
            K_KEY, K_DEVICE, K_EXPIRES, K_LASTOK, K_RECHECK, K_GRACE,
            K_SESSION, K_FEATS, K_REASON, K_LOCKED, K_OK, K_PLAN
    };

    // ── 공개 모델 ─────────────────────────────────────────────────────────────

    public static final class Feat {
        public boolean on;
        public long expiresAt;
        public String plan;
    }

    public static final class State {
        public boolean licensed;        // 키 인증 통과 + 유예 안 넘김
        public String reason;           // 실패 코드 (licensed=false 일 때)
        public String key, deviceId;
        public long expiresAt, lastOk, recheckMs, graceMs;
        public java.util.Map<String, Feat> features;  // 항상 macro/roombot/minigame 3개 키
        public boolean locked;          // session_superseded · clock_rollback 등 강제 잠금
    }

    public interface Cb { void done(boolean ok, String reason); }

    // ── 내부 캐시 ─────────────────────────────────────────────────────────────

    private static final AtomicBoolean ACTIVATING = new AtomicBoolean(false);
    private static volatile String featRaw;                        // 파싱해둔 features 원문
    private static volatile Map<String, Feat> featParsed;

    /** features 파싱 캐시를 버린다 (설정 화면에서 강제로 다시 읽고 싶을 때) */
    public static void invalidate() {
        featRaw = null;
        featParsed = null;
    }

    // ── 상태 조회 ─────────────────────────────────────────────────────────────

    /**
     * 캐시에서 즉시 만든 현재 상태. 네트워크를 타지 않는다.
     * 유예 초과 · 시계 되돌리기 판정은 여기서 같이 한다 (그래서 화면과 게이트가 항상 같은 값을 본다).
     */
    public static State state(Context c) {
        State s = new State();
        s.features = emptyFeats();
        s.reason = "";
        s.key = "";
        s.deviceId = "";
        s.recheckMs = DEF_RECHECK_MS;
        s.graceMs = DEF_GRACE_MS;
        if (c == null) {
            s.reason = "no_license";
            return s;
        }

        s.key = nz(Prefs.getStr(c, K_KEY, ""));
        s.deviceId = Device.deviceId(c);
        s.expiresAt = Prefs.getLong(c, K_EXPIRES, 0L);
        s.lastOk = Prefs.getLong(c, K_LASTOK, 0L);
        long rc = Prefs.getLong(c, K_RECHECK, 0L);
        long gr = Prefs.getLong(c, K_GRACE, 0L);
        s.recheckMs = (rc > 0) ? rc : DEF_RECHECK_MS;
        s.graceMs = (gr > 0) ? gr : DEF_GRACE_MS;
        s.locked = Prefs.getBool(c, K_LOCKED, false);
        s.licensed = Prefs.getBool(c, K_OK, false);
        s.reason = nz(Prefs.getStr(c, K_REASON, ""));
        // 캐시를 그대로 넘기면 호출한 쪽이 on 을 true 로 바꿔서 게이트를 뚫을 수 있다 → 복사본을 준다
        s.features = copyFeats(feats(c));

        long now = System.currentTimeMillis();

        if (s.key.length() == 0) {
            s.licensed = false;
            if (s.reason.length() == 0) s.reason = "no_license";
            return s;
        }
        if (s.locked) {
            s.licensed = false;
            if (s.reason.length() == 0) s.reason = "session_superseded";
            return s;
        }
        if (!s.licensed) {
            if (s.reason.length() == 0) s.reason = "no_license";
            return s;
        }
        if (s.lastOk <= 0) {
            s.licensed = false;
            s.reason = "no_license";
            return s;
        }
        // 시계 되돌리기 방어 — 유예기간을 무한히 늘리는 제일 쉬운 우회다. 즉시 잠근다.
        if (now < s.lastOk - CLOCK_SLACK_MS) {
            s.licensed = false;
            s.locked = true;
            s.reason = "clock_rollback";
            Prefs.putBool(c, K_LOCKED, true);
            Prefs.putStr(c, K_REASON, "clock_rollback");
            Prefs.putBool(c, K_OK, false);
            Log.add(c, "기기 시간 변경이 감지되어 잠금 처리되었습니다. 라이선스를 다시 인증하십시오.");
            return s;
        }
        // 오프라인 유예 초과
        if (now > s.lastOk + s.graceMs) {
            s.licensed = false;
            s.reason = "grace_expired";
            return s;
        }
        s.reason = "";
        return s;
    }

    /**
     * ★ 유일한 기능 게이트. 발송·봇 실행 경로는 전부 이 한 곳만 통과한다.
     * 곳곳에 검사를 흩뿌리면 우회 지점만 늘어난다.
     */
    public static boolean allowed(Context c, String feature) {
        if (c == null || feature == null) return false;
        State s = state(c);
        if (s.locked) return false;
        if (!s.licensed) return false;
        Feat f = s.features.get(feature);
        if (f == null) return false;
        return f.on && f.expiresAt > System.currentTimeMillis();
    }

    /** 남은 일수 (올림). 미보유·만료면 0. */
    public static long daysLeft(Context c, String feature) {
        if (c == null || feature == null) return 0;
        State s = state(c);
        Feat f = s.features.get(feature);
        if (f == null || f.expiresAt <= 0) return 0;
        long d = f.expiresAt - System.currentTimeMillis();
        if (d <= 0) return 0;
        return (d + DAY_MS - 1) / DAY_MS;
    }

    /** 만료 임박(7일 이하)인가 — 카드에 AMBER 칩 띄울 때 쓴다 */
    public static boolean expiringSoon(Context c, String feature) {
        if (!allowed(c, feature)) return false;
        long d = daysLeft(c, feature);
        return d > 0 && d <= 7;
    }

    /** 하트비트 할 때가 됐나 (recheck_ms 지남). 키가 없으면 false. */
    public static boolean shouldHeartbeat(Context c) {
        if (c == null) return false;
        String key = nz(Prefs.getStr(c, K_KEY, ""));
        if (key.length() == 0) return false;
        if (Prefs.getBool(c, K_LOCKED, false)) return false;
        long lastOk = Prefs.getLong(c, K_LASTOK, 0L);
        long rc = Prefs.getLong(c, K_RECHECK, 0L);
        if (rc <= 0) rc = DEF_RECHECK_MS;
        return System.currentTimeMillis() >= lastOk + rc;
    }

    /**
     * 서버 주소. 항상 {@link #SERVER} 다 — 바꿀 수 있는 경로는 없다.
     * 구버전에서 손님이 넣어둔 덮어쓰기 값이 남아 있으면 조용히 지운다.
     */
    public static String server(Context c) {
        if (c != null) {
            try {
                if (Prefs.getStr(c, OLD_PREF_SERVER, null) != null) Prefs.remove(c, OLD_PREF_SERVER);
            } catch (Throwable ignore) { }
        }
        return SERVER;
    }

    // ── 활성화 (/verify) ──────────────────────────────────────────────────────

    /** 키 인증 + 기기 등록. 백그라운드 스레드에서 돌고 콜백은 메인 스레드로 온다. */
    public static void activate(Context c, String key, final Cb cb) {
        final Context app = appCtx(c);
        final String k = normKey(key);
        if (app == null) { post(cb, false, "bad_request"); return; }
        if (k.length() < 4) {
            Log.add(app, "라이선스 키가 너무 짧습니다. 키를 다시 확인하십시오.");
            post(cb, false, "bad_request");
            return;
        }
        if (!ACTIVATING.compareAndSet(false, true)) {
            post(cb, false, "busy");
            return;
        }
        new Thread(new Runnable() {
            @Override public void run() {
                boolean ok = false;
                String reason = "no_network";
                try {
                    String nonce = Crypto.randomHex(16);
                    JSONObject body = common(app, k, nonce);
                    body.put("device_name", Device.deviceName());
                    Resp r = http(app, "POST", server(app) + "/verify", body);
                    Parsed p = verify(app, r, nonce);
                    if (p.o != null) {
                        saveVerify(app, k, p.o);
                        ok = true;
                        reason = "";
                        // 인증되자마자 하트비트 알람을 잡는다. 매크로를 안 산 사용자(봇만 결제)도
                        // 이게 없으면 lic_lastok 이 안 갱신돼서 3일 뒤 유예 초과로 통째로 잠긴다.
                        try {
                            Scheduler.ensureHeartbeat(app);
                        } catch (Throwable t) {
                            Log.add(app, "라이선스 자동확인 예약에 실패했습니다. 주기적으로 앱을 실행하십시오. (" + t + ")");
                        }
                        Log.add(app, "라이선스 인증 성공 · " + featSummary(app));
                    } else {
                        reason = p.fail;
                        applyFail(app, reason, k);
                        Log.add(app, "라이선스 인증 실패: " + reasonKr(reason));
                    }
                } catch (Throwable t) {
                    reason = "no_network";
                    Log.add(app, "라이선스 인증 중 오류가 발생했습니다: " + t);
                } finally {
                    ACTIVATING.set(false);
                    post(cb, ok, reason);
                }
            }
        }, "lic-activate").start();
    }

    // ── 하트비트 (/heartbeat) ─────────────────────────────────────────────────

    /** 세션 유지 + 탈취/만료 감지. 앱 진입 시와 recheck_ms 주기로 부른다. */
    public static void heartbeat(Context c, final Cb cb) {
        final Context app = appCtx(c);
        if (app == null) { post(cb, false, "bad_request"); return; }
        final String k = nz(Prefs.getStr(app, K_KEY, ""));
        if (k.length() == 0) { post(cb, false, "no_license"); return; }

        new Thread(new Runnable() {
            @Override public void run() {
                boolean ok = false;
                String reason = "no_network";
                try {
                    String nonce = Crypto.randomHex(16);
                    JSONObject body = common(app, k, nonce);
                    body.put("device_name", Device.deviceName());
                    body.put("session", nz(Prefs.getStr(app, K_SESSION, "")));
                    Resp r = http(app, "POST", server(app) + "/heartbeat", body);
                    Parsed p = verify(app, r, nonce);
                    if (p.o != null) {
                        saveTick(app, p.o, true);
                        ok = true;
                        reason = "";
                    } else {
                        reason = p.fail;
                        applyFail(app, reason, k);
                        if ("session_superseded".equals(reason)) {
                            Log.add(app, "다른 기기에서 인증되어 현재 기기가 잠금 처리되었습니다.");
                        } else if (isHard(reason)) {
                            Log.add(app, "라이선스 확인 실패: " + reasonKr(reason));
                        } else {
                            Log.add(app, "라이선스를 확인하지 못했습니다 (" + reasonKr(reason)
                                    + "). 인터넷 연결을 확인하십시오.");
                        }
                    }
                } catch (Throwable t) {
                    reason = "no_network";
                    Log.add(app, "라이선스 확인 중 오류가 발생했습니다: " + t);
                } finally {
                    post(cb, ok, reason);
                }
            }
        }, "lic-heartbeat").start();
    }

    // ── 새로고침 (/entitlements) ──────────────────────────────────────────────

    /** 구매 직후 기능 상태만 다시 받아온다. 세션은 건드리지 않는다. */
    public static void refresh(Context c, final Cb cb) {
        final Context app = appCtx(c);
        if (app == null) { post(cb, false, "bad_request"); return; }
        final String k = nz(Prefs.getStr(app, K_KEY, ""));
        if (k.length() == 0) { post(cb, false, "no_license"); return; }

        new Thread(new Runnable() {
            @Override public void run() {
                boolean ok = false;
                String reason = "no_network";
                try {
                    String nonce = Crypto.randomHex(16);
                    // POST 를 먼저 쓴다 — GET 은 라이선스 키가 서버·프록시 접근로그에 평문으로 쌓인다.
                    // 세션도 같이 보낸다: 서버는 저장값과 같을 때만 그 값을 그대로 되돌려준다(소유 증명).
                    JSONObject body = common(app, k, nonce);
                    String ses = nz(Prefs.getStr(app, K_SESSION, ""));
                    if (ses.length() > 0) body.put("session", ses);
                    Resp r = http(app, "POST", server(app) + "/entitlements", body);
                    if (r.code == 404 || r.code == 405) {
                        // POST 를 모르는 구버전 서버다 — 예전 GET 형식으로 한 번 더 시도한다
                        String url = server(app) + "/entitlements"
                                + "?key=" + enc(k)
                                + "&device_id=" + enc(Device.deviceId(app))
                                + "&nonce=" + enc(nonce)
                                + "&app_sig=" + enc(Device.appSigSha256(app))
                                + "&app_version=" + Device.appVersion(app);
                        r = http(app, "GET", url, null);
                    }
                    Parsed p = verify(app, r, nonce);
                    if (p.o != null) {
                        saveTick(app, p.o, false);
                        ok = true;
                        reason = "";
                        Log.add(app, "기능 상태를 갱신했습니다 · " + featSummary(app));
                    } else {
                        reason = p.fail;
                        applyFail(app, reason, k);
                        Log.add(app, "기능 상태 새로고침 실패: " + reasonKr(reason));
                    }
                } catch (Throwable t) {
                    reason = "no_network";
                    Log.add(app, "새로고침 중 오류가 발생했습니다: " + t);
                } finally {
                    post(cb, ok, reason);
                }
            }
        }, "lic-refresh").start();
    }

    // ── 로그아웃 ──────────────────────────────────────────────────────────────

    /**
     * 이 기기에서 라이선스를 뗀다. 설정 암호화 키가 사라지므로 저장된 설정도 못 읽는다(=의도된 동작).
     * 기기 고정은 서버에 남아있다 — 다른 기기에서 쓰려면 관리자 초기화가 필요하다.
     */
    public static void signOut(Context c) {
        if (c == null) return;
        Context app = appCtx(c);
        // 알람부터 정리한다 — 설정키를 지운 뒤에 부르면 예정 시각을 저장한 설정을 못 읽는다.
        // 발송 알람만 끄면 안 된다: 하트비트 알람이 남아 키 없는 기기에서 계속 깨어난다.
        try {
            Scheduler.cancelAll(app);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "알람 정리 실패", t);
        }
        try {
            Prefs.secRemove(app, "settings");
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "설정 삭제 실패", t);
        }
        try {
            Keystore.clear(app);     // 설정키 삭제 + Prefs 캐시 비움
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "설정키 삭제 실패", t);
        }
        for (int i = 0; i < OWN_KEYS.length; i++) Prefs.remove(app, OWN_KEYS[i]);
        Prefs.clearCache();
        invalidate();
        try {
            Settings.invalidate();
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "설정 임시 저장 비우기 실패", t);
        }
        Log.add(app, "현재 기기의 라이선스를 해제했습니다. 저장된 설정도 함께 삭제되었습니다.");
    }

    // ── 실패 코드 → 한국어 ────────────────────────────────────────────────────

    /** 사용자에게 그대로 보여줄 문장. 모르는 코드면 코드까지 붙여서 돌려준다. */
    public static String reasonKr(String reason) {
        String r = (reason == null) ? "" : reason.trim();
        if (r.length() == 0) return "";
        if ("bad_request".equals(r)) return "잘못된 요청입니다.";
        if ("invalid_key".equals(r)) return "존재하지 않는 라이선스 키입니다.";
        if ("revoked".equals(r)) return "사용이 중지된 라이선스 키입니다.";
        if ("blocked".equals(r)) return "차단된 라이선스 키입니다. 관리자에게 문의하십시오.";
        if ("device_mismatch".equals(r)) return "다른 기기에 등록된 라이선스 키입니다. 키 1개당 기기 1대만 등록됩니다.";
        if ("no_entitlement".equals(r)) return "구매한 기능이 없습니다.";
        if ("expired".equals(r)) return "사용 기간이 만료되었습니다.";
        if ("bad_app_sig".equals(r)) return "앱 서명이 일치하지 않습니다.";
        if ("update_required".equals(r)) return "앱을 최신 버전으로 업데이트하십시오.";
        if ("no_network".equals(r)) return "서버에 연결하지 못했습니다.";
        if ("bad_signature".equals(r)) return "서버 응답의 서명이 유효하지 않습니다.";
        if ("session_superseded".equals(r)) return "다른 기기에서 인증되어 현재 기기가 잠금 상태입니다.";
        if ("clock_rollback".equals(r)) return "기기 시간 변경이 감지되었습니다. 라이선스를 다시 인증하십시오.";
        if ("grace_expired".equals(r)) return "오프라인 사용 기간을 초과했습니다. 인터넷에 연결한 후 다시 확인하십시오.";
        if ("rate_limited".equals(r)) return "요청이 제한되었습니다. 잠시 후 다시 시도하십시오.";
        if ("no_license".equals(r)) return "라이선스 인증이 완료되지 않았습니다.";
        if ("busy".equals(r)) return "인증이 진행 중입니다. 완료까지 대기하십시오.";
        if ("too_large".equals(r)) return "설정 용량이 초과되어 서버가 요청을 거부했습니다.";
        if ("server_error".equals(r)) return "서버 오류가 발생했습니다. 잠시 후 다시 시도하십시오.";
        return "알 수 없는 오류입니다. (" + r + ")";
    }

    /**
     * <b>화면에 띄울 문구</b>. {@link #reasonKr} 는 활동 로그·판매자 문의용이라 방어 장치의
     * 판정 결과까지 적는다 — 앱 서명 불일치, 서버 응답 서명 불일치, 기기 시간 되돌리기,
     * 오프라인 사용 기간 초과. 그 문장을 손님 화면에 그대로 띄우면 "무엇을 건드렸을 때
     * 어느 검사가 걸리는지" 를 앱이 직접 알려주는 셈이고, 손님이 할 수 있는 조치도 없다.
     * 그래서 화면에는 조치만 남긴 문장을 쓴다. 원래 사유는 활동 로그에 그대로 남는다.
     */
    public static String reasonUserKr(String reason) {
        String r = (reason == null) ? "" : reason.trim();
        if (r.length() == 0) return "";
        if ("bad_app_sig".equals(r)) {
            return "앱이 정상적으로 설치되지 않았습니다. 공식 설치 파일로 다시 설치한 후 인증하십시오.";
        }
        if ("bad_signature".equals(r)) {
            return "서버 응답을 확인하지 못했습니다. 잠시 후 다시 시도하십시오.";
        }
        if ("clock_rollback".equals(r)) {
            return "라이선스를 다시 인증해야 합니다. 라이선스 키 화면에서 재인증하십시오.";
        }
        if ("grace_expired".equals(r)) {
            return "인터넷에 연결한 후 라이선스를 다시 확인하십시오.";
        }
        if ("too_large".equals(r)) {
            return "설정이 너무 많습니다. 사용하지 않는 대화방·규칙을 삭제하십시오.";
        }
        String s = reasonKr(r);
        // 서버가 모르는 사유를 내려보냈을 때 내부 코드를 화면에 노출하지 않는다
        if (s.startsWith("알 수 없는 오류")) return "알 수 없는 오류입니다. 판매자에게 문의하십시오.";
        return s;
    }

    /** 서버가 내린 판정(상태를 바꿔야 하는 이유)인가. 통신/검증 실패는 아니다. */
    private static boolean isHard(String r) {
        if (r == null) return false;
        return "invalid_key".equals(r) || "revoked".equals(r) || "blocked".equals(r)
                || "device_mismatch".equals(r) || "no_entitlement".equals(r) || "expired".equals(r)
                || "bad_app_sig".equals(r) || "update_required".equals(r)
                || "session_superseded".equals(r);
    }

    /** 기능을 전부 꺼야 하는 이유인가 (만료·회수·차단). 만료일 표시는 남긴다. */
    private static boolean zeroesFeats(String r) {
        if (r == null) return false;
        return "expired".equals(r) || "revoked".equals(r) || "blocked".equals(r)
                || "no_entitlement".equals(r) || "invalid_key".equals(r) || "device_mismatch".equals(r);
    }

    // ── 저장 ──────────────────────────────────────────────────────────────────

    /** /verify 성공 — 전부 갱신 + config_key 보관 */
    private static void saveVerify(Context c, String attempted, JSONObject o) throws Exception {
        String key = str(o, "key", attempted);
        if (key.length() == 0) key = attempted;
        long now = System.currentTimeMillis();

        Prefs.putStr(c, K_KEY, key);
        Prefs.putStr(c, K_DEVICE, str(o, "device_id", Device.deviceId(c)));
        Prefs.putStr(c, K_PLAN, str(o, "plan", ""));
        Prefs.putLong(c, K_EXPIRES, o.optLong("expires_at", 0L));
        Prefs.putStr(c, K_SESSION, str(o, "session", ""));
        long rc = o.optLong("recheck_ms", 0L);
        long gr = o.optLong("grace_ms", 0L);
        Prefs.putLong(c, K_RECHECK, rc > 0 ? rc : DEF_RECHECK_MS);
        Prefs.putLong(c, K_GRACE, gr > 0 ? gr : DEF_GRACE_MS);
        saveFeats(c, o.optJSONObject("features"));
        String purchase = str(o, "purchase", "");
        if (purchase.length() > 0) Prefs.putStr(c, "purchase_base", purchase);
        Prefs.putLong(c, K_LASTOK, now);
        Prefs.putBool(c, K_OK, true);
        Prefs.putBool(c, K_LOCKED, false);
        Prefs.putStr(c, K_REASON, "");

        // config_key 는 평문 저장 금지 — Keystore 가 한 번 더 봉인해서 보관한다
        String ck = str(o, "config_key", "");
        if (ck.length() > 0) {
            String cur = null;
            try { cur = Keystore.getConfigKey(c); } catch (Throwable t) { cur = null; }
            if (!ck.equals(cur)) {
                Keystore.putConfigKey(c, ck);
                Prefs.clearCache();
            }
        }
        invalidate();
        // 설정키가 생겼으니 옛 평문 설정을 옮기고 암호화 저장까지 해둔다
        try {
            Settings.afterLicense(c);
        } catch (Throwable t) {
            Log.add(c, "설정 준비 중 오류가 발생했습니다: " + t);
        }
    }

    /**
     * /heartbeat · /entitlements 성공.
     * full=true (하트비트) 면 세션·lastOk 까지 갱신하고, false (새로고침) 면 features 만 갱신한다.
     */
    private static void saveTick(Context c, JSONObject o, boolean full) {
        saveFeats(c, o.optJSONObject("features"));
        long exp = o.optLong("expires_at", -1L);
        if (exp >= 0) Prefs.putLong(c, K_EXPIRES, exp);
        String plan = str(o, "plan", null);
        if (plan != null) Prefs.putStr(c, K_PLAN, plan);

        if (full) {
            String ses = str(o, "session", "");
            if (ses.length() > 0) Prefs.putStr(c, K_SESSION, ses);
            long rc = o.optLong("recheck_ms", 0L);
            long gr = o.optLong("grace_ms", 0L);
            if (rc > 0) Prefs.putLong(c, K_RECHECK, rc);
            if (gr > 0) Prefs.putLong(c, K_GRACE, gr);
            Prefs.putLong(c, K_LASTOK, System.currentTimeMillis());
            Prefs.putBool(c, K_OK, true);
            Prefs.putBool(c, K_LOCKED, false);
            Prefs.putStr(c, K_REASON, "");
        } else if (Prefs.getBool(c, K_OK, false)) {
            // 새로고침이 통했으면 "서버 연결 안 됨" 같은 묵은 이유는 지워준다
            String old = nz(Prefs.getStr(c, K_REASON, ""));
            if (old.length() > 0 && !isHard(old)) Prefs.putStr(c, K_REASON, "");
        }

        // 설정키를 잃은 기기 복구용 — 응답에 config_key 가 실려오고 보관본이 없으면 다시 넣는다.
        // ★ 없거나 null 이면 절대 손대지 않는다. /entitlements 는 세션 증명이 없어서 서버가
        //    config_key 를 null 로 내리는데, 그걸 보관본에 덮어쓰면 사용자 설정 전체가 복호화 불가가 된다.
        //    str() 이 ""/"null" 을 기본값으로 바꿔주니까 아래 length()>0 가드가 그 역할을 한다 — 빼지 마라.
        String ck = str(o, "config_key", "");
        if (ck.length() > 0) {
            String cur = null;
            try { cur = Keystore.getConfigKey(c); } catch (Throwable t) { cur = null; }
            if (!ck.equals(cur)) {
                Keystore.putConfigKey(c, ck);
                Prefs.clearCache();
                try { Settings.invalidate(); } catch (Throwable t) { /* 무시 */ }
                Log.add(c, "라이선스 인증을 완료했습니다.");
            }
        }
        invalidate();
    }

    /** 실패 반영. 통신/검증 실패는 라이선스 상태를 건드리지 않는다 (유예기간이 있으니까). */
    private static void applyFail(Context c, String reason, String attemptedKey) {
        String stored = nz(Prefs.getStr(c, K_KEY, ""));
        boolean sameKey = (attemptedKey == null) || stored.length() == 0 || attemptedKey.equals(stored);

        if (isHard(reason) && sameKey) {
            Prefs.putBool(c, K_OK, false);
            Prefs.putStr(c, K_REASON, reason);
            if ("session_superseded".equals(reason)) {
                Prefs.putBool(c, K_LOCKED, true);
                Prefs.putStr(c, K_SESSION, "");
            }
            if (zeroesFeats(reason)) zeroFeats(c);
        } else if (!Prefs.getBool(c, K_OK, false)) {
            // 아직 정상 상태가 아니면 마지막 실패 이유라도 남겨서 잠금화면에 보여준다
            Prefs.putStr(c, K_REASON, reason);
        }
        invalidate();
    }

    // ── features 직렬화 ───────────────────────────────────────────────────────

    private static void saveFeats(Context c, JSONObject fo) {
        if (fo == null) return;
        // 서버가 준 걸 그대로 저장한다 (3개 키는 파싱할 때 보장)
        Prefs.putStr(c, K_FEATS, fo.toString());
        invalidate();
    }

    /** 만료·회수 때: 만료일 표시는 남기고 on 만 끈다 */
    private static void zeroFeats(Context c) {
        try {
            Map<String, Feat> m = feats(c);
            JSONObject out = new JSONObject();
            for (int i = 0; i < Features.ALL.length; i++) {
                String id = Features.ALL[i];
                Feat f = m.get(id);
                JSONObject one = new JSONObject();
                one.put("on", false);
                one.put("expires_at", (f == null) ? 0L : f.expiresAt);
                if (f != null && f.plan != null) one.put("plan", f.plan);
                out.put(id, one);
            }
            Prefs.putStr(c, K_FEATS, out.toString());
        } catch (Throwable t) {
            Prefs.putStr(c, K_FEATS, "");
        }
        invalidate();
    }

    /** 저장된 features 맵. 항상 3개 키가 있다. */
    private static Map<String, Feat> feats(Context c) {
        String raw = nz(Prefs.getStr(c, K_FEATS, ""));
        Map<String, Feat> cached = featParsed;
        if (cached != null && raw.equals(featRaw)) return cached;

        Map<String, Feat> m = emptyFeats();
        if (raw.length() > 0) {
            try {
                JSONObject o = new JSONObject(raw);
                for (int i = 0; i < Features.ALL.length; i++) {
                    String id = Features.ALL[i];
                    JSONObject one = o.optJSONObject(id);
                    if (one == null) continue;
                    Feat f = m.get(id);
                    f.on = one.optBoolean("on", false);
                    f.expiresAt = one.optLong("expires_at", 0L);
                    String p = one.optString("plan", null);
                    f.plan = (p == null || p.length() == 0 || "null".equals(p)) ? null : p;
                }
            } catch (Throwable t) {
                Log.add(c, "기능 목록을 읽지 못했습니다. 새로고침이 필요합니다.");
            }
        }
        featRaw = raw;
        featParsed = m;
        return m;
    }

    /** 바깥으로 나가는 맵은 복사해서 준다 (캐시 오염 = 게이트 우회) */
    private static Map<String, Feat> copyFeats(Map<String, Feat> src) {
        LinkedHashMap<String, Feat> m = new LinkedHashMap<String, Feat>();
        for (int i = 0; i < Features.ALL.length; i++) {
            String id = Features.ALL[i];
            Feat from = (src == null) ? null : src.get(id);
            Feat f = new Feat();
            if (from != null) {
                f.on = from.on;
                f.expiresAt = from.expiresAt;
                f.plan = from.plan;
            }
            m.put(id, f);
        }
        return m;
    }

    private static Map<String, Feat> emptyFeats() {
        LinkedHashMap<String, Feat> m = new LinkedHashMap<String, Feat>();
        for (int i = 0; i < Features.ALL.length; i++) {
            Feat f = new Feat();
            f.on = false;
            f.expiresAt = 0L;
            f.plan = null;
            m.put(Features.ALL[i], f);
        }
        return m;
    }

    /** 로그용 한 줄 요약 */
    private static String featSummary(Context c) {
        StringBuilder sb = new StringBuilder();
        Map<String, Feat> m = feats(c);
        long now = System.currentTimeMillis();
        for (int i = 0; i < Features.ALL.length; i++) {
            String id = Features.ALL[i];
            Feat f = m.get(id);
            boolean on = f != null && f.on && f.expiresAt > now;
            if (sb.length() > 0) sb.append(" · ");
            sb.append(Features.label(id)).append(on ? " 사용중" : " 꺼짐");
        }
        return sb.toString();
    }

    // ── 네트워크 ──────────────────────────────────────────────────────────────

    /** 모든 요청에 공통으로 실리는 값 (기기 지문 · 앱 서명 · 변조 플래그) */
    private static JSONObject common(Context c, String key, String nonce) throws Exception {
        JSONObject b = new JSONObject();
        b.put("key", key);
        b.put("device_id", Device.deviceId(c));
        b.put("device_fp", Device.fingerprint(c));
        b.put("app_sig", Device.appSigSha256(c));
        b.put("app_version", Device.appVersion(c));
        String tamper = Device.tamperFlags(c);
        if (tamper != null && tamper.length() > 0) b.put("tamper", tamper);
        b.put("nonce", nonce);
        return b;
    }

    private static final class Resp {
        int code;
        String raw;      // 본문 (실패해도 담는다)
        String err;      // 전송 자체가 안 된 이유
    }

    private static final class Parsed {
        JSONObject o;    // 검증 통과한 성공 응답
        String fail;     // 실패 코드
    }

    private static Resp http(Context c, String method, String url, JSONObject body) {
        Resp r = new Resp();
        HttpURLConnection h = null;
        try {
            h = (HttpURLConnection) new URL(url).openConnection();
            h.setConnectTimeout(TIMEOUT_MS);
            h.setReadTimeout(TIMEOUT_MS);
            h.setRequestMethod(method);
            h.setUseCaches(false);
            h.setInstanceFollowRedirects(true);
            h.setRequestProperty("Accept", "application/json");
            h.setRequestProperty("Accept-Charset", "UTF-8");
            h.setRequestProperty("User-Agent", "KakaoAuto/" + Device.appVersion(c));
            if (body != null) {
                byte[] out = body.toString().getBytes(StandardCharsets.UTF_8);
                h.setDoOutput(true);
                h.setFixedLengthStreamingMode(out.length);
                h.setRequestProperty("Content-Type", "application/json; charset=utf-8");
                OutputStream os = h.getOutputStream();
                try {
                    os.write(out);
                    os.flush();
                } finally {
                    try { os.close(); } catch (Throwable ignore) { /* 무시 */ }
                }
            }
            r.code = h.getResponseCode();
            InputStream in = (r.code >= 400) ? h.getErrorStream() : h.getInputStream();
            try {
                r.raw = readAll(in);
            } finally {
                if (in != null) try { in.close(); } catch (Throwable ignore) { /* 무시 */ }
            }
        } catch (Throwable t) {
            r.err = String.valueOf(t);
        } finally {
            if (h != null) try { h.disconnect(); } catch (Throwable ignore) { /* 무시 */ }
        }
        return r;
    }

    private static String readAll(InputStream in) throws Exception {
        if (in == null) return "";
        ByteArrayOutputStream bo = new ByteArrayOutputStream(4096);
        byte[] buf = new byte[4096];
        int n;
        int total = 0;
        while ((n = in.read(buf)) != -1) {
            bo.write(buf, 0, n);
            total += n;
            if (total > MAX_BODY) break;   // 비정상 응답으로 메모리 먹는 것 방어
        }
        return new String(bo.toByteArray(), StandardCharsets.UTF_8);
    }

    /**
     * 응답 검증 파이프라인: HTTP → Ed25519 서명 → nonce → ts → ok.
     * 통과하면 Parsed.o 에 JSON, 아니면 Parsed.fail 에 코드가 담긴다.
     */
    private static Parsed verify(Context c, Resp r, String nonce) {
        Parsed p = new Parsed();
        if (r == null) { p.fail = "no_network"; return p; }
        if (r.err != null) {
            Log.add(c, "서버에 연결하지 못했습니다. 인터넷 연결을 확인하십시오.");
            android.util.Log.w("KakaoAuto", "server connect fail: " + r.err);
            p.fail = "no_network";
            return p;
        }
        if (r.code == 429) {
            p.fail = "rate_limited";
            return p;
        }
        if (r.code != 200) {
            // 서버가 서명 안 한 응답(500/503 등)은 서명검증 대상이 아니다. 연결 실패로 취급한다.
            Log.add(c, "서버가 응답을 거부했습니다. (" + r.code + ") 잠시 후 다시 시도하십시오.");
            android.util.Log.w("KakaoAuto", "http " + r.code + snippet(r.raw));
            p.fail = (r.code >= 500) ? "server_error" : "no_network";
            return p;
        }
        String raw = (r.raw == null) ? "" : r.raw.trim();
        if (raw.length() == 0) {
            Log.add(c, "서버 응답이 비어 있습니다.");
            p.fail = "no_network";
            return p;
        }

        // ── 서명: 원문에서 ,"sig":"..." 만 떼어낸 문자열이 서명 대상 (서버와 같은 방식)
        Matcher m = SIG_PAT.matcher(raw);
        int st = -1, en = -1;
        String sigB64 = null;
        while (m.find()) { st = m.start(); en = m.end(); sigB64 = m.group(1); }
        if (sigB64 == null || sigB64.length() == 0) {
            Log.add(c, BAD_RESP);
            android.util.Log.w("KakaoAuto", "resp: no sig" + snippet(raw));
            p.fail = "bad_signature";
            return p;
        }
        String signed = raw.substring(0, st) + raw.substring(en);
        if (!sigOk(c, signed, sigB64)) {
            Log.add(c, BAD_RESP);
            android.util.Log.w("KakaoAuto", "resp: sig mismatch");
            p.fail = "bad_signature";
            return p;
        }

        JSONObject o;
        try {
            o = new JSONObject(raw);
        } catch (Throwable t) {
            Log.add(c, BAD_RESP);
            android.util.Log.w("KakaoAuto", "resp: not json" + snippet(raw));
            p.fail = "bad_signature";
            return p;
        }

        // ── nonce: 응답 재생(replay) 방어
        String back = str(o, "nonce", "");
        if (nonce != null && !nonce.equals(back)) {
            Log.add(c, BAD_RESP);
            android.util.Log.w("KakaoAuto", "resp: nonce mismatch");
            p.fail = "bad_signature";
            return p;
        }
        // ── ts: 현재 시각 ±10분
        long ts = o.optLong("ts", 0L);
        long diff = Math.abs(System.currentTimeMillis() - ts);
        if (ts <= 0 || diff > TS_SKEW_MS) {
            Log.add(c, "서버 응답 시각이 " + (diff / 60000) + "분 차이가 발생했습니다. 기기 시간을 확인하십시오.");
            p.fail = "bad_signature";
            return p;
        }

        if (!o.optBoolean("ok", false)) {
            String reason = str(o, "reason", "");
            p.fail = (reason.length() == 0) ? "bad_request" : reason;
            return p;
        }
        p.o = o;
        return p;
    }

    /** Ed25519 서명 검증. API 33 아래 기기는 소문자 별칭으로 한 번 더 시도한다. */
    private static boolean sigOk(Context c, String signed, String sigB64) {
        byte[] sig = Crypto.unb64(sigB64);
        byte[] spki = Crypto.unb64(PUBLIC_KEY_B64);
        if (sig == null || sig.length == 0 || spki == null || spki.length == 0) return false;
        byte[] data = signed.getBytes(StandardCharsets.UTF_8);
        Throwable last = null;
        for (int i = 0; i < SIG_ALGS.length; i++) {
            try {
                KeyFactory kf = KeyFactory.getInstance(SIG_ALGS[i]);
                PublicKey pk = kf.generatePublic(new X509EncodedKeySpec(spki));
                Signature v = Signature.getInstance(SIG_ALGS[i]);
                v.initVerify(pk);
                v.update(data);
                if (v.verify(sig)) return true;
            } catch (Throwable t) {
                last = t;
            }
        }
        // 안드로이드 13(API 33) 아래 기기는 플랫폼에 Ed25519 가 아예 없다.
        // 그냥 실패시키면 안드로이드 8~12 사용자는 앱을 영구히 못 쓰니 직접 구현한 검증기로 한 번 더 본다.
        if (Ed25519.verifySpki(spki, data, sig)) return true;
        // 어느 검증기가 돌았는지는 손님 로그에 남기지 않는다 (우회 시도의 단서가 된다).
        android.util.Log.w("KakaoAuto", "ed25519 verify failed", last);
        return false;
    }

    // ── 잡동사니 ──────────────────────────────────────────────────────────────

    /**
     * 키 정리: 대문자 + 공백 전부 제거. 서버 keys.normKey 와 결과가 같아야 한다.
     * (붙여넣기로 들어오는 줄바꿈·비끊김공백까지 털어낸다)
     */
    public static String normKey(String key) {
        if (key == null) return "";
        String s = key.toUpperCase(java.util.Locale.US);
        StringBuilder sb = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (Character.isWhitespace(ch) || ch == ' ' || ch == '﻿') continue;
            sb.append(ch);
        }
        return sb.toString();
    }

    private static void post(final Cb cb, final boolean ok, final String reason) {
        if (cb == null) return;
        try {
            new Handler(Looper.getMainLooper()).post(new Runnable() {
                @Override public void run() {
                    try {
                        cb.done(ok, (reason == null) ? "" : reason);
                    } catch (Throwable t) {
                        android.util.Log.w("KakaoAuto", "라이선스 콜백에서 터졌어", t);
                    }
                }
            });
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "콜백 전달 실패", t);
        }
    }

    private static Context appCtx(Context c) {
        if (c == null) return null;
        try {
            Context a = c.getApplicationContext();
            return (a == null) ? c : a;
        } catch (Throwable t) {
            return c;
        }
    }

    private static String enc(String s) {
        try {
            return URLEncoder.encode((s == null) ? "" : s, "UTF-8");
        } catch (Throwable t) {
            return "";
        }
    }

    private static String str(JSONObject o, String k, String def) {
        if (o == null) return def;
        String v = o.optString(k, null);
        if (v == null) return def;
        v = v.trim();
        if (v.length() == 0 || "null".equals(v)) return def;
        return v;
    }

    private static String nz(String s) { return (s == null) ? "" : s; }

    private static String snippet(String raw) {
        if (raw == null || raw.length() == 0) return "";
        String s = raw.replace('\n', ' ').replace('\r', ' ').trim();
        if (s.length() > 120) s = s.substring(0, 120) + "...";
        return " (" + s + ")";
    }
}
