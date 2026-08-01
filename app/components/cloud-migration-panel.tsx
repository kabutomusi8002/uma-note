"use client";

import { useId, useMemo, useState } from "react";

import {
  canonicalJson,
  createLocalBackup,
  sha256Hex,
  type LocalBackup,
} from "../../lib/sync/backup-format";
import {
  buildMigrationPlan,
  canConfirmMigration,
  migrationConfirmationText,
  type MigrationConflictResolution,
  type MigrationPlan,
  type MigrationScopeSelection,
} from "../../lib/sync/migration-plan";
import type {
  PredictionRuleVersion,
  RaceDataScope,
  RaceRecord,
  UserSettings,
} from "../../lib/types";
import { ruleIdentityKey } from "../../lib/rule-identity";

export interface CloudMigrationPreview {
  previewId: string;
  races: RaceRecord[];
  rules: PredictionRuleVersion[];
  settings: UserSettings | null;
}

export interface CloudMigrationPanelProps {
  races: RaceRecord[];
  rules: PredictionRuleVersion[];
  settings: UserSettings;
  activeRuleId: string | null;
  userEmail: string | null;
  onLoadCloudPreview: (
    dataScopes: readonly RaceDataScope[],
  ) => Promise<CloudMigrationPreview>;
  onQueueMigration: (args: {
    selectedRaces: RaceRecord[];
    selectedRules: PredictionRuleVersion[];
    selectedSettings: UserSettings | null;
    backup: LocalBackup;
    planHash: string;
    previewId: string;
  }) => Promise<number>;
  onNotify: (message: string) => void;
}

type BusyStep = "backup" | "preview" | "queue" | null;
type ExtraAction = "create" | "identical" | "conflict";

interface RulePreviewRow {
  local: PredictionRuleVersion;
  cloud: PredictionRuleVersion | null;
  action: ExtraAction;
}

const INITIAL_SCOPES: MigrationScopeSelection = {
  live: true,
  demo: false,
  test: false,
};

const ACTION_LABELS: Record<MigrationPlan["items"][number]["action"], string> = {
  create: "新規登録",
  identical: "登録済み（同一）",
  conflict: "競合あり",
  immutable: "クラウド側が確定済み",
  excluded: "対象外",
};

