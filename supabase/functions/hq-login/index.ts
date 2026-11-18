// hq-login: who can sign in, PIN -> session (no password), PIN changes, and team management.
//   POST {action:'who'}                               (public)
//     200 {ok:true, people:[{id, name, initials}]}     the names shown on the lock screen
//   POST {pin, member_id?, device_token?}              (public; member_id omitted = the owner)
//     200 {ok:true, access_token, refresh_token, expires_at, device_token|null, member:{id,name,role}}
//     401 {ok:false, error:'bad_pin', remaining} | 423 {ok:false, error:'locked', retry_after_s}
//   POST {action:'change_pin', pin, new_pin, device_token?}     (+ session JWT; changes your own PIN)
//     200 {ok:true} | 400 weak_pin | 401/423 as above | 401 unauthorized
//   POST {action:'team_save', member:{id?, name, initials?, active?, sort?}, sign_in?:boolean, pin?}
//     (+ session JWT of the OWNER) create or update a team member; `sign_in:true` with a `pin`
//     gives a new person a login; `pin` on an existing login resets it.
//     200 {ok:true, member} | 400 bad_request|weak_pin | 401 unauthorized | 403 owner_only
//     `email` sets the address a PIN reset is sent to (owner only; your own via action 'set_email').
//   POST {action:'me'}                                  (+ session JWT) → {ok:true, member:{id,name,role,email_hint}}
//   POST {action:'set_email', email}                    (+ session JWT) set your own reset address
//   POST {action:'reset_request', member_id}            (public) emails a one-time link to the address on file.
//     Always 200 {ok:true} whether or not an address exists, except 503 {error:'email_not_configured'}
//     and 429 {error:'too_many'}.
//   POST {action:'reset_confirm', token, new_pin}       (public) 200 {ok:true} | 400 weak_pin | 401 bad_token
import { clientIp, json, preflight } from "../_shared/cors.ts";
import { adminClient, anonClient, bearer } from "../_shared/admin.ts";

function pinError(req: Request, r: Record<string, unknown>): Response {
  switch (r.error) {
    case "bad_pin": return json(req, 401, { ok: false, error: "bad_pin", remaining: r.remaining ?? null });
    case "locked": return json(req, 423, { ok: false, error: "locked", retry_after_s: r.retry_after_s });
    case "weak_pin": return json(req, 400, { ok: false, error: "weak_pin" });
    default: return json(req, 500, { ok: false, error: String(r.error ?? "server_error") });
  }
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const HUB = "https://wise-ai.au/os/";

/** Send the reset link. Returns 'sent' | 'not_configured' | 'failed'. Never throws. */
async function sendResetEmail(to: string, name: string, token: string): Promise<"sent" | "not_configured" | "failed"> {
  const key = Deno.env.get("RESEND_API_KEY");
  if (!key) return "not_configured";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "Wise AI OS <dailybrief@wise-ai.au>",
        to: [to],
        subject: "Reset your Wise AI OS PIN",
        text: `Hi ${name},\n\nSomeone asked to reset the PIN for your Wise AI OS login. If that was you, open this link within 20 minutes and choose a new PIN:\n\n${HUB}#reset/${token}\n\nThe link works once. If you did not ask for this, ignore this email and your PIN stays as it is.\n`,
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) console.error("reset email failed", res.status);
    return res.ok ? "sent" : "failed";
  } catch (e) {
    console.error("reset email error", (e as Error).message);
    return "failed";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PIN = /^[0-9]{4,12}$/;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.trim().slice(0, 2)).toUpperCase();
}

type Member = { member_id: string; name: string; role: string; email_hint?: string | null };

