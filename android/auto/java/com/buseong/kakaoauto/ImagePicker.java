package com.buseong.kakaoauto;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.OpenableColumns;

import java.io.Closeable;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 사진 고르기 (최대 5장) · URI 영속 권한 · 썸네일.
 *
 * 화면(Activity) 에서만 쓴다. 발송은 {@link ImageSender} 가 한다.
 *
 * 쓰는 법:
 * <pre>
 *   static final int REQ_PICK = 4101;
 *   // 버튼 눌렀을 때
 *   ImagePicker.pick(this, REQ_PICK);
 *   // onActivityResult 에서
 *   if (req == REQ_PICK &amp;&amp; res == RESULT_OK) {
 *       java.util.List&lt;String&gt; uris = ImagePicker.onResult(this, data, ImagePicker.MAX);
 *       if (!uris.isEmpty()) { st.macro.setImages(uris); Settings.save(this, st); }
 *   }
 * </pre>
 *
 * 왜 ACTION_OPEN_DOCUMENT 냐 — 여기서 받은 URI 만 takePersistableUriPermission 으로
 * 영속화할 수 있다. 앱을 껐다 켜도, 재부팅해도 그 사진을 계속 읽어서 보낼 수 있어야 하니까.
 */
public final class ImagePicker {
    private ImagePicker() {}

    /** 한 번에 붙일 수 있는 사진 최대 장수 (Settings.MAX_IMAGES 와 같은 값이어야 한다) */
    public static final int MAX = 5;

    /** 썸네일 기본 한 변 크기(px). Activity 에서 dp 로 계산해 넘기는 걸 권한다. */
    public static final int THUMB_PX = 168;

    // ── 1. 고르기 ────────────────────────────────────────────────────────────

