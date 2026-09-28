package com.buseong.kakaoauto.engine;

import android.content.ContentResolver;
import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * 보낼 사진을 엔진이 읽을 파일로 만든다: 긴 변 2048px 이하, EXIF 회전 반영, JPEG 85.
 * HEIC 등 카카오가 받지 않는 형식도 여기서 JPEG 로 바뀐다. 결과는 앱 캐시 안에만 두고 전송 뒤 지운다.
 */
final class ImagePrep {
    private ImagePrep() {}

    private static final int MAX_EDGE = 2048;
    private static final int QUALITY = 85;

    static List<File> prepare(Context c, List<String> uris) throws EngineException {
        File dir = new File(c.getCacheDir(), "engine-out/" + System.currentTimeMillis());
        if (!dir.mkdirs() && !dir.isDirectory()) throw new EngineException("bad_request", "임시 폴더를 만들 수 없습니다.");
        ArrayList<File> out = new ArrayList<File>();
        try {
            for (int i = 0; i < uris.size() && out.size() < 5; i++) {
                File f = new File(dir, "photo-" + (i + 1) + ".jpg");
                encode(c.getContentResolver(), Uri.parse(uris.get(i)), f);
                out.add(f);
            }
        } catch (EngineException e) {
            cleanup(out);
            throw e;
        }
        return out;
    }

    static void cleanup(List<File> files) {
        if (files == null) return;
        File dir = null;
        for (int i = 0; i < files.size(); i++) {
            File f = files.get(i);
            dir = f.getParentFile();
            try { f.delete(); } catch (Throwable ignore) { }
        }
        if (dir != null) {
            try { dir.delete(); } catch (Throwable ignore) { }
        }
    }

    private static void encode(ContentResolver cr, Uri uri, File dst) throws EngineException {
        BitmapFactory.Options bounds = new BitmapFactory.Options();
        bounds.inJustDecodeBounds = true;
        decode(cr, uri, bounds);
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) {
            throw new EngineException("bad_request", "이미지를 읽을 수 없습니다. 다시 선택하십시오.");
        }
        int sample = 1;
        while (Math.max(bounds.outWidth, bounds.outHeight) / (sample * 2) >= MAX_EDGE) sample *= 2;

        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inSampleSize = sample;
        o.inPreferredConfig = Bitmap.Config.ARGB_8888;
        Bitmap bm = decode(cr, uri, o);
        if (bm == null) throw new EngineException("bad_request", "이미지를 디코딩하지 못했습니다.");

        try {
            int rot = rotation(cr, uri);
            float scale = Math.min(1f, (float) MAX_EDGE / Math.max(bm.getWidth(), bm.getHeight()));
            if (rot != 0 || scale < 1f) {
                Matrix m = new Matrix();
                if (scale < 1f) m.postScale(scale, scale);
                if (rot != 0) m.postRotate(rot);
                Bitmap t = Bitmap.createBitmap(bm, 0, 0, bm.getWidth(), bm.getHeight(), m, true);
                if (t != bm) {
                    bm.recycle();
                    bm = t;
                }
            }
            if (bm.hasAlpha()) {
                Bitmap flat = Bitmap.createBitmap(bm.getWidth(), bm.getHeight(), Bitmap.Config.ARGB_8888);
                flat.eraseColor(0xFFFFFFFF);
                new android.graphics.Canvas(flat).drawBitmap(bm, 0, 0, null);
                bm.recycle();
                bm = flat;
            }
            FileOutputStream os = null;
            try {
                os = new FileOutputStream(dst);
                if (!bm.compress(Bitmap.CompressFormat.JPEG, QUALITY, os)) {
                    throw new EngineException("bad_request", "JPEG 변환에 실패했습니다.");
                }
            } catch (EngineException ee) {
                throw ee;
            } catch (Throwable t) {
                throw new EngineException("bad_request", "이미지를 저장하지 못했습니다. (" + t.getClass().getSimpleName() + ")");
            } finally {
                try { if (os != null) os.close(); } catch (Throwable ignore) { }
            }
        } finally {
            bm.recycle();
        }
    }

    private static Bitmap decode(ContentResolver cr, Uri uri, BitmapFactory.Options o) throws EngineException {
        InputStream in = null;
        try {
            in = cr.openInputStream(uri);
            if (in == null) throw new EngineException("bad_request", "이미지 접근 권한이 없습니다. 다시 선택하십시오.");
            return BitmapFactory.decodeStream(in, null, o);
        } catch (EngineException ee) {
            throw ee;
        } catch (OutOfMemoryError oom) {
            throw new EngineException("bad_request", "이미지가 너무 큽니다.");
        } catch (Throwable t) {
            throw new EngineException("bad_request", "이미지를 열 수 없습니다. (" + t.getClass().getSimpleName() + ")");
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignore) { }
        }
    }

    private static int rotation(ContentResolver cr, Uri uri) {
        InputStream in = null;
        try {
            in = cr.openInputStream(uri);
            if (in == null) return 0;
            int o = new ExifInterface(in).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL);
            switch (o) {
                case ExifInterface.ORIENTATION_ROTATE_90: return 90;
                case ExifInterface.ORIENTATION_ROTATE_180: return 180;
                case ExifInterface.ORIENTATION_ROTATE_270: return 270;
                default: return 0;
            }
        } catch (Throwable t) {
            return 0;
        } finally {
            try { if (in != null) in.close(); } catch (Throwable ignore) { }
        }
    }
}
