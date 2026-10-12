package com.buseong.kakaoauto;

import android.app.Activity;
import android.content.ClipData;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.os.Build;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;

import java.io.Closeable;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;

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
            Log.add(a, "이미지 선택창(문서 선택)을 열지 못했습니다 (" + t.getClass().getSimpleName()
                    + "). 다른 방식으로 재시도합니다.");
        }

        // 폴백: ACTION_GET_CONTENT. 이걸로 받은 URI 는 영속화가 안 되는 기기도 있어서
        // 나중에 사진이 안 읽히면 다시 고르라고 안내해야 한다.
        Intent g = new Intent(Intent.ACTION_GET_CONTENT);
        g.setType("image/*");
        g.addCategory(Intent.CATEGORY_OPENABLE);
        g.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        g.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            a.startActivityForResult(Intent.createChooser(g, "이미지 선택"), requestCode);
        } catch (Throwable t2) {
            Log.add(a, "이미지 선택창을 열지 못했습니다 — 대체 방식도 실패 (" + t2.getClass().getSimpleName() + ").");
            Ui.toast(a, "이미지 선택창을 열지 못했습니다.");
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

        if (over) Ui.toast(a, "이미지는 최대 " + cap + "장까지 첨부됩니다.");

        if (out.isEmpty()) {
            Log.add(a, "선택한 이미지 중 읽을 수 있는 항목이 없습니다.");
        } else {
            Log.add(a, "이미지 " + out.size() + "장을 선택했습니다." + (over ? " (" + cap + "장 초과분은 제외)" : ""));
        }
        return out;
    }

    /** 영속 읽기 권한을 잡아둔다. 실패해도 진행 — 로그만 남긴다. */
    private static void persist(Context c, Uri u) {
        if (c == null || u == null) return;
        try {
            c.getContentResolver().takePersistableUriPermission(u, Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Throwable t) {
            Log.add(c, "이미지 접근 권한 고정 실패 — " + shortUri(u.toString()) + " ("
                    + t.getClass().getSimpleName() + "). 앱 재시작 후 이미지를 다시 선택해야 할 수 있습니다.");
        }
    }

    /** 목록에서 뺄 때 잡아둔 권한도 놓아준다. 실패는 무시해도 되는 수준이라 로그만. */
    public static void release(Context c, String uri) {
        if (c == null || uri == null || uri.trim().length() == 0) return;
        try {
            c.getContentResolver().releasePersistableUriPermission(
                    Uri.parse(uri.trim()), Intent.FLAG_GRANT_READ_URI_PERMISSION);
        } catch (Throwable t) {
            Log.add(c, "이미지 접근 권한 해제 실패 — " + shortUri(uri) + " (" + t.getClass().getSimpleName() + ")");
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
                Log.add(c, "이미지 크기를 읽지 못했습니다 — " + shortUri(uri));
                return null;
            }

            BitmapFactory.Options opt = new BitmapFactory.Options();
            opt.inSampleSize = sample(probe.outWidth, probe.outHeight, want);
            in = cr.openInputStream(u);
            if (in == null) return null;
            Bitmap bm = BitmapFactory.decodeStream(in, null, opt);
            if (bm == null) Log.add(c, "이미지를 열지 못했습니다 — " + shortUri(uri));
            return bm;
        } catch (Throwable t) {
            Log.add(c, "썸네일 생성 실패 — " + shortUri(uri) + " (" + t.getClass().getSimpleName() + ")");
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
            Log.add(c, "첨부 이미지 " + dead + "장을 읽을 수 없습니다. 파일이 삭제되었거나 접근 권한이 해제되었습니다. 이미지를 다시 선택하십시오.");
        }
        return out;
    }

    // ── 5. 표시용 이름 ────────────────────────────────────────────────────────

    /** 목록에 곁들일 파일명. 못 읽으면 URI 꼬리표라도 돌려준다. 절대 null 아님. */
    public static String displayName(Context c, String uri) {
        if (uri == null || uri.trim().length() == 0) return "이미지";
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

    // ── 6. 카카오톡 앨범 썸네일 지목용 문자열 ──────────────────────────────────
    //
    //  근거: docs/field/kakao-attach-sheet-26.8.2.md 3장 (실기기 뷰 트리)
    //    [Button] desc="사진, 9월 28일 오전 8:20"
    //  채팅방 첨부 시트의 최근 사진 스트립(rv_media)에서 각 썸네일은 clickable Button 이고,
    //  contentDescription 이 위 형식이다. 우리가 가진 URI 의 촬영/저장 시각을 같은 형식으로
    //  만들면 접근성이 "그 사진" 을 정확히 지목할 수 있다 (순서·좌표 추측이 필요 없어진다).

    /** 썸네일 contentDescription 접두사 (실기기 관측값) */
    private static final String DESC_HEAD = "사진, ";

    /** 후보 목록 상한. 시각 출처가 여러 개라 곱하면 늘어나므로 잘라둔다. */
    private static final int DESC_MAX = 9;

    /** 이보다 오래된 시각은 잘못 읽은 값으로 본다 (2000-01-01) */
    private static final long T_MIN = 946684800000L;

    /**
     * 이 사진이 카카오톡 첨부 시트에서 달고 있을 contentDescription.
     * 예: {@code "사진, 9월 28일 오전 8:20"}
     *
     * 시각 출처 우선순위는 {@code DATE_TAKEN} → EXIF 촬영시각 → {@code DATE_ADDED} → 파일 수정시각이다.
     * (EXIF 가 DATE_TAKEN 의 원본이라 그 다음에 둔다. 문서 URI 는 MediaStore 조회가 막혀 있어도
     *  EXIF 는 읽히는 경우가 있다.)
     *
     * @return 시각을 하나도 못 읽으면 <b>null</b>. null 이면 이 사진은 첨부 시트 경로로 지목할 수 없다 —
     *         호출부는 그 사실을 로그·진단에 남기고 다른 경로를 쓰거나 이 사진을 제외해야 한다.
     */
    public static String kakaoDesc(Context c, String uri) {
        long t = shotAt(c, uri);
        return (t <= 0L) ? null : desc(t);
    }

    /**
     * 같은 사진의 <b>후보 문자열 목록</b> (정확 일치용). 접근성 쪽은 정확 일치만 하므로
     * 후보를 여러 개 넘겨 순서대로 찾게 하는 방식이다.
     *
     * 후보가 여러 개인 이유 두 가지 —
     *   <ol>
     *     <li>카카오톡이 표시하는 시각이 우리가 읽은 값과 <b>1분</b> 차이날 수 있다(초 단위 절삭 지점이 다르다).
     *         그래서 ±1분을 같이 만든다.</li>
     *     <li>카카오톡이 어느 시각(촬영/저장/수정)을 쓰는지 확정되지 않았다. 읽을 수 있는 출처를
     *         전부 후보로 넣는다. 화면에 없는 문자열은 아무것도 고르지 않으니 후보가 늘어도 위험하지 않다.</li>
     *   </ol>
     *
     * 첫 후보가 가장 유력한 값이다. 목록이 비어 있으면 이 사진은 첨부 시트 경로로 보낼 수 없다.
     *
     * @return 절대 null 아님
     */
    public static List<String> kakaoDescList(Context c, String uri) {
        ArrayList<String> out = new ArrayList<String>(DESC_MAX);
        long[] src = times(c, uri);
        for (int i = 0; i < src.length && out.size() < DESC_MAX; i++) {
            long t = src[i];
            if (t <= 0L) continue;
            add(out, desc(t));
            add(out, desc(t - 60000L));
            add(out, desc(t + 60000L));
        }
        return out;
    }

    /**
     * 이 사진의 대표 시각(ms). 읽을 수 없으면 0.
     * {@link #kakaoDesc} 가 쓰는 값이고, 진단에 "왜 못 지목하는지" 를 적을 때도 쓴다.
     */
    public static long shotAt(Context c, String uri) {
        long[] t = times(c, uri);
        return (t.length == 0) ? 0L : t[0];
    }

    /**
     * 읽을 수 있는 시각을 <b>유력한 순서대로</b> 모은다 (중복 제거, 못 읽은 출처는 제외).
     * 길이 0 이면 이 사진의 시각을 전혀 모른다는 뜻이다.
     */
    private static long[] times(Context c, String uri) {
        if (c == null || uri == null || uri.trim().length() == 0) return new long[0];
        Uri u;
        try { u = Uri.parse(uri.trim()); } catch (Throwable t) { return new long[0]; }

        long[] buf = new long[4];
        int n = 0;

        // 1) DATE_TAKEN — URI 자체에 물어보고, 문서 URI 면 MediaStore 항목으로 바꿔 한 번 더.
        Uri media = mediaUri(c, u);
        n = put(buf, n, col(c, u, MediaStore.Images.Media.DATE_TAKEN, false));
        if (media != null) n = put(buf, n, col(c, media, MediaStore.Images.Media.DATE_TAKEN, false));

        // 2) EXIF 촬영시각 — MediaStore 조회가 막힌 문서 URI 에서도 읽히는 경우가 있다.
        n = put(buf, n, exifAt(c, u));

        // 3) DATE_ADDED (초 단위) — 저장 시각.
        n = put(buf, n, col(c, u, MediaStore.Images.Media.DATE_ADDED, true));
        if (media != null) n = put(buf, n, col(c, media, MediaStore.Images.Media.DATE_ADDED, true));

        // 4) 파일 수정시각 — 문서 제공자는 ms, MediaStore 는 초 단위다.
        n = put(buf, n, col(c, u, DocumentsContract.Document.COLUMN_LAST_MODIFIED, false));
        n = put(buf, n, col(c, u, MediaStore.Images.Media.DATE_MODIFIED, true));
        if (media != null) n = put(buf, n, col(c, media, MediaStore.Images.Media.DATE_MODIFIED, true));

        long[] out = new long[n];
        System.arraycopy(buf, 0, out, 0, n);
        return out;
    }

    /** buf 에 중복 없이 담는다 (버퍼가 꽉 차면 버린다). 돌려주는 값은 새 길이. */
    private static int put(long[] buf, int n, long ms) {
        long v = sane(ms);
        if (v <= 0L) return n;
        for (int i = 0; i < n; i++) {
            // 분 단위로 같으면 같은 시각으로 본다 (같은 문자열이 나온다)
            if (buf[i] / 60000L == v / 60000L) return n;
        }
        if (n >= buf.length) return n;
        buf[n] = v;
        return n + 1;
    }

    /** 말이 되는 시각인가. 초 단위 값을 ms 로 잘못 읽은 경우(1970년대)와 미래 시각을 걸러낸다. */
    private static long sane(long ms) {
        if (ms <= 0L) return 0L;
        if (ms < T_MIN) return 0L;
        if (ms > System.currentTimeMillis() + 86400000L) return 0L;
        return ms;
    }

    /**
     * 시각 하나를 카카오톡 표기로 만든다.
     *
     * <b>SimpleDateFormat 의 {@code a} 패턴을 쓰지 않는다.</b> 오전/오후 글자와 12시간제 표기는
     * 기기 로케일·제조사 번역에 따라 "AM"/"오전"/"오전 "처럼 흔들리는데, 여기서는 카카오톡이
     * 화면에 쓴 문자열과 <b>한 글자도 다르면 안 된다</b>. 그래서 전부 직접 조립한다.
     * (달·일·시는 0 을 채우지 않고, 분만 두 자리다 — 실기기 관측값 {@code "9월 28일 오전 8:20"} 기준)
     */
    private static String desc(long ms) {
        Calendar cal = Calendar.getInstance(Locale.KOREA);
        cal.setTimeInMillis(ms);
        int h = cal.get(Calendar.HOUR);          // 0~11
        if (h == 0) h = 12;                      // 0시·12시는 12 로 표기한다
        int min = cal.get(Calendar.MINUTE);
        StringBuilder b = new StringBuilder(28);
        b.append(DESC_HEAD)
         .append(cal.get(Calendar.MONTH) + 1).append("월 ")
         .append(cal.get(Calendar.DAY_OF_MONTH)).append("일 ")
         .append(cal.get(Calendar.AM_PM) == Calendar.AM ? "오전" : "오후").append(' ')
         .append(h).append(':');
        if (min < 10) b.append('0');
        b.append(min);
        return b.toString();
    }

    private static void add(ArrayList<String> out, String v) {
        if (v == null || out.size() >= DESC_MAX || out.contains(v)) return;
        out.add(v);
    }

    /** 열 하나만 물어본다. 제공자가 그 열을 모르면 예외가 나므로 열마다 따로 묻는다. */
    private static long col(Context c, Uri u, String name, boolean seconds) {
        Cursor cur = null;
        try {
            cur = c.getContentResolver().query(u, new String[] { name }, null, null, null);
            if (cur == null || !cur.moveToFirst()) return 0L;
            int i = cur.getColumnIndex(name);
            if (i < 0 || cur.isNull(i)) return 0L;
            long v = cur.getLong(i);
            if (v <= 0L) return 0L;
            return seconds ? (v * 1000L) : v;
        } catch (Throwable t) {
            return 0L;   // 그 열이 없는 제공자다. 다음 출처로 넘어간다.
        } finally {
            close(cur);
        }
    }

    /**
     * 문서 URI({@code ACTION_OPEN_DOCUMENT} 결과)를 MediaStore 항목 URI 로 바꿔본다.
     * 문서 제공자는 {@code DATE_TAKEN} 을 모르지만 MediaStore 는 알고 있다.
     *
     * @return 못 바꾸면 null (권한이 없어 조회가 실패할 수도 있는데, 그건 호출부의 try 가 먹는다)
     */
    private static Uri mediaUri(Context c, Uri u) {
        boolean doc = false;
        try { doc = DocumentsContract.isDocumentUri(c, u); } catch (Throwable ignore) { }
        if (!doc) return null;

        if (Build.VERSION.SDK_INT >= 29) {
            try {
                Uri m = MediaStore.getMediaUri(c, u);
                if (m != null) return m;
            } catch (Throwable ignore) { }
        }
        // 폴백: 문서 id 가 "image:1234" 형태면 이미지 항목을 직접 만든다.
        try {
            String id = DocumentsContract.getDocumentId(u);
            int i = (id == null) ? -1 : id.indexOf(':');
            if (i > 0 && "image".equals(id.substring(0, i))) {
                long n = Long.parseLong(id.substring(i + 1).trim());
                if (n > 0) {
                    return ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, n);
                }
            }
        } catch (Throwable ignore) { }
        return null;
    }

    /**
     * EXIF 촬영시각. MediaStore 의 {@code DATE_TAKEN} 이 여기서 나온 값이라 사실상 같은 시각이다.
     * EXIF 시각에는 시간대가 없어서 기기 기본 시간대로 읽는다 — 카카오톡도 같은 기준으로 표시한다.
     */
    private static long exifAt(Context c, Uri u) {
        InputStream in = null;
        try {
            in = c.getContentResolver().openInputStream(u);
            if (in == null) return 0L;
            android.media.ExifInterface ex = new android.media.ExifInterface(in);
            String s = ex.getAttribute(android.media.ExifInterface.TAG_DATETIME_ORIGINAL);
            if (s == null || s.trim().length() == 0) {
                s = ex.getAttribute(android.media.ExifInterface.TAG_DATETIME);
            }
            if (s == null || s.trim().length() == 0) return 0L;
            SimpleDateFormat f = new SimpleDateFormat("yyyy:MM:dd HH:mm:ss", Locale.US);
            f.setLenient(false);
            Date d = f.parse(s.trim());
            return (d == null) ? 0L : d.getTime();
        } catch (Throwable t) {
            return 0L;
        } finally {
            close(in);
        }
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
