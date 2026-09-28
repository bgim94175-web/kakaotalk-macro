package com.buseong.kakaoadmin;

import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.drawable.Drawable;

/**
 * 선 아이콘. 24×24 격자 위에 Path 로 직접 그린다 (벡터 리소스·라이브러리 없음).
 * 획 두께는 격자 기준 1.6 — 가늘고 단정한 선이 이 앱 톤이다.
 * 관리자앱(kakaoadmin)에 같은 파일이 패키지만 바꿔 들어가 있다. 글리프를 고치면 둘 다 고쳐라.
 */
public final class Icon extends Drawable {

    public static final int HOME = 1;
    public static final int SEND = 2;
    public static final int CLOCK = 3;
    public static final int BUBBLE = 4;
    public static final int ROOMS = 5;
    public static final int IMAGE = 6;
    public static final int GAUGE = 7;
    public static final int BOLT = 8;
    public static final int REPLY = 9;
    public static final int SHIELD = 10;
    public static final int DICE = 11;
    public static final int PERSON = 12;
    public static final int KEY = 13;
    public static final int LIST = 14;
    public static final int LOCK = 15;
    public static final int BELL = 16;
    public static final int BATTERY = 17;
    public static final int CHECK = 18;
    public static final int USERS = 19;
    public static final int SPARK = 20;
    public static final int GEAR = 21;
    public static final int RECEIPT = 22;
    public static final int EYE = 23;
    public static final int COIN = 24;
    public static final int SEARCH = 25;
    public static final int PLUS = 26;
    public static final int DOOR = 27;
    public static final int TERMINAL = 28;
    public static final int WARN = 29;
    public static final int TROPHY = 30;
    public static final int CHART = 31;
    public static final int ALARM = 32;
    public static final int BOT = 33;
    public static final int CHEVRON = 34;
    public static final int BACK = 35;

    private final int glyph;
    private final Paint stroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path p = new Path();
    private final RectF r = new RectF();
    private float s = 1f;   // 격자 1칸 = s px
    private float ox = 0f, oy = 0f;

    public Icon(int glyph, int color) {
        this.glyph = glyph;
        stroke.setStyle(Paint.Style.STROKE);
        stroke.setStrokeCap(Paint.Cap.ROUND);
        stroke.setStrokeJoin(Paint.Join.ROUND);
        stroke.setColor(color);
        fill.setStyle(Paint.Style.FILL);
        fill.setColor(color);
    }

    public void setColor(int color) {
        stroke.setColor(color);
        fill.setColor(color);
        invalidateSelf();
    }

    @Override public void draw(Canvas c) {
        Rect b = getBounds();
        float side = Math.min(b.width(), b.height());
        if (side <= 0) return;
        s = side / 24f;
        ox = b.left + (b.width() - side) / 2f;
        oy = b.top + (b.height() - side) / 2f;
        stroke.setStrokeWidth(Math.max(1f, 1.6f * s));
        try {
            paint(c);
        } catch (Throwable ignore) {
            // 아이콘 하나 못 그린 건 무해
        }
    }

    private float X(float v) { return ox + v * s; }
    private float Y(float v) { return oy + v * s; }

    private void line(Canvas c, float x1, float y1, float x2, float y2) {
        c.drawLine(X(x1), Y(y1), X(x2), Y(y2), stroke);
    }

    private void circ(Canvas c, float cx, float cy, float rad) {
        c.drawCircle(X(cx), Y(cy), rad * s, stroke);
    }

    private void dot(Canvas c, float cx, float cy, float rad) {
        c.drawCircle(X(cx), Y(cy), rad * s, fill);
    }

    private void rrect(Canvas c, float l, float t, float rr, float bb, float rad) {
        r.set(X(l), Y(t), X(rr), Y(bb));
        c.drawRoundRect(r, rad * s, rad * s, stroke);
    }

    private void arc(Canvas c, float cx, float cy, float rad, float start, float sweep) {
        r.set(X(cx - rad), Y(cy - rad), X(cx + rad), Y(cy + rad));
        c.drawArc(r, start, sweep, false, stroke);
    }

    /** 점 목록을 이은 선 (x1,y1,x2,y2,...) */
    private void poly(Canvas c, boolean close, float... xy) {
        p.rewind();
        p.moveTo(X(xy[0]), Y(xy[1]));
        for (int i = 2; i + 1 < xy.length; i += 2) p.lineTo(X(xy[i]), Y(xy[i + 1]));
        if (close) p.close();
        c.drawPath(p, stroke);
    }

