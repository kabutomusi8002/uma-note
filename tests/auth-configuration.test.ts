import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const config = readFileSync("supabase/config.toml", "utf8");
const authSource = readFileSync("lib/supabase/auth.ts", "utf8");
const clientSource = readFileSync("lib/supabase/client.ts", "utf8");
const checklist = readFileSync("docs/production-auth.md", "utf8");

function section(name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = config.match(
    new RegExp(
      `^\\[${escaped}\\]\\r?\\n([\\s\\S]*?)(?=^\\[|(?![\\s\\S]))`,
      "mu",
    ),
  );
  expect(match, `missing [${name}]`).not.toBeNull();
  return match?.[1] ?? "";
}

describe("Supabase Auth repository policy", () => {
  it("keeps the used email OTP flow and session/callback behavior", () => {
    expect(authSource).toContain("auth.signInWithOtp({");
    expect(authSource).toContain("auth.verifyOtp({");
    expect(authSource).toContain('type: "email"');
    expect(authSource).toContain("shouldCreateUser: true");
    expect(authSource).toContain("exchangeCodeForSession");
    expect(authSource).toContain("auth.signOut()");
    expect(clientSource).toContain("persistSession: true");
    expect(clientSource).toContain("detectSessionInUrl: false");
  });

  it("does not add unused authentication APIs to application code", () => {
    expect(authSource).not.toMatch(
      /signInWithPassword|signUp\s*\(|signInWithOAuth|signInAnonymously|signInWithWeb3|signInWithSSO/,
    );
  });

  it("hardens local OTP settings and disables configurable unused paths", () => {
    expect(config).toContain("LOCAL DEVELOPMENT ONLY");
    expect(section("auth")).toMatch(/enable_anonymous_sign_ins = false/);
    expect(section("auth")).toMatch(/enable_manual_linking = false/);
    expect(section("auth.email")).toMatch(/enable_signup = true/);
    expect(section("auth.email")).toMatch(/max_frequency = "60s"/);
    expect(section("auth.email")).toMatch(/otp_length = 6/);
    expect(section("auth.email")).toMatch(/otp_expiry = 600/);
    expect(section("auth.sms")).toMatch(/enable_signup = false/);
    expect(section("auth.passkey")).toMatch(/enabled = false/);
    expect(section("auth.external.apple")).toMatch(/enabled = false/);
    expect(section("auth.web3.solana")).toMatch(/enabled = false/);
    expect(section("auth.third_party.firebase")).toMatch(/enabled = false/);
    expect(section("auth.third_party.auth0")).toMatch(/enabled = false/);
    expect(section("auth.third_party.aws_cognito")).toMatch(/enabled = false/);
    expect(section("auth.third_party.clerk")).toMatch(/enabled = false/);
    expect(section("auth.oauth_server")).toMatch(/enabled = false/);
    expect(section("auth.oauth_server")).toMatch(/allow_dynamic_registration = false/);
  });

  it("documents every production-only manual Auth check", () => {
    expect(checklist).toContain("manual verification required");
    for (const item of [
      "Unused authentication methods",
      "Signup policy",
      "Email confirmation policy",
      "OTP expiry and rate limits",
      "CAPTCHA / Turnstile",
      "SMTP sending limits",
      "Redirect URL allow-list",
      "Site URL",
      "Password controls (only if password authentication is enabled)",
    ]) {
      expect(checklist).toContain(item);
    }
    expect(checklist).toContain("does **not** establish");
  });
});
