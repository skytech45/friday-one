package com.friday.one.ui.components

import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * Dashboard primitives.
 *
 * Rules followed throughout:
 *
 * - Every animated value starts at 0 and animates from there, so a repaint from a
 *   telemetry poll interpolates instead of jumping. `animateFloatAsState` with a
 *   tween does this by itself; a raw value would snap on every poll.
 * - `null` is not 0. Sensors that don't exist (no thermal zones on this host, no
 *   cpufreq) render a dash, never a fake zero, so the UI never claims a fact it
 *   does not have.
 * - Colour is derived from magnitude, but always interpolated - a red ring that
 *   snaps to green reads as a glitch.
 */

object Dash {
    val Bg = Color(0xFF080B12)
    val Card = Color(0xFF101722)
    val CardEdge = Color(0xFF263244)
    val Text = Color(0xFFF4F7FB)
    val Dim = Color(0xFFA7B4C7)
    val Accent = Color(0xFF36A8FF)
    val Violet = Color(0xFF7657FF)
    val Ok = Color(0xFF28D98B)
    val Warn = Color(0xFFFFB547)
    val Bad = Color(0xFFFF5D6C)
    val Blue = Color(0xFF36A8FF)

    /** Green -> amber -> red as load rises. Interpolated, never stepped. */
    fun heat(pct: Float): Color = when {
        pct < 60f -> blend(Ok, Warn, (pct / 60f).coerceIn(0f, 1f) * 0.35f)
        pct < 85f -> blend(Ok, Warn, 1f - ((85f - pct) / 25f) * 0.65f)
        else -> blend(Warn, Bad, ((pct - 85f) / 15f).coerceIn(0f, 1f))
    }

    private fun blend(a: Color, b: Color, t: Float): Color {
        val u = t.coerceIn(0f, 1f)
        return Color(
            red = a.red + (b.red - a.red) * u,
            green = a.green + (b.green - a.green) * u,
            blue = a.blue + (b.blue - a.blue) * u,
            alpha = 1f,
        )
    }
}

fun fmtBytes(b: Long): String {
    if (b < 1024) return "$b B"
    val units = listOf("KB", "MB", "GB", "TB")
    var v = b.toDouble() / 1024
    var i = 0
    while (v >= 1024 && i < units.size - 1) {
        v /= 1024
        i++
    }
    return if (v >= 100) "%.0f %s".format(v, units[i]) else "%.1f %s".format(v, units[i])
}

fun fmtBps(b: Double?): String = if (b == null) "--" else fmtBytes(b.toLong()) + "/s"

fun fmtUptime(s: Long): String {
    val d = s / 86400
    val h = (s % 86400) / 3600
    val m = (s % 3600) / 60
    return when {
        d > 0 -> "${d}d ${h}h"
        h > 0 -> "${h}h ${m}m"
        else -> "${m}m"
    }
}

@Composable
fun SectionLabel(text: String, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier.fillMaxWidth().padding(start = 4.dp, top = 6.dp, bottom = 6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            Modifier
                .size(width = 3.dp, height = 12.dp)
                .clip(RoundedCornerShape(2.dp))
                .background(Dash.Accent)
        )
        Spacer(Modifier.width(8.dp))
        Text(
            text.uppercase(),
            color = Dash.Dim,
            fontSize = 11.sp,
            fontWeight = FontWeight.SemiBold,
            letterSpacing = 1.2.sp,
        )
    }
}

/**
 * Lagging indicator: a bar drawn from the ANIMATED value, so every telemetry
 * update slides rather than snaps. Primitive-looking but this is what makes the
 * whole screen feel alive instead of flickering once a second.
 */
