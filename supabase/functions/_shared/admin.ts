// Service-role client + small Deno-only helpers.
import { createClient, type SupabaseClient } from "jsr:@supabase/supabase-js@2";

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
export const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// The public functions URL (what Twilio signs and what we hand out as StatusCallback).
export const FUNCTIONS_BASE = (Deno.env.get("PUBLIC_FUNCTIONS_URL") ??
  "https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1").replace(/\/+$/, "");

const NO_SESSION = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

export function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SERVICE_KEY, NO_SESSION);
}

export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, NO_SESSION);
}

/** A client that acts as the caller (their JWT), for RPCs like is_operator(). */
export function userClient(jwt: string): SupabaseClient {
  return createClient(SUPABASE_URL, ANON_KEY, { ...NO_SESSION, global: { headers: { Authorization: `Bearer ${jwt}` } } });
}

export function bearer(req: Request): string | null {
  const h = req.headers.get("authorization") ?? "";
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Verifies the bearer JWT and that its user is the operator. Returns the user id or null. */
export async function requireOperator(req: Request): Promise<string | null> {
  const token = bearer(req);
  if (!token) return null;
  const { data, error } = await adminClient().auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: isOp, error: rpcErr } = await userClient(token).rpc("is_operator");
  if (rpcErr || isOp !== true) return null;
  return data.user.id;
}

export async function getSettings(db: SupabaseClient) {
  const { data, error } = await db.from("settings").select("*").eq("id", 1).single();
  if (error) throw error;
  return data;
}

export async function logEvent(db: SupabaseClient, kind: string, leadId: string | null, summary: string) {
  const { error } = await db.from("events").insert({ kind, lead_id: leadId, summary: summary.slice(0, 500) });
  if (error) console.error("event insert failed", kind, error.message);
}