function downloadBackup(backup: LocalBackup): void {
  const blob = new Blob([backup.text], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const date = backup.content.createdAt.slice(0, 10).replaceAll("-", "");
  link.href = url;
  link.download = `uma-note-backup-${date}.uma-note.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

function raceLabel(race: RaceRecord): string {
  return `${race.date} ${race.course} ${race.raceNumber}R${race.name ? ` ${race.name}` : ""}`;
}

function comparableRule(rule: PredictionRuleVersion): unknown {
  return {
    name: rule.name,
    version: rule.version,
    rules: rule.rules,
    note: rule.note ?? "",
  };
}

function buildRulePreviewRows(
  localRules: readonly PredictionRuleVersion[],
  cloudRules: readonly PredictionRuleVersion[],
): RulePreviewRow[] {
  return localRules.map((local) => {
    const cloud = cloudRules.find((candidate) =>
      candidate.id === local.id ||
      ruleIdentityKey(candidate) === ruleIdentityKey(local),
    ) ?? null;
    return {
      local,
      cloud,
      action: !cloud
        ? "create"
        : canonicalJson(comparableRule(local)) === canonicalJson(comparableRule(cloud))
          ? "identical"
          : "conflict",
    };
  });
}

function settingsAction(
  local: UserSettings,
  cloud: UserSettings | null,
): ExtraAction {
  if (!cloud) return "create";
  return canonicalJson(local) === canonicalJson(cloud) ? "identical" : "conflict";
}

function backupSettings(backup: LocalBackup): UserSettings {
  const value = backup.settings as unknown as Partial<UserSettings>;
  return {
    timezone: "Asia/Tokyo",
    defaultStakePerPoint:
      typeof value.defaultStakePerPoint === "number"
        ? value.defaultStakePerPoint
        : 100,
    defaultDataScope:
      value.defaultDataScope === "demo" || value.defaultDataScope === "test"
        ? value.defaultDataScope
        : "live",
    activeRuleVersionId: backup.activeRuleId,
  };
}

export function CloudMigrationPanel({
  races,
  rules,
  settings,
  activeRuleId,
  userEmail,
  onLoadCloudPreview,
  onQueueMigration,
  onNotify,
}: CloudMigrationPanelProps) {
  const titleId = useId();
  const confirmationId = useId();
  const [busy, setBusy] = useState<BusyStep>(null);
  const [error, setError] = useState("");
  const [backup, setBackup] = useState<LocalBackup | null>(null);
  const [backupSaved, setBackupSaved] = useState(false);
  const [scopes, setScopes] = useState<MigrationScopeSelection>(INITIAL_SCOPES);
  const [cloudRaces, setCloudRaces] = useState<RaceRecord[] | null>(null);
  const [cloudRules, setCloudRules] = useState<PredictionRuleVersion[] | null>(null);
  const [cloudSettings, setCloudSettings] = useState<UserSettings | null>(null);
  const [cloudPreviewId, setCloudPreviewId] = useState<string | null>(null);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectedRuleIds, setSelectedRuleIds] = useState<Set<string>>(new Set());
  const [conflictResolutions, setConflictResolutions] = useState<
    Record<string, MigrationConflictResolution>
  >({});
  const [ruleConflictResolutions, setRuleConflictResolutions] = useState<
    Record<string, "keep-cloud">
  >({});
  const [settingsResolution, setSettingsResolution] = useState<
    "keep-cloud" | "replace-local" | null
  >(null);
  const [previewReviewed, setPreviewReviewed] = useState(false);
  const [confirmationText, setConfirmationText] = useState("");

  const sourceRules = useMemo(() => backup?.rules ?? [], [backup]);
  const sourceSettings = backup ? backupSettings(backup) : null;
  const ruleRows = useMemo(
    () => buildRulePreviewRows(sourceRules, cloudRules ?? []),
    [cloudRules, sourceRules],
  );
  const comparableSourceSettings = sourceSettings?.activeRuleVersionId
    ? {
        ...sourceSettings,
        activeRuleVersionId:
          ruleRows.find((row) => row.local.id === sourceSettings.activeRuleVersionId)
            ?.cloud?.id ?? sourceSettings.activeRuleVersionId,
      }
    : sourceSettings;
  const currentSettingsAction = comparableSourceSettings
    ? settingsAction(comparableSourceSettings, cloudSettings)
    : "identical";
  const settingsSelected = Boolean(
    sourceSettings &&
      currentSettingsAction !== "identical" &&
      settingsResolution === "replace-local",
  );
  const activeSettingsRule = sourceSettings?.activeRuleVersionId
    ? ruleRows.find((row) => row.local.id === sourceSettings.activeRuleVersionId)
    : null;
  const settingsDependencyAvailable = Boolean(
    !sourceSettings?.activeRuleVersionId ||
      activeSettingsRule?.cloud ||
      (activeSettingsRule && selectedRuleIds.has(activeSettingsRule.local.id)),
  );

  const selectedSourceIds = useMemo(() => [...selectedIds].sort(), [selectedIds]);
  const selectedAdditionalCount = selectedRuleIds.size + (settingsSelected ? 1 : 0);
  const selectedTotal = selectedSourceIds.length + selectedAdditionalCount;
  const expectedConfirmation = migrationConfirmationText(selectedTotal);
  const confirmation = plan
    ? {
        planHash: plan.hash,
        backupSaved,
        backupHash: backup?.sha256,
        previewReviewed,
        selectedSourceIds,
        selectedAdditionalCount,
        conflictResolutions,
        confirmationText,
      }
    : null;
  const unresolvedRaceConflictCount = plan
    ? plan.items.filter(
        (item) => item.action === "conflict" && !conflictResolutions[item.sourceId],
      ).length
    : 0;
  const unresolvedRuleConflictCount = ruleRows.filter(
    (row) => row.action === "conflict" && !ruleConflictResolutions[row.local.id],
  ).length;
  const unresolvedSettingsConflictCount =
    currentSettingsAction === "conflict" && settingsResolution === null ? 1 : 0;
  const unresolvedConflictCount =
    unresolvedRaceConflictCount +
    unresolvedRuleConflictCount +
    unresolvedSettingsConflictCount;
  const isConfirmable = Boolean(
    userEmail &&
      backup &&
      plan &&
      confirmation &&
      selectedTotal > 0 &&
      unresolvedConflictCount === 0 &&
      (!settingsSelected || settingsDependencyAvailable) &&
      canConfirmMigration(plan, confirmation),
  );

  const applyPlan = (nextPlan: MigrationPlan) => {
    setPlan(nextPlan);
    setSelectedIds(
      new Set(
        nextPlan.items
          .filter((item) => item.action === "create" && item.selected)
          .map((item) => item.sourceId),
      ),
    );
    setConflictResolutions({});
    setPreviewReviewed(false);
    setConfirmationText("");
  };

  const rebuildPlan = async (
    nextScopes: MigrationScopeSelection,
    remoteRaces: RaceRecord[],
  ) => {
    if (!backup) return;
    const nextPlan = await buildMigrationPlan({
      localRaces: backup.races,
      cloudRaces: remoteRaces,
      includeScopes: nextScopes,
      backupHash: backup.sha256,
    });
    applyPlan(nextPlan);
  };

  const saveBackup = async () => {
    setBusy("backup");
    setError("");
    try {
      const nextBackup = await createLocalBackup({
        races,
        rules,
        settings: { ...settings },
        activeRuleId,
      });
      downloadBackup(nextBackup);
      setBackup(nextBackup);
      setBackupSaved(true);
      setCloudRaces(null);
      setCloudRules(null);
      setCloudSettings(null);
      setCloudPreviewId(null);
      setPlan(null);
      setSelectedIds(new Set());
      setSelectedRuleIds(new Set());
      setConflictResolutions({});
      setRuleConflictResolutions({});
      setSettingsResolution(null);
      setPreviewReviewed(false);
      setConfirmationText("");
      onNotify("ローカルデータの安全バックアップを保存しました。");
    } catch (caught) {
      setBackupSaved(false);
      setError(caught instanceof Error ? caught.message : "バックアップを作成できませんでした。");
    } finally {
      setBusy(null);
    }
  };

  const loadPreview = async (
    previewScopes: MigrationScopeSelection = scopes,
  ) => {
    if (!backup) return;
    setBusy("preview");
    setError("");
    try {
      const selectedScopes = (Object.keys(previewScopes) as RaceDataScope[])
        .filter((scope) => previewScopes[scope]);
      const remote = await onLoadCloudPreview(selectedScopes);
      setCloudRaces(remote.races);
      setCloudRules(remote.rules);
      setCloudSettings(remote.settings);
      setCloudPreviewId(remote.previewId);
      const nextRuleRows = buildRulePreviewRows(backup.rules, remote.rules);
      setSelectedRuleIds(new Set(
        nextRuleRows
          .filter((row) => row.action === "create")
          .map((row) => row.local.id),
      ));
      setRuleConflictResolutions({});
      const nextSettingsAction = settingsAction(backupSettings(backup), remote.settings);
      setSettingsResolution(nextSettingsAction === "create" ? "replace-local" : null);
      await rebuildPlan(previewScopes, remote.races);
      onNotify("移行プレビューを更新しました。まだクラウドへは送信していません。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "クラウドのプレビューを取得できませんでした。");
    } finally {
      setBusy(null);
    }
  };

  const changeScope = async (scope: RaceDataScope, checked: boolean) => {
    const nextScopes = { ...scopes, [scope]: checked };
    setScopes(nextScopes);
    setError("");
    if (!cloudRaces || !backup) return;
    await loadPreview(nextScopes);
  };

  const toggleCreate = (sourceId: string, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
    setConfirmationText("");
  };

  const resolveConflict = (
    sourceId: string,
    resolution: MigrationConflictResolution,
  ) => {
    setConflictResolutions((current) => ({ ...current, [sourceId]: resolution }));
    setSelectedIds((current) => {
      const next = new Set(current);
      if (resolution === "replace-local") next.add(sourceId);
      else next.delete(sourceId);
      return next;
    });
    setConfirmationText("");
  };

  const queueMigration = async () => {
    if (!backup || !plan || !confirmation || !isConfirmable || !cloudPreviewId) return;
    setBusy("queue");
    setError("");
    try {
      const selectedRaces = plan.items
        .filter((item) => selectedIds.has(item.sourceId))
        .map((item) => item.localRace);
      const selectedRules = backup.rules.filter((rule) => selectedRuleIds.has(rule.id));
      const selectedSettings = settingsSelected ? backupSettings(backup) : null;
      const documentPlanHash = await sha256Hex(canonicalJson({
        version: 1,
        racePlanHash: plan.hash,
        backupHash: backup.sha256,
        selectedRaceIds: selectedRaces.map((race) => race.id).sort(),
        selectedRuleIds: selectedRules.map((rule) => rule.id).sort(),
        selectedSettings,
      }));
      const queuedCount = await onQueueMigration({
        selectedRaces,
        selectedRules,
        selectedSettings,
        backup,
        planHash: documentPlanHash,
        previewId: cloudPreviewId,
      });
      onNotify(`${queuedCount}件を安全にクラウドへ移行しました。`);
      setPlan(null);
      setCloudRaces(null);
      setCloudRules(null);
      setCloudSettings(null);
      setCloudPreviewId(null);
      setSelectedIds(new Set());
      setSelectedRuleIds(new Set());
      setConflictResolutions({});
      setRuleConflictResolutions({});
      setSettingsResolution(null);
      setPreviewReviewed(false);
      setConfirmationText("");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "移行を同期待ちへ追加できませんでした。");
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="cloud-migration-panel" aria-labelledby={titleId}>
      <header>
        <div>
          <p className="eyebrow">LOCAL → SUPABASE</p>
          <h2 id={titleId}>クラウド移行</h2>
          <p>バックアップ、差分プレビュー、明示確認の順で安全に移行します。</p>
        </div>
        <span className={`connection-state ${userEmail ? "ready" : ""}`}>
          {userEmail ?? "メール認証が必要です"}
        </span>
      </header>

      <ol className="cloud-migration-steps">
        <li className={backupSaved ? "is-complete" : ""}>
          <div className="cloud-migration-step-title">
            <span>1</span>
            <div>
              <strong>安全バックアップを保存</strong>
              <small>レース・ルール・設定を1つの検証可能なファイルに保存します。</small>
            </div>
          </div>
          <button
            type="button"
            className="secondary-button"
            disabled={busy !== null}
            onClick={() => void saveBackup()}
          >
            {busy === "backup" ? "作成中…" : backupSaved ? "バックアップを再保存" : "バックアップを保存"}
          </button>
          {backup ? <code className="cloud-backup-hash">SHA-256 {backup.sha256}</code> : null}
        </li>

        <li className={plan ? "is-complete" : ""}>
          <div className="cloud-migration-step-title">
            <span>2</span>
            <div>
              <strong>対象区分と差分をプレビュー</strong>
              <small>liveのみ選択済みです。demo/testは必要な場合だけ含めてください。</small>
            </div>
          </div>
          <fieldset className="migration-scope-options" disabled={busy !== null}>
            <legend>移行する区分</legend>
            {(["live", "demo", "test"] as const).map((scope) => (
              <label key={scope}>
                <input
                  type="checkbox"
                  checked={scopes[scope]}
                  onChange={(event) => void changeScope(scope, event.target.checked)}
                />
                <span>{scope}</span>
                {scope !== "live" ? <small>確認用データ</small> : <small>実運用データ</small>}
              </label>
            ))}
          </fieldset>
          <button
            type="button"
            className="secondary-button"
            disabled={!userEmail || !backupSaved || busy !== null}
            onClick={() => void loadPreview()}
          >
            {busy === "preview" ? "比較中…" : plan ? "プレビューを再取得" : "クラウドと比較する"}
          </button>
        </li>

        {plan ? (
          <li className="cloud-migration-preview">
            <div className="cloud-migration-step-title">
              <span>3</span>
              <div>
                <strong>移行内容を確認</strong>
                <small>競合は端末版かクラウド版かを必ず選択します。</small>
              </div>
            </div>

            <div className="migration-counts" aria-label="プレビュー集計">
              <span><b>{plan.counts.create}</b> 新規</span>
              <span><b>{plan.counts.conflict}</b> 競合</span>
              <span><b>{plan.counts.identical}</b> 同一</span>
              <span><b>{plan.counts.immutable}</b> 確定済み</span>
              <span><b>{plan.counts.excluded}</b> 対象外</span>
            </div>

            <ul className="migration-race-list">
              {plan.items.map((item) => (
                <li key={item.sourceId} className={`migration-action-${item.action}`}>
                  <div className="migration-race-heading">
                    <div>
                      <strong>{raceLabel(item.localRace)}</strong>
                      <small>{item.dataScope} · {item.naturalKey}</small>
                    </div>
                    <span>{ACTION_LABELS[item.action]}</span>
                  </div>

                  {item.action === "create" ? (
                    <label className="migration-select-row">
                      <input
                        type="checkbox"
                        checked={selectedIds.has(item.sourceId)}
                        onChange={(event) => toggleCreate(item.sourceId, event.target.checked)}
                      />
                      このレースを移行する
                    </label>
                  ) : null}

                  {item.action === "conflict" ? (
                    <>
                      <fieldset className="migration-conflict-choice">
                        <legend>採用する内容を選択</legend>
                        <label>
                          <input
                            type="radio"
                            name={`migration-conflict-${item.sourceId}`}
                            checked={conflictResolutions[item.sourceId] === "keep-cloud"}
                            onChange={() => resolveConflict(item.sourceId, "keep-cloud")}
                          />
                          クラウド版を維持（端末版は送信しない）
                        </label>
                        <label>
                          <input
                            type="radio"
                            name={`migration-conflict-${item.sourceId}`}
                            checked={conflictResolutions[item.sourceId] === "replace-local"}
                            onChange={() => resolveConflict(item.sourceId, "replace-local")}
                          />
                          端末版で置き換える（確認後に再送）
                        </label>
                      </fieldset>
                      <details className="migration-diff">
                        <summary>端末版とクラウド版の差分を表示</summary>
                        <div>
                          <article><h4>端末版</h4><pre>{JSON.stringify(item.localRace, null, 2)}</pre></article>
                          <article><h4>クラウド版</h4><pre>{JSON.stringify(item.cloudRace ?? null, null, 2)}</pre></article>
                        </div>
                      </details>
                    </>
                  ) : null}
                </li>
              ))}
            </ul>

            <fieldset className="migration-extra-selection">
              <legend>バックアップ時点のルール・設定</legend>
              <div className="migration-extra-group">
                <h3>予想ルール {ruleRows.length}件</h3>
                {ruleRows.length === 0 ? <p>対象なし</p> : (
                  <ul>
                    {ruleRows.map((row) => (
                      <li key={row.local.id} className={`migration-action-${row.action}`}>
                        <div className="migration-race-heading">
                          <strong>{row.local.name} v{row.local.version}</strong>
                          <span>{ACTION_LABELS[row.action]}</span>
                        </div>
                        {row.action === "create" ? (
                          <label className="migration-select-row">
                            <input
                              type="checkbox"
                              checked={selectedRuleIds.has(row.local.id)}
                              onChange={(event) => {
                                setSelectedRuleIds((current) => {
                                  const next = new Set(current);
                                  if (event.target.checked) next.add(row.local.id);
                                  else next.delete(row.local.id);
                                  return next;
                                });
                                setConfirmationText("");
                              }}
                            />
                            このルール版を移行する
                          </label>
                        ) : null}
                        {row.action === "identical" ? <small>同じ内容がクラウドにあります。</small> : null}
                        {row.action === "conflict" ? (
                          <>
                            <fieldset className="migration-conflict-choice">
                              <legend>同名・同版は不変です</legend>
                              <label>
                                <input
                                  type="radio"
                                  name={`migration-rule-${row.local.id}`}
                                  checked={ruleConflictResolutions[row.local.id] === "keep-cloud"}
                                  onChange={() => {
                                    setRuleConflictResolutions((current) => ({
                                      ...current,
                                      [row.local.id]: "keep-cloud",
                                    }));
                                    setConfirmationText("");
                                  }}
                                />
                                クラウド版を維持し、端末版は別バージョンとして後で保存する
                              </label>
                            </fieldset>
                            <details className="migration-diff">
                              <summary>端末版とクラウド版の差分を表示</summary>
                              <div>
                                <article><h4>端末版</h4><pre>{JSON.stringify(row.local, null, 2)}</pre></article>
                                <article><h4>クラウド版</h4><pre>{JSON.stringify(row.cloud, null, 2)}</pre></article>
                              </div>
                            </details>
                          </>
                        ) : null}
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {sourceSettings ? (
                <div className={`migration-extra-group migration-action-${currentSettingsAction}`}>
                  <div className="migration-race-heading">
                    <strong>ユーザー設定</strong>
                    <span>{ACTION_LABELS[currentSettingsAction]}</span>
                  </div>
                  <small>
                    端末版: 1点 {sourceSettings.defaultStakePerPoint}円・既定区分 {sourceSettings.defaultDataScope}
                  </small>
                  {currentSettingsAction === "create" ? (
                    <label className="migration-select-row">
                      <input
                        type="checkbox"
                        checked={settingsResolution === "replace-local"}
                        onChange={(event) => {
                          setSettingsResolution(event.target.checked ? "replace-local" : null);
                          setConfirmationText("");
                        }}
                      />
                      この設定を移行する
                    </label>
                  ) : null}
                  {currentSettingsAction === "identical" ? <small>同じ設定がクラウドにあります。</small> : null}
                  {currentSettingsAction === "conflict" ? (
                    <fieldset className="migration-conflict-choice">
                      <legend>採用する設定を選択</legend>
                      <label>
                        <input
                          type="radio"
                          name="migration-settings"
                          checked={settingsResolution === "keep-cloud"}
                          onChange={() => {
                            setSettingsResolution("keep-cloud");
                            setConfirmationText("");
                          }}
                        />
                        クラウド設定を維持
                      </label>
                      <label>
                        <input
                          type="radio"
                          name="migration-settings"
                          checked={settingsResolution === "replace-local"}
                          onChange={() => {
                            setSettingsResolution("replace-local");
                            setConfirmationText("");
                          }}
                        />
                        端末設定を明示的に採用
                      </label>
                    </fieldset>
                  ) : null}
                  {currentSettingsAction === "conflict" ? (
                    <details className="migration-diff">
                      <summary>端末設定とクラウド設定の差分を表示</summary>
                      <div>
                        <article><h4>端末版</h4><pre>{JSON.stringify(sourceSettings, null, 2)}</pre></article>
                        <article><h4>クラウド版</h4><pre>{JSON.stringify(cloudSettings, null, 2)}</pre></article>
                      </div>
                    </details>
                  ) : null}
                  {settingsSelected && !settingsDependencyAvailable ? (
                    <p className="migration-warning" role="status">
                      有効ルールを先に移行するか、クラウドにある版を選んでください。
                    </p>
                  ) : null}
                </div>
              ) : null}
            </fieldset>

            <label className="migration-review-check">
              <input
                type="checkbox"
                checked={previewReviewed}
                onChange={(event) => setPreviewReviewed(event.target.checked)}
              />
              プレビューと全競合の選択内容を確認しました
            </label>

            <label className="field migration-confirm-field" htmlFor={confirmationId}>
              <span>確認のため「{expectedConfirmation}」と入力</span>
              <input
                id={confirmationId}
                value={confirmationText}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setConfirmationText(event.target.value)}
              />
            </label>

            {unresolvedConflictCount > 0 ? (
              <p className="migration-warning" role="status">
                未選択の競合が{unresolvedConflictCount}件あります。自動上書きは行いません。
              </p>
            ) : null}

            <button
              type="button"
              className="primary-button full"
              disabled={!isConfirmable || busy !== null}
              onClick={() => void queueMigration()}
            >
              {busy === "queue" ? "安全に移行中…" : `${selectedTotal}件を安全に移行`}
            </button>
          </li>
        ) : null}
      </ol>

      {error ? <p className="form-error" role="alert">{error}</p> : null}
      <p className="cloud-migration-footnote">
        過去レースは中断再開可能な専用移行RPC、通常変更はOutboxを使います。競合時は自動上書きしません。
      </p>
    </section>
  );
}
