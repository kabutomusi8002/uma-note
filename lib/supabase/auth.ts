import type { Session, User } from "@supabase/supabase-js";
import { getSupabaseClient, isSupabaseConfigured } from "@/lib/supabase/client";

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

export async function sendEmailMagicLink(email: string): Promise<void> {
  const normalizedEmail = email.trim();
  if (!normalizedEmail) throw new Error("メールアドレスを入力してください。");
  const { error } = await getSupabaseClient().auth.signInWithOtp({
    email: normalizedEmail,
    options: {
      emailRedirectTo: window.location.origin,
      shouldCreateUser: true,
    },
  });
  if (error) throw error;
}

export async function signOutFromCloud(): Promise<void> {
  const { error } = await getSupabaseClient().auth.signOut();
  if (error) throw error;
}
