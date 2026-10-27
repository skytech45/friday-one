package com.friday.one

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.test.core.app.ApplicationProvider
import com.friday.one.data.CloudAgent
import com.friday.one.data.CloudProject
import com.friday.one.data.CloudServer
import com.friday.one.data.CloudSession
import com.friday.one.data.SupabaseAuth
import com.friday.one.feature.cloud.AuthScreen
import com.friday.one.feature.cloud.ChatView
import com.friday.one.feature.cloud.DashboardView
import com.friday.one.feature.cloud.ServerPairingScreen
import com.friday.one.ui.theme.FridayOneTheme
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Smoke test for every top-level screen (alignment plan, Phase 0/1).
 *
 * Renders each screen with fixed inputs and checks its key labels. It guards
 * the CloudScreen.kt split: the moves must not change what is rendered.
 * No backend is contacted except the chat's gateway socket, which points at
 * a closed local port and simply fails.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class ScreensSmokeTest {
    @get:Rule
    val compose = createComposeRule()

    private val session = CloudSession(
        accessToken = "test-access-token",
        refreshToken = "test-refresh-token",
        userId = "user-1",
        email = "owner@friday-one.test",
    )

    private val server = CloudServer(
        id = "s1",
        name = "prod-vps",
        enrollmentState = "active",
        online = true,
        agents = listOf(CloudAgent(id = "a1", adapter = "hermes", version = "0.22.5", health = "healthy")),
        projects = listOf(CloudProject(id = "p1", root = "/srv/app", label = "app")),
    )

    @Test
    fun authScreenShowsSignInOptions() {
        val auth = SupabaseAuth(ApplicationProvider.getApplicationContext())
        compose.setContent {
            FridayOneTheme { AuthScreen(auth = auth, onSignedIn = {}, googleError = null) }
        }
        compose.onNodeWithText("Continue with Google").assertIsDisplayed()
        compose.onAllNodesWithText("Sign In").onFirst().assertExists()
        compose.onNodeWithText("Email address").assertExists()
    }

    @Test
    fun dashboardListsServers() {
        compose.setContent {
            FridayOneTheme {
                DashboardView(
                    session = session,
                    servers = listOf(server),
                    loadError = null,
                    onAddServer = {},
                    onOpenChat = {},
                    onOpenSecurity = {},
                    onReload = {},
                    onSignedOut = {},
                )
            }
        }
        compose.onNodeWithText("Your Servers").assertExists()
        compose.onNodeWithText("prod-vps").assertExists()
        compose.onNodeWithText("Add Server").assertExists()
    }

    @Test
    fun dashboardShowsEmptyState() {
        compose.setContent {
            FridayOneTheme {
                DashboardView(
                    session = session,
                    servers = emptyList(),
                    loadError = null,
                    onAddServer = {},
                    onOpenChat = {},
                    onOpenSecurity = {},
                    onReload = {},
                    onSignedOut = {},
                )
            }
        }
        compose.onNodeWithText("No Servers Enrolled").assertExists()
        compose.onNodeWithText("Pair Server Now").assertExists()
    }

    @Test
    fun pairingScreenStartsAtNameStep() {
        compose.setContent {
            FridayOneTheme {
                ServerPairingScreen(
                    accessToken = session.accessToken,
                    existingCount = 1,
                    onPairingComplete = {},
                    onCancel = {},
                )
            }
        }
        compose.onNodeWithText("Pair Cloud Server").assertExists()
        compose.onNodeWithText("Generate Pairing Session").assertExists()
        compose.onNodeWithText("vps-2").assertExists()
    }

    @Test
    fun chatShowsServerAndPromptInput() {
        compose.setContent {
            FridayOneTheme {
                ChatView(
                    session = session,
                    server = server,
                    gatewayUrl = "ws://127.0.0.1:9",
                    onBack = {},
                )
            }
        }
        compose.onAllNodesWithText("prod-vps").onFirst().assertExists()
        compose.onNodeWithText("Prompt AI agent on prod-vps", substring = true, useUnmergedTree = true)
            .assertExists()
    }
}
