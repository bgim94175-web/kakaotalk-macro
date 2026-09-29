package com.buseong.kakaoauto.engine;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import com.buseong.kakaoauto.AlarmReceiver;
import com.buseong.kakaoauto.AutoReply;
import com.buseong.kakaoauto.Features;
import com.buseong.kakaoauto.KakaoAccount;
import com.buseong.kakaoauto.License;
import com.buseong.kakaoauto.Log;
import com.buseong.kakaoauto.MiniGame;
import com.buseong.kakaoauto.Prefs;
import com.buseong.kakaoauto.RoomBot;
import com.buseong.kakaoauto.RoomRef;
import com.buseong.kakaoauto.Settings;
import com.buseong.kakaoauto.Trigger;

import java.util.List;
import java.util.Map;

/**
 * 연결된 카카오 방의 새 메시지를 LOCO 세션에서 읽어 기능으로 넘긴다.
 * 알림 리스너는 쓰지 않는다. 계정이 등록되고 세션이 저장된 뒤에만 돈다.
 */
public final class LocoInbox {
    private LocoInbox() {}

    public static final String ACTION = "com.buseong.kakaoauto.ALARM_INBOX";
    private static final int REQ = 7313;
    private static final long INTERVAL_MS = 45_000L;
    private static final String K_SEEN = "loco_seen_";

    private static volatile boolean polling = false;

    /** 조건이 맞으면 다음 조회 알람을 잡고, 아니면 끈다. */
    public static void ensure(Context ctx) {
        Context c = app(ctx);
        if (c == null) return;
        if (!wanted(c)) {
            cancel(c);
            return;
        }
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            PendingIntent pi = pi(c);
            if (am == null || pi == null) return;
            long at = System.currentTimeMillis() + INTERVAL_MS;
            if (Build.VERSION.SDK_INT >= 23) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, at, pi);
            }
        } catch (Throwable t) {
            Log.add(c, "카카오 수신 예약을 하지 못했습니다. (" + t + ")");
        }
    }

    public static void poll(Context ctx) {
        final Context c = app(ctx);
        if (c == null) return;
        if (!sessionReady(c)) return;
        if (polling) return;
        polling = true;
        try {
            Map<String, RoomLinks.Link> links = RoomLinks.all(c);
            for (RoomLinks.Link link : links.values()) {
                if (link == null || link.chatId == null || link.chatId.length() == 0) continue;
                pull(c, link);
            }
        } catch (Throwable t) {
            Log.add(c, "카카오 수신 조회에 실패했습니다. (" + t + ")");
        } finally {
            polling = false;
            ensure(c);
        }
    }

    private static void pull(Context c, RoomLinks.Link link) {
        RoomRef ref = RoomRef.parse(link.roomKey);
        if (ref == null || !ref.valid()) return;
        String seen = Prefs.getStr(c, K_SEEN + link.chatId, "");
        boolean first = seen == null || seen.length() == 0;
        List<KakaoEngine.Inbound> msgs;
        try {
            msgs = Engine.get(c).recent(link.chatId, first ? "" : seen);
        } catch (EngineException e) {
            Log.add(c, "「" + ref.label(c) + "」 수신 조회 실패: " + e.userText());
            return;
        }
        String newest = seen;
        if (msgs != null) {
            for (int i = 0; i < msgs.size(); i++) {
                KakaoEngine.Inbound m = msgs.get(i);
                if (m == null || m.logId.length() == 0) continue;
                if (newest == null || newest.length() == 0 || cmp(m.logId, newest) > 0) newest = m.logId;
                if (!first) deliver(c, ref, link, m);
            }
        }
        if (newest != null && newest.length() > 0 && !newest.equals(seen)) {
            Prefs.putStr(c, K_SEEN + link.chatId, newest);
        }
    }

    private static void deliver(Context c, RoomRef ref, RoomLinks.Link link, KakaoEngine.Inbound m) {
        if (m.text == null || m.text.trim().length() == 0) return;
        boolean group = "group".equals(link.kind) || "open".equals(link.kind);
        String who = m.authorName == null ? "" : m.authorName;
        if (License.allowed(c, Features.MACRO)) {
            try {
                Trigger.onMessage(c, ref, who, m.text, group, m.mine);
            } catch (Throwable t) {
                Log.add(c, "경쟁사 저격 처리 중 오류: " + t);
            }
            if (!group && !m.mine) {
                try {
                    AutoReply.onDirectMessage(c, ref, who, m.text);
                } catch (Throwable t) {
                    Log.add(c, "자동응답 처리 중 오류: " + t);
                }
            }
        }
        if (!m.mine) {
            if (License.allowed(c, Features.ROOMBOT)) {
                try { RoomBot.onMessage(c, ref, who, m.text, group); }
                catch (Throwable t) { Log.add(c, "대화방 관리봇 처리 중 오류: " + t); }
            }
            if (License.allowed(c, Features.MINIGAME)) {
                try { MiniGame.onMessage(c, ref, who, m.text, group); }
                catch (Throwable t) { Log.add(c, "미니게임봇 처리 중 오류: " + t); }
            }
        }
    }

    private static boolean wanted(Context c) {
        if (com.buseong.kakaoauto.engine.SenderSync.blocksPhoneFeatures(c)) return false;
        if (!sessionReady(c)) return false;
        try {
            if (License.allowed(c, Features.MACRO)) {
                Settings s = Settings.load(c);
                if (s.macro != null && s.macro.enabled) return true;
                if (s.autoreply != null && s.autoreply.enabled) return true;
                if (s.triggers != null) {
                    for (int i = 0; i < s.triggers.size(); i++) {
                        Settings.TriggerCfg t = s.triggers.get(i);
                        if (t != null && t.enabled) return true;
                    }
                }
            }
            if (License.allowed(c, Features.ROOMBOT)) {
                Settings.RoomBotCfg b = Settings.roombot(c);
                if (b != null && b.enabled) return true;
            }
            if (License.allowed(c, Features.MINIGAME)) {
                Settings.MiniGameCfg g = Settings.minigame(c);
                if (g != null && g.enabled) return true;
            }
        } catch (Throwable t) {
            return false;
        }
        return false;
    }

    private static boolean sessionReady(Context c) {
        return c != null && KakaoAccount.ready(c) && Engine.ready(c);
    }

    private static int cmp(String a, String b) {
        try {
            return new java.math.BigInteger(a).compareTo(new java.math.BigInteger(b));
        } catch (Throwable t) {
            return a.compareTo(b);
        }
    }

    private static void cancel(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            PendingIntent pi = pi(c);
            if (am != null && pi != null) am.cancel(pi);
        } catch (Throwable ignore) { }
    }

    private static PendingIntent pi(Context c) {
        Intent i = new Intent(c, AlarmReceiver.class);
        i.setAction(ACTION);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getBroadcast(c, REQ, i, flags);
    }

    private static Context app(Context c) {
        if (c == null) return null;
        Context a = c.getApplicationContext();
        return (a == null) ? c : a;
    }
}
