# Google OAuth — owner setup steps (5 minutes)

The Android app is ALREADY wired for Google sign-in (PKCE via Custom Tab,
deep link `fridayone://auth-callback`). It activates the moment the provider
exists in Supabase. Nothing in the app needs to change.

## 1. Google Cloud Console (~3 min)

1. https://console.cloud.google.com → create (or pick) a project.
2. **APIs & Services → OAuth consent screen** → External → fill app name
   (`FRIDAY One`) and your email → save. (Personal use: add yourself as a
   test user; no verification needed for test mode.)
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**:
   - Application type: **Web application**
   - Authorized redirect URI:
     `https://tbysxnyuipjwutqxtxvy.supabase.co/auth/v1/callback`
4. Copy the **Client ID** and **Client Secret**.

## 2. Supabase dashboard (~2 min)

1. https://supabase.com/dashboard → project `tbysxnyuipjwutqxtxvy`
2. **Authentication → Providers → Google** → enable, paste the Client ID +
   Secret from step 1 → save.
3. **Authentication → URL Configuration**:
   - Add Site URL: `fridayone://auth-callback`
   - Add Redirect URL: `fridayone://auth-callback`

## 3. Recommended while you're there

- **Authentication → Providers → Email**: if you want instant login after
  registration (no confirmation email), turn OFF "Confirm email". The app
  handles BOTH cases — with confirmation ON, the register page shows
  "check your email" instead of signing straight in. Note: the built-in
  email sender is rate-limited (2/hour) — for real confirmation mail you'd
  configure SMTP.

## 4. Verify

Open the app → "Continue with Google" → Google account picker → back to the
app, signed in. If you see a Supabase error page, step 2 was skipped.

## Why the app needs no changes

The app starts the standard Supabase `/auth/v1/authorize?provider=google`
flow with an S256 PKCE challenge; Supabase returns to
`fridayone://auth-callback?code=...`; the app exchanges the code with its
verifier at `/auth/v1/token?grant_type=pkce`. Google passwords never touch
the app; the publishable key in the APK is public by design.