@Composable
fun LoadBar(
    pct: Float,
    modifier: Modifier = Modifier,
    height: Int = 6,
    colorOverride: Color? = null,
) {
    val target = pct.coerceIn(0f, 100f)
    // 700ms settle: fast enough to track a 1s poll, slow enough to read as motion.
    val animated by animateFloatAsState(
        targetValue = target,
        animationSpec = tween(700, easing = FastOutSlowInEasing),
        label = "loadbar",
    )
    val barColor by animateColorAsState(
        targetValue = colorOverride ?: Dash.heat(animated),
        animationSpec = tween(700),
        label = "loadbar-color",
    )
    Box(
        modifier
            .fillMaxWidth()
            .height(height.dp)
            .clip(RoundedCornerShape(height.dp / 2))
            .background(Dash.CardEdge)
    ) {
        Box(
            Modifier
                .fillMaxWidth(fraction = (animated / 100f).coerceIn(0f, 1f))
                .height(height.dp)
                .clip(RoundedCornerShape(height.dp / 2))
                .background(
                    Brush.horizontalGradient(
                        listOf(barColor.copy(alpha = 0.55f), barColor)
                    )
                )
        )
    }
}

/**
 * Ring gauge with the classic trick: one continuous sweep if >= 50% of a turn,
 * two arcs joined by short empties otherwise. A single Path with moveTo/close
 * across the gap draws a chord straight through the middle, which is the usual
 * giveaway of a handmade gauge.
 */
@Composable
fun RingGauge(
    pct: Float,
    label: String,
    value: String,
    sub: String? = null,
    sizeDp: Int = 92,
    thickness: Float = 9f,
    colorOverride: Color? = null,
) {
    val target = pct.coerceIn(0f, 100f)
    val animated by animateFloatAsState(
        targetValue = target,
        animationSpec = tween(900, easing = FastOutSlowInEasing),
        label = "ring",
    )
    val arcColor by animateColorAsState(
        targetValue = colorOverride ?: Dash.heat(animated),
        animationSpec = tween(900),
        label = "ring-color",
    )
    Box(
        Modifier.size(sizeDp.dp),
        contentAlignment = Alignment.Center,
    ) {
        Canvas(Modifier.size(sizeDp.dp)) {
            val stroke = thickness * density
            val d = size.minDimension - stroke
            val topLeft = Offset((size.width - d) / 2f, (size.height - d) / 2f)
            val arcSize = Size(d, d)

            drawArc(
                color = Dash.CardEdge,
                startAngle = 0f,
                sweepAngle = 360f,
                useCenter = false,
                topLeft = topLeft,
                size = arcSize,
                style = Stroke(width = stroke, cap = StrokeCap.Round),
            )

            val sweep = animated / 100f * 360f
            val gap = 3f
            if (sweep <= gap * 2) {
                if (sweep > 0.5f) {
                    drawArc(
                        color = arcColor,
                        startAngle = -90f,
                        sweepAngle = sweep,
                        useCenter = false,
                        topLeft = topLeft,
                        size = arcSize,
                        style = Stroke(width = stroke, cap = StrokeCap.Round),
                    )
                }
            } else if (sweep > 180f) {
                drawArc(
                    color = arcColor,
                    startAngle = -90f,
                    sweepAngle = sweep,
                    useCenter = false,
                    topLeft = topLeft,
                    size = arcSize,
                    style = Stroke(width = stroke, cap = StrokeCap.Round),
                )
            } else {
                drawArc(
                    color = arcColor,
                    startAngle = -90f,
                    sweepAngle = sweep - gap,
                    useCenter = false,
                    topLeft = topLeft,
                    size = arcSize,
                    style = Stroke(width = stroke, cap = StrokeCap.Round),
                )
                drawArc(
                    color = arcColor,
                    startAngle = -90f + sweep - gap,
                    sweepAngle = gap,
                    useCenter = false,
                    topLeft = topLeft,
                    size = arcSize,
                    style = Stroke(width = stroke, cap = StrokeCap.Round),
                )
            }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Text(
                value,
                color = Dash.Text,
                fontSize = (sizeDp / 4.4f).sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
            )
            Text(label.uppercase(), color = Dash.Dim, fontSize = 9.sp, letterSpacing = 0.8.sp)
            if (sub != null) {
                Text(sub, color = Dash.Dim, fontSize = 9.sp)
            }
        }
    }
}

