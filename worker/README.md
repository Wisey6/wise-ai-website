# wise-ai-inquiry-agent

Cloudflare Worker that proxies the browser → Claude Haiku 4.5 with a per-IP daily cost cap. Browser handles TTS/STT (Web Speech API) — this Worker is LLM-only, so total cost stays low.

## Cost model

| Per visitor (daily) | $0.30 hard cap |
| Global (daily backstop) | $25.00 hard cap |
| Worker compute | $0/mo at any reasonable volume (free tier: 100k req/day) |
| KV reads/writes | $0/mo at this volume (free tier: 100k reads, 1k writes/day) |
| LLM (Haiku 4.5) | ~$0.005–0.008 per conversation, less with prompt caching |

System prompt is cached (`cache_control: ephemeral`), so the second turn onwards reads the prefix at 10% of input cost. Rough rule: **~50–80 conversations per IP before the cap hits**.

## Prerequisites

- A Cloudflare account (free tier is fine) — https://dash.cloudflare.com/sign-up
- An Anthropic API key — https://console.anthropic.com/settings/keys
- Node 20+ and `wrangler` installed once: `npm install -g wrangler`

## Deploy steps

```bash
cd worker

# 1. Authenticate wrangler with your Cloudflare account
wrangler login

# 2. Create the KV namespace for usage counters
wrangler kv namespace create USAGE
# It prints something like:
#   { binding = "USAGE", id = "abc123def456..." }
# Copy the id into wrangler.toml, replacing <KV_ID>.

# 3. Set your Anthropic key as an encrypted secret
wrangler secret put ANTHROPIC_API_KEY
# (Paste the key when prompted. It's stored encrypted in Cloudflare, never in git.)

# 4. (Optional) Try it locally first
wrangler dev
# Then in another shell:
#   curl -X POST http://localhost:8787 \
#     -H 'Content-Type: application/json' \
#     -H 'Origin: https://wiseai.website' \
#     -d '{"message":"how much is an audit?"}'

# 5. Ship it
wrangler deploy
# Prints the public URL, e.g.:
#   https://wise-ai-inquiry-agent.<your-cf-subdomain>.workers.dev
```

## Wire it up to wiseai.website

Edit `index.html` (in the parent directory of this folder) and set the endpoint:

```js
const VOICE_AGENT_ENDPOINT = "https://wise-ai-inquiry-agent.<your-cf-subdomain>.workers.dev";
```

Commit and push. The next page load will start using the real LLM instead of the keyword stub.

## Tunable knobs

All in `src/index.js` near the top:

| Knob | Default | Notes |
|------|---------|-------|
| `MODEL` | `claude-haiku-4-5` | Bump to Sonnet for higher-quality replies; cost rises ~3×. |
| `MAX_OUTPUT_TOKENS` | 250 | Caps output cost per call. |
| `PER_IP_LIMIT_USD` | 0.30 | Per-visitor daily cap. |
| `GLOBAL_DAILY_LIMIT_USD` | 25.00 | Backstop across all IPs. |
| `MAX_INPUT_CHARS` | 1000 | Rejects pathologically long inputs. |
| `MAX_HISTORY` | 8 | Last N messages sent in context. |
| `ALLOWED_ORIGINS` | `wiseai.website`, `www.wiseai.website`, `wisey6.github.io` | CORS allowlist. |

## Operational notes

- **IPs aren't perfect identity.** Mobile carriers NAT lots of users behind one IP; a VPN switch resets it. The cap is good against casual abuse, not determined attackers. If that becomes a problem, layer Cloudflare Turnstile on the Worker.
- **Daily reset.** KV TTL is 25h to cleanly cover the day-rollover window. If you change `PER_IP_LIMIT_USD` you don't need to touch anything else.
- **Logs.** `wrangler tail` streams live request logs from the deployed Worker — useful for debugging or watching the cost counter in action.
- **Upgrading to ElevenLabs TTS later.** The Worker only handles the LLM call right now. To upgrade voice quality, add an ElevenLabs `text-to-speech` call after the Claude response and return audio bytes alongside the text. The browser plays the audio instead of using `speechSynthesis`. Roughly +30 lines.

## File layout

```
worker/
├── README.md           ← you are here
├── package.json        ← wrangler scripts
├── wrangler.toml       ← Worker config (edit the KV id)
├── .gitignore
└── src/
    └── index.js        ← the Worker
```
