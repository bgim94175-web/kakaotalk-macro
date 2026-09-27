package com.buseong.kakaoauto;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.Random;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 주기 자동발송 스케줄러 + 라이선스 하트비트 스케줄러.
 *
 * 알람은 두 종류다. 서로 완전히 독립이다 (섞으면 안 된다).
 *   1) 발송 알람   {@link #ACTION_FIRE}      — 매크로가 켜져 있고 macro 기능이 열렸을 때만 유지
 *   2) 하트비트 알람 {@link #ACTION_HEARTBEAT} — 키가 저장돼 있으면 <b>언제나</b> 유지.
 *      매크로를 안 샀거나 껐어도, 심지어 잠긴 상태여도 돈다. 이게 없으면 봇만 산 사용자는
 *      3일 유예가 지난 순간 전부 잠기고 스스로 복구할 방법이 없다.
 *      끄는 건 로그아웃({@link #cancelAll}) 한 곳뿐이다.
 *
 * 핵심 동작(v1.8 에서 그대로 가져온 것 — 절대 바꾸지 마라)
 *   "내가 마지막으로 보낸 뒤 그 방에 남의 새 메시지가 minMessages 개 이상 쌓였을 때만 보낸다."
 *   아무도 말 안 하는 방에 혼자 도배하지 않게 하는 장치다.
 *
 * 흐름
 *   ensureScheduled → 알람 예약 → AlarmReceiver → runDue(조건 판정 + 발송) → scheduleNext → 반복
 *
 * 기능 게이트는 License.allowed(ctx,"macro") 한 곳만 통과한다 (SPEC 6.6).
 * 설정은 암호화돼 있어서, 인증을 통과한 적 없는 기기는 Settings.load 가 기본값(enabled=false)을 돌려준다
 * → 보낼 메시지도 방도 없다. 그게 SPEC 6.1 의 방어다.
 */
public final class Scheduler {
    private Scheduler() {}

    /** 알람 브로드캐스트 액션. AlarmReceiver 가 이걸 보고 runDue 로 보낸다. */
    public static final String ACTION_FIRE = "com.buseong.kakaoauto.ALARM_FIRE";

    /** 라이선스 하트비트 알람 액션. 발송 알람과 완전히 별개다. */
    public static final String ACTION_HEARTBEAT = "com.buseong.kakaoauto.ALARM_HEARTBEAT";

    /** PendingIntent requestCode (다른 PendingIntent 와 겹치지 않게 고정) */
    public static final int REQ_ALARM = 7311;

    /** 하트비트 알람 requestCode — 발송 알람과 겹치면 서로를 덮어쓴다 */
    public static final int REQ_HEARTBEAT = 7312;

    /** 다음 발송 예정 시각 (평문 Prefs — 시각 자체는 민감정보가 아니고, 설정키가 없어도 읽혀야 한다) */
    private static final String K_NEXT = "sched_next";

    /** 누적 발송 카운터. EVERY_N("N번째 발송마다") 이미지 첨부 판정에 쓴다. */
    private static final String K_SEQ = "sched_seq";

    /** 다음 하트비트 예정 시각 (평문 Prefs — 설정키가 없어도 읽혀야 한다) */
    private static final String K_HB_NEXT = "sched_hb_next";

    /** 하트비트 기본 주기. 서버가 recheck_ms 를 주면 그 값을 쓴다. */
    private static final long HB_DEFAULT_MS = 6 * 3600 * 1000L;

    /** 서버가 너무 짧은 recheck_ms 를 줘도 이보다 잦게는 안 돈다 (배터리) */
    private static final long HB_MIN_MS = 15 * 60 * 1000L;

    /** 이미 때가 지났거나 실패했을 때 다시 시도하는 간격 */
    private static final long HB_RETRY_MS = 30 * 60 * 1000L;

    /**
     * 잠긴 기기(License.state().locked)의 하트비트 주기.
     *
     * 잠긴 상태에서는 {@link License#shouldHeartbeat} 가 false 라서 네트워크를 안 쓴다 —
     * 그런데도 30분마다 알람이 울려서 기기를 깨우기만 했다(배터리만 먹는 완전한 헛수고).
     * 잠금은 사용자가 재인증(활성화/새로고침)해야 풀리는 상태고, 그때는 그 경로가
     * {@link #ensureHeartbeat} 를 다시 불러서 정상 주기로 되돌린다. 그래서 여기선 넉넉히 12시간.
     */
    private static final long HB_LOCKED_MS = 12 * 3600 * 1000L;

    /** 하트비트 응답을 기다리는 최대 시간 (네트워크 타임아웃보다 넉넉히) */
    private static final long HB_WAIT_MS = 25000L;

    /** WakeLock 은 runDue 도는 동안만, 최대 60초. */
    private static final long WAKE_TIMEOUT_MS = 60000L;

    /** 하트비트는 네트워크 한 번이라 짧게 잡는다. */
    private static final long HB_WAKE_MS = 30000L;

    /**
     * 한 번의 runDue 가 쓸 수 있는 시간. WakeLock 타임아웃(60초)보다 넉넉히 짧게 잡는다.
     * 브로드캐스트를 너무 오래 붙잡으면 시스템이 프로세스를 잡아간다.
     */
    private static final long RUN_BUDGET_MS = 35000L;

    /** 방 사이 간격 (봇처럼 안 보이게 1~3초 랜덤) */
    private static final int GAP_MIN_MS = 1000;
    private static final int GAP_MAX_MS = 3000;

    private static final Random RND = new Random();

    /** runDue 중복 실행 방지 */
    private static final Object LOCK = new Object();
    private static boolean running = false;

    /** "정확한 알람 권한 없음" 안내를 로그에 한 번만 남기려고 */
    private static boolean warnedInexact = false;

    /** WakeLock 실패(권한 없음 등) 안내도 로그에 한 번만 남긴다 — 매 주기마다 쌓으면 링버퍼가 오염된다 */
    private static boolean warnedWake = false;

    /** 하트비트 알람 예약 실패 안내도 한 번만 */
    private static boolean warnedHb = false;

    // ── 예약 ──────────────────────────────────────────────────────────────────

    /**
     * 발송 알람이 걸려 있게 보장한다. 여러 번 불러도 안전하다(같은 PendingIntent 를 덮어쓴다).
     * 매크로가 꺼져 있거나 기능이 안 열려 있으면 알람을 끈다.
     */
    public static void ensureScheduled(Context ctx) {
        Context c = app(ctx);
        if (c == null) return;

        // 하트비트는 매크로와 무관하게 먼저 보장한다.
        // 설정을 못 읽는 상황(설정키 없음)에서도, 매크로가 꺼져 있어도 하트비트는 살아 있어야 한다.
        ensureHeartbeat(c);

        Settings.Macro m = macro(c);
        if (m == null) return;

        if (!m.enabled) {
            cancel(c);
            return;
        }
        if (!License.allowed(c, Features.MACRO)) {
            cancel(c);
            Log.add(c, "자동발송 예약을 껐어 — 매크로 기능이 켜져 있지 않아(구매·인증 확인)");
            return;
        }

        long now = System.currentTimeMillis();
        long next = storedNext(c);

        // 주기 최대치보다 더 멀리 잡혀 있으면(주기를 줄였거나 값이 깨졌으면) 다시 계산한다.
        // 단, 지금이 방해금지 시간이면 예정 시각이 원래 멀 수밖에 없다 — 그건 건드리지 않는다.
        long maxAhead = (long) Math.max(1, Math.max(m.intervalMinMin, m.intervalMaxMin)) * 60000L;
        boolean tooFar = (next > now + maxAhead) && !m.inQuiet(now);
        if (next <= now || tooFar) next = m.pickNextAt(now);

        setNext(c, m, next);
        arm(c, next);
    }

    /**
     * 발송 알람만 끈다. 예정 시각도 지운다.
     * 하트비트 알람은 <b>건드리지 않는다</b> — 매크로를 껐다고 라이선스 확인을 멈추면 3일 뒤 전부 잠긴다.
     */
    public static void cancel(Context ctx) {
        Context c = app(ctx);
        if (c == null) return;

        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            PendingIntent pi = pending(c);
            if (am != null && pi != null) am.cancel(pi);
            if (pi != null) pi.cancel();
        } catch (Throwable t) {
            Log.add(c, "발송 알람을 끄지 못했어: " + t);
        }

        Prefs.putLong(c, K_NEXT, 0L);
        try {
            Settings.Macro m = Settings.macro(c);
            if (m != null && m.nextAt != 0L) {
                m.nextAt = 0L;
                if (Settings.canSave(c)) Settings.flush(c);
            }
        } catch (Throwable t) {
            // 설정키가 없는 상황(로그아웃 직후 등)이면 그냥 넘어간다 — 평문 예정 시각은 이미 지웠다
            android.util.Log.w("KakaoAuto", "예정 시각 초기화 실패", t);
        }
    }

    /** 다음 발송 예정 시각 (epoch ms). 예정이 없으면 0. */
    public static long nextAt(Context ctx) {
        Context c = app(ctx);
        if (c == null) return 0L;
        long at = storedNext(c);
        if (at > 0) return at;
        try {
            Settings.Macro m = Settings.macro(c);
            return (m == null) ? 0L : m.nextAt;
        } catch (Throwable t) {
            return 0L;
        }
    }

    /**
     * 지금부터 주기(intervalMinMin~intervalMaxMin 분) 안에서 랜덤으로 다음 발송을 새로 잡는다.
     * 방해금지 시간대에 걸리면 pickNextAt 이 끝나는 시각 뒤로 밀어준다.
     */
    public static void scheduleNext(Context ctx) {
        Context c = app(ctx);
        if (c == null) return;

        Settings.Macro m = macro(c);
        if (m == null) return;

        if (!m.enabled || !License.allowed(c, Features.MACRO)) {
            cancel(c);
            return;
        }

        long at = m.pickNextAt(System.currentTimeMillis());
        setNext(c, m, at);
        arm(c, at);
    }

    // ── 라이선스 하트비트 (매크로와 완전히 독립) ───────────────────────────────

    /**
     * 하트비트 알람이 걸려 있게 보장한다. 여러 번 불러도 안전하다.
     *
     * 조건은 하나뿐이다 — <b>키가 저장돼 있으면 예약한다.</b>
     * 매크로 on/off, 어떤 기능을 샀는지, 유예가 지났는지 전부 상관없다.
     * 봇만 산 사용자도 이 알람으로 lic_lastok 이 갱신돼서 3일 유예에 걸리지 않는다.
     * 키가 없으면(로그아웃) 알람도 같이 정리한다.
     */
    public static void ensureHeartbeat(Context ctx) {
        Context c = app(ctx);
        if (c == null) return;

        License.State st;
        try {
            st = License.state(c);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "라이선스 상태를 못 읽어서 하트비트 예약을 건너뛴다", t);
            return;
        }
        if (st == null || st.key == null || st.key.length() == 0) {
            cancelHeartbeat(c);
            return;
        }

        long interval = st.recheckMs;
        if (interval <= 0) interval = HB_DEFAULT_MS;
        if (interval < HB_MIN_MS) interval = HB_MIN_MS;

        // 잠긴 기기는 하트비트가 아무 일도 안 한다 → 주기를 12시간 이상으로 늘린다.
        // (알람을 아예 끄지는 않는다. 끄면 스스로 되살아날 길이 없어진다 — cancelHeartbeat 주석 참고)
        long retry = HB_RETRY_MS;
        boolean locked = st.locked;
        if (locked) {
            if (interval < HB_LOCKED_MS) interval = HB_LOCKED_MS;
            retry = HB_LOCKED_MS;
        }

        long now = System.currentTimeMillis();
        long stored = Prefs.getLong(c, K_HB_NEXT, 0L);

        long at;
        // 잠긴 상태면 예전에 잡아둔 "30분 뒤" 같은 가까운 예정 시각은 버리고 멀리 밀어버린다.
        if (stored > now && stored <= now + interval && (!locked || stored >= now + retry)) {
            // 이미 잡혀 있는 예정 시각을 그대로 쓴다 (앱을 켤 때마다 뒤로 밀리면 안 된다)
            at = stored;
        } else {
            long due = st.lastOk + interval;
            at = (due <= now + retry) ? (now + retry) : due;
        }

        armHeartbeat(c, at, interval);
    }

    /**
     * 하트비트 알람이 울렸을 때 호출된다. <b>백그라운드 스레드에서 불러라</b> —
     * 서버 응답을 최대 {@link #HB_WAIT_MS} 까지 기다린다.
     * 끝나면 어떤 경우에도 다음 하트비트를 다시 잡는다
     * (잠긴 기기는 {@link #HB_LOCKED_MS} 간격으로 — 아무 일도 안 하면서 30분마다 깨면 안 된다).
     */
    public static void runHeartbeat(Context ctx) {
        final Context c = app(ctx);
        if (c == null) return;

        PowerManager.WakeLock wl = null;
        try {
            License.State st = License.state(c);
            if (st == null || st.key == null || st.key.length() == 0) {
                // 로그아웃된 기기다 — 알람만 정리하고 끝낸다
                cancelHeartbeat(c);
                return;
            }
            if (!License.shouldHeartbeat(c)) {
                // 앱을 방금 열어서 이미 확인했거나(때가 아님), 잠긴 상태다 — 네트워크는 아낀다.
                // 잠긴 상태면 finally 의 ensureHeartbeat 가 12시간 뒤로 잡아준다(30분마다 깨지 않게).
                if (st.locked) {
                    Log.add(c, "기기가 잠겨 있어서 라이선스 확인을 건너뛸게 —"
                            + " 다시 인증하면 바로 정상으로 돌아와 (다음 확인은 12시간 뒤)");
                }
                return;
            }

            wl = acquire(c, "kakaoauto:heartbeat", HB_WAKE_MS);

            final CountDownLatch latch = new CountDownLatch(1);
            License.heartbeat(c, new License.Cb() {
                @Override public void done(boolean ok, String reason) {
                    latch.countDown();
                }
            });
            try {
                // 응답을 기다리는 동안 WakeLock 이 프로세스를 잡아준다 (권한이 없으면 그냥 기다린다)
                latch.await(HB_WAIT_MS, TimeUnit.MILLISECONDS);
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
            }
        } catch (Throwable t) {
            Log.add(c, "라이선스 확인 중 오류가 났어: " + t);
        } finally {
            release(wl);
            // 예정 시각을 지워서 갱신된 lic_lastok 기준으로 다시 계산되게 한다
            Prefs.putLong(c, K_HB_NEXT, 0L);
            try {
                ensureHeartbeat(c);
            } catch (Throwable t) {
                Log.add(c, "다음 라이선스 확인 예약에 실패했어: " + t);
            }
        }
    }

    /**
     * 하트비트 알람을 끈다. <b>로그아웃(License.signOut) 때만 부른다.</b>
     * 매크로를 끄거나 기능이 만료됐다고 부르면 안 된다 — 그러면 스스로 되살아날 길이 없어진다.
     */
    private static void cancelHeartbeat(Context c) {
        try {
            AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
            PendingIntent pi = pendingHeartbeat(c);
            if (am != null && pi != null) am.cancel(pi);
            if (pi != null) pi.cancel();
        } catch (Throwable t) {
            Log.add(c, "라이선스 확인 알람을 끄지 못했어: " + t);
        }
        Prefs.putLong(c, K_HB_NEXT, 0L);
    }

    /**
     * 발송 알람 + 하트비트 알람을 전부 끈다. 로그아웃 경로(License.signOut 주변)에서 부른다.
     * 그 외에는 {@link #cancel(Context)} 만 써라.
     */
    public static void cancelAll(Context ctx) {
        Context c = app(ctx);
        if (c == null) return;
        cancel(c);
        cancelHeartbeat(c);
    }

    // ── 발송 ──────────────────────────────────────────────────────────────────

    /**
     * 알람이 울렸을 때 호출된다. 조건을 다 따져보고 실제로 보낸다.
     * <b>백그라운드 스레드에서 불러라</b> — 방 사이에 1~3초 쉬면서 최대 {@link #RUN_BUDGET_MS} 까지 돈다.
     * 끝나면 무조건 다음 알람을 다시 잡는다.
     */
    public static void runDue(Context ctx) {
        final Context c = app(ctx);
        if (c == null) return;

        synchronized (LOCK) {
            if (running) {
                Log.add(c, "앞선 자동발송이 아직 안 끝났어 — 이번 알람은 건너뛸게");
                return;
            }
            running = true;
        }

        PowerManager.WakeLock wl = null;
        try {
            wl = acquire(c, "kakaoauto:send", WAKE_TIMEOUT_MS);
            work(c);
        } catch (Throwable t) {
            Log.add(c, "자동발송 중 오류가 났어: " + t);
        } finally {
            release(wl);
            synchronized (LOCK) { running = false; }

            try {
                scheduleNext(c);
                long at = nextAt(c);
                if (at > 0) Log.add(c, "다음 발송은 " + when(at) + " 쯤이야");
            } catch (Throwable t) {
                Log.add(c, "다음 발송 예약에 실패했어: " + t);
            }

            kickHeartbeat(c);
            refreshUi();
        }
    }

    /** 실제 판정 + 발송. runDue 안에서만 부른다. */
    private static void work(Context c) {
        final long now = System.currentTimeMillis();

        // 1) 기능 게이트 — 유일한 관문
        if (!License.allowed(c, Features.MACRO)) {
            Log.add(c, "자동발송을 건너뛰었어 — 매크로 기능이 켜져 있지 않아(구매·인증 확인)");
            return;
        }

        Settings s;
        try {
            s = Settings.load(c);
        } catch (Throwable t) {
            Log.add(c, "설정을 읽지 못해서 발송을 건너뛰었어: " + t);
            return;
        }
        final Settings.Macro m = s.macro;

        // 2) 활성 여부
        if (!m.enabled) {
            Log.add(c, "자동발송이 꺼져 있어서 안 보냈어");
            return;
        }

        // 3) 방해금지 시간
        if (m.inQuiet(now)) {
            Log.add(c, "방해금지 시간(" + m.quietFrom + "~" + m.quietTo + ")이라 이번엔 안 보낼게");
            return;
        }

        // 4) 일일 한도
        final int limit = m.dailyLimit;
        if (limit > 0 && MainActivity.sentToday(c) >= limit) {
            Log.add(c, "하루 발송 한도(" + limit + "건)를 다 썼어 — 자정에 다시 0부터 센다");
            return;
        }

        // 5) 보낼 내용 / 대상
        final String msg = (m.message == null) ? "" : m.message;
        if (msg.trim().length() == 0) {
            Log.add(c, "발송 메시지가 비어있어서 안 보냈어 — 매크로 탭에서 메시지를 적어줘");
            return;
        }
        List<String> rooms = new ArrayList<String>();
        if (m.rooms != null) {
            for (int i = 0; i < m.rooms.size(); i++) {
                String r = m.rooms.get(i);
                if (r != null && r.trim().length() > 0) rooms.add(r.trim());
            }
        }
        if (rooms.isEmpty()) {
            Log.add(c, "대상 방이 없어서 안 보냈어 — 매크로 탭에서 방을 추가해줘");
            return;
        }

        // 6) 알림 읽기 권한 — 없으면 어떤 방도 못 보낸다(방마다 실패 로그 쌓지 말고 여기서 끝낸다)
        if (!KakaoListener.listenerBound()) {
            if (KakaoListener.connected(c)) {
                Log.add(c, "알림 리스너가 아직 안 붙었어 — 카톡 알림이 한 번 오면 발송이 살아난다");
            } else {
                Log.add(c, "알림 읽기 권한이 꺼져 있어서 발송을 못 해 — 내정보 탭에서 권한을 켜줘");
            }
            return;
        }

        // 7) 방별 발송
        final long deadline = now + RUN_BUDGET_MS;
        final int minNeed = (m.minMessages < 0) ? 0 : m.minMessages;
        int ok = 0;
        int waiting = 0;
        int left = 0;
        StringBuilder failed = new StringBuilder();

        for (int i = 0; i < rooms.size(); i++) {
            if (System.currentTimeMillis() > deadline) {
                left = rooms.size() - i;
                break;
            }
            if (limit > 0 && MainActivity.sentToday(c) >= limit) {
                Log.add(c, "하루 발송 한도(" + limit + "건)에 걸려서 남은 방은 멈췄어");
                left = rooms.size() - i;
                break;
            }

            String room = rooms.get(i);

            // ★ v1.8 핵심: 내 마지막 발송 뒤 남의 새 메시지가 minNeed 개 이상 쌓인 방에만 보낸다
            int others = 0;
            try {
                others = KakaoListener.othersSinceMine(room);
            } catch (Throwable t) {
                Log.add(c, "「" + room + "」 새 메시지 수를 못 읽었어: " + t);
            }
            if (others < minNeed) {
                waiting++;
                continue;
            }

            boolean sent = false;
            try {
                sent = KakaoListener.sendTo(c, room, msg);
            } catch (Throwable t) {
                Log.add(c, "「" + room + "」 발송 중 오류: " + t);
            }

            if (sent) {
                ok++;
                MainActivity.countSent(c, 1);

                // 이미지 첨부 (EVERY / EVERY_N). NEVER·MANUAL 은 imagesThisTime 이 false 를 준다.
                int seq = bumpSeq(c);
                try {
                    if (m.imagesThisTime(seq)) {
                        ImageSender.send(c, room, m.images, null);
                    }
                } catch (Throwable t) {
                    Log.add(c, "「" + room + "」 사진 전송을 시작하지 못했어: " + t);
                }

                if (i < rooms.size() - 1) gap();
            } else {
                if (failed.length() > 0) failed.append(", ");
                failed.append(room);
            }
        }

        StringBuilder sb = new StringBuilder(96);
        sb.append("자동발송 · 성공 ").append(ok).append("건");
        if (waiting > 0) {
            sb.append(" / 대기 ").append(waiting).append("개 방(새 메시지 ")
              .append(minNeed).append("개 미달)");
        }
        if (failed.length() > 0) sb.append(" / 실패: ").append(failed);
        if (left > 0) sb.append(" / 시간이 모자라 ").append(left).append("개 방은 다음 주기로");
        Log.add(c, sb.toString());
    }

    // ── 알람 배선 ─────────────────────────────────────────────────────────────

    private static PendingIntent pending(Context c) {
        try {
            Intent i = new Intent(c, AlarmReceiver.class);
            i.setAction(ACTION_FIRE);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            return PendingIntent.getBroadcast(c, REQ_ALARM, i, flags);
        } catch (Throwable t) {
            Log.add(c, "알람 PendingIntent 를 못 만들었어: " + t);
            return null;
        }
    }

    private static PendingIntent pendingHeartbeat(Context c) {
        try {
            Intent i = new Intent(c, AlarmReceiver.class);
            i.setAction(ACTION_HEARTBEAT);
            int flags = PendingIntent.FLAG_UPDATE_CURRENT;
            if (Build.VERSION.SDK_INT >= 23) flags |= PendingIntent.FLAG_IMMUTABLE;
            return PendingIntent.getBroadcast(c, REQ_HEARTBEAT, i, flags);
        } catch (Throwable t) {
            Log.add(c, "라이선스 확인 알람 PendingIntent 를 못 만들었어: " + t);
            return null;
        }
    }

    /**
     * 하트비트 알람을 건다. 6시간 주기라 정확할 필요가 전혀 없으니
     * setInexactRepeating 으로 배터리를 아낀다(시스템이 다른 알람과 묶어서 깨운다).
     * 그게 실패하면 setAndAllowWhileIdle 한 방으로 폴백하고, 어차피 runHeartbeat 가 매번 다시 잡는다.
     */
    private static boolean armHeartbeat(Context c, long at, long interval) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            if (!warnedHb) {
                warnedHb = true;
                Log.add(c, "알람 서비스를 못 가져와서 라이선스 자동확인을 예약하지 못했어");
            }
            return false;
        }
        PendingIntent pi = pendingHeartbeat(c);
        if (pi == null) return false;

        Prefs.putLong(c, K_HB_NEXT, at);

        try {
            am.setInexactRepeating(AlarmManager.RTC_WAKEUP, at, interval, pi);
            return true;
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "하트비트 반복 알람 실패 — 한 방 예약으로 바꾼다", t);
        }
        try {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            return true;
        } catch (Throwable t) {
            Prefs.putLong(c, K_HB_NEXT, 0L);
            if (!warnedHb) {
                warnedHb = true;
                Log.add(c, "라이선스 자동확인 예약에 실패했어 — 가끔 앱을 열어줘: " + t);
            }
            return false;
        }
    }

    /**
     * at 시각에 알람을 건다. 도즈 모드에서도 깨어나게 ...AndAllowWhileIdle 를 쓴다.
     * API 31+ 에서 「알람 및 리마인더」 권한이 없으면 정확한 알람을 못 걸기 때문에
     * setAndAllowWhileIdle 로 폴백하고 그 사실을 로그로 알린다(조용히 넘기면 사용자가 왜 늦는지 모른다).
     */
    private static boolean arm(Context c, long at) {
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) {
            Log.add(c, "알람 서비스를 못 가져와서 발송 예약에 실패했어");
            return false;
        }
        PendingIntent pi = pending(c);
        if (pi == null) return false;

        boolean exact = true;
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                exact = am.canScheduleExactAlarms();
            } catch (Throwable t) {
                exact = false;
            }
        }

        if (exact) {
            try {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                return true;
            } catch (SecurityException se) {
                Log.add(c, "정확한 알람 권한이 없어서 대략 예약으로 바꿨어 — 몇 분 늦을 수 있어");
            } catch (Throwable t) {
                Log.add(c, "정확한 알람 예약이 실패해서 대략 예약으로 바꿔볼게: " + t);
            }
        } else if (!warnedInexact) {
            warnedInexact = true;
            Log.add(c, "「알람 및 리마인더」 권한이 꺼져 있어 — 대략적인 시각으로 예약할게. "
                    + "몇 분 늦을 수 있어(설정에서 허용하면 정확해진다)");
        }

        try {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            return true;
        } catch (Throwable t) {
            Log.add(c, "발송 알람 예약에 완전히 실패했어: " + t);
            return false;
        }
    }

    // ── WakeLock ──────────────────────────────────────────────────────────────

    /**
     * PARTIAL_WAKE_LOCK 을 잡는다. 매니페스트에 WAKE_LOCK 권한이 있어야 한다.
     * 권한이 없거나(구버전 설치본) 제조사가 막으면 acquire 에서 터지는데,
     * 그때도 발송·하트비트 자체는 계속 진행한다 — 안내는 로그에 한 번만 남긴다.
     */
    private static PowerManager.WakeLock acquire(Context c, String tag, long timeoutMs) {
        PowerManager.WakeLock wl = null;
        try {
            PowerManager pm = (PowerManager) c.getSystemService(Context.POWER_SERVICE);
            if (pm == null) {
                warnWake(c, "전원 관리자를 못 가져왔어");
                return null;
            }
            wl = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, tag);
            wl.setReferenceCounted(false);
            wl.acquire(timeoutMs);
            return wl;
        } catch (Throwable t) {
            // WAKE_LOCK 권한이 없으면 여기서 터진다. 일 자체는 계속한다.
            warnWake(c, String.valueOf(t));
            // 절반만 잡힌 상태로 새는 걸 막는다
            release(wl);
            return null;
        }
    }

    private static void warnWake(Context c, String why) {
        if (warnedWake) return;
        warnedWake = true;
        Log.add(c, "WakeLock 을 못 잡았어(" + why + ") — 화면이 꺼진 동안 작업이 끊길 수 있어");
    }

    private static void release(PowerManager.WakeLock wl) {
        if (wl == null) return;
        try {
            if (wl.isHeld()) wl.release();
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "WakeLock 해제 실패", t);
        }
    }

    // ── 잡동사니 ──────────────────────────────────────────────────────────────

    /** 누적 발송 카운터 +1. EVERY_N 판정용이라 자정에 리셋하지 않는다(계속 누적). */
    private static synchronized int bumpSeq(Context c) {
        int n = Prefs.getInt(c, K_SEQ, 0);
        if (n < 0 || n >= 1000000000) n = 0;
        n = n + 1;
        Prefs.putInt(c, K_SEQ, n);
        return n;
    }

    /** 지금까지 보낸 누적 건수 (EVERY_N 안내 문구에 써도 된다) */
    public static int sendSeq(Context ctx) {
        Context c = app(ctx);
        return (c == null) ? 0 : Prefs.getInt(c, K_SEQ, 0);
    }

    private static void gap() {
        int ms = GAP_MIN_MS + RND.nextInt(GAP_MAX_MS - GAP_MIN_MS + 1);
        try {
            Thread.sleep(ms);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
        }
    }

    private static long storedNext(Context c) {
        long at = Prefs.getLong(c, K_NEXT, 0L);
        return (at < 0) ? 0L : at;
    }

    /** 예정 시각을 평문 Prefs 에 쓰고, 설정 쪽 nextAt 에도 거울처럼 맞춰둔다. */
    private static void setNext(Context c, Settings.Macro m, long at) {
        Prefs.putLong(c, K_NEXT, at);
        try {
            if (m != null && m.nextAt != at) {
                m.nextAt = at;
                if (Settings.canSave(c)) Settings.flush(c);
            }
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "예정 시각 저장 실패", t);
        }
    }

    /** 설정을 읽는다. 못 읽으면 로그를 남기고 null. */
    private static Settings.Macro macro(Context c) {
        try {
            return Settings.macro(c);
        } catch (Throwable t) {
            Log.add(c, "설정을 읽지 못해서 발송 예약을 못 했어: " + t);
            return null;
        }
    }

    /** 하트비트 할 때가 됐으면 지금 해둔다 — 앱을 안 열어도 라이선스가 만료/잠금을 따라가게. */
    private static void kickHeartbeat(Context c) {
        try {
            if (License.shouldHeartbeat(c)) License.heartbeat(c, null);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "하트비트 시작 실패", t);
        }
    }

    /** 홈 화면이 떠 있으면 숫자를 갱신해준다 (UI 건드리는 거라 메인 스레드로 넘긴다) */
    private static void refreshUi() {
        try {
            new Handler(Looper.getMainLooper()).post(new Runnable() {
                @Override public void run() {
                    try {
                        MainActivity.refreshHome();
                    } catch (Throwable t) {
                        android.util.Log.w("KakaoAuto", "홈 갱신 실패", t);
                    }
                }
            });
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "홈 갱신 예약 실패", t);
        }
    }

    private static String when(long at) {
        try {
            return new SimpleDateFormat("MM/dd HH:mm", Locale.KOREA).format(new Date(at));
        } catch (Throwable t) {
            return "-";
        }
    }

    private static Context app(Context c) {
        if (c == null) return App.app();
        Context a = c.getApplicationContext();
        return (a == null) ? c : a;
    }
}
