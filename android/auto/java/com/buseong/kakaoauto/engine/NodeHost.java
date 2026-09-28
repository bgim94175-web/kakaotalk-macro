package com.buseong.kakaoauto.engine;

import android.content.Context;
import android.content.pm.PackageInfo;

import com.buseong.kakaoauto.Prefs;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * 엔진 프로세스 하나를 소유한다: 스크립트 풀기 → 실행 → 줄 단위 JSON RPC.
 *
 * 실행 파일은 lib/&lt;abi&gt;/libkmnode.so 로 APK 에 들어가 설치 때 nativeLibraryDir 로 풀린다
 * (안드로이드 10+ 에서 앱이 exec 할 수 있는 유일한 앱 소유 경로다 → 매니페스트 extractNativeLibs="true").
 * 통신은 표준입출력 파이프만 쓴다. 포트를 열지 않으니 같은 폰의 다른 앱이 엔진에 붙을 수 없다.
 */
final class NodeHost {

    interface Events {
        void onEvent(String name, JSONObject data);
        void onExit(int generation);
    }

    private static final String TAG = "KakaoEngine";
    private static final String ASSET = "engine/main.js";
    private static final String K_STAMP = "eng_stamp";
    private static final long READY_TIMEOUT_MS = 25000L;
    private static final int STDERR_KEEP = 40;
    /** 연달아 죽으면 잠시 쉰다 (고장 난 런타임을 무한 재시작하지 않게) */
    private static final int CRASH_LIMIT = 3;
    private static final long CRASH_WINDOW_MS = 5 * 60 * 1000L;
    private static final long CRASH_COOLDOWN_MS = 10 * 60 * 1000L;

    private final Context app;
    private final Events events;

    private Process proc;
    private Writer stdin;
    private int generation = 0;
    private long nextId = 1;
    private final Map<Long, Slot> pending = new HashMap<Long, Slot>();
    private final ArrayDeque<String> stderr = new ArrayDeque<String>();
    private final ArrayDeque<Long> crashes = new ArrayDeque<Long>();
    private volatile JSONObject readyInfo;
    private CountDownLatch readyLatch;
    private volatile long lastCallAt = 0L;

    private static final class Slot {
        final CountDownLatch done = new CountDownLatch(1);
        JSONObject resp;
    }

    NodeHost(Context app, Events events) {
        this.app = app;
        this.events = events;
    }

    static File executable(Context c) {
        return new File(c.getApplicationInfo().nativeLibraryDir, "libkmnode.so");
    }

    static boolean packaged(Context c) {
        try {
            return executable(c).isFile();
        } catch (Throwable t) {
            return false;
        }
    }

    synchronized boolean alive() {
        return proc != null;
    }

    synchronized int generation() {
        return generation;
    }

    long lastCallAt() {
        return lastCallAt;
    }

    JSONObject readyInfo() {
        return readyInfo;
    }

    synchronized String stderrTail() {
        StringBuilder sb = new StringBuilder();
        for (String s : stderr) sb.append(s).append('\n');
        return sb.toString();
    }

    /** 떠 있지 않으면 띄우고 ready 이벤트까지 기다린다. 돌아온 값은 이번 프로세스의 세대 번호. */
    int ensureStarted() throws EngineException {
        CountDownLatch wait;
        int gen;
        synchronized (this) {
            if (proc != null && readyInfo != null) return generation;
            if (proc == null) start();
            wait = readyLatch;
            gen = generation;
        }
        try {
            if (!wait.await(READY_TIMEOUT_MS, TimeUnit.MILLISECONDS)) {
                String tail = stderrTail();
                stop();
                throw new EngineException("engine_start_failed", "준비 응답 없음" + brief(tail));
            }
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            throw new EngineException("engine_start_failed", "중단됨");
        }
        synchronized (this) {
            if (proc == null || generation != gen || readyInfo == null) {
                throw new EngineException("engine_start_failed", "시작 직후 종료됨" + brief(stderrTail()));
            }
            return gen;
        }
    }

