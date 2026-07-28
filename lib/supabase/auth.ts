import type { Session, User } from "@supabase/supabase-js";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";

export const CLOUD_AUTH_CALLBACK_PATH = "/auth/callback";
export const CLOUD_AUTH_CALLBACK_ERROR =
  "ログインリンクを確認できませんでした。期限切れまたは使用済みの可能性があります。設定画面からもう一度ログインしてください。";
export const EMAIL_OTP_INVALID_ERROR =
  "認証コードが正しくありません。最新の6桁コードを確認してください。";
export const EMAIL_OTP_EXPIRED_ERROR =
  "認証コードの有効期限が切れています。新しいコードを送信してください。";
export const EMAIL_OTP_RATE_LIMIT_ERROR =
  "認証の試行回数が上限に達しました。しばらく待ってから再試行してください。";
export const EMAIL_OTP_SEND_ERROR =
  "認証コードを送信できませんでした。しばらく待ってから再試行してください。";

export type CloudAuthState =
  | { status: "local"; user: null; session: null }
  | { status: "checking"; user: null; session: null }
  | { status: "anonymous"; user: null; session: null }
  | { status: "authenticated"; user: User; session: Session }
  | { status: "expired"; user: null; session: null; message: string };

export async function readCloudAuthState(): Promise<CloudAuthState> {
  if (!isSupabaseConfigured()) {
    return { status: "local", user: null, session: null };
  }

  const client = getSupabaseClient();
  const { data: sessionData, error: sessionError } = await client.auth.getSession();
  if (sessionError) {
    return {
      status: "expired",
      user: null,
      session: null,
      message: sessionError.message,
    };
  }
  if (!sessionData.session) {
    return { status: "anonymous", user: null, session: null };
  }

  const { data: userData, error: userError } = await client.auth.getUser();
  if (userError || !userData.user) {
    return {
      status: "expired",
      user: null,
      session: null,
      message: userError?.message ?? "ログイン状態を確認できませんでした。",
    };
  }
  return {
    status: "authenticated",
    user: userData.user,
    session: sessionData.session,
  };
}

export function subscribeToCloudAuth(
  listener: (state: CloudAuthState) => void,
): () => void {
  if (!isSupabaseConfigured()) {
    listener({ status: "local", user: null, session: null });
    return () => undefined;
  }

  const client = getSupabaseClient();
  const { data } = client.auth.onAuthStateChange((_event, session) => {
    window.setTimeout(() => {
      if (session?.user) {
        listener({ status: "authenticated", user: session.user, session });
      } else {
        listener({ status: "anonymous", user: null, session: null });
      }
    }, 0);
  });
  return () => data.subscription.unsubscribe();
}

export function buildCloudAuthCallbackUrl(baseUrl: string): string {
  try {
    const base = new URL(baseUrl);
    if (base.protocol !== "http:" && base.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    return new URL(CLOUD_AUTH_CALLBACK_PATH, base.origin).toString();
  } catch {
    throw new Error(
      "認証コールバックURLを作成できませんでした。NEXT_PUBLIC_SITE_URLを確認してください。",
    );
  }
}

export function getCloudAuthCallbackUrl(): string {
  const configuredSiteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  const browserOrigin =
    typeof window === "undefined" ? "" : window.location.origin;
  const baseUrl = configuredSiteUrl || browserOrigin;
  if (!baseUrl) {
    throw new Error(
      "認証コールバックURLを作成できませんでした。NEXT_PUBLIC_SITE_URLを確認してください。",
    );
  }
  return buildCloudAuthCallbackUrl(baseUrl);
}

export async function sendEmailMagicLink(email: string): Promise<void> {
  const normalizedEmail = email.trim();
  if (!normalizedEmail) throw new Error("メールアドレスを入力してください。");
  const { error } = await getSupabaseClient().auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: getCloudAuthCallbackUrl(),
      shouldCreateUser: true,
    },
  });
  if (error) throw error;
}

type AuthErrorDetails = {
  code?: string;
  message?: string;
  status?: number;
};

function authErrorDetails(cause: unknown): AuthErrorDetails {
  if (!cause || typeof cause !== "object") return {};
  const value = cause as Record<string, unknown>;
  return {
    ...(typeof value.code === "string" ? { code: value.code } : {}),
    ...(typeof value.message === "string" ? { message: value.message } : {}),
    ...(typeof value.status === "number" ? { status: value.status } : {}),
  };
}

function emailOtpError(
  cause: unknown,
  phase: "request" | "verify",
): Error {
  const details = authErrorDetails(cause);
  const searchable = `${details.code ?? ""} ${details.message ?? ""}`.toLowerCase();
  if (
    details.status === 429 ||
    searchable.includes("rate limit") ||
    searchable.includes("rate_limit") ||
    searchable.includes("too many")
  ) {
    return new Error(EMAIL_OTP_RATE_LIMIT_ERROR);
  }
  if (phase === "verify" && searchable.includes("expired")) {
    return new Error(EMAIL_OTP_EXPIRED_ERROR);
  }
  return new Error(
    phase === "verify" ? EMAIL_OTP_INVALID_ERROR : EMAIL_OTP_SEND_ERROR,
  );
}

export async function requestEmailOtp(email: string): Promise<void> {
  const normalizedEmail = email.trim();
  if (!normalizedEmail) throw new Error("メールアドレスを入力してください。");

  const { error } = await getSupabaseClient().auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      shouldCreateUser: true,
    },
  });
  if (error) throw emailOtpError(error, "request");
}

export async function verifyEmailOtp(
  email: string,
  token: string,
): Promise<Session> {
  const normalizedEmail = email.trim();
  const normalizedToken = token.trim();
  if (!normalizedEmail) throw new Error("メールアドレスを入力してください。");
  if (!/^\d{6}$/.test(normalizedToken)) {
    throw new Error(EMAIL_OTP_INVALID_ERROR);
  }

  const client = getSupabaseClient();
  const { data, error } = await client.auth.verifyOtp({
    email: normalizedEmail,
    token: normalizedToken,
    type: "email",
  });
  if (error) throw emailOtpError(error, "verify");
  if (data.session) return data.session;

  const { data: current, error: sessionError } = await client.auth.getSession();
  if (sessionError || !current.session) {
    throw emailOtpError(sessionError, "verify");
  }
  return current.session;
}

export async function exchangeCloudAuthCode(code: string): Promise<Session> {
  const normalizedCode = code.trim();
  if (!normalizedCode) throw new Error(CLOUD_AUTH_CALLBACK_ERROR);

  const client = getSupabaseClient();
  const { data, error } = await client.auth.exchangeCodeForSession(normalizedCode);
  if (!error && data.session) return data.session;

  // React development checks or a resumed callback can observe an already
  // established session after the one-time code has been consumed.
  const { data: current } = await client.auth.getSession();
  if (current.session) return current.session;

  throw new Error(CLOUD_AUTH_CALLBACK_ERROR);
}

export async function signOutFromCloud(): Promise<void> {
  const { error } = await getSupabaseClient().auth.signOut();
  if (error) throw error;
}
