package com.buseong.kakaoauto.engine;

import android.content.Context;

/** 앱 전체에서 하나뿐인 {@link KakaoEngine}. */
public final class Engine {
    private Engine() {}

    private static volatile NodeEngine instance;

    public static KakaoEngine get(Context c) {
        return impl(c);
    }

    static NodeEngine impl(Context c) {
        NodeEngine e = instance;
        if (e != null) return e;
        synchronized (Engine.class) {
            if (instance == null) {
                Context app = c.getApplicationContext();
                instance = new NodeEngine(app == null ? c : app);
            }
            return instance;
        }
    }

    /** 이 기기용 런타임이 APK 에 들어 있나 */
    public static boolean packaged(Context c) {
        return NodeHost.packaged(c);
    }

    /** 카카오 계정이 연결돼 있고 발송에 쓸 수 있는 상태인가 (네트워크 없음) */
    public static boolean ready(Context c) {
        return c != null && get(c).status().link == KakaoEngine.Link.READY;
    }

    /** 라이선스 로그아웃: 토큰·기기 UUID·방 연결·KeyStore 키 전부 삭제, 엔진 종료 */
    public static void wipe(Context c) {
        if (c == null) return;
        try { impl(c).wipe(); } catch (Throwable t) { android.util.Log.w("KakaoEngine", "wipe failed", t); }
    }

    /** 오래 안 쓴 엔진 프로세스를 내린다 (포그라운드 서비스가 돌고 있으면 유지) */
    static void reapIfIdle(Context c, long idleMs) {
        NodeEngine e = instance;
        if (e == null || !e.host().alive()) return;
        if (System.currentTimeMillis() - e.host().lastCallAt() >= idleMs) e.host().stop();
    }
}
