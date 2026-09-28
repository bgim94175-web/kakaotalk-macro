package com.buseong.kakaoauto.engine;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import com.buseong.kakaoauto.ImageSender;
import com.buseong.kakaoauto.Log;
import com.buseong.kakaoauto.RoomRef;

import java.io.File;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * 발송 흐름(ImageSender · Scheduler)이 엔진을 쓰는 입구.
 *
 * 이미지는 연결된 방(= {@link RoomLinks} 에 확인된 chat_id 가 있고 카카오 계정이 READY)일 때만
 * 엔진으로 보낸다. 아니면 {@link #unavailableReason} 을 기록하고 끝낸다. 카카오톡 화면은 열지 않는다.
 */
public final class EngineSend {
    private EngineSend() {}

    /** 업로드는 한 번에 한 건씩 (동시에 여러 방 × 5장이 몰리면 메모리·회선이 버티지 못한다) */
    private static final ExecutorService Q = Executors.newSingleThreadExecutor();
    private static final Handler MAIN = new Handler(Looper.getMainLooper());
    private static final long WAKE_MS = 5 * 60 * 1000L;

    /** 이 방을 엔진으로 보낼 수 있나 (네트워크 없음) */
    public static boolean handles(Context c, RoomRef ref) {
        if (c == null || ref == null || !ref.valid()) return false;
        if (!Engine.ready(c)) return false;
        return realChatId(RoomLinks.chatIdFor(c, ref));
    }

    /**
     * 엔진으로 보내지 못할 때 이미지 전송 기록에 남길 이유.
     * 카카오톡을 여는 대신 이 문장을 실패로 보여 준다.
     */
    public static String unavailableReason(Context c, RoomRef ref) {
        if (c == null) return "앱 컨텍스트가 없습니다.";
        if (!Engine.packaged(c)) return "이 기기용 카카오 엔진이 앱에 포함되어 있지 않습니다.";
        KakaoEngine.Status st = Engine.get(c).status();
        if (st.link == KakaoEngine.Link.KICKED) {
            return "다른 기기가 같은 로그인 슬롯을 사용하여 연결이 해제되었습니다. 카카오 계정을 다시 연결하십시오.";
        }
        if (st.link == KakaoEngine.Link.REAUTH) {
            return "저장된 카카오 로그인이 만료되었습니다. 카카오 계정을 다시 연결하십시오.";
        }
        if (st.link != KakaoEngine.Link.READY) {
            return "카카오 계정이 연결되어 있지 않습니다. 내정보에서 카카오 계정을 연결하십시오.";
        }
        String id = (ref == null) ? null : RoomLinks.chatIdFor(c, ref);
        if (id != null && id.length() > 0 && !realChatId(id)) {
            return "연결된 카카오 방 번호가 올바르지 않습니다. (" + id + ") 내정보에서 방을 다시 연결하십시오.";
        }
        return "이 대화방은 카카오 방과 연결되어 있지 않습니다. 내정보 › 카카오 계정 직접 연결에서 이 방을 연결한 뒤 다시 보내십시오.";
    }

    /** 양의 십진 방 번호만 발송 대상이다. 빈 값과 {@code "0"} 은 연결이 아니다. */
    private static boolean realChatId(String id) {
        if (id == null || id.length() == 0 || id.charAt(0) == '0') return false;
        for (int i = 0; i < id.length(); i++) {
            char ch = id.charAt(i);
            if (ch < '0' || ch > '9') return false;
        }
        return true;
    }

    /**
     * 이미지 1~5장을 엔진으로 보낸다. 1장은 사진, 2장 이상은 묶음 사진 한 건.
     * done 은 정확히 한 번, 메인 스레드에서 불린다.
     */
    public static void sendImages(final Context ctx, final RoomRef ref, final List<String> uris,
                                  final ImageSender.Done done) {
        final Context c = ctx.getApplicationContext();
        final String label = ref.label(c);
        Q.execute(new Runnable() {
            @Override public void run() {
                PowerManager.WakeLock wl = wake(c);
                List<File> files = null;
                boolean ok = false;
                String detail;
                try {
                    String chatId = RoomLinks.chatIdFor(c, ref);
                    if (chatId == null) throw new EngineException("not_linked", "대화방이 카카오 방과 연결되어 있지 않습니다.");
                    files = ImagePrep.prepare(c, uris);
                    KakaoEngine.SendResult r = Engine.get(c).sendImages(chatId, files);
                    // 로컬 대기열에 넣은 것, 또는 메시지 번호가 없는 카카오 응답은 성공이 아니다.
                    // 여기서 실패하면 알림 답장으로 넘어가지 않는다 — 그 경로는 접수만으로 성공을 보고한다.
                    if (r == null || !NodeEngine.isMessageId(r.logId)) {
                        throw new EngineException("undelivered",
                                "missing log_id (got " + (r == null ? "null" : r.logId) + ")");
                    }
                    ok = true;
                    detail = ("multiphoto".equals(r.kind) ? "묶음 사진 " + files.size() + "장" : "사진 1장")
                            + " · 카카오 계정 직접 전송 · 메시지 " + r.logId;
                    Log.add(c, "「" + label + "」 에 " + detail + "을 완료했습니다.");
                } catch (EngineException e) {
                    detail = "카카오 계정 직접 전송 실패: " + e.userText();
                } catch (Throwable t) {
                    detail = "카카오 계정 직접 전송 실패: " + t;
                } finally {
                    ImagePrep.cleanup(files);
                    release(wl);
                }
                final boolean fOk = ok;
                final String fDetail = detail;
                MAIN.post(new Runnable() {
                    @Override public void run() {
                        try { if (done != null) done.done(fOk, fDetail); } catch (Throwable ignore) { }
                    }
                });
            }
        });
    }

    /** 알림 답장 세션이 없는 방에 텍스트를 보낸다. 블로킹 — 백그라운드 스레드에서만. */
    public static boolean sendText(Context c, RoomRef ref, String text) {
        if (!handles(c, ref)) return false;
        try {
            Engine.get(c).sendText(RoomLinks.chatIdFor(c, ref), text);
            return true;
        } catch (EngineException e) {
            Log.add(c, "「" + ref.label(c) + "」 카카오 계정 직접 발송 실패: " + e.userText());
            return false;
        }
    }

    /**
     * 내 마지막 메시지 뒤 남의 메시지 수를 카카오 서버 기록으로 센다. 모르면 -1.
     * 알림 기반 계산은 앱이 켜진 뒤 받은 알림만 알지만, 이건 방의 실제 기록이다.
     */
    public static int othersSinceMine(Context c, RoomRef ref) {
        if (!handles(c, ref)) return -1;
        try {
            return Engine.get(c).activity(RoomLinks.chatIdFor(c, ref)).othersSinceMine;
        } catch (EngineException e) {
            return -1;
        }
    }

    private static PowerManager.WakeLock wake(Context c) {
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            PowerManager.WakeLock wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "kakaoauto:engine-send");
            wl.setReferenceCounted(false);
            wl.acquire(WAKE_MS);
            return wl;
        } catch (Throwable t) {
            return null;
        }
    }

    private static void release(PowerManager.WakeLock wl) {
        try { if (wl != null && wl.isHeld()) wl.release(); } catch (Throwable ignore) { }
    }
}
