import { createClient, type SupabaseClient } from "@supabase/supabase-js";

type SupabaseClientGlobal = typeof globalThis & {
  __umaNoteSupabaseClient?: SupabaseClient;
};

function publicKey(): string | undefined {
  return (
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ??
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  );
}

export function isSupabaseConfigured(): boolean {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      publicKey(),
  );
}

export function getSupabaseClient(): SupabaseClient {
  const runtime = globalThis as SupabaseClientGlobal;
  if (runtime.__umaNoteSupabaseClient) {
    return runtime.__umaNoteSupabaseClient;
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = publicKey();
  if (!url || !key) {
    throw new Error(
      "Supabase接続が未設定です。.env.local に NEXT_PUBLIC_SUPABASE_URL と NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY を設定してください。",
    );
  }

  runtime.__umaNoteSupabaseClient = createClient(url, key, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      // PKCE is completed explicitly by /auth/callback. Automatic detection
      // would race with exchangeCodeForSession and can consume the code twice.
      detectSessionInUrl: false,
      flowType: "pkce",
    },
  });
  return runtime.__umaNoteSupabaseClient;
}
