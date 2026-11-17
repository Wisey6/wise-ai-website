// twilio-webhook: inbound SMS + delivery status callbacks (form-encoded, signed by Twilio).
// Paste into Twilio (number's "A message comes in" webhook, HTTP POST):
//   https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/twilio-webhook
import { adminClient, FUNCTIONS_BASE, logEvent } from "../_shared/admin.ts";
import { validTwilioSignature } from "../_shared/crypto.ts";
import { normalisePhone } from "../_shared/phone.ts";
import { notify } from "../_shared/notify.ts";

const STOP_WORDS = new Set(["STOP", "STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT", "OPT OUT", "OPTOUT"]);
const STATUS_MAP: Record<string, string> = { delivered: "delivered", failed: "failed", undelivered: "failed", sent: "sent" };

const twiml = () => new Response("<Response></Response>", { status: 200, headers: { "Content-Type": "text/xml" } });
const plain = (status: number, text: string) => new Response(text, { status, headers: { "Content-Type": "text/plain" } });

Deno.serve(async (req) => {
  if (req.method !== "POST") return plain(405, "method not allowed");
  try {
    const raw = await req.text();
    const params = new URLSearchParams(raw);
    // Twilio signs the public URL it was given (plus any query string), not the internal req.url.
    const url = `${FUNCTIONS_BASE}/twilio-webhook${new URL(req.url).search}`;
    const ok = await validTwilioSignature(Deno.env.get("TWILIO_AUTH_TOKEN"), url, params, req.headers.get("x-twilio-signature"));
    if (!ok) return plain(403, "forbidden");

    const db = adminClient();
    const sid = params.get("MessageSid") ?? params.get("SmsSid");
    const msgStatus = params.get("MessageStatus") ?? params.get("SmsStatus");

    // ---- delivery status callback
    if (!params.has("Body") && sid && msgStatus) {
      const mapped = STATUS_MAP[msgStatus.toLowerCase()];
      if (mapped) {
        const patch: Record<string, unknown> = { status: mapped };
        const code = params.get("ErrorCode");
        if (code && mapped === "failed") patch.error = `Twilio error ${code}`;
        let q = db.from("messages").update(patch).eq("provider_sid", sid);
        // Callbacks can arrive out of order: never move delivered/failed back to sent.
        if (mapped === "sent") q = q.in("status", ["queued"]);
        if (mapped === "delivered") q = q.in("status", ["queued", "sent"]);
        const { error } = await q;
        if (error) throw error;
      }
      return twiml();
    }

    // ---- inbound message
    const from = normalisePhone(params.get("From"));
    if (!from) return twiml();
    const body = (params.get("Body") ?? "").slice(0, 2000);
    const isStop = STOP_WORDS.has(body.trim().toUpperCase().replace(/\s+/g, " "));

    let { data: lead } = await db.from("leads").select("*").eq("phone", from).maybeSingle();
    if (!lead) {
      const ins = await db.from("leads").insert({ phone: from, source: "inbound_sms", status: isStop ? "dnc" : "replied" })
        .select("*").single();
      lead = ins.data ?? (await db.from("leads").select("*").eq("phone", from).maybeSingle()).data;
      if (!lead) throw ins.error ?? new Error("lead create failed");
    }
    const name = lead.business || lead.contact_name || from;
    const now = new Date().toISOString();

    // Keep the inbound text on the thread (for STOP it is the opt-out evidence).
    const { error: msgErr } = await db.from("messages").insert({
      lead_id: lead.id, direction: "in", channel: "sms", body: body || "(empty message)", status: "received",
      provider_sid: sid, sent_at: now,
    });
    if (msgErr?.code === "23505") return twiml(); // Twilio retry of a message we already have
    if (msgErr) throw msgErr;

    if (isStop) {
      await db.from("suppressions").upsert({ phone: from, reason: "opt_out" }, { onConflict: "phone" });
      await db.from("leads").update({ status: "dnc", next_followup_at: null }).eq("id", lead.id);
      await logEvent(db, "opt_out", lead.id, `${name} opted out (${body.trim().toUpperCase()})`);
      return twiml();
    }

    const patch: Record<string, unknown> = { last_reply_at: now, unread: true, next_followup_at: null };
    if (["new", "queued", "contacted"].includes(lead.status)) patch.status = "replied";
    await db.from("leads").update(patch).eq("id", lead.id);
    await logEvent(db, "sms_reply", lead.id, `Reply from ${name}: ${body.slice(0, 140)}`);
    await notify(db, `Reply from ${name}`, `${name} (${from}) replied:\n\n${body}`, `inbox/${lead.id}`);
    return twiml();
  } catch (e) {
    console.error("twilio-webhook error", (e as Error).message);
    return plain(500, "error");
  }
});
