import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Session } from "@supabase/supabase-js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn(),
  getSession: vi.fn(),
  signInWithOtp: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock("@/lib/supabase/client", () => ({
  getSupabaseClient: () => ({ auth: authMocks }),
  isSupabaseConfigured: () => true,
}));

import {
  CLOUD_AUTH_CALLBACK_ERROR,
  buildCloudAuthCallbackUrl,
  exchangeCloudAuthCode,
  sendEmailMagicLink,
} from "@/lib/supabase/auth";

const root = fileURLToPath(new URL("..", import.meta.url));
const originalSiteUrl = process.env.NEXT_PUBLIC_SITE_URL;
const session = {
  user: { id: "test-user" },
} as unknown as Session;

describe("Supabase PKCE callback", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.NEXT_PUBLIC_SITE_URL = "http://127.0.0.1:4173";
  });

  afterEach(() => {
    if (originalSiteUrl === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = originalSiteUrl;
    }
  });

  it("builds the exact callback URL from an origin or nested site URL", () => {
    expect(buildCloudAuthCallbackUrl("http://127.0.0.1:4173")).toBe(
      "http://127.0.0.1:4173/auth/callback",
    );
    expect(
      buildCloudAuthCallbackUrl("https://example.invalid/app/?source=test"),
    ).toBe("https://example.invalid/auth/callback");
  });

  it("sends new magic links to the explicit callback route", async () => {
    authMocks.signInWithOtp.mockResolvedValue({ error: null });

    await sendEmailMagicLink(" login@example.invalid ");

    expect(authMocks.signInWithOtp).toHaveBeenCalledTimes(1);
    expect(authMocks.signInWithOtp).toHaveBeenCalledWith({
      email: "login@example.invalid",
      options: {
        emailRedirectTo: "http://127.0.0.1:4173/auth/callback",
        shouldCreateUser: true,
      },
    });
  });

  it("exchanges the one-time code with the existing client", async () => {
    authMocks.exchangeCodeForSession.mockResolvedValue({
      data: { session },
      error: null,
    });

    await expect(exchangeCloudAuthCode("one-time-code")).resolves.toBe(session);
    expect(authMocks.exchangeCodeForSession).toHaveBeenCalledTimes(1);
    expect(authMocks.exchangeCodeForSession).toHaveBeenCalledWith(
      "one-time-code",
    );
    expect(authMocks.getSession).not.toHaveBeenCalled();
  });

  it("accepts an already-persisted session after a duplicate callback attempt", async () => {
    authMocks.exchangeCodeForSession.mockResolvedValue({
      data: { session: null },
      error: { message: "provider detail" },
    });
    authMocks.getSession.mockResolvedValue({
      data: { session },
      error: null,
    });

    await expect(exchangeCloudAuthCode("used-code")).resolves.toBe(session);
  });

  it("returns only the safe Japanese retry message on an invalid code", async () => {
    authMocks.exchangeCodeForSession.mockResolvedValue({
      data: { session: null },
      error: { message: "provider detail" },
    });
    authMocks.getSession.mockResolvedValue({
      data: { session: null },
      error: null,
    });

    await expect(exchangeCloudAuthCode("expired-code")).rejects.toThrow(
      CLOUD_AUTH_CALLBACK_ERROR,
    );
    await expect(exchangeCloudAuthCode("")).rejects.toThrow(
      CLOUD_AUTH_CALLBACK_ERROR,
    );
  });

  it("uses no parallel client or logging and keeps callbacks out of the app-shell cache", () => {
    const callbackSource = readFileSync(
      join(root, "app/auth/callback/page.tsx"),
      "utf8",
    );
    const clientSource = readFileSync(
      join(root, "lib/supabase/client.ts"),
      "utf8",
    );
    const workerSource = readFileSync(join(root, "public/sw.js"), "utf8");

    expect(callbackSource).toContain("exchangeCloudAuthCode(code)");
    expect(callbackSource).toContain(
      "window.history.replaceState({}, document.title, CLOUD_AUTH_CALLBACK_PATH)",
    );
    expect(callbackSource).toContain('window.location.replace("/")');
    expect(callbackSource).not.toContain("createClient");
    expect(callbackSource).not.toMatch(/console\./);
    expect(clientSource.match(/createClient\(/g)).toHaveLength(1);
    expect(clientSource).toContain("__umaNoteSupabaseClient");
    expect(clientSource).toContain("detectSessionInUrl: false");
    expect(workerSource).toContain(
      'request.mode === "navigate" && url.pathname === "/auth/callback"',
    );
    expect(workerSource).toContain('fetch(request, { cache: "no-store" })');
  });
});