/** The signed-in team member behind the request's JWT, or null. */
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
  const early = preflight(req);
  if (early) return early;
  try {
    const body = await req.json().catch(() => ({}));
    const db = adminClient();
    const ip = clientIp(req);
    const deviceToken = str(body.device_token, 128);

    if (body.action === "who") {
      const { data, error } = await db.from("team_members").select("id, name, initials")
        .eq("active", true).eq("can_sign_in", true).order("sort").order("created_at");
      if (error) throw error;
      return json(req, 200, { ok: true, people: data ?? [] });
    }

    if (body.action === "reset_request") {
      if (!Deno.env.get("RESEND_API_KEY")) return json(req, 503, { ok: false, error: "email_not_configured" });
      const memberId = typeof body.member_id === "string" && UUID.test(body.member_id) ? body.member_id : null;
      if (!memberId) return json(req, 400, { ok: false, error: "bad_request" });
      const { data, error } = await db.rpc("hq_reset_start", { p_member: memberId });
      if (error) throw error;
      if (data?.error === "too_many") return json(req, 429, { ok: false, error: "too_many" });
      if (data?.ok) await sendResetEmail(data.email, data.name, data.token);
      // Same answer whether or not an address is on file, so the form cannot be used to probe.
      return json(req, 200, { ok: true });
    }

    if (body.action === "reset_confirm") {
      const newPin = typeof body.new_pin === "string" ? body.new_pin : "";
      if (!PIN.test(newPin)) return json(req, 400, { ok: false, error: "weak_pin" });
      const { data, error } = await db.rpc("hq_reset_finish", { p_token: str(body.token, 128), p_new: newPin });
      if (error) throw error;
      if (data?.ok) return json(req, 200, { ok: true });
      return json(req, data?.error === "weak_pin" ? 400 : 401, { ok: false, error: data?.error ?? "bad_token" });
    }

    if (body.action === "me") {
      const me = await sessionMember(req, db);
      if (!me) return json(req, 401, { ok: false, error: "unauthorized" });
      return json(req, 200, { ok: true, member: { id: me.member_id, name: me.name, role: me.role, email_hint: me.email_hint ?? null } });
    }

    if (body.action === "set_email") {
      const me = await sessionMember(req, db);
      if (!me) return json(req, 401, { ok: false, error: "unauthorized" });
      const email = typeof body.email === "string" ? body.email.trim() : "";
      if (email && !EMAIL.test(email)) return json(req, 400, { ok: false, error: "bad_request", detail: "That does not look like an email address." });
      const { error } = await db.rpc("hq_team_set_email", { p_member: me.member_id, p_email: email });
      if (error) throw error;
      return json(req, 200, { ok: true });
    }

    if (body.action === "change_pin") {
      const me = await sessionMember(req, db);
      if (!me) return json(req, 401, { ok: false, error: "unauthorized" });
      const newPin = typeof body.new_pin === "string" ? body.new_pin : "";
      if (!PIN.test(newPin)) return json(req, 400, { ok: false, error: "weak_pin" });
      const { data, error } = await db.rpc("hq_change_pin", {
        p_member: me.member_id, p_old: str(body.pin, 32), p_new: newPin, p_device_token: deviceToken, p_ip: ip,
      });
      if (error) throw error;
      return data?.ok ? json(req, 200, { ok: true }) : pinError(req, data ?? {});
    }

    if (body.action === "team_save") {
      const me = await sessionMember(req, db);
      if (!me) return json(req, 401, { ok: false, error: "unauthorized" });
      if (me.role !== "owner") return json(req, 403, { ok: false, error: "owner_only" });
      const m = (body.member && typeof body.member === "object") ? body.member as Record<string, unknown> : {};
      const name = str(typeof m.name === "string" ? m.name.trim() : null, 60);
      const pin = typeof body.pin === "string" && body.pin.length ? body.pin : null;
      if (pin && !PIN.test(pin)) return json(req, 400, { ok: false, error: "weak_pin" });

      let id = typeof m.id === "string" && UUID.test(m.id) ? m.id : null;
      if (!id) {
        if (!name) return json(req, 400, { ok: false, error: "bad_request", detail: "A name is needed." });
        if (body.sign_in === true && !pin) return json(req, 400, { ok: false, error: "weak_pin" });
        const { data, error } = await db.from("team_members").insert({
          name, initials: str(typeof m.initials === "string" ? m.initials.trim().toUpperCase() : null, 3) ?? initialsOf(name),
          sort: Number.isFinite(Number(m.sort)) ? Number(m.sort) : 10,
        }).select().single();
        if (error) throw error;
        id = data.id as string;
      } else {
        const { data: existing, error: exErr } = await db.from("team_members").select("*").eq("id", id).maybeSingle();
        if (exErr) throw exErr;
        if (!existing) return json(req, 400, { ok: false, error: "bad_request", detail: "That person no longer exists." });
        const patch: Record<string, unknown> = {};
        if (name) patch.name = name;
        if (typeof m.initials === "string" && m.initials.trim()) patch.initials = m.initials.trim().toUpperCase().slice(0, 3);
        if (Number.isFinite(Number(m.sort)) && m.sort !== undefined) patch.sort = Number(m.sort);
        if (typeof m.active === "boolean") {
          // The owner cannot switch themselves off: someone must always be able to manage the team.
          if (!m.active && (existing.role === "owner" || id === me.member_id)) {
            return json(req, 400, { ok: false, error: "bad_request", detail: "The owner's login cannot be switched off." });
          }
          patch.active = m.active;
        }
        if (Object.keys(patch).length) {
          const { error } = await db.from("team_members").update(patch).eq("id", id);
          if (error) throw error;
        }
      }

      if (pin) {
        // Reset an existing login's PIN, or create the login if this person has none yet.
        const { data: set, error: setErr } = await db.rpc("hq_team_set_pin", { p_member: id, p_new: pin });
        if (setErr) throw setErr;
        if (!set?.ok && set?.error === "not_found") {
          if (body.sign_in !== true) return json(req, 400, { ok: false, error: "bad_request", detail: "That person has no login yet." });
          const email = `hq-${crypto.randomUUID()}@wise-ai.au`;
          const password = crypto.randomUUID() + crypto.randomUUID();
          const { data: created, error: cErr } = await db.auth.admin.createUser({ email, password, email_confirm: true });
          if (cErr || !created?.user) throw cErr ?? new Error("could not create the login");
          const { data: added, error: aErr } = await db.rpc("hq_team_add_login", {
            p_member: id, p_user_id: created.user.id, p_email: email, p_pin: pin,
          });
          if (aErr) throw aErr;
          if (!added?.ok) return pinError(req, added ?? {});
        } else if (!set?.ok) {
          return pinError(req, set ?? {});
        }
      }
      if (typeof body.email === "string") {
        const email = body.email.trim();
        if (email && !EMAIL.test(email)) return json(req, 400, { ok: false, error: "bad_request", detail: "That does not look like an email address." });
        const { data: se, error: seErr } = await db.rpc("hq_team_set_email", { p_member: id, p_email: email });
        if (seErr) throw seErr;
        if (!se?.ok) return json(req, 400, { ok: false, error: "bad_request", detail: "That person has no login to attach an email to." });
      }
      const { data: member, error: gErr } = await db.from("team_members").select("*").eq("id", id).single();
      if (gErr) throw gErr;
      return json(req, 200, { ok: true, member });
    }

    // Sign in.
    const pin = str(body.pin, 32);
    if (!pin) return json(req, 400, { ok: false, error: "pin_required" });
    const memberId = typeof body.member_id === "string" && UUID.test(body.member_id) ? body.member_id : null;
    const { data: r, error } = memberId
      ? await db.rpc("hq_verify_pin", { p_member: memberId, p_pin: pin, p_device_token: deviceToken, p_ip: ip })
      : await db.rpc("hq_verify_pin", { p_pin: pin, p_device_token: deviceToken, p_ip: ip });
    if (error) throw error;
    if (!r?.ok) return pinError(req, r ?? {});

    // Mint a session for that person: a one-time magic-link token, redeemed immediately.
    const { data: link, error: linkErr } = await db.auth.admin.generateLink({ type: "magiclink", email: r.operator_email });
    if (linkErr || !link?.properties?.hashed_token) throw linkErr ?? new Error("no hashed_token");
    const { data: otp, error: otpErr } = await anonClient().auth.verifyOtp({
      token_hash: link.properties.hashed_token, type: "email",
    });
    if (otpErr || !otp?.session) throw otpErr ?? new Error("no session");

    return json(req, 200, {
      ok: true,
      access_token: otp.session.access_token,
      refresh_token: otp.session.refresh_token,
      expires_at: otp.session.expires_at,
      device_token: r.device_token ?? null,
      member: { id: r.member_id, name: r.name, role: r.role },
    });
  } catch (e) {
    console.error("hq-login error", (e as Error).message);
    return json(req, 500, { ok: false, error: "server_error" });
  }
});
