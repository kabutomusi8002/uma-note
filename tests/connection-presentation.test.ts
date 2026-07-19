import { describe, expect, it } from "vitest";

import { connectionPresentationFor } from "../lib/sync/connection-presentation";

const cloudReadyInput = {
  supabaseConfigured: true,
  cloudAuthStatus: "authenticated" as const,
  userWorkspaceActive: true,
  online: true,
  pendingSyncCount: 0,
  conflictCount: 0,
  syncPhase: "idle" as const,
  cloudConnectionProbe: "ready" as const,
};

describe("connection presentation", () => {
  it("keeps an unconfigured build in explicit LOCAL stopped mode", () => {
    expect(connectionPresentationFor({
      ...cloudReadyInput,
      supabaseConfigured: false,
      cloudAuthStatus: "local",
      cloudConnectionProbe: "local",
    })).toEqual({
      primary: "LOCAL",
      secondary: "Supabase 未接続 · 同期停止",
      badge: "LOCAL",
      ready: false,
    });
  });

  it("does not claim a DB connection before a bootstrap or RPC succeeds", () => {
    expect(connectionPresentationFor({
      ...cloudReadyInput,
      cloudConnectionProbe: "checking",
    })).toMatchObject({
      primary: "未接続",
      ready: false,
    });
  });

  it.each(["error", "auth-required", "owner-mismatch", "conflict", "stopped"] as const)(
    "shows synchronization stopped for %s",
    (syncPhase) => {
      expect(connectionPresentationFor({
        ...cloudReadyInput,
        syncPhase,
      })).toMatchObject({
        primary: "同期停止",
        badge: "STOPPED",
        ready: false,
      });
    },
  );

  it("shows connected only after a verified cloud response", () => {
    expect(connectionPresentationFor(cloudReadyInput)).toMatchObject({
      primary: "クラウド接続",
      ready: true,
    });
  });
});
