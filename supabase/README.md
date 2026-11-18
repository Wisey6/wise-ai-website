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

### chat (the conversational assistant: `{agent:'chat'}`)

One assistant per signed-in team member that reads the hub, answers from it and makes the changes it
is asked for (`functions/agent/chat.ts`; prompt and tool list `chat-prompt.ts`; pure rules
`chat-rules.ts`; money maths `money.ts`, ported from `os/js/views/money-math.js`; Drive tools
`files.ts` / `files-rules.ts`). Model `settings.agent_chat_model` (Sonnet 5.5 default; Haiku 5.5,
Opus 5.5), adaptive thinking, effort medium, manual tool loop (≤12 model calls, ≤24 tool calls).

Request `{agent:'chat', chat_id?, message ≤4000}`. Response:

```
{ ok:true, chat_id, title,
  message: { id, role:'assistant', text, at,
             steps: [{ tool, kind:'read'|'write'|'draft'|'memory'|'note', ok, text,
                       link?, change_id?, table_name?, row_id? }],
             links: [{ label, hash }] },                       // ≤6, hub hashes ('#leads/<id>', '#files/<id>')
  changes: [ record: { id, kind:'record', at, chat_id, table_name, row_id, op:'insert'|'update', summary, open, undone_at:null }
           | file:   { id, kind:'file', at, chat_id, table_name:'file_changes', row_id:<drive id>, op:'move'|'rename'|'create_folder', summary, open, undone_at:null, undoable }
           | link:   { id, kind:'file_link', at, chat_id, table_name:'file_links', row_id:<drive id>, op:'link', summary, open, undone_at:null, undoable:true } ],
  draft?: { lead_id, body },                                   // never sent: for the inbox reply box
  usage: { input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens, iterations, tool_calls },
  run_id, model, cost_usd, spent_usd, cap_usd }
```

Errors as the other agents (400, 401, 402 `cap_reached`, 403 disabled, 404 `not_found` for someone
else's chat, 429 `daily_limit` (300 a day), 502 `ai_error`, 503 `ai_not_configured`, 200
`{ok:false, error:'declined'}`). Other actions: `chat_rename {chat_id, title}`, `chat_archive
{chat_id, archived}`, `chat_delete {chat_id}` (own chats only; the change log keeps its rows),
`undo {change_id}` (record change, file change or file link), `memory_delete {id}`. Undo restores
`before` for an update and removes an inserted row (archives it if anything points at it, including
linked files and events); it refuses when the row changed since on the same fields, when a later change
to the row is still in place, or when the lead has opted out; every restoring write is conditional on
`updated_at` being what it read. A new folder cannot be undone.

History is rebuilt each request from the stored text (last 30 messages, older ones as one recap line,
plus a "what I did" line per message); the system prompt and tools are byte-stable and cached, and
everything that changes (date and time, who is asking, memory notes, a small hub overview, the
business folder) goes in the newest user message. Measured: second turn `cache_read_input_tokens`
≈ 22,000; a typical turn costs about US$0.006–0.04 on Sonnet 5.5 and US$0.0005–0.002 on Haiku 5.5.

Guarantees in code:
- One audited write path (`writeAudited`): table and field allowlist, ids must exist, an
  `agent_changes` row with before/after for each change. Never deletes (except undoing its own
  insert), never writes settings, the team, suppressions or agent logs, never sets or clears `dnc`,
  never edits an opted-out lead, never links a deal or client to one. Sends nothing.
- Untrusted text: tool results mask phones and emails, and notes, messages and library text are
  scrubbed. Lists never carry a lead's notes or a library body. Once a turn has read a lead's notes or
  messages, a file or a library body, that turn cannot change files or links, archive, or save a
  business-wide memory, and makes at most 5 more record changes (the model is told to ask the person
  to confirm in their next message). Business-wide memory needs the person's own "remember / from now
  on / always / never".
- Files: only inside the business folder (`settings.files_home_id`); at most 3 moves or renames per
  message; nothing is trashed.
- Budget: running tokens and cost are written to the run row after every model call; the loop stops at
  the monthly cap, starts no model call after 110 s and gives each call at most 60 s (ending by 135 s,
  inside the 150 s function limit). `agent_runs.input` holds `{chat_id, chars}` and `output` ids and
  counts only, never message text.

Tests: `node --test supabase/tests/chat.test.mjs supabase/tests/chat-files.test.mjs`.

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

`agent` and `gdrive` are deployed as bundles, because their source (with `_shared/`) is too large to
send in one deploy call:

