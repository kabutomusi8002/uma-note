import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session, User } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getUser: vi.fn(),
  signInWithOtp: vi.fn(),
  signOut: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: () => ({ auth: authMocks }),
  isSupabaseConfigured: () => true,
}));

import {
  EMAIL_OTP_EXPIRED_ERROR,
  EMAIL_OTP_INVALID_ERROR,
  EMAIL_OTP_RATE_LIMIT_ERROR,
  readCloudAuthState,
  requestEmailOtp,
  sendEmailMagicLink,
  signOutFromCloud,
  verifyEmailOtp,
} from "@/lib/supabase/auth";

const root = fileURLToPath(new URL("..", import.meta.url));
const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
const testEmail = ["otp", "example.invalid"].join("@");
const validOtp = "1".repeat(6);
const expiredOtp = "2".repeat(6);
const user = {
  id: "otp-test-user",
  email: testEmail,
} as unknown as User;
const session = {
  user,
} as unknown as Session;

describe("Supabase email OTP authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    if (originalSiteUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
    }
  });

  it("requests a six-digit email OTP without a PKCE redirect", async () => {
    authMocks.signInWithOtp.mockResolvedValue({ error: null });

    await requestEmailOtp(` ${testEmail} `);

    expect(authMocks.signInWithOtp).toHaveBeenCalledWith({
      email: testEmail,
      options: {
        shouldCreateUser: true,
      },
    });
  });

  it("keeps the existing Magic Link request path available", async () => {
    authMocks.signInWithOtp.mockResolvedValue({ error: null });
    process.env.NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:4173";

    await sendEmailMagicLink(testEmail);

    expect(authMocks.signInWithOtp).toHaveBeenCalledWith({
      email: testEmail,
      options: {
        emailRedirectTo: "http://127.0.0.1:4173/auth/callback",
        shouldCreateUser: true,
      },
    });
  });

  it("verifies the OTP with the email type and returns the persisted session", async () => {
    authMocks.verifyOtp.mockResolvedValue({
      data: { session, user },
      error: null,
    });

    await expect(
      verifyEmailOtp(` ${testEmail} `, ` ${validOtp} `),
    ).resolves.toBe(session);

    expect(authMocks.verifyOtp).toHaveBeenCalledWith({
      email: testEmail,
      token: validOtp,
      type: "email",
    });
    expect(authMocks.getSession).not.toHaveBeenCalled();
  });

  it("accepts the session persisted by the client when verifyOtp omits it", async () => {
    authMocks.verifyOtp.mockResolvedValue({
      data: { session: null, user },
      error: null,
    });
    authMocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });

    await expect(
      verifyEmailOtp(testEmail, validOtp),
    ).resolves.toBe(session);
  });

  it("does not call Supabase for a malformed code", async () => {
    await expect(
      verifyEmailOtp(testEmail, "12ab"),
    ).rejects.toThrow(EMAIL_OTP_INVALID_ERROR);
    expect(authMocks.verifyOtp).not.toHaveBeenCalled();
  });

  it("shows safe Japanese errors for invalid, expired, and rate-limited attempts", async () => {
    authMocks.verifyOtp.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { code: "otp_invalid", message: "Token is invalid", status: 400 },
    });
    await expect(
      verifyEmailOtp(testEmail, validOtp),
    ).rejects.toThrow(EMAIL_OTP_INVALID_ERROR);

    authMocks.verifyOtp.mockResolvedValueOnce({
      data: { session: null, user: null },
      error: { code: "otp_expired", message: "Token has expired", status: 403 },
    });
    await expect(
      verifyEmailOtp(testEmail, expiredOtp),
    ).rejects.toThrow(EMAIL_OTP_EXPIRED_ERROR);

    authMocks.signInWithOtp.mockResolvedValueOnce({
      error: {
        code: "over_email_send_rate_limit",
        message: "Email rate limit exceeded",
        status: 429,
      },
    });
    await expect(requestEmailOtp(testEmail)).rejects.toThrow(
      EMAIL_OTP_RATE_LIMIT_ERROR,
    );
  });

  it("restores the authenticated state from the persisted session after reload", async () => {
    authMocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });
    authMocks.getUser.mockResolvedValue({
      data: { user },
      error: null,
    });

    await expect(readCloudAuthState()).resolves.toMatchObject({
      status: "authenticated",
      session,
      user,
    });
  });

  it("signs out through the existing public browser client", async () => {
    authMocks.signOut.mockResolvedValue({ error: null });

    await signOutFromCloud();

    expect(authMocks.signOut).toHaveBeenCalledTimes(1);
  });

  it("renders the OTP controls without logging authentication values", () => {
    const appSource = readFileSync(
      join(root, "app/components/uma-note-app.tsx"),
      "utf8",
    );
    const authSource = readFileSync(
      join(root, "lib/supabase/auth.ts"),
      "utf8",
    );
    const callbackSource = readFileSync(
      join(root, "app/auth/callback/page.tsx"),
      "utf8",
    );

    expect(appSource).toContain("認証コードを送信");
    expect(appSource).toContain("6桁の認証コード");
    expect(appSource).toContain("コードを確認");
    expect(appSource).toContain('autoComplete="one-time-code"');
    expect(authSource).toContain("verifyOtp({");
    expect(authSource).not.toMatch(/console\./);
    expect(callbackSource).toContain("exchangeCloudAuthCode(code)");
  });
});
