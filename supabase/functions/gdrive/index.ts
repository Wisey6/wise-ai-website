// gdrive: the hub's window onto the business Google Drive (the Google Workspace account), read
// live through the Drive API v3. verify_jwt is off: this function does its own auth.
//
//   GET ?code&state | ?error&state   Google's redirect after sign-in (the registered redirect URI is
//       exactly this function's URL). Checks the signed state and sends the browser to
//       https://wise-ai.au/os/?drive=<result>#files (connected | denied | expired | bad_state |
//       not_owner | not_in_org | no_refresh | scope_missing | not_configured | busy | error).
//   GET ?f=<signed token>            streams one thumbnail, preview (image, PDF, video, a Google
//       Doc/Sheet/Slides as PDF) or download for an hour after the hub asked for it.
//   POST {action, ...} with a signed-in team member's JWT: the same actions and shapes as the
//       onedrive function (status, connect_url, disconnect, list, folders, search, item, move,
//       rename, create_folder, undo, link, unlink). See ../_shared/gdrive.ts and supabase/README.md.
//   POST {action:'mail_status'|'mail_connect_url'|'mail_disconnect'|'mail_send'|'mail_discard', ...}:
//       the CALLER's own Google account (Gmail and calendar), see ../_shared/gmail.ts. The redirect
//       URI is shared: a state signed with purpose 'gmail' comes back to /os/?mail=<result>#settings.
import { corsHeaders, json } from "../_shared/cors.ts";
import { adminClient, bearer } from "../_shared/admin.ts";
import { handleFile, runAction, type Member } from "../_shared/gdrive.ts";
import { MAIL_ACTIONS, routeCallback, runMailAction } from "../_shared/gmail.ts";

const env = (k: string) => Deno.env.get(k);

async function sessionMember(req: Request, db: ReturnType<typeof adminClient>): Promise<Member | null> {
  const token = bearer(req);
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  const { data: m, error: mErr } = await db.rpc("hq_member_for_user", { p_user_id: data.user.id });
  if (mErr || !m?.member_id) return null;
  return m as Member;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...corsHeaders(req), "Access-Control-Allow-Methods": "GET, POST, OPTIONS" } });
  const db = adminClient();

  if (req.method === "GET") {
    const params = new URL(req.url).searchParams;
    if (params.has("f")) {
      const r = await handleFile({ db, env, token: params.get("f") });
      const cors = corsHeaders(req);
      return new Response(r.body, { status: r.status, headers: { ...r.headers, "Access-Control-Allow-Origin": cors["Access-Control-Allow-Origin"], Vary: "Origin", "referrer-policy": "no-referrer" } });
    }
    if (!params.has("state") && !params.has("code") && !params.has("error")) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    const to = await routeCallback({ db, env, params });
    return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }

  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });
  try {
    const member = await sessionMember(req, db);
    if (!member) return json(req, 401, { ok: false, error: "unauthorized", message: "Sign in again." });
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object") return json(req, 400, { ok: false, error: "bad_request" });
    const action = String((body as Record<string, unknown>).action ?? "");
    const r = MAIL_ACTIONS.includes(action)
      ? await runMailAction({ db, env, member }, body as Record<string, unknown>)
      : await runAction({ db, env, member, source: "hub" }, body as Record<string, unknown>);
    return json(req, r.status, r.body);
  } catch (e) {
    console.error("gdrive", (e as Error).message);
    return json(req, 500, { ok: false, error: "server_error", message: "Something went wrong on our side." });
  }
});
