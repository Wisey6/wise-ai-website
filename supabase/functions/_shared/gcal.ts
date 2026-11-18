// The person's own Google Calendar: the calendar calls shared by the assistant and the hub, and
// the hub actions on the `gdrive` function that carry out a change involving guests once the
// PERSON presses the button on its card (cal_confirm) or dismiss it (cal_cancel).
//
// RULES THIS FILE ENFORCES
//  - Only the caller's own primary calendar, through the caller's own connection (gmail.ts).
//  - Google emails guests only from cal_confirm (sendUpdates=all). Every change the assistant
//    makes itself is sent with sendUpdates=none and never has guests.
//  - A proposal is carried out once, only by the member it was made for, within 24 hours.
import * as M from "./gmail.ts";
import type * as G from "./gdrive.ts";

type Row = Record<string, unknown>;
// deno-lint-ignore no-explicit-any
type Db = any;
const enc1 = encodeURIComponent;
export const EVENTS = `${M.CALENDAR}/calendars/primary/events`;
export const CAL_ACTIONS = ["cal_confirm", "cal_cancel"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const EVENT_ID = /^[A-Za-z0-9_@.-]{1,1024}$/;

export const CAL_MESSAGES: Record<string, string> = {
  not_found: "That calendar change is no longer here.",
  expired: "That change waited more than a day, so it was dropped. Ask the assistant again.",
  done: "That change was already made.",
  cancelled: "That change was cancelled.",
  working: "That change is being made.",
  event_gone: "That event is no longer in your calendar.",
};
const fail = (code: string, extra: Row = {}): M.Result => {
  const base = M.mailFail(code, extra);
  return CAL_MESSAGES[code] ? { status: code === "not_found" || code === "event_gone" ? 404 : 409, body: { ...base.body, message: CAL_MESSAGES[code] } } : base;
};

/** One calendar call through the person's own client (errors as calendar codes). */
export async function cal(g: M.GoogleClient, method: string, url: string, body?: unknown): Promise<Row> {
  return await g.call(method, url, body, "calendar");
}

const COLS = "id, member_id, chat_id, action, event_id, payload, title, when_text, guests, location, status, created_at, expires_at, done_at, result_event_id";
export function proposalView(r: Row): Row {
  return { proposal_id: r.id, action: r.action, title: r.title, when: r.when_text, guests: r.guests ?? [], location: r.location ?? null, status: r.status, expires_at: r.expires_at, done_at: r.done_at ?? null };
}

/** cal_confirm / cal_cancel for the signed-in member's own proposal. */
export async function runCalAction(ctx: { db: Db; env: G.Env; member: G.Member; fetchImpl?: typeof fetch; now?: Date }, body: Row): Promise<M.Result> {
  const action = String(body.action ?? "");
  const id = String(body.proposal_id ?? "");
  if (!UUID.test(id)) return M.mailFail("bad_request");
  try {
    const { data: p, error } = await ctx.db.from("calendar_proposals").select(COLS).eq("id", id).eq("member_id", ctx.member.member_id).maybeSingle();
    if (error) throw new Error(error.message);
    if (!p) return fail("not_found");
    if (p.status !== "pending") return fail(String(p.status), { proposal: proposalView(p) });
    const now = ctx.now ?? new Date();
    if (Date.parse(p.expires_at) < now.getTime()) {
      await mark(ctx.db, id, ctx.member.member_id, { status: "expired" }, "pending");
      return fail("expired", { proposal: proposalView({ ...p, status: "expired" }) });
    }
    if (action === "cal_cancel") {
      const r = await mark(ctx.db, id, ctx.member.member_id, { status: "cancelled", done_at: now.toISOString() }, "pending");
      return { status: 200, body: { ok: true, proposal: proposalView(r ?? { ...p, status: "cancelled" }) } };
    }
    if (action !== "cal_confirm") return M.mailFail("bad_request");
    const open = await M.openMail({ db: ctx.db, env: ctx.env, memberId: ctx.member.member_id, fetchImpl: ctx.fetchImpl });
    if ("error" in open) return M.mailFail(open.error);
    if (!M.hasScope(open.conn, M.SCOPE_CALENDAR)) return M.mailFail("scope_missing");
    const claimed = await mark(ctx.db, id, ctx.member.member_id, { status: "working" }, "pending");
    if (!claimed) return fail("working");
    const payload = (p.payload ?? {}) as Row;
    let resultId: string | null = p.event_id ?? null;
    try {
      if (p.action === "create") {
        const ev = await cal(open.g, "POST", `${EVENTS}?sendUpdates=all`, payload.body);
        resultId = typeof ev.id === "string" ? ev.id : null;
      } else if (p.action === "update") {
        if (!EVENT_ID.test(String(p.event_id))) throw new M.MailError("bad_request");
        await cal(open.g, "PATCH", `${EVENTS}/${enc1(String(p.event_id))}?sendUpdates=all`, payload.body);
      } else if (p.action === "remove") {
        if (!EVENT_ID.test(String(p.event_id))) throw new M.MailError("bad_request");
        await cal(open.g, "DELETE", `${EVENTS}/${enc1(String(p.event_id))}?sendUpdates=all`);
      }
    } catch (e) {
      await mark(ctx.db, id, ctx.member.member_id, { status: "pending" }, "working").catch(() => {});
      if (e instanceof M.MailError && e.code === "not_found") return fail("event_gone");
      throw e;
    }
    const r = await mark(ctx.db, id, ctx.member.member_id, { status: "done", done_at: new Date().toISOString(), result_event_id: resultId }, "working");
    return { status: 200, body: { ok: true, proposal: proposalView(r ?? { ...p, status: "done" }) } };
  } catch (e) {
    if (e instanceof M.MailError) return M.mailFail(e.code);
    throw e;
  }
}

async function mark(db: Db, id: string, member: string, patch: Row, onlyIf: string): Promise<Row | null> {
  const { data, error } = await db.from("calendar_proposals").update(patch).eq("id", id).eq("member_id", member).eq("status", onlyIf).select(COLS);
  if (error) throw new Error(error.message);
  return (data as Row[] | null)?.[0] ?? null;
}
