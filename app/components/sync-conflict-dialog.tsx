"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { SyncConflict } from "../../lib/sync/types";
import type { RaceRecord } from "../../lib/types";

export interface SyncConflictDialogProps {
  conflict: SyncConflict | null;
  onUseLocal: () => void | Promise<void>;
  onUseCloud: () => void | Promise<void>;
  onBackup: () => void | Promise<void>;
  onExport: () => void;
}

function prettyValue(value: unknown): string {
  if (value === undefined) return "値なし";
  if (typeof value === "string") return value;
  try {
    const text = JSON.stringify(value, null, 2);
    return text.length > 240 ? `${text.slice(0, 237)}...` : text;
  } catch {
    return String(value);
  }
}

function fieldLabel(path: string): string {
  const labels: Record<string, string> = {
    "/name": "レース名",
    "/race/name": "レース名",
    "/dataScope": "データ区分",
    "/course": "競馬場",
    "/date": "開催日",
    "/raceNumber": "レース番号",
    "/prediction": "予想内容",
  };
  return labels[path] ?? (path || "レース内容");
}

function isRaceRecord(value: unknown): value is RaceRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.name === "string" &&
    typeof record.date === "string" &&
    typeof record.course === "string" &&
    typeof record.raceNumber === "number" &&
    record.prediction !== null &&
    typeof record.prediction === "object";
}

export function SyncConflictDialog({
  conflict,
  onUseLocal,
  onUseCloud,
  onBackup,
  onExport,
}: SyncConflictDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [busyAction, setBusyAction] = useState<
    "local" | "cloud" | "backup" | null
  >(null);
  const [error, setError] = useState<{
    conflictId: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!conflict) return;
    panelRef.current?.focus();
  }, [conflict]);

  if (!conflict) return null;

  const displayFields =
    conflict.entityType === "race" &&
      isRaceRecord(conflict.localSnapshot) &&
      isRaceRecord(conflict.remoteSnapshot) &&
      conflict.localSnapshot.name !== conflict.remoteSnapshot.name
      ? [{
          path: "/name",
          base: null,
          local: conflict.localSnapshot.name,
          remote: conflict.remoteSnapshot.name,
        }]
      : conflict.fields;

  const runAction = async (
    action: "local" | "cloud" | "backup",
    callback: () => void | Promise<void>,
  ) => {
    setBusyAction(action);
    setError(null);
    try {
      await callback();
    } catch (caught) {
      setError({
        conflictId: conflict.conflictId,
        message:
          caught instanceof Error
            ? caught.message
            : "安全条件を確認できないため処理を停止しました。",
      });
    } finally {
      setBusyAction(null);
    }
  };

  const exportComparison = () => {
    setError(null);
    try {
      onExport();
    } catch (caught) {
      setError({
        conflictId: conflict.conflictId,
        message:
          caught instanceof Error
            ? caught.message
            : "比較内容を書き出せませんでした。",
      });
    }
  };

  return (
    <div className="sync-conflict-backdrop">
      <div
        ref={panelRef}
        className="sync-conflict-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
      >
        <header className="sync-conflict-header">
          <div>
            <p className="eyebrow">SYNC CONFLICT</p>
            <h2 id={titleId}>クラウドと端末で変更が競合しています</h2>
            <p id={descriptionId}>
              自動では上書きしません。差分を確認して、採用するレース名を選択してください。
            </p>
          </div>
          <span className="sync-conflict-version">比較待ち</span>
        </header>

        <dl className="sync-conflict-meta">
          <div>
            <dt>対象</dt>
            <dd>{conflict.entityType === "race" ? "レース" : conflict.entityType}</dd>
          </div>
          <div>
            <dt>差分</dt>
            <dd>{displayFields.length}件</dd>
          </div>
          <div>
            <dt>同期状態</dt>
            <dd>クラウド側の更新を確認済み</dd>
          </div>
          {conflict.expectedParentVersion !== undefined ||
          conflict.remoteParentVersion !== undefined ? (
            <div>
              <dt>親ルールセット版</dt>
              <dd>
                端末基準 v{conflict.expectedParentVersion ?? "未取得"} /
                クラウド v{conflict.remoteParentVersion ?? "未取得"}
              </dd>
            </div>
          ) : null}
        </dl>

        <section className="sync-conflict-fields" aria-labelledby={`${titleId}-fields`}>
          <h3 id={`${titleId}-fields`}>異なる項目</h3>
          {displayFields.length === 0 ? (
            <p className="sync-conflict-empty">
              項目単位の差分がありません。処理を進めず、比較内容を書き出して確認してください。
            </p>
          ) : (
            <ul>
              {displayFields.map((field, index) => (
                <li key={`${field.path}-${index}`}>
                  <strong>{fieldLabel(field.path)}</strong>
                  <div>
                    <span>現在の端末</span>
                    <pre>{prettyValue(field.local)}</pre>
                  </div>
                  <div>
                    <span>現在のクラウド</span>
                    <pre>{prettyValue(field.remote)}</pre>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <p className="sync-conflict-empty">
          「クラウドを採用」は新しいmutationを作りません。「端末を採用」は確認済みversionを基準に、
          新しい後続mutationを端末へ保存します。どちらも元mutationは再送しません。
        </p>

        {error?.conflictId === conflict.conflictId ? (
          <p className="form-error" role="alert">{error.message}</p>
        ) : null}

        <footer className="sync-conflict-actions">
          <button
            type="button"
            className="secondary-button"
            disabled={busyAction !== null}
            onClick={() => void runAction("backup", onBackup)}
          >
            {busyAction === "backup" ? "保存中…" : "原本バックアップ"}
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busyAction !== null}
            onClick={exportComparison}
          >
            比較内容を書き出す
          </button>
          <button
            type="button"
            className="secondary-button"
            disabled={busyAction !== null}
            onClick={() => void runAction("cloud", onUseCloud)}
          >
            {busyAction === "cloud" ? "反映中…" : "クラウドを採用"}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busyAction !== null}
            onClick={() => void runAction("local", onUseLocal)}
          >
            {busyAction === "local"
              ? "作成中…"
              : "端末を採用して後続mutationを作成"}
          </button>
        </footer>
      </div>
    </div>
  );
}
