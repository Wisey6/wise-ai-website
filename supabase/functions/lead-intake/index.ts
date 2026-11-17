// lead-intake: public website enquiry form.
//   POST {name, email?, phone?, business?, source?, summary?, website?(honeypot)}
//     200 {ok:true} | 400 {ok:false, error} | 429 {ok:false, error:'rate_limited'}
import { json, preflight } from "../_shared/cors.ts";
import { adminClient, logEvent } from "../_shared/admin.ts";
import { normalisePhone } from "../_shared/phone.ts";
import { notify } from "../_shared/notify.ts";

const EMAIL = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[a-z]{2,}$/i;
const MAX_PER_HOUR = 20;

function clean(v: unknown, max: number): string {
  return typeof v === "string" ? v.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim().slice(0, max) : "";
}

async function readBody(req: Request): Promise<Record<string, unknown>> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
    const fd = await req.formData();
    return Object.fromEntries([...fd.entries()].filter(([, v]) => typeof v === "string"));
  }
  const b = await req.json().catch(() => null);
  return b && typeof b === "object" && !Array.isArray(b) ? b : {};
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  try {
    const b = await readBody(req);
    if (clean(b.website, 500)) return json(req, 200, { ok: true }); // honeypot

    const name = clean(b.name, 120);
    const emailRaw = clean(b.email, 254).toLowerCase();
    const phoneRaw = clean(b.phone, 40);
    const business = clean(b.business, 160);
    const formSource = clean(b.source, 60);
    const summary = clean(b.summary, 2000);

    if (!name) return json(req, 400, { ok: false, error: "name_required" });
    if (!emailRaw && !phoneRaw) return json(req, 400, { ok: false, error: "contact_required" });
    if (emailRaw && !EMAIL.test(emailRaw)) return json(req, 400, { ok: false, error: "invalid_email" });
    const phone = phoneRaw ? normalisePhone(phoneRaw) : null;
    if (phoneRaw && !phone) return json(req, 400, { ok: false, error: "invalid_phone" });
    const email = emailRaw || null;

    const db = adminClient();
    let lead = null;
    if (phone) lead = (await db.from("leads").select("*").eq("phone", phone).maybeSingle()).data;
    if (!lead && email) {
      const pattern = email.replace(/[\\%_]/g, (c) => "\\" + c);
      lead = (await db.from("leads").select("*").ilike("email", pattern).order("created_at").limit(1)).data?.[0] ?? null;
    }

    const stamp = new Date().toLocaleDateString("en-CA", { timeZone: "Australia/Brisbane" });
    const note = summary ? `[${stamp} website${formSource ? ` / ${formSource}` : ""}] ${summary}` : "";

    if (lead) {
      const patch: Record<string, unknown> = {};
      if (!lead.contact_name) patch.contact_name = name;
      if (!lead.email && email) patch.email = email;
      if (!lead.phone && phone) patch.phone = phone;
      if (!lead.business && business) patch.business = business;
      if (note) patch.notes = lead.notes ? `${lead.notes}\n\n${note}` : note;
      if (Object.keys(patch).length) {
        const { error } = await db.from("leads").update(patch).eq("id", lead.id);
        if (error) throw error;
      }
    } else {
      const since = new Date(Date.now() - 3600_000).toISOString();
      const { count } = await db.from("leads").select("id", { count: "exact", head: true })
        .eq("source", "website").gte("created_at", since);
      if ((count ?? 0) >= MAX_PER_HOUR) return json(req, 429, { ok: false, error: "rate_limited" });
      const { data, error } = await db.from("leads").insert({
        contact_name: name, email, phone, business: business || null,
        source: "website", status: "interested", notes: note || null,
      }).select("*").single();
      if (error) throw error;
      lead = data;
    }

    const who = business ? `${name} (${business})` : name;
    await logEvent(db, "website_lead", lead.id, `Website enquiry from ${who}${formSource ? ` via ${formSource}` : ""}`);
    await notify(db, `New website lead: ${who}`,
      `${who}\nEmail: ${email ?? "-"}\nPhone: ${phone ?? "-"}\n${summary ? `\n${summary}\n` : ""}`, `leads/${lead.id}`);
    return json(req, 200, { ok: true });
  } catch (e) {
    console.error("lead-intake error", (e as Error).message);
    return json(req, 500, { ok: false, error: "server_error" });
  }
});
