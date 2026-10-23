package com.friday.one.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp

// Palette carried over from the v1 console so the app feels the same in both
// light and dark: near-black surface, cyan accent, restrained status colours.
private val Accent = Color(0xFF22D3EE)
private val Bg = Color(0xFF08090B)
private val Surface = Color(0xFF111316)
private val Ink = Color(0xFFE8EAED)
private val Ink2 = Color(0xFFA8ADB5)
private val Ok = Color(0xFF34D399)
private val Warn = Color(0xFFFBBF24)
private val Crit = Color(0xFFF87171)

private val DarkScheme = darkColorScheme(
    primary = Accent,
    onPrimary = Color(0xFF00222A),
    secondary = Ok,
    background = Bg,
    onBackground = Ink,
    surface = Surface,
    onSurface = Ink,
    surfaceVariant = Color(0xFF181B20),
    onSurfaceVariant = Ink2,
    error = Crit,
    outline = Color(0xFF2A2F36),
)

private val LightScheme = lightColorScheme(
    primary = Color(0xFF0E7490),
    onPrimary = Color.White,
    secondary = Color(0xFF047857),
    background = Color(0xFFF7F8FA),
    onBackground = Color(0xFF111316),
    surface = Color.White,
    onSurface = Color(0xFF111316),
    surfaceVariant = Color(0xFFEDEFF3),
    onSurfaceVariant = Color(0xFF4B5563),
    error = Color(0xFFB91C1C),
    outline = Color(0xFFD3D8DF),
)

val FridayStatusOk = Ok
val FridayStatusWarn = Warn
val FridayStatusCrit = Crit

private val FridayTypography = Typography(
    headlineSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 22.sp,
        letterSpacing = (-0.2).sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 15.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 11.sp,
        letterSpacing = 0.6.sp,
    ),
)

@Composable
fun FridayOneTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkScheme else LightScheme,
        typography = FridayTypography,
        content = content,
    )
}