    private void start() throws EngineException {
        long now = System.currentTimeMillis();
        while (!crashes.isEmpty() && now - crashes.peekFirst() > CRASH_WINDOW_MS) crashes.pollFirst();
        if (crashes.size() >= CRASH_LIMIT && now - crashes.peekLast() < CRASH_COOLDOWN_MS) {
            throw new EngineException("engine_start_failed", "엔진이 반복 종료되어 잠시 재시작을 멈췄습니다" + brief(stderrTail()));
        }
        File exe = executable(app);
        if (!exe.isFile()) throw new EngineException("not_packaged", exe.getName() + " 없음");

        File root = new File(app.getFilesDir(), "engine");
        File script = extractScript(root);
        File home = new File(root, "home");
        File state = new File(root, "state");
        File tmp = new File(app.getCacheDir(), "engine-tmp");
        home.mkdirs();
        state.mkdirs();
        tmp.mkdirs();

        String libDir = app.getApplicationInfo().nativeLibraryDir;
        ProcessBuilder pb = new ProcessBuilder(exe.getAbsolutePath(),
                "--max-old-space-size=160", "--dns-result-order=ipv4first", script.getAbsolutePath());
        pb.directory(root);
        Map<String, String> env = pb.environment();
        env.put("LD_LIBRARY_PATH", libDir);
        env.put("HOME", home.getAbsolutePath());
        env.put("TMPDIR", tmp.getAbsolutePath());
        env.put("AGENT_MESSENGER_CONFIG_DIR", state.getAbsolutePath());
        env.put("NODE_ENV", "production");

        final Process p;
        try {
            p = pb.start();
        } catch (Throwable t) {
            throw new EngineException("engine_start_failed", String.valueOf(t));
        }
        generation++;
        final int gen = generation;
        proc = p;
        readyInfo = null;
        readyLatch = new CountDownLatch(1);
        stdin = new OutputStreamWriter(p.getOutputStream(), StandardCharsets.UTF_8);

        Thread out = new Thread(new Runnable() {
            @Override public void run() { readStdout(p, gen); }
        }, "engine-stdout");
        out.setDaemon(true);
        out.start();
        Thread err = new Thread(new Runnable() {
            @Override public void run() { readStderr(p); }
        }, "engine-stderr");
        err.setDaemon(true);
        err.start();
    }

