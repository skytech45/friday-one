package com.friday.one.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

// UI/UX Guide (§3 Suggested color tokens):
// Apple-inspired technical palette: near-black/navy surfaces, restrained blue-violet brand accent.
val FridayBrandBlue = Color(0xFF36A8FF)
val FridayBrandViolet = Color(0xFF7657FF)
val FridayStatusOk = Color(0xFF28D98B)
val FridayStatusWarn = Color(0xFFFFB547)
val FridayStatusCrit = Color(0xFFFF5D6C)

private val DarkBackground = Color(0xFF080B12)
private val DarkSurface = Color(0xFF101722)
private val DarkRaisedSurface = Color(0xFF151F2D)
private val DarkBorder = Color(0xFF263244)
private val DarkPrimaryText = Color(0xFFF4F7FB)
private val DarkSecondaryText = Color(0xFFA7B4C7)

private val LightBackground = Color(0xFFF5F7FB)
private val LightSurface = Color(0xFFFFFFFF)
private val LightRaisedSurface = Color(0xFFEDF1F7)
private val LightBorder = Color(0xFFDCE3ED)
private val LightPrimaryText = Color(0xFF121826)
private val LightSecondaryText = Color(0xFF536176)

private val DarkScheme = darkColorScheme(
    primary = FridayBrandBlue,
    onPrimary = Color(0xFF041E38),
    secondary = FridayBrandViolet,
    onSecondary = Color.White,
    tertiary = FridayStatusOk,
    background = DarkBackground,
    onBackground = DarkPrimaryText,
    surface = DarkSurface,
    onSurface = DarkPrimaryText,
    surfaceVariant = DarkRaisedSurface,
    onSurfaceVariant = DarkSecondaryText,
    error = FridayStatusCrit,
    outline = DarkBorder,
)

private val LightScheme = lightColorScheme(
    primary = Color(0xFF1D82D2),
    onPrimary = Color.White,
    secondary = Color(0xFF6444E0),
    onSecondary = Color.White,
    tertiary = Color(0xFF1EAB6C),
    background = LightBackground,
    onBackground = LightPrimaryText,
    surface = LightSurface,
    onSurface = LightPrimaryText,
    surfaceVariant = LightRaisedSurface,
    onSurfaceVariant = LightSecondaryText,
    error = Color(0xFFD32F2F),
    outline = LightBorder,
)

private val FridayTypography = Typography(
    headlineMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Bold,
        fontSize = 24.sp,
        letterSpacing = (-0.3).sp,
    ),
    headlineSmall = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 20.sp,
        letterSpacing = (-0.2).sp,
    ),
    titleLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.SemiBold,
        fontSize = 17.sp,
    ),
    titleMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 15.sp,
    ),
    bodyLarge = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 15.sp,
        lineHeight = 22.sp,
    ),
    bodyMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontSize = 14.sp,
        lineHeight = 20.sp,
    ),
    labelMedium = TextStyle(
        fontFamily = FontFamily.SansSerif,
        fontWeight = FontWeight.Medium,
        fontSize = 12.sp,
    ),
    labelSmall = TextStyle(
        fontFamily = FontFamily.Monospace,
        fontSize = 11.sp,
        letterSpacing = 0.5.sp,
    ),
)

// UI/UX Guide (§5 Spacing and shapes):
// Chips 10-12dp, buttons/inputs 14-16dp, cards 18-22dp
private val FridayShapes = Shapes(
    small = RoundedCornerShape(12.dp),
    medium = RoundedCornerShape(16.dp),
    large = RoundedCornerShape(20.dp),
    extraLarge = RoundedCornerShape(26.dp),
)

@Composable
fun FridayOneTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkScheme else LightScheme,
        typography = FridayTypography,
        shapes = FridayShapes,
        content = content,
    )
}
