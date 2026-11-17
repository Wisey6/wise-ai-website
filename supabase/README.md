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