```sh
node supabase/scripts/build-agent.mjs <path-to-esbuild> agent     # or: gdrive
# → supabase/dist/agent.js and supabase/dist/agent-entry.ts; it prints {sha, name}
# 1. upload dist/agent.js to the public storage bucket `fn-src` as agent/<name> (content-type application/javascript)
# 2. deploy dist/agent-entry.ts as the function's index.ts, verify_jwt off
```

The entry is a small loader: it imports the exact SDK versions (`@anthropic-ai/sdk@0.137.0`,
`@supabase/supabase-js@2.119.0`), fetches that one file, checks its SHA-256 against the value baked
into the entry and only then runs it, so a changed or swapped file is refused. Run `deno check` on
`functions/<fn>/index.ts` first. Old bundles in `fn-src` can be removed once a newer one is live.

## Tests

Pure helpers (phone normalisation, template rendering, opt-out tail, Twilio/Cal signatures,
timezone maths) have unit checks with dummy secrets: `node --test supabase/tests/shared.test.mjs`
(Node 22.18+, which runs the `.ts` files directly).

## gdrive (the Files page, Google Drive)

The Files page shows the business **Google Drive** (the Google Workspace account on wise-ai.au):
My Drive plus any shared drives, live, read through the Drive API v3 each time. The page picks
Google Drive when `gdrive` is set up or connected, otherwise OneDrive (below) if that is set up,
otherwise it explains the Google setup. Function `gdrive`, shared code
`functions/_shared/gdrive.ts`, migration `0011_gdrive.sql` (adds `provider` to `file_links` and
`file_changes`, and the private `gdrive_connection` row reached only through
`gdrive_get / gdrive_save / gdrive_clear`, service role only).

**No delete, no trash.** Nothing in the function deletes or trashes. Moves stay inside one drive
(My Drive, or one shared drive); moving between drives is refused with `cross_drive`. Files that are
only "shared with me" are not shown.