    private void paint(Canvas c) {
        switch (glyph) {
            case HOME:
                poly(c, false, 3.5f, 11f, 12f, 4f, 20.5f, 11f);
                poly(c, false, 6f, 9.5f, 6f, 20f, 18f, 20f, 18f, 9.5f);
                poly(c, false, 10f, 20f, 10f, 14.5f, 14f, 14.5f, 14f, 20f);
                break;
            case SEND:
                poly(c, true, 20.5f, 3.5f, 3.5f, 10.5f, 10.5f, 13.5f, 13.5f, 20.5f);
                line(c, 10.5f, 13.5f, 20.5f, 3.5f);
                break;
            case CLOCK:
                circ(c, 12f, 12f, 8.5f);
                poly(c, false, 12f, 7.5f, 12f, 12f, 15f, 14f);
                break;
            case BUBBLE:
                p.rewind();
                r.set(X(3.5f), Y(4.5f), X(20.5f), Y(16.5f));
                p.addRoundRect(r, 3f * s, 3f * s, Path.Direction.CW);
                c.drawPath(p, stroke);
                poly(c, false, 8f, 16.5f, 7f, 20.5f, 12f, 16.5f);
                line(c, 7.5f, 9f, 16.5f, 9f);
                line(c, 7.5f, 12f, 13.5f, 12f);
                break;
            case ROOMS:
                rrect(c, 4f, 4f, 10.8f, 10.8f, 2f);
                rrect(c, 13.2f, 4f, 20f, 10.8f, 2f);
                rrect(c, 4f, 13.2f, 10.8f, 20f, 2f);
                rrect(c, 13.2f, 13.2f, 20f, 20f, 2f);
                break;
            case IMAGE:
                rrect(c, 3.5f, 5f, 20.5f, 19f, 2.5f);
                circ(c, 9f, 10f, 1.6f);
                poly(c, false, 4f, 17f, 9.5f, 12.5f, 13f, 15.5f, 16f, 13f, 20.5f, 16.5f);
                break;
            case GAUGE:
                arc(c, 12f, 13.5f, 8.5f, 150f, 240f);
                line(c, 12f, 13.5f, 15.8f, 9.2f);
                dot(c, 12f, 13.5f, 1.3f);
                break;
            case BOLT:
                poly(c, true, 13.5f, 3f, 5f, 13.5f, 11.5f, 13.5f, 10.5f, 21f, 19f, 10f, 12.5f, 10f);
                break;
            case REPLY:
                poly(c, false, 9.5f, 6.5f, 4.5f, 11.5f, 9.5f, 16.5f);
                p.rewind();
                p.moveTo(X(4.5f), Y(11.5f));
                p.lineTo(X(14f), Y(11.5f));
                p.cubicTo(X(17.5f), Y(11.5f), X(20f), Y(14f), X(20f), Y(18f));
                c.drawPath(p, stroke);
                break;
            case SHIELD:
                p.rewind();
                p.moveTo(X(12f), Y(3f));
                p.lineTo(X(19.5f), Y(6f));
                p.lineTo(X(19.5f), Y(11.5f));
                p.cubicTo(X(19.5f), Y(16f), X(16.3f), Y(19.5f), X(12f), Y(21f));
                p.cubicTo(X(7.7f), Y(19.5f), X(4.5f), Y(16f), X(4.5f), Y(11.5f));
                p.lineTo(X(4.5f), Y(6f));
                p.close();
                c.drawPath(p, stroke);
                poly(c, false, 8.7f, 12f, 11f, 14.3f, 15.5f, 9.6f);
                break;
            case DICE:
                rrect(c, 4f, 4f, 20f, 20f, 3.5f);
                dot(c, 8.6f, 8.6f, 1.25f);
                dot(c, 15.4f, 8.6f, 1.25f);
                dot(c, 12f, 12f, 1.25f);
                dot(c, 8.6f, 15.4f, 1.25f);
                dot(c, 15.4f, 15.4f, 1.25f);
                break;
            case PERSON:
                circ(c, 12f, 8.5f, 3.8f);
                p.rewind();
                p.moveTo(X(4.5f), Y(20f));
                p.cubicTo(X(5.5f), Y(16f), X(8.5f), Y(14f), X(12f), Y(14f));
                p.cubicTo(X(15.5f), Y(14f), X(18.5f), Y(16f), X(19.5f), Y(20f));
                c.drawPath(p, stroke);
                break;
            case KEY:
                circ(c, 8f, 15.5f, 4f);
                line(c, 10.9f, 12.6f, 20f, 3.5f);
                line(c, 16.5f, 7f, 19f, 9.5f);
                line(c, 14f, 9.5f, 16f, 11.5f);
                break;
            case LIST:
                line(c, 9f, 7f, 20f, 7f);
                line(c, 9f, 12f, 20f, 12f);
                line(c, 9f, 17f, 20f, 17f);
                dot(c, 5f, 7f, 1.2f);
                dot(c, 5f, 12f, 1.2f);
                dot(c, 5f, 17f, 1.2f);
                break;
            case LOCK:
                rrect(c, 5f, 10.5f, 19f, 20.5f, 2.5f);
                p.rewind();
                p.moveTo(X(8f), Y(10.5f));
                p.lineTo(X(8f), Y(8f));
                p.cubicTo(X(8f), Y(5.8f), X(9.8f), Y(4f), X(12f), Y(4f));
                p.cubicTo(X(14.2f), Y(4f), X(16f), Y(5.8f), X(16f), Y(8f));
                p.lineTo(X(16f), Y(10.5f));
                c.drawPath(p, stroke);
                line(c, 12f, 14.3f, 12f, 16.7f);
                break;
            case BELL:
                p.rewind();
                p.moveTo(X(6f), Y(16.5f));
                p.lineTo(X(6f), Y(11f));
                p.cubicTo(X(6f), Y(7.7f), X(8.7f), Y(5f), X(12f), Y(5f));
                p.cubicTo(X(15.3f), Y(5f), X(18f), Y(7.7f), X(18f), Y(11f));
                p.lineTo(X(18f), Y(16.5f));
                p.lineTo(X(19.5f), Y(18f));
                p.lineTo(X(4.5f), Y(18f));
                p.close();
                c.drawPath(p, stroke);
                line(c, 10f, 20.8f, 14f, 20.8f);
                line(c, 12f, 3f, 12f, 5f);
                break;
            case BATTERY:
                rrect(c, 3f, 8f, 18.5f, 16f, 2f);
                line(c, 21f, 10.8f, 21f, 13.2f);
                line(c, 6.5f, 12f, 11.5f, 12f);
                break;
            case CHECK:
                poly(c, false, 5f, 12.5f, 10f, 17.5f, 19.5f, 7f);
                break;
            case USERS:
                circ(c, 9f, 8.8f, 3.2f);
                p.rewind();
                p.moveTo(X(3.2f), Y(19f));
                p.cubicTo(X(4f), Y(15.8f), X(6.3f), Y(14.2f), X(9f), Y(14.2f));
                p.cubicTo(X(11.7f), Y(14.2f), X(14f), Y(15.8f), X(14.8f), Y(19f));
                c.drawPath(p, stroke);
                circ(c, 16.4f, 8f, 2.6f);
                p.rewind();
                p.moveTo(X(16.3f), Y(12.8f));
                p.cubicTo(X(18.5f), Y(12.8f), X(20.2f), Y(14.2f), X(20.9f), Y(17f));
                c.drawPath(p, stroke);
                break;
            case SPARK:
                p.rewind();
                p.moveTo(X(12f), Y(3f));
                p.cubicTo(X(12.8f), Y(8.5f), X(15.5f), Y(11.2f), X(21f), Y(12f));
                p.cubicTo(X(15.5f), Y(12.8f), X(12.8f), Y(15.5f), X(12f), Y(21f));
                p.cubicTo(X(11.2f), Y(15.5f), X(8.5f), Y(12.8f), X(3f), Y(12f));
                p.cubicTo(X(8.5f), Y(11.2f), X(11.2f), Y(8.5f), X(12f), Y(3f));
                p.close();
                c.drawPath(p, stroke);
                break;
            case GEAR:
                circ(c, 12f, 12f, 3f);
                circ(c, 12f, 12f, 6.6f);
                for (int i = 0; i < 8; i++) {
                    double a = Math.PI / 4.0 * i;
                    float cx = (float) Math.cos(a), sy = (float) Math.sin(a);
                    line(c, 12f + cx * 6.6f, 12f + sy * 6.6f, 12f + cx * 9f, 12f + sy * 9f);
                }
                break;
            case RECEIPT:
                poly(c, true, 6f, 3.5f, 18f, 3.5f, 18f, 20.5f, 15.6f, 19f, 13.8f, 20.5f, 12f, 19f,
                        10.2f, 20.5f, 8.4f, 19f, 6f, 20.5f);
                line(c, 9f, 8f, 15f, 8f);
                line(c, 9f, 11.5f, 15f, 11.5f);
                line(c, 9f, 15f, 12.5f, 15f);
                break;
            case EYE:
                p.rewind();
                p.moveTo(X(2.5f), Y(12f));
                p.cubicTo(X(5f), Y(7.5f), X(8.3f), Y(5.5f), X(12f), Y(5.5f));
                p.cubicTo(X(15.7f), Y(5.5f), X(19f), Y(7.5f), X(21.5f), Y(12f));
                p.cubicTo(X(19f), Y(16.5f), X(15.7f), Y(18.5f), X(12f), Y(18.5f));
                p.cubicTo(X(8.3f), Y(18.5f), X(5f), Y(16.5f), X(2.5f), Y(12f));
                p.close();
                c.drawPath(p, stroke);
                circ(c, 12f, 12f, 3f);
                break;
            case COIN:
                circ(c, 12f, 12f, 8.5f);
                poly(c, false, 8f, 8.5f, 9.7f, 15.5f, 12f, 10f, 14.3f, 15.5f, 16f, 8.5f);
                line(c, 7.5f, 12f, 16.5f, 12f);
                break;
            case SEARCH:
                circ(c, 10.5f, 10.5f, 6f);
                line(c, 15f, 15f, 20f, 20f);
                break;
            case PLUS:
                line(c, 12f, 5f, 12f, 19f);
                line(c, 5f, 12f, 19f, 12f);
                break;
            case DOOR:
                poly(c, false, 13f, 4f, 19f, 4f, 19f, 20f, 13f, 20f);
                line(c, 4f, 12f, 14f, 12f);
                poly(c, false, 10.5f, 8.5f, 14f, 12f, 10.5f, 15.5f);
                break;
            case TERMINAL:
                rrect(c, 3.5f, 5f, 20.5f, 19f, 2.5f);
                poly(c, false, 7.5f, 9.5f, 10.5f, 12f, 7.5f, 14.5f);
                line(c, 12.5f, 15f, 16.5f, 15f);
                break;
            case WARN:
                poly(c, true, 12f, 4f, 21f, 19.5f, 3f, 19.5f);
                line(c, 12f, 10f, 12f, 14f);
                dot(c, 12f, 16.8f, 1.1f);
                break;
            case TROPHY:
                p.rewind();
                p.moveTo(X(8f), Y(4.5f));
                p.lineTo(X(16f), Y(4.5f));
                p.lineTo(X(16f), Y(9.5f));
                p.cubicTo(X(16f), Y(11.7f), X(14.2f), Y(13.5f), X(12f), Y(13.5f));
                p.cubicTo(X(9.8f), Y(13.5f), X(8f), Y(11.7f), X(8f), Y(9.5f));
                p.close();
                c.drawPath(p, stroke);
                poly(c, false, 8f, 6.5f, 5f, 6.5f, 5f, 8f);
                arc(c, 7.5f, 8f, 2.5f, 90f, 90f);
                poly(c, false, 16f, 6.5f, 19f, 6.5f, 19f, 8f);
                arc(c, 16.5f, 8f, 2.5f, 0f, 90f);
                line(c, 12f, 13.5f, 12f, 17f);
                poly(c, false, 8.5f, 20f, 15.5f, 20f, 14.5f, 17f, 9.5f, 17f, 8.5f, 20f);
                break;
            case CHART:
                line(c, 4f, 20f, 20f, 20f);
                line(c, 7f, 16.5f, 7f, 12f);
                line(c, 12f, 16.5f, 12f, 6.5f);
                line(c, 17f, 16.5f, 17f, 10f);
                break;
            case ALARM:
                circ(c, 12f, 13f, 7.5f);
                poly(c, false, 12f, 9f, 12f, 13f, 14.5f, 14.5f);
                line(c, 4f, 6.5f, 7f, 4f);
                line(c, 20f, 6.5f, 17f, 4f);
                break;
            case BOT:
                rrect(c, 4.5f, 8f, 19.5f, 19f, 3.5f);
                line(c, 12f, 8f, 12f, 4.8f);
                dot(c, 12f, 4f, 1.2f);
                dot(c, 9.2f, 13f, 1.3f);
                dot(c, 14.8f, 13f, 1.3f);
                line(c, 10f, 16f, 14f, 16f);
                break;
            case CHEVRON:
                poly(c, false, 9.5f, 6f, 15.5f, 12f, 9.5f, 18f);
                break;
            case BACK:
                poly(c, false, 14.5f, 5.5f, 8f, 12f, 14.5f, 18.5f);
                break;
            default:
                circ(c, 12f, 12f, 7f);
                break;
        }
    }

    @Override public void setAlpha(int alpha) {
        stroke.setAlpha(alpha);
        fill.setAlpha(alpha);
        invalidateSelf();
    }

    @Override public void setColorFilter(ColorFilter cf) {
        stroke.setColorFilter(cf);
        fill.setColorFilter(cf);
        invalidateSelf();
    }

    @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
}
