// cal-webhook: Cal.com booking created / rescheduled / cancelled.
// Paste into Cal.com (Settings -> Developer -> Webhooks), with the same secret as CAL_WEBHOOK_SECRET:
//   https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/cal-webhook
import { adminClient, logEvent } from "../_shared/admin.ts";
import { validCalSignature } from "../_shared/crypto.ts";
import { normalisePhone } from "../_shared/phone.ts";
import { notify } from "../_shared/notify.ts";
import type { SupabaseClient } from "jsr:@supabase/supabase-js@2";

const out = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// deno-lint-ignore no-explicit-any
type Any = any;

function respValue(responses: Any, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = responses?.[k];
    const val = v && typeof v === "object" && "value" in v ? v.value : v;
    if (typeof val === "string" && val.trim()) return val.trim();
  }
  return null;
}

async function findOrCreateLead(db: SupabaseClient, name: string | null, email: string | null, phone: string | null) {
  if (phone) {
    const { data } = await db.from("leads").select("*").eq("phone", phone).maybeSingle();
    if (data) return data;
  }
  if (email) {
    const pattern = email.replace(/[\\%_]/g, (c) => "\\" + c);
    const { data } = await db.from("leads").select("*").ilike("email", pattern).order("created_at").limit(1);
    if (data?.[0]) return data[0];
  }
  const { data, error } = await db.from("leads").insert({
    contact_name: name, email, phone, source: "booking", status: "booked",
  }).select("*").single();
  if (error) throw error;
  return data;
}

function when(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("en-AU", { timeZone: "Australia/Brisbane", dateStyle: "medium", timeStyle: "short" });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return out(405, { ok: false, error: "method_not_allowed" });
  try {
    const raw = await req.text();
    const ok = await validCalSignature(Deno.env.get("CAL_WEBHOOK_SECRET"), raw, req.headers.get("x-cal-signature-256"));
    if (!ok) return out(403, { ok: false, error: "forbidden" });

    let evt: Any;
    try { evt = JSON.parse(raw); } catch { return out(400, { ok: false, error: "bad_json" }); }
    const trigger = String(evt?.triggerEvent ?? "");
    const p = evt?.payload ?? {};
    if (!["BOOKING_CREATED", "BOOKING_RESCHEDULED", "BOOKING_CANCELLED"].includes(trigger) || !p.uid) {
      return out(200, { ok: true, ignored: true }); // PING and other events
    }

    const db = adminClient();
    const att = Array.isArray(p.attendees) ? p.attendees[0] ?? {} : {};
    const name = (att.name || respValue(p.responses, "name")) ?? null;
    const email = ((att.email || respValue(p.responses, "email")) ?? "").toLowerCase().trim() || null;
    const phone = normalisePhone(att.phoneNumber || respValue(p.responses, "attendeePhoneNumber", "phone", "phoneNumber", "smsReminderNumber"));
    const lead = await findOrCreateLead(db, name, email, phone);
    const cancelled = trigger === "BOOKING_CANCELLED";

    const oldUid = trigger === "BOOKING_RESCHEDULED" ? (p.rescheduleUid ?? p.fromReschedule ?? null) : null;
    if (oldUid && oldUid !== p.uid) {
      await db.from("bookings").update({ status: "rescheduled" }).eq("cal_uid", oldUid);
    }

    const row = {
      cal_uid: String(p.uid),
      lead_id: lead.id,
      title: p.title ?? null,
      starts_at: p.startTime ?? null,
      ends_at: p.endTime ?? null,
      attendee_name: name,
      attendee_email: email,
      attendee_phone: phone,
      status: cancelled ? "cancelled" : "booked",
      meeting_url: p.metadata?.videoCallUrl ?? (typeof p.location === "string" && /^https?:\/\//.test(p.location) ? p.location : null),
      raw: evt,
    };
    const { data: booking, error } = await db.from("bookings").upsert(row, { onConflict: "cal_uid" }).select("id").single();
    if (error) throw error;

    // Fill gaps on the lead from the booking.
    const patch: Record<string, unknown> = {};
    if (!lead.contact_name && name) patch.contact_name = name;
    if (!lead.email && email) patch.email = email;
    if (!lead.phone && phone) patch.phone = phone;
    if (cancelled) {
      if (lead.status === "booked") patch.status = "interested";
    } else if (!["won", "dnc"].includes(lead.status)) {
      patch.status = "booked";
      patch.next_followup_at = null;
    }
    if (Object.keys(patch).length) {
      const { error: upErr } = await db.from("leads").update(patch).eq("id", lead.id);
      if (upErr) console.error("lead update failed", upErr.message);
    }

    const who = lead.business || name || email || phone || "Someone";
    const verb = cancelled ? "cancelled" : trigger === "BOOKING_RESCHEDULED" ? "rescheduled" : "booked";
    const summary = `${who} ${verb} a call${p.startTime ? ` for ${when(p.startTime)}` : ""}`;
    await logEvent(db, cancelled ? "booking_cancelled" : "booking", lead.id, summary);
    await notify(db, `Call ${verb}: ${who}`, `${summary}.\n${p.title ?? ""}`, "bookings");

    return out(200, { ok: true, booking_id: booking.id });
  } catch (e) {
    console.error("cal-webhook error", (e as Error).message);
    return out(500, { ok: false, error: "server_error" });
  }
});