    /**
     * 사진 선택창을 띄운다. 결과는 Activity 의 onActivityResult 로 온다.
     * 여러 장 선택 가능하고, 영속 권한을 같이 요청한다.
     */
    public static void pick(Activity a, int requestCode) {
        if (a == null) return;

        Intent i = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        i.setType("image/*");
        i.putExtra(Intent.EXTRA_MIME_TYPES, new String[] { "image/*" });
        i.addCategory(Intent.CATEGORY_OPENABLE);
        i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        try {
            a.startActivityForResult(i, requestCode);
            return;
        } catch (Throwable t) {
            Log.add(a, "사진 선택창(문서 선택)을 못 열었어 — " + t.getClass().getSimpleName()
                    + ". 다른 방식으로 다시 해볼게");
        }

        // 폴백: ACTION_GET_CONTENT. 이걸로 받은 URI 는 영속화가 안 되는 기기도 있어서
        // 나중에 사진이 안 읽히면 다시 고르라고 안내해야 한다.
        Intent g = new Intent(Intent.ACTION_GET_CONTENT);
        g.setType("image/*");
        g.addCategory(Intent.CATEGORY_OPENABLE);
        g.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        g.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            a.startActivityForResult(Intent.createChooser(g, "사진 고르기"), requestCode);
        } catch (Throwable t2) {
            Log.add(a, "사진 선택창을 아예 못 열었어 — " + t2.getClass().getSimpleName());
            Ui.toast(a, "사진 선택창을 못 열었어");
        }
    }

    // ── 2. 결과 받기 ──────────────────────────────────────────────────────────

    /**
     * onActivityResult 에서 받은 Intent 를 URI 문자열 목록으로 바꾼다.
     * max 장을 넘으면 앞에서 max 장만 쓰고 토스트로 알려준다. 중복은 걸러낸다.
     * 영속 권한 잡기는 실패해도 그냥 진행한다(로그만 남는다).
     *
     * @param max 0 이하면 {@link #MAX} 로 본다
     * @return 절대 null 아님. 고른 게 없으면 빈 목록.
     */
    public static List<String> onResult(Activity a, Intent data, int max) {
        ArrayList<String> out = new ArrayList<String>();
        if (data == null) return out;

        int cap = (max <= 0) ? MAX : max;
        boolean over = false;

        ClipData cd = null;
        try { cd = data.getClipData(); } catch (Throwable ignore) { }

        if (cd != null) {
            int n = 0;
            try { n = cd.getItemCount(); } catch (Throwable ignore) { }
            for (int i = 0; i < n; i++) {
                Uri u = null;
                try {
                    ClipData.Item it = cd.getItemAt(i);
                    if (it != null) u = it.getUri();
                } catch (Throwable ignore) { }
                if (u == null) continue;
                String s = u.toString();
                if (out.contains(s)) continue;
                if (out.size() >= cap) { over = true; continue; }
                persist(a, u);
                out.add(s);
            }
        } else {
            Uri u = null;
            try { u = data.getData(); } catch (Throwable ignore) { }
            if (u != null) {
                persist(a, u);
                out.add(u.toString());
            }
        }

        if (over) Ui.toast(a, "사진은 " + cap + "장까지야");

        if (out.isEmpty()) {
            Log.add(a, "사진을 고르긴 했는데 읽을 수 있는 게 없어");
        } else {
            Log.add(a, "사진 " + out.size() + "장 골랐어" + (over ? " (" + cap + "장 넘은 건 버렸어)" : ""));
        }
        return out;
    }

    /** 영속 읽기 권한을 잡아둔다. 실패해도 진행 — 로그만 남긴다. */
    private static void persist(Context c, Uri u) {
        if (c == null || u == null) return;
        try {
            c.getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Throwable t) {
            Log.add(c, "사진 권한 고정 실패 — " + shortUri(u.toString()) + " ("
                    + t.getClass().getSimpleName() + "). 앱을 껐다 켜면 다시 골라야 할 수 있어");
        }
    }

    /** 목록에서 뺄 때 잡아둔 권한도 놓아준다. 실패는 무시해도 되는 수준이라 로그만. */
    public static void release(Context c, String uri) {
        if (c == null || uri == null || uri.trim().length() == 0) return;
        try {
            c.getContentResolver().releasePersistableUriPermission(
                    Uri.parse(uri.trim()), Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Throwable t) {
            Log.add(c, "사진 권한 해제 실패 — " + shortUri(uri) + " (" + t.getClass().getSimpleName() + ")");
        }
    }

    // ── 3. 썸네일 ────────────────────────────────────────────────────────────

    /**
     * 목록에 보여줄 작은 비트맵. sizePx 는 한 변 목표 크기.
     * inJustDecodeBounds 로 크기만 먼저 읽고 inSampleSize 로 줄여서 로드한다(OOM 방지).
     *
     * @return 실패하면 null (사진이 지워졌거나 권한이 풀렸거나 포맷이 깨진 경우)
     */
    public static Bitmap thumb(Context c, String uri, int sizePx) {
        if (c == null || uri == null || uri.trim().length() == 0) return null;
        int want = (sizePx <= 0) ? THUMB_PX : sizePx;

        Uri u;
        try {
            u = Uri.parse(uri.trim());
        } catch (Throwable t) {
            return null;
        }

        ContentResolver cr = c.getContentResolver();
        if (cr == null) return null;

        InputStream in = null;
        try {
            BitmapFactory.Options probe = new BitmapFactory.Options();
            probe.inJustDecodeBounds = true;
            in = cr.openInputStream(u);
            if (in == null) return null;
            BitmapFactory.decodeStream(in, null, probe);
            close(in);
            in = null;

            if (probe.outWidth <= 0 || probe.outHeight <= 0) {
                Log.add(c, "사진 크기를 못 읽었어 — " + shortUri(uri));
                return null;
            }

            BitmapFactory.Options opt = new BitmapFactory.Options();
            opt.inSampleSize = sample(probe.outWidth, probe.outHeight, want);
            in = cr.openInputStream(u);
            if (in == null) return null;
            Bitmap bm = BitmapFactory.decodeStream(in, null, opt);
            if (bm == null) Log.add(c, "사진을 못 열었어 — " + shortUri(uri));
            return bm;
        } catch (Throwable t) {
            Log.add(c, "썸네일 실패 — " + shortUri(uri) + " (" + t.getClass().getSimpleName() + ")");
            return null;
        } finally {
            close(in);
        }
    }

    /** 원본 w·h 를 want 아래로 줄이는 2의 거듭제곱 배율 */
    private static int sample(int w, int h, int want) {
        int s = 1;
        if (h > want || w > want) {
            int halfH = h / 2;
            int halfW = w / 2;
            while ((halfH / s) >= want && (halfW / s) >= want) {
                s *= 2;
                if (s >= 64) break;
            }
        }
        return s;
    }

    // ── 4. 아직 살아있나 ──────────────────────────────────────────────────────

    /**
     * URI 가 지금도 읽히는지 확인한다. 사진 삭제·권한 만료·SD 분리 등을 잡는다.
     * 실제로 1바이트 읽어본다 — 열기만 성공하고 읽을 때 터지는 제공자가 있어서.
     */
    public static boolean alive(Context c, String uri) {
        if (c == null || uri == null || uri.trim().length() == 0) return false;
        InputStream in = null;
        try {
            Uri u = Uri.parse(uri.trim());
            ContentResolver cr = c.getContentResolver();
            if (cr == null) return false;
            in = cr.openInputStream(u);
            if (in == null) return false;
            in.read();      // -1(0바이트) 이어도 살아있는 건 맞다. 터지면 catch 로 간다.
            return true;
        } catch (Throwable t) {
            return false;
        } finally {
            close(in);
        }
    }

    /** 살아있는 것만 남긴 새 목록. 죽은 건 로그로 알려준다. */
    public static List<String> filterAlive(Context c, List<String> uris) {
        ArrayList<String> out = new ArrayList<String>();
        if (uris == null) return out;
        int dead = 0;
        for (int i = 0; i < uris.size(); i++) {
            String s = uris.get(i);
            if (s == null || s.trim().length() == 0) continue;
            if (alive(c, s)) out.add(s.trim());
            else dead++;
        }
        if (dead > 0) {
            Log.add(c, "첨부 사진 " + dead + "장이 안 읽혀 — 지워졌거나 권한이 풀렸어. 다시 골라줘");
        }
        return out;
    }

    // ── 5. 표시용 이름 ────────────────────────────────────────────────────────

    /** 목록에 곁들일 파일명. 못 읽으면 URI 꼬리표라도 돌려준다. 절대 null 아님. */
    public static String displayName(Context c, String uri) {
        if (uri == null || uri.trim().length() == 0) return "사진";
        String u = uri.trim();
        if (c == null) return shortUri(u);
        Cursor cur = null;
        try {
            cur = c.getContentResolver().query(Uri.parse(u),
                    new String[] { OpenableColumns.DISPLAY_NAME }, null, null, null);
            if (cur != null && cur.moveToFirst()) {
                String n = cur.getString(0);
                if (n != null && n.trim().length() > 0) return n.trim();
            }
        } catch (Throwable ignore) {
            // 이름은 없어도 되는 정보라 로그까지 남기지 않는다
        } finally {
            if (cur != null) { try { cur.close(); } catch (Throwable ignore) { } }
        }
        return shortUri(u);
    }

    // ── 유틸 ────────────────────────────────────────────────────────────────

    /** 로그에 URI 전체를 박으면 한 줄이 넘치니까 뒤쪽만 보여준다 */
    static String shortUri(String uri) {
        if (uri == null) return "";
        String s = uri;
        int q = s.indexOf('?');
        if (q > 0) s = s.substring(0, q);
        int slash = s.lastIndexOf('/');
        if (slash >= 0 && slash < s.length() - 1) s = s.substring(slash + 1);
        if (s.length() > 40) s = s.substring(s.length() - 40);
        return s;
    }

    private static void close(Closeable c) {
        if (c == null) return;
        try { c.close(); } catch (Throwable ignore) { }
    }
}
