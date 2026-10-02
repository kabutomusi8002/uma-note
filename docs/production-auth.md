# Supabase Auth production checklist

## Scope and current authentication design

`supabase/config.toml` is for local development with `supabase start`. It neither updates a hosted Supabase project nor proves that production Auth is hardened. Every production item below is **manual verification required** in the Supabase Dashboard before release. Record the reviewer, date, environment, and result outside this repository without secrets or user email addresses.

UMA NOTE currently uses only email OTP authentication:

- `signInWithOtp` sends the six-digit email OTP. The existing magic-link fallback uses the same API and `/auth/callback`.
- `verifyOtp({ type: "email" })` verifies a code.
- The callback exchanges a PKCE code with `exchangeCodeForSession`.
- The browser client deliberately keeps `persistSession: true`, `autoRefreshToken: true`, `flowType: "pkce"`, and `detectSessionInUrl: false`; callback processing is explicit.
- Normal logout calls Supabase `signOut` and does not erase device data. Device-data erasure remains a separate confirmed action.
- The app has no password, direct `signUp`, OAuth/social, phone/SMS, anonymous, passkey, Web3, SSO, or third-party Auth flow.

The current signup policy is public email-OTP signup: both OTP request paths set `shouldCreateUser: true`. Changing to invite-only/existing-users-only requires changing that option and the hosted signup setting together, plus updating tests and user-facing behavior.

## Local configuration intent

The tracked local configuration keeps email signup enabled for the existing OTP flow. It disables anonymous sign-in, manual identity linking, phone/SMS signup, passkeys, Apple OAuth, Solana Web3, third-party providers, and the OAuth server. Other social providers are not configured. Local email confirmation is disabled because successful OTP verification already demonstrates mailbox access; this is not evidence of the hosted setting.

Local OTP requests are separated by at least 60 seconds and expire after 600 seconds. CAPTCHA and SMTP are not enabled in the tracked file because they require environment-specific provider configuration and secrets.

Supabase exposes email OTP and email/password through the email provider; the repository cannot safely claim that the hosted password endpoint is disabled merely because the UI never calls it. Treat password disablement as a hosted-provider capability check. If the Dashboard cannot disable password while retaining email OTP, document that platform constraint and verify that no application path calls password APIs.

## Pre-production Auth checks

All entries are **manual verification required** for each hosted production project:

- [ ] **Unused authentication methods:** Disable every unused provider and path supported by the hosted project, including password (if independently controllable), phone/SMS, anonymous, social/OAuth, passkey, Web3, SSO, manual linking, third-party Auth, and OAuth server. Confirm email OTP remains enabled. Do not infer hosted state from `config.toml`.
- [ ] **Signup policy:** Confirm the intended public-signup policy matches `shouldCreateUser: true` and hosted “Allow new users to sign up”. If policy changes to closed signup, update both repository code/tests and Dashboard before release.
- [ ] **Email confirmation policy:** Confirm the email-OTP template contains the OTP token and that verification is required to establish a session. Decide and record the separate “Confirm Email” setting without breaking the tested OTP flow.
- [ ] **OTP expiry and rate limits:** Set and verify an acceptable OTP expiration, resend interval, email-send quota, sign-in/signup limit, and token-verification limit. Use 600 seconds and a 60-second resend interval as the repository baseline unless a reviewed production requirement says otherwise.
- [ ] **CAPTCHA / Turnstile:** Enable and test CAPTCHA (Turnstile or another supported provider) for exposed Auth requests. Store its secret only in the hosted secret setting; never commit it. Verify both successful login and rejected/expired challenges.
- [ ] **SMTP sending limits:** Configure production custom SMTP with a verified sender/domain; review Supabase and provider quotas, throttling, bounce handling, and abuse alerts. Ensure limits support expected OTP traffic without removing abuse protection. Never record credentials here.
- [ ] **Redirect URL allow-list:** Allow only exact HTTPS production callback URLs required by the app, including `/auth/callback`; remove preview, localhost, broad wildcard, stale, and attacker-controlled URLs from production.
- [ ] **Site URL:** Set the canonical HTTPS production origin exactly and confirm it agrees with `NEXT_PUBLIC_SITE_URL`. Do not use localhost or a preview origin.
- [ ] **Password controls (only if password authentication is enabled):** Enable secure password change / recent reauthentication, choose and verify a reviewed minimum password length and complexity requirements, and test password recovery. These controls are not application requirements while password auth remains unused/disabled.
- [ ] **End-to-end evidence:** In a non-user test account, verify OTP request, OTP verification, callback, persisted-session reload, normal logout, and the separate device-data-erasure action. Do not place the address, OTP, tokens, or secrets in logs or test fixtures.

Completion of this file or its repository tests does **not** establish that a production Supabase project satisfies the checklist. Release approval requires direct Dashboard inspection and environment-specific evidence.
