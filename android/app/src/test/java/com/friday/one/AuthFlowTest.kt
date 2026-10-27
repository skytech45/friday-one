package com.friday.one

import android.content.Context
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.createComposeRule
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.core.app.ApplicationProvider
import com.friday.one.app.FridayApp
import com.friday.one.data.CloudSession
import com.friday.one.data.SupabaseAuth
import com.friday.one.data.auth.AuthRepository
import com.friday.one.data.auth.AuthResult
import com.friday.one.data.auth.FirebaseAuthRepository
import com.friday.one.feature.auth.GoogleSignInScreen
import com.friday.one.ui.theme.FridayOneTheme
import kotlinx.coroutines.runBlocking
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config

/**
 * Firebase sign-in (migration Phase 2/12): screen states, the root's handling
 * of sign-in outcomes, and safe behaviour when a build has no Firebase config.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [34])
class AuthFlowTest {
    @get:Rule
    val compose = createComposeRule()

    /** Hand-written fake: scripted sign-in result, no network. */
    private class FakeAuth(private val result: AuthResult, override val isConfigured: Boolean = true) : AuthRepository {
        var signInCalls = 0
        override suspend fun current(): CloudSession? = null
        override suspend fun signInWithGoogle(activityContext: Context): AuthResult {
            signInCalls++
            return result
        }
        override suspend fun signOut() = Unit
    }

    @Test
    fun `sign-in button calls back when configured`() {
        var clicks = 0
        compose.setContent {
            FridayOneTheme { GoogleSignInScreen(configured = true, busy = false, error = null, onSignIn = { clicks++ }) }
        }
        compose.onNodeWithText("Continue with Google").assertIsEnabled().performClick()
        assertEquals(1, clicks)
        compose.onNodeWithText("Your Google password is never seen or stored by FRIDAY One.").assertExists()
    }

    @Test
    fun `unconfigured build disables sign-in and says why`() {
        compose.setContent {
            FridayOneTheme { GoogleSignInScreen(configured = false, busy = false, error = null, onSignIn = {}) }
        }
        compose.onNodeWithText("Continue with Google").assertIsNotEnabled()
        compose.onNodeWithText("Sign-in is not configured for this build (missing Firebase config).").assertExists()
    }

    @Test
    fun `failed sign-in shows its message and stays on the sign-in screen`() {
        val fake = FakeAuth(AuthResult.Failed("Sign-in was rejected (ERROR_USER_DISABLED)."))
        compose.setContent {
            FridayOneTheme { FridayApp(SupabaseAuth(ApplicationProvider.getApplicationContext()), fake) }
        }
        compose.onNodeWithText("Continue with Google").performClick()
        compose.waitForIdle()
        assertEquals(1, fake.signInCalls)
        compose.onNodeWithText("Sign-in was rejected (ERROR_USER_DISABLED).").assertExists()
        compose.onNodeWithText("Continue with Google").assertIsEnabled()
    }

    @Test
    fun `cancelled sign-in is not an error`() {
        val fake = FakeAuth(AuthResult.Cancelled)
        compose.setContent {
            FridayOneTheme { FridayApp(SupabaseAuth(ApplicationProvider.getApplicationContext()), fake) }
        }
        compose.onNodeWithText("Continue with Google").performClick()
        compose.waitForIdle()
        assertEquals(1, fake.signInCalls)
        assertEquals(0, compose.onAllNodesWithTextCount("Sign-in failed"))
        compose.onNodeWithText("Continue with Google").assertIsEnabled()
    }

    @Test
    fun `repository without Firebase config fails closed instead of crashing`() = runBlocking {
        val repo = FirebaseAuthRepository(ApplicationProvider.getApplicationContext())
        assertFalse(repo.isConfigured)
        assertNull(repo.current())
        val result = repo.signInWithGoogle(ApplicationProvider.getApplicationContext())
        assertTrue(result is AuthResult.Failed)
        repo.signOut() // must not throw
    }

    private fun androidx.compose.ui.test.junit4.ComposeContentTestRule.onAllNodesWithTextCount(text: String): Int =
        onAllNodes(androidx.compose.ui.test.hasText(text, substring = true)).fetchSemanticsNodes().size
}
