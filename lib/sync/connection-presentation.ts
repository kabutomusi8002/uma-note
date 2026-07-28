import type { SyncPhase } from "./types";

export type CloudAuthPresentationStatus =
  | "local"
  | "checking"
  | "anonymous"
  | "authenticated"
  | "expired";

export type CloudConnectionProbe = "local" | "checking" | "ready" | "error";

export interface ConnectionPresentation {
  primary: string;
  secondary: string;
  badge: string;
  ready: boolean;
}

export function connectionPresentationFor(input: {
  supabaseConfigured: boolean;
  cloudAuthStatus: CloudAuthPresentationStatus;
  userWorkspaceActive: boolean;
  online: boolean;
  pendingSyncCount: number;
  conflictCount: number;
  syncPhase: SyncPhase;
  cloudConnectionProbe: CloudConnectionProbe;
}): ConnectionPresentation {
  if (!input.supabaseConfigured) {
    return {
      primary: "LOCAL",
      secondary: "Supabase 未接続 · 同期停止",
      badge: "LOCAL",
      ready: false,
    };
  }
  if (input.cloudAuthStatus === "checking") {
    return {
      primary: "接続確認中",
      secondary: "認証状態を確認しています",
      badge: "CHECK",
      ready: false,
    };
  }
  if (input.cloudAuthStatus !== "authenticated") {
    return {
      primary: "未接続",
      secondary: "ログインが必要 · 同期停止",
      badge: "NO AUTH",
      ready: false,
    };
  }
  if (!input.userWorkspaceActive) {
    return {
      primary: "LOCAL",
      secondary: "ログイン済み · 移行前は同期停止",
      badge: "LOCAL",
      ready: false,
    };
  }
  if (!input.online) {
    return {
      primary: "オフライン",
      secondary: input.pendingSyncCount
        ? `Outbox ${input.pendingSyncCount}件を端末に保持`
        : "再接続まで同期停止",
      badge: `OFFLINE ${input.pendingSyncCount || ""}`.trim(),
      ready: false,
    };
  }
  if (input.conflictCount > 0) {
    return {
      primary: "競合停止",
      secondary: `比較待ち ${input.conflictCount}件`,
      badge: `CONFLICT ${input.conflictCount}`,
      ready: false,
    };
  }
  if (input.syncPhase === "syncing") {
    return {
      primary: "同期中",
      secondary: `Outbox ${input.pendingSyncCount}件`,
      badge: "SYNCING",
      ready: false,
    };
  }
  if (
    input.syncPhase === "error" ||
    input.syncPhase === "auth-required" ||
    input.syncPhase === "owner-mismatch" ||
    input.syncPhase === "conflict" ||
    input.syncPhase === "stopped" ||
    input.cloudConnectionProbe === "error"
  ) {
    return {
      primary: "同期停止",
      secondary: "Supabaseへ接続できません",
      badge: "STOPPED",
      ready: false,
    };
  }
  if (input.cloudConnectionProbe !== "ready") {
    return {
      primary: "未接続",
      secondary: "Supabase応答を確認中 · 同期停止",
      badge: "CHECK",
      ready: false,
    };
  }
  return {
    primary: "クラウド接続",
    secondary: input.pendingSyncCount
      ? `Outbox ${input.pendingSyncCount}件を同期待ち`
      : "Supabase 同期準備完了",
    badge: input.pendingSyncCount ? `OUTBOX ${input.pendingSyncCount}` : "SYNC",
    ready: true,
  };
}
