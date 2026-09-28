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

    // ── 마지막 사진 전송 실패 기록 ────────────────────────────────────────────
    //  예약 발송의 사진 전송은 아무도 화면을 안 보고 있을 때 돌아간다. 그래서 실패를
    //  여기 안 남기면 사용자는 영원히 모른다 — 활동 로그는 200줄 링버퍼라 금방 밀려난다.
    //  평문 Prefs 에 둔다: 설정키가 없는 상태(재인증 전)에서도 경고는 떠야 하니까.
    private static final String K_IMG_FAIL_AT = "img_fail_at";
    private static final String K_IMG_FAIL_ROOM = "img_fail_room";
    private static final String K_IMG_FAIL_WHY = "img_fail_why";
    /** "이미지 생략" 을 마지막으로 알린 날 ({@link #dayOf}). 하루 1회만 남기기 위한 값이다. */
    private static final String K_IMG_SKIP_NOTED = "img_skip_noted_day";

    /** 사유 문구가 아무리 길어도 이만큼만 보관한다 (경고 줄 한 줄에 들어갈 만큼) */
    private static final int IMG_FAIL_WHY_MAX = 300;

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
            Log.add(c, "자동발송 예약을 해제했습니다. 매크로 기능이 활성 상태가 아닙니다. 구매 내역과 인증 상태를 확인하십시오.");
            return;
        }

        long now = System.currentTimeMillis();
        long next = earliestAlarm(m, now);
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
            Log.add(c, "발송 알람 해제에 실패했습니다. (" + t + ")");
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
     * 방별 쿨타임 중 가장 빠른 시각으로 다음 알람을 다시 잡는다.
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

        long at = earliestAlarm(m, System.currentTimeMillis());
        setNext(c, m, at);
        arm(c, at);
    }

    /**
     * 다음 알람 시각. 방마다 저장된 예약 중 가장 빠른 것.
     * 아직 예약이 없는 방은 바로 보낼 수 있으므로 곧 한 번 깨운다.
     */
    private static long earliestAlarm(Settings.Macro m, long now) {
        long soonest = Long.MAX_VALUE;
        boolean pending = false;
        int n = 0;
        List<RoomRef> all = m.roomRefs();
        for (int i = 0; i < all.size(); i++) {
            RoomRef r = all.get(i);
            if (r == null || !r.valid()) continue;
            n++;
            long due = m.dueAt(r);
            if (due > now) {
                if (due < soonest) soonest = due;
            } else {
                pending = true;
            }
        }
        if (n == 0) return now + m.cooldownMs(null);
        if (pending) {
            long retry = now + 5000L;
            if (retry < soonest) soonest = retry;
        }
        if (soonest == Long.MAX_VALUE) return now + m.cooldownMs(null);
        return soonest;
    }

    /**
     * 이번에 보내지 못한 방의 다음 시각을 쿨타임만큼 뒤로 민다.
     * 예약이 비어 있으면 알람이 5초마다 다시 깨어나므로, 조건이 안 되는 실행은 여기서 막는다.
     */
    private static void deferOpenRooms(Context c, long now) {
        try {
            Settings s = Settings.load(c);
            if (s == null) return;
            deferOpenRooms(c, s, now);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "방별 쿨타임 연기에 실패", t);
        }
    }

    private static void deferOpenRooms(Context c, Settings s, long now) {
        if (s == null || s.macro == null) return;
        Settings.Macro m = s.macro;
        List<RoomRef> all = m.roomRefs();
        boolean changed = false;
        for (int i = 0; i < all.size(); i++) {
            RoomRef r = all.get(i);
            if (r == null || !r.valid()) continue;
            if (m.dueAt(r) > now) continue;
            m.setDueAt(r, now + m.cooldownMs(r));
            changed = true;
        }
        if (!changed) return;
        try {
            s.save(c);
        } catch (Throwable t) {
            Log.add(c, "방별 쿨타임을 저장하지 못했습니다. (" + t + ")");
        }
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
                    Log.add(c, "기기가 잠금 상태이므로 라이선스 확인을 건너뜁니다."
                            + " 재인증 시 정상 상태로 복구됩니다. (다음 확인 12시간 후)");
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
            Log.add(c, "라이선스 확인 중 오류가 발생했습니다. (" + t + ")");
        } finally {
            release(wl);
            // 예정 시각을 지워서 갱신된 lic_lastok 기준으로 다시 계산되게 한다
            Prefs.putLong(c, K_HB_NEXT, 0L);
            try {
                ensureHeartbeat(c);
            } catch (Throwable t) {
                Log.add(c, "다음 라이선스 확인 예약에 실패했습니다. (" + t + ")");
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
            Log.add(c, "라이선스 확인 알람 해제에 실패했습니다. (" + t + ")");
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
                Log.add(c, "이전 자동발송이 진행 중입니다. 이번 주기는 건너뜁니다.");
                return;
            }
            running = true;
        }

        PowerManager.WakeLock wl = null;
        try {
            wl = acquire(c, "kakaoauto:send", WAKE_TIMEOUT_MS);
            work(c);
        } catch (Throwable t) {
            Log.add(c, "자동발송 중 오류가 발생했습니다. (" + t + ")");
        } finally {
            release(wl);
            synchronized (LOCK) { running = false; }

            try {
                scheduleNext(c);
                long at = nextAt(c);
                if (at > 0) Log.add(c, "다음 발송 예정 " + when(at));
            } catch (Throwable t) {
                Log.add(c, "다음 발송 예약에 실패했습니다. (" + t + ")");
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
            Log.add(c, "자동발송을 건너뛰었습니다. 매크로 기능이 활성 상태가 아닙니다. 구매 내역과 인증 상태를 확인하십시오.");
            deferOpenRooms(c, now);
            return;
        }

        Settings s;
        try {
            s = Settings.load(c);
        } catch (Throwable t) {
            Log.add(c, "설정을 읽지 못해 발송을 건너뛰었습니다. (" + t + ")");
            return;
        }
        final Settings.Macro m = s.macro;

        // 2) 활성 여부
        if (!m.enabled) {
            Log.add(c, "자동발송이 비활성 상태이므로 발송하지 않았습니다.");
            return;
        }

        // 3) 보낼 내용 / 대상
        final String msg = (m.message == null) ? "" : m.message;
        if (msg.trim().length() == 0) {
            Log.add(c, "발송 메시지가 비어 있어 발송하지 않았습니다. 매크로 탭에서 메시지를 입력하십시오.");
            deferOpenRooms(c, s, now);
            return;
        }
        // 대상 계정 필터 — Settings.accounts 가 비어 있으면 모든 계정이 대상이다
        List<RoomRef> rooms = new ArrayList<RoomRef>();
        int offAccount = 0;
        List<RoomRef> all = m.roomRefs();
        for (int i = 0; i < all.size(); i++) {
            RoomRef r = all.get(i);
            if (r == null || !r.valid()) continue;
            if (!s.accountOn(r.acc)) { offAccount++; continue; }
            rooms.add(r);
        }
        if (rooms.isEmpty()) {
            if (offAccount > 0) {
                Log.add(c, "방 " + offAccount + "개가 모두 미사용 계정에 속해 발송하지 않았습니다."
                        + " 내정보 탭의 카카오톡 계정에서 대상 계정을 확인하십시오.");
            } else {
                Log.add(c, "방이 지정되지 않아 발송하지 않았습니다. 매크로 탭에서 대화방을 추가하십시오.");
            }
            return;
        }

        // 6) 알림 읽기 권한 — 없으면 어떤 방도 못 보낸다(방마다 실패 로그 쌓지 말고 여기서 끝낸다)
        if (!KakaoListener.listenerBound()) {
            if (KakaoListener.connected(c)) {
                Log.add(c, "알림 리스너가 아직 연결되지 않았습니다. 카카오톡 알림이 1회 수신되면 발송이 재개됩니다.");
            } else {
                Log.add(c, "알림 읽기 권한이 비활성 상태이므로 발송이 불가합니다. 내정보 탭에서 권한을 허용하십시오.");
            }
            deferOpenRooms(c, s, now);
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

            RoomRef room = rooms.get(i);
            // 계정이 2개 이상이면 label(c) 가 계정 이름까지 붙여준다 (하나면 방 이름만)
            String label = room.label(c);

            long due = m.dueAt(room);
            if (due > now) continue;

            // ★ v1.8 핵심: 내 마지막 발송 뒤 남의 새 메시지가 minNeed 개 이상 쌓인 방에만 보낸다
            int others = 0;
            try {
                others = KakaoListener.othersSinceMine(room);
            } catch (Throwable t) {
                Log.add(c, "「" + label + "」 신규 메시지 수를 읽지 못했습니다. (" + t + ")");
            }
            if (others < minNeed) {
                waiting++;
                long retry = now + (long) Math.max(1, m.baseMin) * 60000L;
                m.setDueAt(room, retry);
                continue;
            }

            boolean sent = false;
            try {
                sent = KakaoListener.sendTo(c, room, msg);
            } catch (Throwable t) {
                Log.add(c, "「" + label + "」 발송 중 오류가 발생했습니다. (" + t + ")");
            }

            if (sent) {
                ok++;
                MainActivity.countSent(c, 1);
                long sentAt = System.currentTimeMillis();
                m.setLastSent(room, sentAt);
                m.setDueAt(room, sentAt + m.cooldownMs(room));

                // 이미지 첨부 (EVERY / EVERY_N). NEVER·MANUAL 은 imagesThisTime 이 false 를 준다.
                int seq = bumpSeq(c);
                // ★ ImageSender 에는 RoomRef 를 그대로 넘긴다. 저장 키(RoomRef.key())를 넘기면
                //   계정 구분자가 붙은 문자열이 화면 매칭에 쓰여 카톡 화면의 어떤 텍스트와도 안 맞는다.
                final RoomRef imgRoom = room;
                final String imgLabel = label;
                final boolean wantImages = m.imagesThisTime(seq);
                try {
                    if (wantImages && ImageSender.blockedInBackground(c, imgRoom, m.images)) {
                        // 공유창도 안 뜨고 채팅방 첨부 경로의 재료도 없는 백그라운드 상태다.
                        // 매 주기 같은 실패를 되풀이하는 대신 텍스트만 보내고 이 사실을 하루 1회만 알린다.
                        // (images 를 같이 넘기는 이유: 채팅방 첨부 경로는 공유창과 무관하게 동작하므로
                        //  "공유창 불가 확정" 만으로 이미지를 포기하면 실제로 되는 경로를 스스로 닫는다.)
                        noteImageSkipped(c, imgLabel);
                    } else if (wantImages) {
                        // ★ 콜백을 버리면 안 된다. 예약 발송은 아무도 안 보고 있어서,
                        //   여기서 결과를 기록하지 않으면 사진이 안 갔다는 걸 사용자가 영원히 모른다.
                        ImageSender.sendWithResult(c, imgRoom, m.images, new ImageSender.Done() {
                            @Override public void done(boolean ok, String detail) {
                                if (ok) {
                                    clearImageFail(c, imgLabel);
                                    Log.add(c, "「" + imgLabel + "」 이미지 전송을 완료했습니다.");
                                } else {
                                    noteImageFail(c, imgLabel, detail);
                                    Log.add(c, "「" + imgLabel + "」 이미지 전송에 실패했습니다. "
                                            + ((detail == null || detail.length() == 0)
                                               ? "원인 확인 불가" : detail));
                                }
                                refreshUi();
                            }
                        });
                    }
                } catch (Throwable t) {
                    noteImageFail(c, imgLabel, "전송을 시작하지 못했습니다. (" + t + ")");
                    Log.add(c, "「" + imgLabel + "」 이미지 전송을 시작하지 못했습니다. (" + t + ")");
                }

                if (i < rooms.size() - 1) gap();
            } else {
                if (failed.length() > 0) failed.append(", ");
                failed.append(label);
                long retry = now + 60_000L;
                if (m.dueAt(room) < retry) m.setDueAt(room, retry);
            }
        }
        try {
            s.save(c);
        } catch (Throwable t) {
            Log.add(c, "방별 쿨타임을 저장하지 못했습니다. (" + t + ")");
        }

        StringBuilder sb = new StringBuilder(96);
        sb.append("자동발송 · 성공 ").append(ok).append("건");
        if (waiting > 0) {
            sb.append(" / 대기 ").append(waiting).append("개 대화방(신규 메시지 ")
              .append(minNeed).append("개 미달)");
        }
        if (failed.length() > 0) sb.append(" / 실패: ").append(failed);
        if (offAccount > 0) sb.append(" / 미사용 계정 제외 ").append(offAccount).append("개");
        if (left > 0) sb.append(" / 시간 부족으로 ").append(left).append("개 대화방은 다음 주기로 이월");
        Log.add(c, sb.toString());
    }

    // ── 마지막 사진 전송 실패 기록 (공개 API) ─────────────────────────────────

    /**
     * 마지막으로 실패한 사진 전송 한 건. {@link #lastImageFail} 이 돌려준다.
     * 성공하면 {@link #clearImageFail} 로 지워진다 — 그래서 이게 null 이 아니면
     * "지금도 안 고쳐진 실패" 라고 봐도 된다.
     */
    public static final class ImageFail {
        /** 실패한 시각 (0 이 아니다) */
        public final long at;
        /** 어느 방에 보내려던 거였나 ("" 면 모름) */
        public final String room;
        /** 왜 실패했나 (사람이 읽는 한 줄) */
        public final String why;

        ImageFail(long at, String room, String why) {
            this.at = at;
            this.room = (room == null) ? "" : room;
            this.why = (why == null || why.length() == 0) ? "원인 확인 불가" : why;
        }
    }

    /** 마지막 사진 전송 실패 기록. 없으면 null. */
    public static ImageFail lastImageFail(Context ctx) {
        Context c = app(ctx);
        if (c == null) return null;
        long at = Prefs.getLong(c, K_IMG_FAIL_AT, 0L);
        if (at <= 0) return null;
        return new ImageFail(at, Prefs.getStr(c, K_IMG_FAIL_ROOM, ""),
                Prefs.getStr(c, K_IMG_FAIL_WHY, ""));
    }

    /**
     * "백그라운드에서는 이미지를 보낼 수 없어서 텍스트만 보냈다" 를 <b>하루 1회만</b> 알린다.
     *
     * 왜 하루 1회인가 — 예약 발송은 20~40분마다 돌고, 같은 원인의 같은 줄이 매 주기 쌓이면
     * 활동 로그(200줄 링버퍼)가 이 줄로만 가득 차서 정작 읽어야 하는 실패가 밀려난다.
     * 그래서 마지막으로 알린 <b>날짜</b>를 기록하고 날이 바뀌기 전에는 다시 적지 않는다.
     * (예전에는 {@link ImageSender#backgroundBlockedAt} 값으로만 판단했는데, 전송이 한 번 성공해
     *  그 값이 지워졌다가 다시 확정될 때마다 새 회차로 취급되어 같은 날에도 여러 번 쌓였다.)
     *
     * 실패 기록({@link #noteImageFail})은 항상 갱신한다 — 그건 누적되지 않고 마지막 한 건만 남는
     * 상태 표시라서, 하루 1회로 묶으면 화면이 오래된 내용을 보여준다.
     */
    private static void noteImageSkipped(Context c, String label) {
        if (ImageSender.backgroundBlockedAt(c) <= 0L) return;

        String why = "이미지를 생략하고 텍스트만 발송했습니다. "
                + "이 기기의 예약 발송에서는 카카오톡 화면이 표시되지 않아 이미지를 첨부할 수 없습니다(원인 미확정). "
                + "매크로 › 이미지 첨부 › 즉시 발송 으로 1회 전송하면 다시 시도합니다.";
        noteImageFail(c, label, why);

        boolean first;
        long today = dayOf(System.currentTimeMillis());
        try {
            first = Prefs.getLong(c, K_IMG_SKIP_NOTED, 0L) != today;
            if (first) Prefs.putLong(c, K_IMG_SKIP_NOTED, today);
        } catch (Throwable t) {
            first = true;   // 못 읽었으면 한 번은 알리는 쪽이 낫다
        }
        if (!first) return;

        Log.add(c, "이미지 전송을 생략하고 텍스트만 발송합니다. 백그라운드 상태에서 카카오톡 화면이 "
                + ImageSender.BG_FAIL_LIMIT + "회 연속 표시되지 않았습니다. "
                + "채팅방 첨부 경로도 사용할 수 없는 상태입니다(방 알림 미수신 또는 이미지 시각 확인 불가). "
                + "이미지는 매크로 › 이미지 첨부 › 즉시 발송 으로 전송하십시오. "
                + "1회 성공하면 예약 발송이 이미지 첨부를 다시 시도합니다. "
                + "이 안내는 하루 1회만 기록됩니다.");
    }

    /** 그 시각이 며칠째인가 (기기 시간대 기준 일 번호). 하루 1회 안내 판정에 쓴다. */
    private static long dayOf(long ms) {
        java.util.Calendar cal = java.util.Calendar.getInstance();
        cal.setTimeInMillis(ms);
        return cal.get(java.util.Calendar.YEAR) * 1000L + cal.get(java.util.Calendar.DAY_OF_YEAR);
    }

    /**
     * 사진 전송 실패를 기록한다. 예약 발송·수동 전송·진단이 전부 이걸 부른다.
     * 마지막 한 건만 보관한다 (사용자가 알아야 하는 건 "지금 안 되고 있다" 는 사실이다).
     */
    public static void noteImageFail(Context ctx, String room, String why) {
        Context c = app(ctx);
        if (c == null) return;
        String w = (why == null) ? "" : why.trim();
        if (w.length() == 0) w = "원인 확인 불가";
        if (w.length() > IMG_FAIL_WHY_MAX) w = w.substring(0, IMG_FAIL_WHY_MAX) + "…";
        try {
            Prefs.putLong(c, K_IMG_FAIL_AT, System.currentTimeMillis());
            Prefs.putStr(c, K_IMG_FAIL_ROOM, (room == null) ? "" : room);
            Prefs.putStr(c, K_IMG_FAIL_WHY, w);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "사진 전송 실패 기록을 못 남겼다", t);
        }
    }

    /** 실패 기록을 무조건 지운다 (사용자가 "지우기" 를 누른 경우). */
    public static void clearImageFail(Context ctx) {
        clearImageFail(ctx, null);
    }

    /**
     * 실패 기록을 지운다.
     *
     * @param room null 이면 무조건 지운다. 방 이름을 주면 <b>그 방 실패였을 때만</b> 지운다.
     *        방을 따지는 이유: 한 주기에 여러 방으로 보내는데, 뒷방이 성공했다고
     *        앞방의 실패 기록을 덮어버리면 사용자는 앞방이 안 간 걸 영원히 모른다.
     */
    public static void clearImageFail(Context ctx, String room) {
        Context c = app(ctx);
        if (c == null) return;
        if (room != null) {
            ImageFail cur = lastImageFail(c);
            if (cur == null) return;
            if (!cur.room.trim().equals(room.trim())) return;
        }
        try {
            Prefs.remove(c, K_IMG_FAIL_AT);
            Prefs.remove(c, K_IMG_FAIL_ROOM);
            Prefs.remove(c, K_IMG_FAIL_WHY);
        } catch (Throwable t) {
            android.util.Log.w("KakaoAuto", "사진 전송 실패 기록을 못 지웠다", t);
        }
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
            Log.add(c, "발송 알람을 등록하지 못했습니다. (" + t + ")");
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
            Log.add(c, "라이선스 확인 알람을 등록하지 못했습니다. (" + t + ")");
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
                Log.add(c, "알람 서비스를 사용할 수 없어 라이선스 자동확인을 예약하지 못했습니다.");
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
                Log.add(c, "라이선스 자동확인 예약에 실패했습니다. 주기적으로 앱을 실행하십시오. (" + t + ")");
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
            Log.add(c, "알람 서비스를 사용할 수 없어 발송 예약에 실패했습니다.");
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
                Log.add(c, "정확한 알람 권한이 없어 대략적인 시각으로 예약했습니다. 최대 수 분 지연될 수 있습니다.");
            } catch (Throwable t) {
                Log.add(c, "정확한 알람 예약에 실패하여 대략적인 시각으로 예약합니다. (" + t + ")");
            }
        } else if (!warnedInexact) {
            warnedInexact = true;
            Log.add(c, "「알람 및 리마인더」 권한이 비활성 상태입니다. 대략적인 시각으로 예약되며 최대 수 분 지연될 수 있습니다. "
                    + "시스템 설정에서 허용하면 정확한 시각에 발송됩니다.");
        }

        try {
            am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
            return true;
        } catch (Throwable t) {
            Log.add(c, "발송 알람 예약에 실패했습니다. (" + t + ")");
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
                warnWake(c, "전원 관리자를 사용할 수 없음");
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
        Log.add(c, "WakeLock 획득에 실패했습니다(" + why + "). 화면이 꺼진 동안 작업이 중단될 수 있습니다.");
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
            Log.add(c, "설정을 읽지 못해 발송 예약에 실패했습니다. (" + t + ")");
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

    /**
     * 앱이 떠 있으면 <b>보고 있는 탭</b>을 갱신해준다 (UI 건드리는 거라 메인 스레드로 넘긴다).
     *
     * 홈만 갱신하면 안 된다 — 사진 전송 실패 경고는 매크로 탭 사진 카드에도 뜨는데,
     * 사용자가 그 탭을 보고 있는 동안 실패하면 다시 들어올 때까지 아무 변화가 없다.
     */
    private static void refreshUi() {
        try {
            new Handler(Looper.getMainLooper()).post(new Runnable() {
                @Override public void run() {
                    try {
                        Nav.reload();
                    } catch (Throwable t) {
                        android.util.Log.w("KakaoAuto", "화면 갱신 실패", t);
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
