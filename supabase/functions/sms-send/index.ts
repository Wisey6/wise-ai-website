// sms-send: compliant outbound SMS (or logging of a text sent from the operator's own phone).
//   POST {lead_ids:[uuid], template_id?, body?, mode?:'send'|'manual'}  (operator JWT required)
//     200 {results:[{lead_id, ok, status?, error?, body?}], sent, failed}
//     503 {error:'sms_not_configured'} when mode 'send' and the Twilio secrets are missing
//   POST {action:'status'} -> {configured, sent_today, daily_cap, window_open}
import { json, preflight } from "../_shared/cors.ts";
import { adminClient, FUNCTIONS_BASE, getSettings, logEvent, requireOperator } from "../_shared/admin.ts";
import { AU_MOBILE, normalisePhone } from "../_shared/phone.ts";
import { ensureCompliance, renderTemplate } from "../_shared/template.ts";
import { startOfLocalDay, windowOpen } from "../_shared/time.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LEADS = 200;

function twilio() {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID");
  const token = Deno.env.get("TWILIO_AUTH_TOKEN");
  const from = Deno.env.get("TWILIO_FROM_NUMBER");
  return sid && token && from ? { sid, token, from } : null;
}

async function sentToday(db: SupabaseClient, tz: string): Promise<number> {
  const since = startOfLocalDay(new Date(), tz || "Australia/Brisbane").toISOString();
  const { count, error } = await db.from("messages").select("id", { count: "exact", head: true })
    .eq("direction", "out").eq("channel", "sms").in("status", ["queued", "sent", "delivered"])
    .gte("created_at", since);
  if (error) throw error;
  return count ?? 0;
}

