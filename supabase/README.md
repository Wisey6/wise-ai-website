# Wise AI OS backend (Supabase)

Project ref `adfgtlhryyyrqbbgbfmx`. Schema: `migrations/` (applied). Edge functions: `functions/`,
shared code in `functions/_shared/`. All five functions are deployed with `verify_jwt = false`;
the two that need the operator check it themselves.

Functions base URL: `https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/`

| Function | Caller | What it does |
| --- | --- | --- |
| `hq-login` | hub PIN pad | `{pin, device_token?}` → checks the PIN (`hq_verify_pin`, with lockout), mints an operator session without a password (magic-link token redeemed server side) → `{ok, access_token, refresh_token, expires_at, device_token}`. `{action:'change_pin', pin, new_pin}` with the operator's bearer token changes the PIN. |
| `sms-send` | hub (operator JWT) | `{lead_ids, template_id?, body?, mode?}` → per-lead compliance checks (dnc, suppressed, AU mobile, number source, personal hook), renders variables, adds sender + opt-out for leads who never replied, enforces the sending window and daily cap, sends via Twilio (or logs a `manual` send), advances the sequence. `{action:'status'}` → `{configured, sent_today, daily_cap, window_open}`. |
| `twilio-webhook` | Twilio | Validates `X-Twilio-Signature`. Delivery status callbacks update `messages.status`. Inbound texts land on the lead (created if unknown); STOP words add a suppression and mark the lead `dnc`; anything else marks it replied/unread and emails the operator. |
| `cal-webhook` | Cal.com | Validates `X-Cal-Signature-256`. Booking created / rescheduled / cancelled → `bookings` row, lead matched by phone then email (or created), lead status `booked` (back to `interested` on cancel), event + email. |
| `lead-intake` | public website form | `{name, email?, phone?, business?, source?, summary?, website?}` (`website` is a honeypot). Creates or updates the lead (`source 'website'`, `status 'interested'` if new), appends the summary to notes, event + email. More than 20 new website leads in an hour → 429. |

## agent (the four hub assistants)

`functions/agent/` (deployed `verify_jwt = false`; operator JWT checked by `requireOperator`). One
endpoint, four tightly scoped agents. Contract: request `{agent, …}` → `{ok, result, run_id, model,
cost_usd, spent_usd, cap_usd}`; `{action:'status'}` → switches, spend, `runs_today`, `limits`.

