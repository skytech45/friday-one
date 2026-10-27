package com.friday.one

import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.friday.one.data.CloudAgent
import com.friday.one.data.CloudProject
import com.friday.one.data.CloudServer
import com.friday.one.data.CloudSession
import com.friday.one.data.SupabaseAuth
import com.friday.one.feature.auth.AuthScreen
import com.friday.one.feature.cloud.ChatView
import com.friday.one.feature.home.DashboardView
import com.friday.one.feature.pairing.PairingConnectCard
import com.friday.one.feature.pairing.PairingInstructionsCard
import com.friday.one.feature.pairing.ServerPairingScreen
import com.friday.one.ui.theme.FridayOneTheme
import org.junit.Assert.assertEquals
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
    fun pairingInstructionsShowTokenAndCopyState() {
        compose.setContent {
            FridayOneTheme {
                PairingInstructionsCard(token = "enroll-token-123", copiedNotice = true, onTokenCopied = {})
            }
        }
        compose.onNodeWithText("Install Connector on Server").assertExists()
        compose.onNodeWithText("enroll-token-123").assertExists()
        compose.onNodeWithText("Token copied to clipboard!").assertExists()
    }

    @Test
    fun pairingConnectKeyModeWiresCallbacks() {
        var mode = 1
        var pairCalls = 0
        compose.setContent {
            FridayOneTheme {
                PairingConnectCard(
                    pairingModeTab = 1,
                    onModeChange = { mode = it },
                    claiming = false,
                    codeInput = "1234567890123456",
                    onCodeInputChange = {},
                    statusMessage = null,
                    errorMessage = "Claim failed: boom",
                    onScanQr = {},
                    onPairWithKey = { pairCalls++ },
                )
            }
        }
        compose.onNodeWithText("Pair With This Device").assertExists()
        compose.onNodeWithText("Claim failed: boom").assertExists()
        // "Pair with Key" is both the mode tab and the submit button.
        compose.onAllNodesWithText("Pair with Key")[1].performClick()
        compose.onNodeWithText("Scan Terminal QR").performClick()
        assertEquals("submit should call onPairWithKey once", 1, pairCalls)
        assertEquals("QR tab should request mode 0", 0, mode)
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
