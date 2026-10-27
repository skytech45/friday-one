package com.friday.one.core.designsystem.components

import androidx.compose.foundation.layout.*
import androidx.compose.material.icons.outlined.*
import androidx.compose.material3.*
import androidx.compose.runtime.*
import com.friday.one.core.designsystem.Dash
import com.friday.one.data.*
import com.friday.one.ui.theme.*

@Composable
internal fun cloudFieldColors() = OutlinedTextFieldDefaults.colors(
    focusedTextColor = Dash.Text,
    unfocusedTextColor = Dash.Text,
    focusedBorderColor = FridayBrandBlue,
    unfocusedBorderColor = Dash.CardEdge,
    cursorColor = FridayBrandBlue,
    focusedLabelColor = FridayBrandBlue,
    unfocusedLabelColor = Dash.Dim,
    focusedContainerColor = Dash.Card,
    unfocusedContainerColor = Dash.Card,
)