| Agent | Input | Model / effort | What it does |
| --- | --- | --- | --- |
| `researcher` | `{lead_id}` | Sonnet 5.5, low; `web_fetch` (≤4, limited to the lead's website/listing hosts) + `web_search` (≤2) | Reads one lead's own public pages → `{observations[{text, source_url}], hooks[], pain, opted_out, opted_out_evidence, number_published, number_evidence_url, could_not_read}` plus `sources`. Writes nothing to the lead. |
| `briefing` | `{refresh?}` | Sonnet 5.5, low | Morning briefing `{headline, do_first[{text,hash}], watch[], numbers}`. One per local day (cached, no cost) unless `refresh`; empty hub → `{ok:false, error:'empty'}` without a model call. |
| `ask` | `{question ≤600, history? ≤10×2,000}` | Haiku 5.5, low | `{answer, links[{label,hash}], cannot_answer}` from the hub snapshot only. Snapshot sits in a cached system block (`usage.cache_read_input_tokens` > 0 on follow-ups). |
| `doer` | `{instruction ≤600}` | Sonnet 5.5, medium | Turns an instruction into PROPOSALS (`agent_actions`, status `proposed`): `{note, actions[], dropped, rejected[]}`. Send/delete/pay/settings requests come back in `note`. |

Guarantees (in code, see the header of `functions/agent/index.ts`):
- Writes only `agent_runs` and `agent_actions`; every other table is read-only to it. Sends nothing.
- Phone numbers and emails never reach the model: the snapshot never reads contact columns and
  scrubs every free-text field (and the operator's question/instruction) of emails, URLs and
  phone-like numbers. The researcher sees the lead's website/listing URL and the mobile's last 3 digits only.
- Every doer action passes an allowlist (9 kinds; ids must exist; never a dnc lead, never a suppressed
  lead for drafts; length, date (today..+90 for follow-ups), amount (0 < x ≤ 50,000) and stage rules; ≤20)
  or is dropped and counted. Approved proposals are applied by the browser (`applyAgentAction`), never here.
- Briefing/ask hashes not offered by the snapshot are dropped; researcher observations must cite a page
  it actually fetched in that run, and hooks are emptied when none survive.
- Off switches (`settings.agents_enabled`, `agent_researcher|briefing|ask|doer`) → 403; monthly budget
  (`agent_runs.cost_usd` this UTC month vs `settings.agent_monthly_cap_usd`) → 402; daily limits per local
  day (researcher 40, briefing 4, ask 150, doer 30) → 429 — all checked before any model call. Blocked
  attempts are logged as `capped`; every other outcome (`ok`, `error`, `declined`, `empty`) is logged with
  tokens, searches, cost (list price; cache reads at 10%; $0.01 per search) and duration.

Measured cost per run (Nov 2026 test data): researcher US$0.03–0.14 (a no-URL lead that needs a search and two fetches is the dear end), briefing ~$0.013, ask ~$0.0002–0.0004,
doer ~$0.005–0.016. Secret: `ANTHROPIC_API_KEY` (without it → 503 `ai_not_configured`).
Tests: `node --test supabase/tests/agent.test.mjs` (snapshot has no contact details, allowlist rules,
hash filtering, researcher output rules, cost maths, day/month windows).

## Secrets to set

Dashboard → Edge Functions → Secrets (or `supabase secrets set NAME=value --project-ref adfgtlhryyyrqbbgbfmx`).
`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.

| Secret | Used by | Without it |
| --- | --- | --- |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | `sms-send`, `twilio-webhook` | `sms-send` mode `send` returns `503 {error:'sms_not_configured'}` (mode `manual` still works); `twilio-webhook` rejects everything with 403. `TWILIO_FROM_NUMBER` is an E.164 number, or a Messaging Service SID (`MG…`). |
| `CAL_WEBHOOK_SECRET` | `cal-webhook` | every call is rejected with 403 |
| `RESEND_API_KEY` | all notify emails | no emails are sent (requests still succeed). Sender `dailybrief@wise-ai.au` must be a verified Resend domain. Recipient is `settings.notify_email`. |
| `PUBLIC_FUNCTIONS_URL` (optional) | `sms-send`, `twilio-webhook` | defaults to `https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1`; only set if the functions move behind another domain. |

## Webhook URLs

- **Twilio** (Phone Numbers → your number → Messaging → "A message comes in", HTTP POST):
  `https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/twilio-webhook`
  Status callbacks are sent to the same URL automatically by `sms-send`.
- **Cal.com** (Settings → Developer → Webhooks → New; events Booking Created, Rescheduled,
  Cancelled; set a secret and put the same value in `CAL_WEBHOOK_SECRET`):
  `https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/cal-webhook`

## Redeploy

```sh
supabase functions deploy hq-login sms-send twilio-webhook cal-webhook lead-intake \
  --project-ref adfgtlhryyyrqbbgbfmx --no-verify-jwt
```

`--no-verify-jwt` matters: the webhooks and the public form carry no Supabase JWT, and `hq-login`
is how a JWT is obtained.

## Tests

Pure helpers (phone normalisation, template rendering, opt-out tail, Twilio/Cal signatures,
timezone maths) have unit checks with dummy secrets: `node --test supabase/tests/shared.test.mjs`
(Node 22.18+, which runs the `.ts` files directly).

## Reset a PIN lockout

```sql
update private.hq_auth set failed_count = 0, lock_level = 0, locked_until = null;
delete from private.hq_devices;  -- also forgets every remembered device
```
