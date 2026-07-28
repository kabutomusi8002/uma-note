"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
  CLOUD_AUTH_CALLBACK_ERROR,
  CLOUD_AUTH_CALLBACK_PATH,
  exchangeCloudAuthCode,
} from "@/lib/supabase/auth";

type CallbackState = "checking" | "error";

export default function SupabaseAuthCallbackPage() {
  const exchangeStarted = useRef(false);
  const [state, setState] = useState<CallbackState>("checking");

  useEffect(() => {
    if (exchangeStarted.current) return;
    exchangeStarted.current = true;

    const parameters = new URLSearchParams(window.location.search);
    const code = parameters.get("code")?.trim() ?? "";

    // Remove the one-time code from the address bar and browser history before
    // any asynchronous work. It is never rendered or written to a log.
    window.history.replaceState({}, document.title, CLOUD_AUTH_CALLBACK_PATH);

    const completeLogin = async () => {
      if (!code) throw new Error(CLOUD_AUTH_CALLBACK_ERROR);
      await exchangeCloudAuthCode(code);
    };

    void completeLogin()
      .then(() => {
        // A full navigation mounts the normal auth lifecycle, immediately
        // updates NO AUTH, and leaves no authentication parameter in the URL.
        window.location.replace("/");
      })
      .catch(() => {
        setState("error");
      });
  }, []);

  return (
    <main className="auth-callback-shell">
      <section className="auth-callback-card" aria-live="polite">
        <span className="brand-mark" aria-hidden="true">U</span>
        {state === "checking" ? (
          <>
            <p className="eyebrow dark">SUPABASE AUTH</p>
            <h1>ログインを確認しています</h1>
            <p>この画面を閉じずにお待ちください。</p>
          </>
        ) : (
          <>
            <p className="eyebrow dark">LOGIN REQUIRED</p>
            <h1>ログインを完了できませんでした</h1>
            <p role="alert">{CLOUD_AUTH_CALLBACK_ERROR}</p>
            <p className="security-note">
              ログインリンクは、送信を開始した同じ端末・ブラウザで開いてください。
            </p>
            <Link className="primary-button auth-callback-action" href="/">
              ホームへ戻る
            </Link>
          </>
        )}
      </section>
    </main>
  );
}
