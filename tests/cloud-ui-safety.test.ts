import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const appSource = readFileSync(
  `${root}/app/components/uma-note-app.tsx`,
  "utf8",
);
const migrationSource = readFileSync(
  `${root}/app/components/cloud-migration-panel.tsx`,
  "utf8",
);
const connectionSource = readFileSync(
  `${root}/lib/sync/connection-presentation.ts`,
  "utf8",
);
const conflictDialogSource = readFileSync(
  `${root}/app/components/sync-conflict-dialog.tsx`,
  "utf8",
);

describe("cloud UI safety wiring", () => {
  it("previews races, immutable rules and settings before migration", () => {
    expect(migrationSource).toContain("backup.races");
    expect(migrationSource).toContain("selectedRules: PredictionRuleVersion[]");
    expect(migrationSource).toContain("selectedSettings: UserSettings | null");
    expect(migrationSource).toContain("端末版とクラウド版の差分を表示");
    expect(migrationSource).toContain("端末設定とクラウド設定の差分を表示");
    expect(migrationSource).toContain("selectedAdditionalCount");
  });

  it("subscribes to user-scoped changes and pulls again after reconnect", () => {
    expect(appSource).toContain("subscribeToSyncChanges(client, userId, schedulePull)");
    expect(appSource).toContain("activeOwnerScope !== ownerScopeForUser(userId)");
    expect(appSource).toContain("void client.removeChannel(channel)");
    expect(appSource).toContain("rerunRequested = true");
  });

  it("generates one stable race clientKey and queues that persisted value", () => {
    const blankRace = appSource.slice(
      appSource.indexOf("function makeBlankRace"),
      appSource.indexOf("function safeSummary"),
    );
    const queueRace = appSource.slice(
      appSource.indexOf("const queueRaceCloudSave"),
      appSource.indexOf("const queueRuleCloudAction"),
    );
    expect(blankRace).toContain('const id = makeId("race")');
    expect(blankRace).toContain("id,");
    expect(blankRace).toContain("clientKey: id");
    expect(queueRace).toContain("const entityKey = raceClientKey(race)");
    expect(queueRace).toContain("payload: race");
    expect(queueRace).not.toContain("cloudRaceAliasesRef.current.get");
    expect(appSource).toContain("nextRaces[localIndex] = { ...local, clientKey }");
  });

  it("commits a local conflict choice and old-intent removal atomically", () => {
    const handler = appSource.slice(
      appSource.indexOf("const resendLocalConflictVersion"),
      appSource.indexOf("const exportCurrentConflict"),
    );
    expect(handler).toContain('markConflictResolved(conflict, "local", successor)');
    expect(appSource).toContain("await resolveConflict(database");
    expect(appSource).toContain("cloudRuleAliasesRef.current.entries()");
  });

  it("shows both parent rule-set versions for a parent CAS conflict", () => {
    expect(conflictDialogSource).toContain("親ルールセット版");
    expect(conflictDialogSource).toContain("conflict.expectedParentVersion");
    expect(conflictDialogSource).toContain("conflict.remoteParentVersion");
  });

  it("does not label internet reachability as an active Supabase connection", () => {
    expect(connectionSource).toContain('primary: "LOCAL"');
    expect(connectionSource).toContain('secondary: "Supabase 未接続 · 同期停止"');
    expect(connectionSource).toContain('primary: "未接続"');
    expect(connectionSource).toContain('secondary: "ログインが必要 · 同期停止"');
    expect(connectionSource).toContain('cloudConnectionProbe !== "ready"');
    expect(appSource).toContain(
      'className={connectionPresentation.ready ? "status-dot online" : "status-dot"}',
    );
    expect(appSource).not.toContain('<strong>{online ? "オンライン" : "オフライン"}</strong>');
  });

  it("drops stale cloud completions after authentication or workspace changes", () => {
    expect(appSource).toContain("authEpochRef.current !== authEpoch");
    expect(appSource).toContain("ownerScopeRef.current !== ownerScope");
    expect(appSource).toContain("appliesToCurrentWorkspace");
    expect(appSource).toContain("getWorkspace(localDatabase, mutation.ownerScope)");
    expect(appSource).toContain("workspaceSwitchRequestRef.current !== switchRequest");
    expect(appSource).toContain("workspaceSwitchRequestRef.current += 1");
  });

  it("binds local migration and sync-state refreshes to the current owner", () => {
    expect(appSource).toContain("localMigrationAbortRef.current?.abort()");
    expect(appSource).toContain("assertCurrentMigration(ownerScope)");
    expect(appSource).toContain("signal: migrationController.signal");
    expect(appSource).toContain("syncStateRequestRef.current !== request");
    expect(appSource).toContain("ownerScopeRef.current !== scope");
    expect(appSource).toContain("setSyncConflicts([])");
  });

  it("refuses to resolve a conflict from a stale owner workspace", () => {
    expect(appSource).toContain("assertConflictOwnerCurrent(conflict)");
    expect(appSource).toContain("conflict.ownerScope !== ownerScopeRef.current");
    expect(appSource).toContain('auth.status !== "authenticated"');
  });
});
