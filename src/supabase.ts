import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";

export function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) throw new Error(`Missing env ${name}. Copy .env.example → .env`);
  return v;
}

let cachedClient: SupabaseClient | null = null;
let refreshTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Prefer PROGRESSO_REFRESH_TOKEN (long-lived) + anon key.
 * Falls back to PROGRESSO_ACCESS_TOKEN for one-shot Inspector use.
 */
export function makeClient(): SupabaseClient {
  if (cachedClient) return cachedClient;

  const url = requireEnv("SUPABASE_URL");
  const anon = requireEnv("SUPABASE_ANON_KEY");
  const refresh = process.env.PROGRESSO_REFRESH_TOKEN?.trim();
  const access = process.env.PROGRESSO_ACCESS_TOKEN?.trim();

  if (refresh) {
    const sb = createClient(url, anon, {
      auth: {
        persistSession: false,
        autoRefreshToken: true,
        detectSessionInUrl: false,
      },
    });
    // Seed session asynchronously; callers must await requireUser first.
    (globalThis as { __progressoRefresh?: string }).__progressoRefresh = refresh;
    if (access) {
      (globalThis as { __progressoAccess?: string }).__progressoAccess = access;
    }
    cachedClient = sb;
    return sb;
  }

  if (!access) {
    throw new Error(
      "Set PROGRESSO_REFRESH_TOKEN (preferred) or PROGRESSO_ACCESS_TOKEN. Never use the service-role key.",
    );
  }

  cachedClient = createClient(url, anon, {
    global: { headers: { Authorization: `Bearer ${access}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return cachedClient;
}

async function ensureSession(sb: SupabaseClient): Promise<User> {
  const refresh = process.env.PROGRESSO_REFRESH_TOKEN?.trim();
  if (refresh) {
    const { data: existing } = await sb.auth.getSession();
    if (!existing.session) {
      const access = process.env.PROGRESSO_ACCESS_TOKEN?.trim();
      if (access) {
        const { error } = await sb.auth.setSession({
          access_token: access,
          refresh_token: refresh,
        });
        if (error) {
          // Access may be expired — refresh only.
          const { data, error: rErr } = await sb.auth.refreshSession({ refresh_token: refresh });
          if (rErr || !data.session) {
            throw new Error(`Auth refresh failed (${rErr?.message ?? "no session"}).`);
          }
        }
      } else {
        const { data, error } = await sb.auth.refreshSession({ refresh_token: refresh });
        if (error || !data.session) {
          throw new Error(
            `Auth refresh failed (${error?.message ?? "no session"}). Re-copy refresh token from a live Progresso session.`,
          );
        }
      }
    }

    if (!refreshTimer) {
      refreshTimer = setInterval(() => {
        void sb.auth.refreshSession();
      }, 20 * 60 * 1000);
      if (typeof refreshTimer === "object" && "unref" in refreshTimer) {
        (refreshTimer as NodeJS.Timeout).unref?.();
      }
    }
  }

  const token =
    process.env.PROGRESSO_REFRESH_TOKEN?.trim()
      ? (await sb.auth.getSession()).data.session?.access_token
      : process.env.PROGRESSO_ACCESS_TOKEN?.trim();

  if (!token) {
    throw new Error("No access token after session setup.");
  }

  const { data, error } = await sb.auth.getUser(token);
  if (error || !data.user) {
    throw new Error(
      `Auth failed (${error?.message ?? "no user"}). Prefer PROGRESSO_REFRESH_TOKEN from Keychain/browser session.`,
    );
  }
  return data.user;
}

export async function requireUser(sb: SupabaseClient): Promise<User> {
  return ensureSession(sb);
}
