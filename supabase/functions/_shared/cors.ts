// CORS + JSON response helpers shared by every function.

const ALLOWED = [/^https:\/\/(www\.)?wise-ai\.au$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allowed = ALLOWED.some((re) => re.test(origin));
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "https://wise-ai.au",
    "Access-Control-Allow-Headers": "authorization, content-type, apikey, x-client-info",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

export function json(req: Request, status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

/** Returns a response for OPTIONS / non-POST requests, or null to continue. */
export function preflight(req: Request): Response | null {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json(req, 405, { ok: false, error: "method_not_allowed" });
  return null;
}

export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for") ?? "";
  return (xff.split(",")[0] ?? "").trim() || req.headers.get("x-real-ip") || "unknown";
}