async function twilioSend(cfg: { sid: string; token: string; from: string }, to: string, body: string) {
  const form = new URLSearchParams({ To: to, Body: body, StatusCallback: `${FUNCTIONS_BASE}/twilio-webhook` });
  // A Messaging Service SID (MG...) can be used in place of a from number.
  if (cfg.from.startsWith("MG")) form.set("MessagingServiceSid", cfg.from); else form.set("From", cfg.from);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${cfg.sid}/Messages.json`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${cfg.sid}:${cfg.token}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: form,
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) return { ok: false as const, error: `twilio_${data.code ?? res.status}`, message: String(data.message ?? "") };
  return { ok: true as const, sid: String(data.sid) };
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  try {
    if (!(await requireOperator(req))) return json(req, 401, { error: "unauthorized" });
    const input = await req.json().catch(() => ({}));
    const db = adminClient();
    const settings = await getSettings(db);
    const cfg = twilio();

    if (input.action === "status") {
      return json(req, 200, {
        configured: !!cfg,
        sent_today: await sentToday(db, settings.timezone),
        daily_cap: settings.daily_cap,
        window_open: windowOpen(new Date(), settings),
      });
    }

    const mode = input.mode === "manual" ? "manual" : "send";
    if (mode === "send" && !cfg) return json(req, 503, { error: "sms_not_configured" });

    const ids: string[] = Array.isArray(input.lead_ids)
      ? [...new Set(input.lead_ids.filter((x: unknown) => typeof x === "string" && UUID.test(x)))] as string[]
      : [];
    if (!ids.length) return json(req, 400, { error: "no_leads" });
    if (ids.length > MAX_LEADS) return json(req, 400, { error: "too_many_leads", max: MAX_LEADS });

    let template: { id: string; step: number; body: string; campaign_id: string | null } | null = null;
    if (input.template_id) {
      if (typeof input.template_id !== "string" || !UUID.test(input.template_id)) return json(req, 400, { error: "template_not_found" });
      const { data } = await db.from("templates").select("id, step, body, campaign_id").eq("id", input.template_id).maybeSingle();
      if (!data) return json(req, 400, { error: "template_not_found" });
      template = data;
    }
    const customBody = typeof input.body === "string" && input.body.trim() ? input.body.slice(0, 1600) : null;
    const source = customBody ?? template?.body;
    if (!source) return json(req, 400, { error: "no_body" });

    // Next cold step after the template used (same campaign scope as the template).
    let nextStep: { step: number; delay_days: number } | null = null;
    if (template && template.step < 90) {
      let q = db.from("templates").select("step, delay_days").eq("active", true)
        .gt("step", template.step).lt("step", 90).order("step", { ascending: true }).limit(1);
      q = template.campaign_id ? q.eq("campaign_id", template.campaign_id) : q.is("campaign_id", null);
      const { data } = await q;
      nextStep = data?.[0] ?? null;
    }

    const { data: leads, error: leadErr } = await db.from("leads").select("*").in("id", ids);
    if (leadErr) throw leadErr;
    const byId = new Map(leads.map((l) => [l.id, l]));
    const phones = leads.map((l) => normalisePhone(l.phone)).filter(Boolean) as string[];
    const { data: sup } = phones.length
      ? await db.from("suppressions").select("phone").in("phone", phones)
      : { data: [] as { phone: string }[] };
    const suppressed = new Set((sup ?? []).map((s) => s.phone));
    const { data: inbound } = await db.from("messages").select("lead_id").in("lead_id", ids).eq("direction", "in");
    const replied = new Set((inbound ?? []).map((m) => m.lead_id));

    const open = windowOpen(new Date(), settings);
    let today = mode === "send" ? await sentToday(db, settings.timezone) : 0;
    const results: Record<string, unknown>[] = [];
    let sent = 0, failed = 0;
    const fail = (lead_id: string, error: string, body?: string) => {
      failed++;
      results.push(body ? { lead_id, ok: false, error, body } : { lead_id, ok: false, error });
    };

    for (const id of ids) {
      const lead = byId.get(id);
      if (!lead) { fail(id, "not_found"); continue; }
      if (lead.archived) { fail(id, "archived"); continue; }
      if (lead.status === "dnc") { fail(id, "dnc"); continue; }
      if (!lead.phone) { fail(id, "no_phone"); continue; }
      const phone = normalisePhone(lead.phone);
      if (phone && suppressed.has(phone)) { fail(id, "suppressed"); continue; }
      if (!phone || !AU_MOBILE.test(phone)) { fail(id, "not_au_mobile"); continue; }
      const hasReplied = replied.has(id);
      if (["import", "manual"].includes(lead.source) && !hasReplied && !String(lead.number_source_url ?? "").trim()) {
        fail(id, "no_number_source"); continue;
      }
      if (settings.require_hook && template?.step === 0 && !hasReplied && !String(lead.hook ?? "").trim()) {
        fail(id, "no_hook"); continue;
      }
      let text = renderTemplate(source, lead, settings);
      if (!hasReplied) text = ensureCompliance(text, settings);
      if (!text) { fail(id, "empty_body"); continue; }

      let sid: string | null = null;
      if (mode === "send") {
        if (!hasReplied && !open) { fail(id, "outside_window", text); continue; }
        if (!hasReplied && today >= settings.daily_cap) { fail(id, "daily_cap", text); continue; }
        const r = await twilioSend(cfg!, phone, text);
        if (!r.ok) {
          await db.from("messages").insert({
            lead_id: id, direction: "out", channel: "sms", body: text, status: "failed",
            error: `${r.error} ${r.message}`.trim().slice(0, 500), template_id: template?.id ?? null,
          });
          fail(id, r.error, text); continue;
        }
        sid = r.sid;
        today++;
      }

      const now = new Date();
      const status = mode === "manual" ? "manual" : "sent";
      const { error: msgErr } = await db.from("messages").insert({
        lead_id: id, direction: "out", channel: "sms", body: text, status,
        provider_sid: sid, template_id: template?.id ?? null, sent_at: now.toISOString(),
      });
      if (msgErr) console.error("message insert failed", msgErr.message);

      const patch: Record<string, unknown> = { last_contacted_at: now.toISOString() };
      if (lead.status === "new" || lead.status === "queued") patch.status = "contacted";
      if (template && template.step < 90) {
        patch.sequence_step = template.step + 1;
        patch.next_followup_at = nextStep ? new Date(now.getTime() + nextStep.delay_days * 86400000).toISOString() : null;
      }
      const { error: upErr } = await db.from("leads").update(patch).eq("id", id);
      if (upErr) console.error("lead update failed", upErr.message);

      const stepLabel = template ? (template.step < 90 ? ` (step ${template.step})` : " (quick reply)") : "";
      await logEvent(db, "sms_sent", id, `${mode === "manual" ? "SMS sent from own phone" : "SMS sent"}${stepLabel} to ${lead.business || lead.contact_name || phone}`);
      sent++;
      results.push({ lead_id: id, ok: true, status, body: text });
    }

    return json(req, 200, { results, sent, failed });
  } catch (e) {
    console.error("sms-send error", (e as Error).message);
    return json(req, 500, { error: "server_error" });
  }
});
