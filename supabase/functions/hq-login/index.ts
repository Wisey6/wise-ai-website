// hq-login: PIN -> operator session, without a password.
//   POST {pin, device_token?}
//     200 {ok:true, access_token, refresh_token, expires_at, device_token|null}
//     401 {ok:false, error:'bad_pin', remaining} | 423 {ok:false, error:'locked', retry_after_s}
//   POST {action:'change_pin', pin, new_pin, device_token?}  (+ operator JWT in Authorization)
//     200 {ok:true} | 400 {ok:false, error:'weak_pin'} | 401/423 as above | 401 {error:'unauthorized'}
import { clientIp, json, preflight } from "../_shared/cors.ts";
import { adminClient, anonClient, requireOperator } from "../_shared/admin.ts";

function pinError(req: Request, r: Record<string, unknown>): Response {
  switch (r.error) {
    case "bad_pin": return json(req, 401, { ok: false, error: "bad_pin", remaining: r.remaining });
    case "locked": return json(req, 423, { ok: false, error: "locked", retry_after_s: r.retry_after_s });
    case "weak_pin": return json(req, 400, { ok: false, error: "weak_pin" });
    default: return json(req, 500, { ok: false, error: String(r.error ?? "server_error") });
  }
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" && v.length > 0 && v.length <= max ? v : null;
}

Deno.serve(async (req) => {
  const early = preflight(req);
  if (early) return early;
  try {
    const body = await req.json().catch(() => ({}));
    const pin = str(body.pin, 32);
    const deviceToken = str(body.device_token, 128);
    const ip = clientIp(req);
    const db = adminClient();

    if (body.action === "change_pin") {
      if (!(await requireOperator(req))) return json(req, 401, { ok: false, error: "unauthorized" });
      const newPin = typeof body.new_pin === "string" ? body.new_pin : "";
      if (!/^[0-9]{4,12}$/.test(newPin)) return json(req, 400, { ok: false, error: "weak_pin" });
      const { data, error } = await db.rpc("hq_change_pin", {
        p_old: pin, p_new: newPin, p_device_token: deviceToken, p_ip: ip,
      });
      if (error) throw error;
      return data?.ok ? json(req, 200, { ok: true }) : pinError(req, data ?? {});
    }

    if (!pin) return json(req, 400, { ok: false, error: "pin_required" });
    const { data: r, error } = await db.rpc("hq_verify_pin", { p_pin: pin, p_device_token: deviceToken, p_ip: ip });
    if (error) throw error;
    if (!r?.ok) return pinError(req, r ?? {});

    // Mint a session for the operator: a one-time magic-link token, redeemed immediately.
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
    });
  } catch (e) {
    console.error("hq-login error", (e as Error).message);
    return json(req, 500, { ok: false, error: "server_error" });
  }
});
