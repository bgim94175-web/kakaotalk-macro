package com.buseong.kakaoauto.engine;

import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import com.buseong.kakaoauto.ImageSender;
import com.buseong.kakaoauto.KakaoAccount;
import com.buseong.kakaoauto.KakaoListener;
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
        if (!KakaoAccount.ready(c) || !Engine.ready(c)) return false;
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
        if (!KakaoAccount.ready(c) || st.link != KakaoEngine.Link.READY) {
            return "카카오 계정이 등록되어 있지 않습니다. 계정을 등록하고 카카오톡에서 인증을 마치십시오.";
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

    /**
     * 매크로 글을 보낼 수 있는 방. 알림 답장이 켜져 있고 상시 발송이 세션을 갖고 있어도
     * 방 번호가 있으면 포함한다. 기록을 읽을 수 없으면 제외한다.
     */
    public static boolean macroTarget(Context c, RoomRef ref, boolean notifyReply) {
        if (c == null || ref == null || !ref.valid()) return false;
        if (notifyReply && notifyRoom(c, ref)) return true;
        if (!KakaoAccount.ready(c)) return false;
        if (!realChatId(RoomLinks.chatIdFor(c, ref))) return false;
        if (!notifyReply) return Engine.ready(c);
        return Engine.ready(c) || SenderSync.blocksPhoneFeatures(c);
    }

    /** 알림이 알려준 방이면 인증 없이도 알림 답장 대상이다. */
    private static boolean notifyRoom(Context c, RoomRef ref) {
        if (KakaoListener.isNotifyRoom(c, ref)) return true;
        RoomRef as = KakaoListener.replyTarget(c, ref);
        return as != null && (KakaoListener.isNotifyRoom(c, as) || KakaoListener.hasSession(as));
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
     * 매크로 글. 알림 답장이 꺼져 있으면 {@link #sendText}.
     * 켜져 있으면 답장할 알림이 있고, 넣은 뒤 카카오 메시지 번호가 확인될 때만 true.
     * 블로킹 — 백그라운드 스레드에서만.
     */
    public static boolean sendMacroText(Context c, RoomRef ref, String text, boolean notifyReply) {
        if (!notifyReply) return sendText(c, ref, text);
        if (c == null || ref == null) return false;
        String label = ref.label(c);
        RoomRef as = KakaoListener.replyTarget(c, ref);
        if (as == null) {
            Log.add(c, "「" + label + "」 알림에서 감지된 폰 카카오톡 계정이 없습니다. 발송으로 세지 않았습니다.");
            return false;
        }
        if (!KakaoListener.hasSession(as)) {
            KakaoListener.queueReply(c, as, text);
            return false;
        }
        String chatId = RoomLinks.chatIdFor(c, ref);
        if (!realChatId(chatId)) chatId = RoomLinks.chatIdFor(c, as);
        if (realChatId(chatId) && canReadChat(c)) {
            String floor;
            try {
                floor = newestId(readRecent(c, chatId));
            } catch (EngineException e) {
                Log.add(c, "「" + label + "」 대화 기록을 읽을 수 없어 알림 답장을 보내지 않았습니다. 발송으로 세지 않았습니다.");
                return false;
            }
            if (!KakaoListener.queueReply(c, as, text)) return false;
            for (int i = 0; i < 3; i++) {
                try {
                    Thread.sleep(1200L);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    break;
                }
                try {
                    String id = confirmedId(readRecent(c, chatId), text, floor);
                    if (id != null) {
                        Log.add(c, "「" + label + "」 알림 답장으로 보냈습니다. 메시지 " + id);
                        return true;
                    }
                } catch (EngineException ignore) { }
            }
            Log.add(c, "「" + label + "」 알림 답장은 넣었으나 카카오 메시지 번호가 없습니다. 발송으로 세지 않았습니다.");
            return false;
        }
        if (KakaoListener.queuedRecently(as, text)) {
            Log.add(c, "「" + label + "」 알림 답장은 넣었으나 카카오 메시지 번호가 없습니다. 발송으로 세지 않았습니다.");
            return false;
        }
        if (!KakaoListener.queueReply(c, as, text)) return false;
        KakaoListener.noteQueued(as, text);
        Log.add(c, "「" + label + "」 알림 답장은 넣었으나 카카오 메시지 번호가 없습니다. 발송으로 세지 않았습니다.");
        return false;
    }

    private static boolean canReadChat(Context c) {
        return Engine.ready(c) || SenderSync.blocksPhoneFeatures(c);
    }

    private static List<KakaoEngine.Inbound> readRecent(Context c, String chatId) throws EngineException {
        if (SenderSync.blocksPhoneFeatures(c)) return SenderSync.recent(c, chatId);
        return Engine.get(c).recent(chatId, "");
    }

    /**
     * 내 마지막 메시지 뒤 남의 메시지 수를 카카오 서버 기록으로 센다. 모르면 -1.
     * 알림 기반 계산은 앱이 켜진 뒤 받은 알림만 알지만, 이건 방의 실제 기록이다.
     */
    public static int othersSinceMine(Context c, RoomRef ref) {
        return othersSinceMine(c, ref, false);
    }

    /**
     * 알림 답장이고 상시 발송이 세션을 갖고 있으면 서버 기록으로 센다.
     * 폰 LOCO 는 그 슬롯을 다시 열지 않는다.
     */
    public static int othersSinceMine(Context c, RoomRef ref, boolean notifyReply) {
        if (notifyReply && c != null && notifyRoom(c, ref)
                && !realChatId(RoomLinks.chatIdFor(c, ref))) {
            RoomRef as = KakaoListener.replyTarget(c, ref);
            return KakaoListener.othersSinceMine(as != null ? as : ref);
        }
        if (notifyReply && c != null && SenderSync.blocksPhoneFeatures(c)) {
            String id = (ref == null) ? null : RoomLinks.chatIdFor(c, ref);
            if (!realChatId(id)) return -1;
            try {
                return countOthers(SenderSync.recent(c, id));
            } catch (EngineException e) {
                return -1;
            }
        }
        if (!handles(c, ref)) return -1;
        try {
            return Engine.get(c).activity(RoomLinks.chatIdFor(c, ref)).othersSinceMine;
        } catch (EngineException e) {
            return -1;
        }
    }

    private static int countOthers(List<KakaoEngine.Inbound> msgs) {
        if (msgs == null) return -1;
        String mineId = "";
        for (int i = 0; i < msgs.size(); i++) {
            KakaoEngine.Inbound m = msgs.get(i);
            if (m == null || !m.mine) continue;
            if (newerThan(m.logId, mineId)) mineId = m.logId;
        }
        int others = 0;
        for (int i = 0; i < msgs.size(); i++) {
            KakaoEngine.Inbound m = msgs.get(i);
            if (m == null || !NodeEngine.isMessageId(m.logId)) continue;
            if (mineId.length() > 0 && !newerThan(m.logId, mineId)) continue;
            if (!m.mine) others++;
        }
        return others;
    }

    private static String newestId(List<KakaoEngine.Inbound> msgs) {
        String best = "";
        if (msgs == null) return best;
        for (int i = 0; i < msgs.size(); i++) {
            KakaoEngine.Inbound m = msgs.get(i);
            if (m != null && newerThan(m.logId, best)) best = m.logId;
        }
        return best;
    }

    private static String confirmedId(List<KakaoEngine.Inbound> msgs, String text, String floor) {
        String want = text == null ? "" : text.trim();
        String hit = null;
        if (msgs == null) return null;
        for (int i = 0; i < msgs.size(); i++) {
            KakaoEngine.Inbound m = msgs.get(i);
            if (m == null || !m.mine) continue;
            String body = m.text == null ? "" : m.text.trim();
            if (!want.equals(body)) continue;
            if (!newerThan(m.logId, floor)) continue;
            if (hit == null || newerThan(m.logId, hit)) hit = m.logId;
        }
        return hit;
    }

    /** 앞자리가 0이 아닌 십진 메시지 번호. 자릿수가 길면 더 크다. */
    private static boolean newerThan(String id, String floor) {
        if (!NodeEngine.isMessageId(id)) return false;
        if (floor == null || floor.length() == 0) return true;
        if (!NodeEngine.isMessageId(floor)) return true;
        if (id.length() != floor.length()) return id.length() > floor.length();
        return id.compareTo(floor) > 0;
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
