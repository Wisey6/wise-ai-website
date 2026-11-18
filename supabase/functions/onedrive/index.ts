// onedrive: the hub's window onto the business OneDrive (a personal Microsoft account), read
// live through Microsoft Graph. verify_jwt is off: this function does its own auth.
//
//   GET  ?code&state | ?error&state      Microsoft's redirect after sign-in (the registered
//        redirect URI is exactly this function's URL). Validates the signed state, stores the
//        tokens and sends the browser to https://wise-ai.au/os/?onedrive=<result>#files where
//        result is connected | denied | expired | bad_state | not_owner | not_configured | busy | error.
//
//   POST {action, ...} with a signed-in team member's JWT (401 otherwise):
//     status                        → {configured, connected, needs_reconnect, can_connect, owner_name, account:{name, connected_at, connected_by, root_id}|null}
//     connect_url        (owner)    → {url, expires_in}
//     disconnect         (owner)    → {connected:false}
//     list {item_id?, cursor?, with_path?}  → {folder, items[], cursor|null, path[]|null}
//     folders {item_id?}            → same as list, folders only, always with path (the move picker)
//     search {q}                    → {q, items[]}
//     item {id, with_path?}         → {item, download_url|null (short-lived, about an hour), path|null, links[]}
//     move {id, parent_id}          → {item, change}
//     rename {id, name}             → {item, change}
//     create_folder {parent_id?, name} → {item, change}
//     undo {change_id}              → {item, change}
//     link {item_id, kind: client|project|deal|lead, record_id} → {link}
//     unlink {link_id}              → {unlinked}
//   Every response has ok. Failures: {ok:false, error, message} with error one of not_configured,
//   not_connected, reconnect_needed, busy (+retry_after_s), not_found, name_taken, bad_name,
//   changed_since, already_undone, not_undoable, outside_drive, bad_move, locked, drive_full,
//   forbidden, owner_only, bad_request, ms_error, unauthorized, server_error.
//   Item shape and every action live in ../_shared/onedrive.ts (shared with the assistant).
import { corsHeaders, json } from "../_shared/cors.ts";
import { adminClient, bearer } from "../_shared/admin.ts";
import { handleCallback, runAction, type Member } from "../_shared/onedrive.ts";

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
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  const db = adminClient();

  if (req.method === "GET") {
    const params = new URL(req.url).searchParams;
    if (!params.has("state") && !params.has("code") && !params.has("error")) {
      return new Response("Not found", { status: 404, headers: { "content-type": "text/plain" } });
    }
    const to = await handleCallback({ db, env, params });
    return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store", "referrer-policy": "no-referrer" } });
  }

  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });
  try {
    const member = await sessionMember(req, db);
    if (!member) return json(req, 401, { ok: false, error: "unauthorized", message: "Sign in again." });
    const body = await req.json().catch(() => ({}));
    if (!body || typeof body !== "object") return json(req, 400, { ok: false, error: "bad_request" });
    const r = await runAction({ db, env, member, source: "hub" }, body as Record<string, unknown>);
    return json(req, r.status, r.body);
  } catch (e) {
    console.error("onedrive", (e as Error).message);
    return json(req, 500, { ok: false, error: "server_error", message: "Something went wrong on our side." });
  }
});