    /** 앱이 설치·업데이트될 때만 스크립트를 다시 푼다 */
    private File extractScript(File root) throws EngineException {
        File dst = new File(root, "main.js");
        String stamp = stamp();
        if (dst.isFile() && stamp.equals(Prefs.getStr(app, K_STAMP, ""))) return dst;
        root.mkdirs();
        File part = new File(root, "main.js.part");
        InputStream in = null;
        OutputStream os = null;
        try {
            in = app.getAssets().open(ASSET);
            os = new FileOutputStream(part);
            byte[] buf = new byte[64 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) os.write(buf, 0, n);
            os.close();
            os = null;
            if (!part.renameTo(dst)) throw new EngineException("engine_start_failed", "스크립트 교체 실패");
        } catch (EngineException ee) {
            throw ee;
        } catch (Throwable t) {
            throw new EngineException("not_packaged", "엔진 스크립트 없음 (" + t.getClass().getSimpleName() + ")");
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignore) { }
            try { if (os != null) os.close(); } catch (Throwable ignore) { }
        }
        Prefs.putStr(app, K_STAMP, stamp);
        return dst;
    }

    private String stamp() {
        try {
            PackageInfo pi = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            return pi.lastUpdateTime + ":" + pi.versionCode;
        } catch (Throwable t) {
            return String.valueOf(System.currentTimeMillis());
        }
    }

    JSONObject call(String method, JSONObject params, long timeoutMs) throws EngineException {
        ensureStarted();
        lastCallAt = System.currentTimeMillis();
        Slot slot = new Slot();
        long id;
        synchronized (this) {
            if (proc == null) throw new EngineException("engine_died", "엔진이 종료됨");
            id = nextId++;
            pending.put(id, slot);
            try {
                JSONObject req = new JSONObject();
                req.put("id", id);
                req.put("m", method);
                req.put("p", params == null ? new JSONObject() : params);
                stdin.write(req.toString());
                stdin.write('\n');
                stdin.flush();
            } catch (Throwable t) {
                pending.remove(id);
                throw new EngineException("engine_died", "요청 전달 실패 (" + t.getClass().getSimpleName() + ")");
            }
        }
        boolean got;
        try {
            got = slot.done.await(timeoutMs, TimeUnit.MILLISECONDS);
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            got = false;
        }
        synchronized (this) {
            pending.remove(id);
        }
        lastCallAt = System.currentTimeMillis();
        if (!got) throw new EngineException("timeout", method + " " + (timeoutMs / 1000) + "초 초과", true);
        JSONObject resp = slot.resp;
        if (resp == null) throw new EngineException("engine_died", "엔진이 응답 전에 종료됨", true);
        if (resp.optBoolean("ok")) {
            JSONObject r = resp.optJSONObject("r");
            return r == null ? new JSONObject() : r;
        }
        JSONObject e = resp.optJSONObject("e");
        if (e == null) throw new EngineException("upstream_error", "알 수 없는 오류", true);
        throw new EngineException(e.optString("code", "upstream_error"), e.optString("message", ""),
                e.optBoolean("retryable", false));
    }

    void stop() {
        Process p;
        synchronized (this) {
            p = proc;
            proc = null;
            readyInfo = null;
            try { if (stdin != null) stdin.close(); } catch (Throwable ignore) { }
            stdin = null;
        }
        if (p != null) {
            try { p.destroy(); } catch (Throwable ignore) { }
        }
    }

    private void readStdout(Process p, int gen) {
        try {
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getInputStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = r.readLine()) != null) {
                if (line.length() == 0) continue;
                JSONObject o;
                try {
                    o = new JSONObject(line);
                } catch (Throwable t) {
                    continue;
                }
                if (o.has("id") && !o.isNull("id")) {
                    Slot s;
                    synchronized (this) {
                        s = pending.get(o.optLong("id"));
                    }
                    if (s != null) {
                        s.resp = o;
                        s.done.countDown();
                    }
                    continue;
                }
                String ev = o.optString("ev", "");
                JSONObject d = o.optJSONObject("d");
                if ("ready".equals(ev)) {
                    synchronized (this) {
                        if (generation == gen) {
                            readyInfo = (d == null) ? new JSONObject() : d;
                            readyLatch.countDown();
                        }
                    }
                    continue;
                }
                try {
                    events.onEvent(ev, d == null ? new JSONObject() : d);
                } catch (Throwable t) {
                    android.util.Log.w(TAG, "event handler failed: " + ev, t);
                }
            }
        } catch (Throwable t) {
            android.util.Log.w(TAG, "stdout reader ended", t);
        }
        int code = -1;
        try { code = p.waitFor(); } catch (Throwable ignore) { }
        boolean current;
        synchronized (this) {
            current = (proc == p);
            if (current) {
                proc = null;
                readyInfo = null;
                crashes.addLast(System.currentTimeMillis());
            }
            Iterator<Slot> it = pending.values().iterator();
            while (it.hasNext()) it.next().done.countDown();
            if (readyLatch != null && generation == gen) readyLatch.countDown();
        }
        android.util.Log.w(TAG, "engine exited code=" + code);
        if (current) {
            try { events.onExit(gen); } catch (Throwable ignore) { }
        }
    }

    private void readStderr(Process p) {
        try {
            BufferedReader r = new BufferedReader(new InputStreamReader(p.getErrorStream(), StandardCharsets.UTF_8));
            String line;
            while ((line = r.readLine()) != null) {
                android.util.Log.i(TAG, line);
                synchronized (this) {
                    stderr.addLast(line.length() > 300 ? line.substring(0, 300) : line);
                    while (stderr.size() > STDERR_KEEP) stderr.pollFirst();
                }
            }
        } catch (Throwable ignore) {
            // 프로세스 종료
        }
    }

    private static String brief(String tail) {
        if (tail == null) return "";
        String t = tail.trim();
        if (t.length() == 0) return "";
        int nl = t.lastIndexOf('\n');
        String last = (nl >= 0) ? t.substring(nl + 1) : t;
        if (last.length() > 160) last = last.substring(0, 160) + "…";
        return " — " + last;
    }
}