**Previews.** Google's thumbnail links need the signed-in token and are blocked by CORS, so the
function streams thumbnails, images, PDFs, short videos and Google Docs/Sheets/Slides (exported as
PDF, Google's limit 10 MB) itself, through `GET /gdrive?f=<signed token>`. A token names one file
and one kind of output and expires after an hour. This works whether or not the viewer is signed in
to Google in their browser (the `drive.google.com/.../preview` iframe does not, for private files).

### Set it up (once, about ten minutes)

Signed in to Google as the Workspace admin (the wise-ai.au account):

1. Go to console.cloud.google.com. In the project picker choose **New project**; name it
   "Wise AI OS"; Organisation: **wise-ai.au**. Create, then select it.
2. **Menu > APIs & Services > Library**: search **Google Drive API**, open it, **Enable**.
3. **Menu > Google Auth platform > Branding**. If it says "Google Auth platform not configured
   yet", click **Get started**. App name "Wise AI OS"; User support email: the business address;
   **Next**. Audience: **Internal**; **Next**. Contact information: the business address; **Next**.
   Tick the policy agreement, **Continue**, **Create**.
4. (Optional for an Internal app, but it records what the hub asks for.) **Google Auth platform >
   Data access > Add or remove scopes**: tick
   `https://www.googleapis.com/auth/drive` (find it by filtering for "drive"), plus `openid`,
   `.../auth/userinfo.email` and `.../auth/userinfo.profile`; **Update**, then **Save**.
5. **Google Auth platform > Clients > Create client**. Application type **Web application**; name
   "Wise AI OS hub". Under **Authorised redirect URIs**, **Add URI**:
   `https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/gdrive` (exactly). **Create**.
6. Copy the **Client ID** and the **Client secret** straight away: Google shows the secret only
   once (if it is lost, add a new secret on the client's page).
7. Supabase → Edge Functions → Secrets: `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
8. In the hub, the owner opens **Files** and presses **Connect Google Drive**, signs in with the
   business account and allows access. One connection serves the whole team.

Optional secret `GDRIVE_STATE_SECRET` (32+ random characters) signs the sign-in state and the
preview links; without it a key is derived from the service-role key.

Why Internal: the full Drive scope is a "restricted" scope. An app whose audience is Internal to the
Workspace organisation needs no Google verification and never shows the unverified-app screen, and
the 7-day refresh-token expiry only applies to External apps in Testing. The connection then lasts
until it is unused for six months, the owner or Workspace admin removes the hub's access (Google
Account > Security > Your connections to third-party apps, or Admin console API controls), or the
OAuth client is deleted (Google deletes clients unused for six months). If any of that happens the
page shows the owner a "Sign in again" banner. Disconnecting from the hub also revokes the token at
Google.

### The business folder

`settings.files_home_id` / `files_home_name` (migration `0012_files_home.sql`) name the business's
files folder, today `My Drive / WiseAI / WiseAI`. Files opens there, its breadcrumbs start there
(with a quiet "All of Drive" link above it), and search looks inside it by default (a chip switches
to all of Drive). The owner can make any folder the business folder from the folder's menu or the
"Make this the business folder" link; members cannot change it. `status` returns `home: {id, name}`.

Drive cannot search "anywhere under a folder", so the function first maps every folder inside the
business folder (a few queries, level by level, cached five minutes per warm function instance)
and then searches inside those folders directly (40 folders a query, six queries at a time, first
150 matches). A warm search takes 2 to 3 seconds; the first one after a cold start rebuilds the
map and can take about 10 seconds.

For the assistant (`functions/_shared/gdrive.ts`):
- `isInside(ctx, itemId, homeId, drive?)` → true when the item is the folder or anywhere inside it.
- `homeFolder(db)` → `{id, name}` or null.
- `readText(ctx, id, maxChars = 20000, drive?)` → `{ok:true, item:{id,name,kind,web_url}, format,
  text, truncated}` for Google Docs and Slides (exported as text), Google Sheets (CSV, first sheet
  only) and text, CSV, Markdown and JSON files; `{ok:false, error:'unsupported', unsupported:'pdf' |
  kind}` for PDFs and other binary files (PDF text is not extracted). Downloads stop at 10 MB.
  Also available as the action `read_text {id, max_chars?}`.
- `search {q, within?}`: `within` is a folder id (the business folder by default in the page).

Members, and the assistant for everyone, are kept inside the business folder when one is set: for
them "the top" (`list` with no `item_id`) is the business folder, `search` always looks inside it,
and `list`, `read_text`, `item`, `move` (item and destination), `rename`, `create_folder`, `undo` and
`link` outside it return `forbidden`. The owner in the hub keeps "All of Drive". Preview and download
links last an hour.

### Actions (the same contract as `onedrive`)

POST JSON with a signed-in team member's JWT. Same actions, request bodies, item shape and error
codes as the OneDrive table below, plus: every answer carries `provider: "gdrive"`; `item` also
returns `preview_url` (signed, one hour; a Google Doc/Sheet/Slides comes back as PDF);
`download_url` is a signed download through the function (null for Google Docs, which open in
Google Drive); items carry `drive_id` (shared drive or null), `can_rename`, `can_move` and, for
Google files, `badge` (DOC, SHEET, SLIDE). Folders have `child_count: null` (Drive does not count).
`list {item_id: "shared"}` lists the shared drives; My Drive's listing ends with a "Shared drives"
folder when there are any. Extra errors: `cross_drive`, `too_large`. Rate limits (429, or 403
`userRateLimitExceeded` / `rateLimitExceeded`) are waited out once and then answered `busy`.

`GET ?code&state` is Google's redirect → `https://wise-ai.au/os/?drive=<result>#files` with result
`connected | denied | expired | bad_state | not_owner | not_in_org | no_refresh | scope_missing |
not_configured | busy | error`.

Unit tests: `node --test supabase/tests/gdrive.test.mjs`. Page tests (fake Google Drive and fake
OneDrive): `os/tests/files.test.mjs`.

## Email and calendar (each person's own Google account)

Each team member can connect their OWN Google Workspace account (Gmail and Google Calendar) in
**Settings, Your sign-in, Email and calendar**. It is separate from the business Drive connection:
one row per person in `private.gmail_connection` (migration `0014_gmail.sql`), reached only through
`gmail_get / gmail_save / gmail_clear / gmail_email_in_use` (service role only). A person only ever
reaches their own mailbox and calendar; the owner cannot read a member's and a member cannot read
the owner's. Shared code `functions/_shared/gmail.ts`; assistant tools `functions/agent/mail.ts`
(pure helpers `mail-rules.ts`).

Scopes (one consent): `gmail.readonly` (search and read), `gmail.compose` (write drafts, and send a
draft when the person presses Send), `calendar.events` (their own calendar), plus `openid email`.
Nothing that labels, archives, trashes or deletes received mail. The sign-in does not use
`include_granted_scopes`, so this token never carries the Drive scope.

**What the assistant can do:** search the person's mailbox (`search_email`: words, from, to, subject,
last N days, unread, attachments; Gmail operators are built from these fields only, every value
quoted), read one email (`read_email`: text up to 12,000 characters, attachment names and sizes
only) or a conversation (`read_thread`), and write DRAFTS (`draft_email`, `update_draft`) that sit in
Gmail's Drafts and under its reply as a card. **It cannot send.** There is no send tool; the only
way an email leaves the hub is the person pressing **Send** on the card, which calls `mail_send`.
Reading email marks the turn as having read outside text: in that same message nothing in the hub
(records, files, links, archiving, memory) can change; the assistant proposes and does it after the
person's next message. Drafting is still allowed. Email text is never stored server-side except in
the assistant's own reply in the person's own chat; `agent_runs` holds counts only.

**Drafts:** `public.mail_drafts` (id, member_id, chat_id, gmail_draft_id, to_addrs, cc_addrs,
subject, status `draft|sending|sent|discarded`, created_at, sent_at, gmail_message_id, ...; never the
body), readable by its owner only, written only by the functions. Checks in code: real addresses,
at most 10 recipients, subject at most 200, body at most 8,000, no attachments, never to an address
of a lead who opted out (status `dnc`) or whose number is suppressed (suppressions are kept by phone,
so an address is matched through the lead).

Actions on the `gdrive` function (POST with the person's JWT; the redirect URI is shared):

| Action | Answer (`ok:true` plus) |
| --- | --- |
| `mail_status` | `configured, connected, needs_reconnect, email, connected_at, can_read, can_draft, can_calendar` (the caller's own) |
| `mail_connect_url` | `url` (Google sign-in, signed state with purpose `gmail`, PKCE, one-use nonce, 10 minutes), `scopes` |
| `mail_disconnect` | `connected:false, revoked_at_google` |
| `mail_send {draft_id}` | `draft {id, to, cc, subject, status:'sent', sent_at, ...}` |
| `mail_discard {draft_id}` | `draft {..., status:'discarded'}` (deletes the unsent Gmail draft: the only Gmail delete) |

`mail_send` sends only a draft in `mail_drafts` made for the caller, reads its current recipients
from Gmail (the person may have edited it with Edit in Gmail), re-checks them, refuses more than 10,
claims the row (a double press cannot send twice) and allows 30 sends per person per local day
(429 `daily_limit`). Errors: `not_connected, reconnect_needed, mail_api_off` ("Gmail API is not
switched on in Google Cloud yet"), `scope_missing, blocked (+blocked[])`, `too_many, no_recipients,
gone, already_sent, discarded, not_found, busy`.

`GET ?code&state` with a Gmail state sends the browser to `https://wise-ai.au/os/?mail=<result>#settings`,
result `connected | connected_read_only | denied | expired | bad_state | not_in_org | no_refresh |
scope_missing | api_off | in_use | not_configured | busy | error`.

Revoking: Google revokes every scope an account gave the Google project at once. So when the
mailbox is the same Google account as the business Drive connection, Disconnect only makes the hub
forget it (no revoke), and disconnecting Drive does not revoke while that account is someone's
email connection.

### Set it up (the owner, once)

1. console.cloud.google.com, the same project as Drive ("Wise AI OS"): **APIs & Services > Library**,
   search **Gmail API**, open it, **Enable**. Then the same for **Google Calendar API**.
2. Optional (records what the hub asks for): **Google Auth platform > Data access > Add or remove
   scopes**, tick `.../auth/gmail.readonly`, `.../auth/gmail.compose` and `.../auth/calendar.events`,
   **Update**, **Save**. The client and its redirect URI stay exactly as they are.
3. In the hub: **Settings > Your sign-in > Email and calendar > Connect**, sign in with your own
   wise-ai.au account and tick every box. Each team member does the same for their own account.

These scopes are "restricted" (Gmail) or "sensitive" (Calendar); an app whose audience is Internal to
the Workspace organisation needs no Google verification, as for Drive.

Unit tests: `node --test supabase/tests/mail.test.mjs`. Page tests (mocked): `os/tests/mail.test.mjs`.

## onedrive (the Files page, OneDrive: built, dormant)

A live window onto the business OneDrive (a **personal** Microsoft account) through Microsoft
Graph. Nothing is copied: every folder is read when it is opened. The hub keeps only its own
additions: `public.file_links` (a OneDrive item linked to a client, project, deal or lead) and
`public.file_changes` (every move, rename and new folder, with before/after, for Undo). Both are
readable by anyone signed in and written only by the function. The sign-in itself (refresh token,
cached access token, account name, who connected it and when) is one row in
`private.onedrive_connection`, which the API cannot reach; the function reads and writes it through
`onedrive_get / onedrive_save / onedrive_clear` (service role only). Migration `0010_onedrive.sql`.

**There is no delete.** The function has no code path that deletes anything in OneDrive. Undo
works for moves and renames; a new folder cannot be removed from the hub (remove it in OneDrive).
Undo is refused (`changed_since`) when the item has since been moved or renamed again, in the hub
or in OneDrive itself. Items shared into the drive from other people's drives are never shown.

### Set it up (once)

1. In the Microsoft Entra admin centre (entra.microsoft.com) → App registrations → New
   registration. Supported account types: **Personal Microsoft accounts only** (or "any
   organisational directory and personal Microsoft accounts"). Redirect URI: platform **Web**,
   exactly `https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/onedrive`.
2. API permissions → Microsoft Graph → Delegated: `Files.ReadWrite`, `offline_access`, `User.Read`.
3. Certificates & secrets → New client secret. Note when it expires (24 months at most) and put a
   reminder in the calendar: when it expires, Files shows "not set up" until a new one is added.
4. Edge Functions → Secrets: `MS_CLIENT_ID` (the Application (client) ID) and `MS_CLIENT_SECRET`
   (the secret's **value**, not its ID). Until both are set, every action answers
   `{configured:false}` / `not_configured` and the page says so.
5. The owner opens Files in the hub and presses **Connect OneDrive**. One connection serves the
   whole team. Optional secret `ONEDRIVE_STATE_SECRET` (32+ random characters) signs the sign-in
   `state`; without it a key is derived from the service-role key.

How long the connection lasts: Microsoft's refresh tokens default to 90 days and are replaced with
a fresh one every time they are used, so the connection keeps going as long as Files (or the
assistant) is used at least once in any 90 days. Microsoft can still revoke it earlier (the
account's password or security changes, or the app is removed under the Microsoft account's
"Apps and services"); the page then shows a "Sign in again" banner to the owner.

### Actions (POST, JSON, with a signed-in team member's JWT)

All actions live in `functions/_shared/onedrive.ts` (`runAction(ctx, body)`), so the chat assistant
can call the same code server-side with `source: 'assistant'` and its `chatId`.

| Action | Body | Answer (`ok:true` plus) |
| --- | --- | --- |
| `status` | | `configured, connected, needs_reconnect, can_connect (owner), owner_name, account {name, connected_at, connected_by, root_id}` — never contacts Microsoft, never returns a token |
| `connect_url` (owner) | | `url` (Microsoft sign-in, signed `state` valid 10 minutes, PKCE), `expires_in` |
| `disconnect` (owner) | | `connected:false` (links and the change log stay) |
| `list` / `folders` | `item_id?` (default root), `cursor?`, `with_path?` | `folder, items[], cursor, path[]` (`folders` returns folders only, always with path) |
| `search` | `q` | `q, items[]` (this drive only, top 100) |
| `item` | `id`, `with_path?` | `item, download_url` (short-lived, about an hour), `path, links[]` |
| `move` | `id, parent_id` | `item, change` (`unchanged:true` if already there) |
| `rename` | `id, name` | `item, change` |
| `create_folder` | `parent_id?, name` | `item, change` |
| `undo` | `change_id` | `item, change` |
| `link` | `item_id, kind` (`client`/`project`/`deal`/`lead`), `record_id` | `link` |
| `unlink` | `link_id` | `unlinked` (the file is untouched) |

An item is `{id, name, folder, child_count, size, mime, kind (folder|word|excel|powerpoint|pdf|image|video|audio|text|archive|file), ext, modified, created, modified_by, web_url, parent_id, parent_path, is_root, thumb {small, medium, large}}`.
Failures are `{ok:false, error, message}` with a plain-English `message`; `error` is one of
`not_configured, not_connected, reconnect_needed, busy (+retry_after_s), not_found, name_taken,
bad_name, changed_since, already_undone, not_undoable, outside_drive, bad_move, locked, drive_full,
forbidden, owner_only, bad_request, ms_error, unauthorized, server_error`. Access tokens are cached
in the connection row until a minute or two before expiry; a 401 from Graph refreshes once; a 429
waits the `Retry-After` once (up to 8 seconds) and then answers `busy`.

`GET ?code&state` (or `?error&state`) is Microsoft's redirect: the state is checked (signature,
10-minute expiry, used once, still the owner), the code is exchanged, and the browser is sent to
`https://wise-ai.au/os/?onedrive=<result>#files` (`connected`, `denied`, `expired`, `bad_state`,
`not_owner`, `not_configured`, `busy`, `error`).

Unit tests (fake Microsoft, fake database): `node --test supabase/tests/onedrive.test.mjs`.
Page tests (fake drive): `os/tests/files.test.mjs`.

## Reset a PIN lockout

```sql
update private.hq_auth set failed_count = 0, lock_level = 0, locked_until = null;
delete from private.hq_devices;  -- also forgets every remembered device
```
