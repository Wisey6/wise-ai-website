// wise-ai-inquiry-agent
//
// Cloudflare Worker that proxies the browser → Anthropic Claude with a
// per-IP daily cost cap and a global daily backstop. Browser still does
// TTS / STT (Web Speech API) — this Worker only handles the LLM call.
//
// Pricing model (Claude Haiku 4.5, per-1M tokens):
//   input: $1.00   cache_write: $1.25   cache_read: $0.10   output: $5.00
//
// Caching: the system prompt is marked cache_control: ephemeral, so after
// the first request from any IP, the prefix reads at 10% of input cost.

const SYSTEM_PROMPT = `You are Ottley, the inquiry agent for Wise AI (https://wiseai.website).

About Wise AI:
- Brisbane-based AI consultancy. Owner: Tyler Wise (tyler@wiseai.website).
- Two solutions:
  • AI Audit — $1,347 (fixed). We shadow the team, map workflows, write up where AI pays off and where it doesn't.
  • AI Build — scoped per engagement, fixed fee, paid on completion. Custom agents, automations, owner-led handover.
- Independent. No vendor lock-in. Fixed-fee. Paid on completion.

Your job:
1. Answer questions about pricing, what we do, and how it works.
2. Gather company name, what's eating their team's time, and ideal call time.
3. Point them at the Book a call button on the page or tyler@wiseai.website.

Style:
- Warm and direct. No hype, no AI-jargon, no emoji.
- Short replies — one to three sentences. Ask one question at a time.
- Always quote audit price as $1,347 when relevant. Build is "scoped per engagement, quoted on a call."
- If asked something off-topic, gently redirect to scoping their AI work.`;

// Tunable knobs ---------------------------------------------------------
const MODEL = "claude-haiku-4-5";
const MAX_OUTPUT_TOKENS = 250;
const PER_IP_LIMIT_USD = 0.30;
const GLOBAL_DAILY_LIMIT_USD = 25.00;
const MAX_INPUT_CHARS = 1000;
const MAX_HISTORY = 8;
const ALLOWED_ORIGINS = new Set([
  "https://wiseai.website",
  "https://www.wiseai.website",
  "https://wisey6.github.io",
]);
// -----------------------------------------------------------------------

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: cors });
    }

    const ip = request.headers.get("CF-Connecting-IP") || "unknown";
    const today = new Date().toISOString().slice(0, 10);
    const ipKey = `usage:${today}:ip:${ip}`;
    const globalKey = `usage:${today}:global`;

    const ipUsage = parseFloat((await env.USAGE.get(ipKey)) || "0");
    if (ipUsage >= PER_IP_LIMIT_USD) {
      return json(
        { reply: "I've hit my per-visitor budget for today. Use the Book a call button on the page — we'll chat live." },
        200, cors,
      );
    }
    const globalUsage = parseFloat((await env.USAGE.get(globalKey)) || "0");
    if (globalUsage >= GLOBAL_DAILY_LIMIT_USD) {
      return json(
        { reply: "Inbox is full for today. Drop me a line at tyler@wiseai.website and we'll set a time." },
        200, cors,
      );
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ reply: "Couldn't read that — try again?" }, 400, cors); }

    const userMsg = String(body.message || "").slice(0, MAX_INPUT_CHARS).trim();
    if (!userMsg) return json({ reply: "Sorry, I didn't catch that." }, 200, cors);

    const history = Array.isArray(body.history) ? body.history.slice(-MAX_HISTORY) : [];
    const messages = [
      ...history
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && m.text)
        .map((m) => ({ role: m.role, content: String(m.text).slice(0, 800) })),
      { role: "user", content: userMsg },
    ];

    const apiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: [
          {
            type: "text",
            text: SYSTEM_PROMPT,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages,
      }),
    });

    if (!apiRes.ok) {
      const detail = await apiRes.text().catch(() => "");
      console.error(`Anthropic ${apiRes.status}: ${detail.slice(0, 200)}`);
      return json({ reply: "Hit a snag reaching the model — try again or use Book a call." }, 502, cors);
    }

    const data = await apiRes.json();
    const reply = (data.content?.[0]?.text || "").trim() || "Sorry, I didn't catch that.";

    // Cost (Claude Haiku 4.5 pricing)
    const u = data.usage || {};
    const cost =
      ((u.input_tokens || 0) * 1.0 +
        (u.cache_creation_input_tokens || 0) * 1.25 +
        (u.cache_read_input_tokens || 0) * 0.10 +
        (u.output_tokens || 0) * 5.0) /
      1_000_000;

    // 25h TTL — covers the daily-rollover window cleanly.
    await Promise.all([
      env.USAGE.put(ipKey, (ipUsage + cost).toFixed(6), { expirationTtl: 90000 }),
      env.USAGE.put(globalKey, (globalUsage + cost).toFixed(6), { expirationTtl: 90000 }),
    ]);

    return json({ reply }, 200, cors);
  },
};

function corsHeaders(origin) {
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "https://wiseai.website";
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}