/** Live sparkline. Keeps its own history so the caller stays a plain list of numbers. */
@Composable
fun Sparkline(
    values: List<Float>,
    modifier: Modifier = Modifier,
    color: Color = Dash.Accent,
    maxValue: Float? = null,
    fill: Boolean = true,
) {
    val anim by animateFloatAsState(
        targetValue = values.lastOrNull() ?: 0f,
        animationSpec = tween(600, easing = FastOutSlowInEasing),
        label = "spark",
    )
    val shown = remember(values, anim) { values.dropLast(1) + anim }

    Canvas(modifier) {
        if (shown.size < 2) return@Canvas
        val hi = maxValue ?: (shown.maxOrNull() ?: 1f).coerceAtLeast(1f)
        val stepX = size.width / (shown.size - 1)
        val pts = shown.mapIndexed { i, v ->
            Offset(
                x = i * stepX,
                y = size.height - (v.coerceIn(0f, hi) / hi) * (size.height - 4f) - 2f,
            )
        }

        if (fill) {
            val p = Path().apply {
                moveTo(pts.first().x, size.height)
                pts.forEach { lineTo(it.x, it.y) }
                lineTo(pts.last().x, size.height)
                close()
            }
            drawPath(
                p,
                Brush.verticalGradient(
                    listOf(color.copy(alpha = 0.35f), Color.Transparent)
                ),
            )
        }

        val line = Path().apply {
            moveTo(pts.first().x, pts.first().y)
            pts.drop(1).forEach { lineTo(it.x, it.y) }
        }
        drawPath(line, color, style = Stroke(width = 2f * density, cap = StrokeCap.Round))
        // Head dot: gives the eye a fixed reference point as the trace slides.
        drawCircle(color, radius = 2.6f * density, center = pts.last())
    }
}

/**
 * "Live" pulse - a soft breathing dot. Deliberately slow (1.6s) so it reads as
 * heartbeat, not as a loading spinner.
 */
@Composable
fun LiveDot(color: Color = Dash.Accent, sizeDp: Int = 8) {
    val t = rememberInfiniteTransition(label = "live")
    val scale by t.animateFloat(
        initialValue = 0.65f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            tween(1600, easing = FastOutSlowInEasing),
            RepeatMode.Reverse,
        ),
        label = "pulse",
    )
    val alpha by t.animateFloat(
        initialValue = 0.35f,
        targetValue = 1f,
        animationSpec = infiniteRepeatable(
            tween(1600, easing = LinearEasing),
            RepeatMode.Reverse,
        ),
        label = "pulse-alpha",
    )
    Box(Modifier.size(sizeDp.dp), contentAlignment = Alignment.Center) {
        Canvas(Modifier.size(sizeDp.dp)) {
            drawCircle(color.copy(alpha = alpha * 0.35f), radius = size.minDimension / 2f * scale)
            drawCircle(color.copy(alpha = alpha), radius = size.minDimension / 5f)
        }
    }
}

/** Small labelled metric row used inside cards. */
@Composable
fun MetricRow(
    label: String,
    value: String,
    accent: Color = Dash.Text,
    trailing: @Composable (() -> Unit)? = null,
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.SpaceBetween,
    ) {
        Text(label, color = Dash.Dim, fontSize = 12.sp)
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                value,
                color = accent,
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium,
                fontFamily = FontFamily.Monospace,
            )
            if (trailing != null) {
                Spacer(Modifier.width(6.dp))
                trailing()
            }
        }
    }
}

/** Thin animated divider that grows in - used between dashboard sections. */
@Composable
fun GrowDivider(modifier: Modifier = Modifier) {
    val w by animateFloatAsState(
        targetValue = 1f,
        animationSpec = tween(700, easing = FastOutSlowInEasing),
        label = "divider",
    )
    Box(
        modifier
            .fillMaxWidth(w)
            .height(1.dp)
            .background(
                Brush.horizontalGradient(
                    listOf(Dash.CardEdge, Color.Transparent)
                )
            )
    )
}
