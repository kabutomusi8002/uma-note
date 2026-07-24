"use client";

import { useEffect, useId, useRef, useState } from "react";

import type { SyncConflict } from "../../lib/sync/types";

export interface SyncConflictDialogProps {
  conflict: SyncConflict | null;
  onUseLocal: () => void | Promise<void>;
  onUseCloud: () => void | Promise<void>;
  onExport: () => void;
}

function prettyJson(value: unknown): string {
  if (value === undefined) return "(値なし)";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function compactValue(value: unknown): string {
  const text = prettyJson(value);
  return text.length > 160 ? `${text.slice(0, 157)}...` : text;
}

export function SyncConflictDialog({
  conflict,
  onUseLocal,
  onUseCloud,
  onExport,
}: SyncConflictDialogProps) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [busyAction, setBusyAction] = useState<"local" | "cloud" | null>(null);
  const [error, setError] = useState<{ conflictId: string; message: string } | null>(null);

  useEffect(() => {
    if (!conflict) return;
    panelRef.current?.focus();
  }, [conflict]);

  if (!conflict) return null;

  const runResolution = async (
    action: "local" | "cloud",
    callback: () => void | Promise<void>,
  ) => {
    setBusyAction(action);
    setError(null);
    try {
      await callback();
    } catch (caught) {
      setError({
        conflictId: conflict.conflictId,
        message: caught instanceof Error ? caught.message : "競合を解決できませんでした。",
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
        message: caught instanceof Error ? caught.message : "比較内容を書き出せませんでした。",
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
            <h2 id={titleId}>同じデータが別々に変更されています</h2>
            <p id={descriptionId}>
              自動では上書きしません。端末版とクラウド版を比較して、採用する内容を明示してください。
            </p>
          </div>
          <span className="sync-conflict-version" aria-label={`クラウド版 ${conflict.remoteVersion}`}>
            CLOUD v{conflict.remoteVersion}
          </span>
        </header>

        <dl className="sync-conflict-meta">
          <div>
            <dt>対象</dt>
            <dd>{conflict.entityType}</dd>
          </div>
          <div>
            <dt>キー</dt>
            <dd>{conflict.entityKey}</dd>
          </div>
          <div>
            <dt>競合箇所</dt>
            <dd>{conflict.fields.length}件</dd>
          </div>
          {conflict.expectedParentVersion !== undefined ||
          conflict.remoteParentVersion !== undefined ? (
            <div>
              <dt>親ルールセット版</dt>
              <dd>
                端末基準 v{conflict.expectedParentVersion ?? "未取得"} / クラウド v
                {conflict.remoteParentVersion ?? "未取得"}
              </dd>
            </div>
          ) : null}
        </dl>

        <section className="sync-conflict-fields" aria-labelledby={`${titleId}-fields`}>
          <h3 id={`${titleId}-fields`}>変更が重なった項目</h3>
          {conflict.fields.length === 0 ? (
            <p className="sync-conflict-empty">項目単位の差分はありません。全体の内容を確認してください。</p>
          ) : (
            <ul>
              {conflict.fields.map((field, index) => (
                <li key={`${field.path}-${index}`}>
                  <code>{field.path || "/"}</code>
                  <div>
                    <span>端末</span>
                    <pre>{compactValue(field.local)}</pre>
                  </div>
                  <div>
                    <span>クラウド</span>
                    <pre>{compactValue(field.remote)}</pre>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="sync-conflict-comparison" aria-label="データ全体の比較">
          <article>
            <h3>端末版</h3>
            <pre>{prettyJson(conflict.localSnapshot)}</pre>
          </article>
          <article>
            <h3>クラウド版</h3>
            <pre>{prettyJson(conflict.remoteSnapshot)}</pre>
          </article>
        </section>

        {error?.conflictId === conflict.conflictId ? (
          <p className="form-error" role="alert">{error.message}</p>
        ) : null}

        <footer className="sync-conflict-actions">
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
            onClick={() => void runResolution("cloud", onUseCloud)}
          >
            {busyAction === "cloud" ? "反映中…" : "クラウド版を採用"}
          </button>
          <button
            type="button"
            className="primary-button"
            disabled={busyAction !== null}
            onClick={() => void runResolution("local", onUseLocal)}
          >
            {busyAction === "local" ? "再送中…" : "端末版を再送"}
          </button>
        </footer>
      </div>
    </div>
  );
}
