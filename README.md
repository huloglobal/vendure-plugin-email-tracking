<p align="center"><a href="https://huloglobal.com/vendure-plugins/email-tracking/"><img src="https://huloglobal.com/vendure-plugins/logos/email-tracking.svg?v=2" width="96" height="96" alt="HULO Email Tracking logo"></a></p>

# @huloglobal/vendure-plugin-email-tracking

Track delivery, opens and clicks on every transactional email a Vendure
server sends. Wraps `@vendure/email-plugin`, records every send, delivery,
bounce, open and click as its own event (never deduplicated), verifies
Postmark, SendGrid, Mailgun and Amazon SES delivery webhooks, classifies
opens and clicks as human- or machine-likely, hashes IPs, suppresses bounced
recipients automatically, exports CSV — and ships an admin UI with an email
activity timeline on every order, a PDF delivery evidence report and a
per-customer Emails tab.

Maintained by Wayne Garrison.

## Buy

Every install gets a 14-day evaluation with all features on — no card, nothing to start. Then **£6.95/month**,
or **£139 one-off lifetime** at
[elite.charity/licence/buy/vendure-plugin-email-tracking](https://elite.charity/licence/buy/vendure-plugin-email-tracking).
Subscribe (or buy lifetime) from the plugin's admin page — checkout opens in a new tab and the key installs itself;
subscribing during the evaluation puts the first charge on the day it ends.

## Install

```bash
yarn add @huloglobal/vendure-plugin-email-tracking
```

```ts
import {
    EmailTrackingPlugin,
    TrackingEmailSender,
} from '@huloglobal/vendure-plugin-email-tracking';

export const config: VendureConfig = {
    plugins: [
        EmailTrackingPlugin.init({
            publicBaseUrl: 'https://shop.example.com',
            licenceKey: process.env.HULO_LICENCE_KEY_EMAIL_TRACKING,

            // -- Security (recommended in production) --
            signingSecret: process.env.HULO_EMAIL_SIGNING_SECRET, // unset: generated once and stored in the DB
            bounceWebhookSecret: process.env.HULO_BOUNCE_WEBHOOK_SECRET,
            clickRedirectAllowedDomains: ['shop.example.com', '*.example.com'],
            hashIpsInHistory: true,            // default true
            ipSalt: process.env.HULO_IP_SALT,  // recommended in prod
            rateLimit: { capacity: 60, windowMs: 60_000 },

            // -- Retention (default { days: 365 }; { days: null } keeps everything) --
            retention: { days: 365, maxRows: 5_000_000 },

            // -- Provider delivery webhooks (0.16.0, each off until set) --
            providerWebhooks: {
                postmark: { username: process.env.PM_HOOK_USER!, password: process.env.PM_HOOK_PASS! },
                sendgrid: { verificationKey: process.env.SENDGRID_WEBHOOK_KEY! }, // "Signed Event Webhook" key
                mailgun: { signingKey: process.env.MAILGUN_WEBHOOK_SIGNING_KEY! },
                ses: { topicArns: ['arn:aws:sns:eu-west-1:123456789012:ses-notifications'] },
                recordEngagement: false, // default: provider opens/clicks are ignored
                // Per client IP; these are the defaults (failed: your rateLimit).
                rateLimit: { failed: { capacity: 60, windowMs: 60_000 }, verified: { capacity: 1200, windowMs: 60_000 } },
            },
            // trustedIpHeaders: ['cf-connecting-ip'], // only what your proxy sets and strips (see Privacy + safety)

            // -- IP enrichment (0.16.0, opt-in: no third-party call without it) --
            ipEnrichment: { provider: 'ipinfo', token: process.env.IPINFO_TOKEN!, cacheTtlMs: 86_400_000, maxLookupsPerMinute: 120 },
        }),
        EmailPlugin.init({
            // ... your existing email-plugin config ...
            emailSender: new TrackingEmailSender(),
        }),
    ],
};
```

Then add the UI extensions to your `compileUiExtensions` config:

```ts
EmailTrackingPlugin.uiExtensions
```


> **Since 0.14.2:** the bounce webhook needs `bounceWebhookSecret` (or
> `allowUnauthenticatedBounceWebhook: true` on a private network); rows are
> pruned after 365 days by default (`retention`); the visitor IP is `req.ip`
> unless you list proxy headers in `trustedIpHeaders`; unsigned click links
> only redirect to your own hosts — set `signingSecret` for full tracking.

> **Since 0.14.3:** links are always signed — without `signingSecret` a
> random per-install secret is generated at boot and kept in
> `hulo_licence_store` (key `vendure-plugin-email-tracking:signing-secret`,
> shared by server and worker). Set `signingSecret` yourself to keep links in
> already-sent emails valid across reinstalls and database restores. Emails
> sent before any secret existed keep working (pixel served, clicks to your
> own hosts only). Mail sent through the Vendure email pipeline now records
> the SMTP Message-ID and reply, so the bounce webhook can match it.

> **Since 0.16.0:** one new table, `email_event` (hosts on `synchronize:
> false` create it first: see [Upgrading to 0.16.0](#upgrading-to-0160)).
> Every send outcome, open, click, bounce and verified provider event is a
> row there; `email_log` is unchanged and keeps its counters and JSON
> history. Without new options the plugin behaves as 0.15.4 apart from the
> new event rows and admin panels and the changes below: no new third-party
> calls, every provider webhook is refused (401, after the body checks), and
> tracked links keep the same format. A host plugin that lists
> `EmailTrackingService` in its own `providers` still boots (see
> [Universal capture](#universal-capture)). Opens and clicks through bare
> (unsigned) ids — which anyone can type — are recorded as `unverified`
> events only and no longer counted in `email_log`. Recorded click URLs now
> have secrets (and email addresses) redacted, and statuses follow a fixed
> precedence (a soft bounce never turns a bounced or delivered email back
> into `deferred`). The click
> redirect no longer waits for the click to be recorded.
> `/email-track/bounce` and `/email-track/webhook/*` get a raw-body capture
> so signatures are checked over the exact bytes; `/email-track/bounce`
> takes `application/json` only (at most 100 KB, as before). CSV exports
> quote every cell and start with a UTF-8 byte-order mark, and the Email
> Log's **Export CSV** works (since it was added in 0.3.0, `log/:id` had
> answered it with 400). Every admin REST response is sent
> `Cache-Control: private, no-store`. The Email Log page counts `delivered`
> (and `suppressed`) emails in its totals.

> **Since 0.16.3:** no schema change, and stored statuses are not rewritten;
> they are read the same new way everywhere (see
> [Send attempts](#send-attempts)). An email still being sent reads
> "Sending…", never sent, and one cut off before its reply "No reply
> recorded"; an SMTP 4xx or a connection / timeout error reads "Deferred,
> retrying" and is linked to the retry ("Sent after 1 retry"); the order
> card counts emails "accepted by the mail server" and shows "delivered"
> only when a provider webhook can report it (not on the free tier, which
> does not record deliveries); only emails from before the event timeline
> carry the legacy badge. The Email Log's cards and list share one period
> and filter set, Failed counts emails that failed for good, and By
> template's Sent counts accepted emails only. The weekly report's "emails
> tracked" counts accepted emails too, so it reads lower than before for the
> same emails. SES sends are stored as sent (the SES reply, a message id,
> was read as a failure code); earlier rows keep their status.

## Feature tour

### Universal capture

Every email produced by `@vendure/email-plugin` (order confirmation,
password reset, OTP, invoice, etc.) is logged automatically — no
per-handler wiring. Inject `EmailTrackingService` for ad-hoc sends from
your own plugin code and get the same engagement tracking:

```ts
@VendurePlugin({
    imports: [PluginCommonModule, EmailTrackingPlugin], // exports EmailTrackingService, EmailEventService, EmailLinkService, OrderActivityService
    providers: [MyMailer],                              // MyMailer's constructor takes an EmailTrackingService
})
export class MyPlugin {}
```

Importing `EmailTrackingPlugin` gives your code the plugin's own instances.
Listing `EmailTrackingService` in your plugin's `providers` instead (the
way 0.15.x hosts did it) also works: Nest then creates a second instance,
which writes to the same tables (on the worker it also runs the daily
retention sweep and schedules the weekly report, which is still sent once
per install).

### Open + click tracking with full history

- **1×1 pixel** at `/email-track/open/:token.gif` — the token is
  `<id>.<hmac>` (signed with `signingSecret`, or the generated per-install
  secret) and a forged signature is rejected. A bare numeric id (the links
  in emails sent before any signing secret existed) still works — the pixel
  is served and clicks redirect to your own hosts — but is *unsigned*:
  anyone can type one. It is accepted for every email that has no 0.16.0
  send event saying its links were signed, i.e. every email sent before
  0.16.0, signed or not. While a signing secret exists (always, unless the
  licence store was unavailable at boot) such a hit is recorded as an
  `unverified` event only — reason `unsigned-token`, never enriched, at most
  10 opens and 10 clicks per email per day — and never changes `email_log`
  (open / click counts, first open / click, the JSON history) or any figure
  of the order summary and the evidence report. A bare id of an email whose
  own links were signed is not recorded at all. Without any signing secret
  every link is a bare id: its opens and clicks are then counted as in
  0.15.4, still flagged `unverified` on their events.
- **Click redirector** at `/email-track/click/:token?u=…` — skips
  `mailto:`, `tel:`, `#`-anchors, and `unsubscribe`/`opt-out` links.
  Each rewritten link carries `s`, an HMAC over the token and `u`, so the
  destination cannot be swapped; links without a valid `s` only redirect
  to the shop's own hosts. Optional `clickRedirectAllowedDomains` narrows
  the allowed destinations further.
  Per-link tokens minted with `EmailLinkService.issueLinkToken()` (64-hex,
  `?u=…&s=<hmac>`) are honoured too: the row must exist and be unexpired,
  and both the signature and the stored destination hash must match `u`,
  so a token cannot be pointed at another URL. Sensitive links are recorded
  by their redacted form.
- **Bounce matching for pipeline mail**: every send through
  `TrackingEmailSender` records nodemailer's Message-ID (without angle
  brackets) and SMTP reply on the row, and sets `sent` / `deferred` /
  `failed` from the reply code. The row is written before SMTP starts;
  until the reply (or the error) is recorded it reads as sending.
- **Per-row history** of the last 50 opens and clicks. Each entry includes
  timestamp, IP (raw or hashed), parsed email client (Gmail web, Outlook
  desktop, Apple Mail iOS, Thunderbird, …), bot flag for prefetch
  proxies, and best-effort country / city via MaxMind GeoLite2 (when
  installed via the visitor-analytics plugin or directly; a lookup never
  waits more than a second for that database to load, so a host that cannot
  reach its updater still records every open). Every open and click is also
  its own `email_event` row (below), up to 100 of each per email per day.
- **Which link was clicked.** For mail the plugin wraps, the send event
  keeps each rewritten link's position, anchor text (120 characters, an
  image's alt text when there is no text), whether it carries a secret and a
  fingerprint of its URL — an HMAC keyed with the signing secret, taken over
  the redacted URL for a sensitive link, so a short code cannot be recovered
  from it — so the timeline and the PDF name the clicked link ("Link #2:
  Reset your password"; `linkIndex` in the JSON and `link_index` in the CSV
  are 0-based, so that link is 1). Per-link tokens from `EmailLinkService`
  carry their own index and text.
- **Secrets are not recorded.** A clicked URL is recorded as
  `https://host/path?[redacted]` (event and `clicksJson`) when it carries
  user info, a query parameter whose name holds a secret (token, code, key,
  sig, signature, auth, password, reset, otp, session, sid, jwt, apikey, pin,
  magic, nonce, hash, ticket, …), a parameter whose value is an email address
  (`?email=bea@example.com`), a parameter whose value is a URL that does
  (`?next=/reset?token=…`, also when encoded), a `key=value` fragment
  (`#access_token=…`), or an account-action path (reset, password, verify,
  confirm, activate, login, magic, auth, token, invite, unsubscribe, …) with
  any query; token-like segments after such a path segment become
  `[redacted]` too (`/password/reset/[redacted]`). The same applies to the
  click URLs providers report, after one of the plugin's own tracked links
  is unwrapped to its destination. The redirect still goes to the real URL.
  The Email Log detail shows click history written before 0.16.0 redacted
  the same way.

### Event timeline (`email_event`)

One row per event, never deduplicated — three Gmail-proxy fetches are three
rows — up to 100 opens and 100 clicks per email per UTC day through the
plugin's own pixel and redirector (10 of each through bare ids). Past that,
one marker row ("Further opens not stored", reason `events-capped`, saying
how many were stored) stands for the rest of the day and nothing more is
stored, while signed hits still increment the `email_log` counters: one
tracked URL, or enumerated bare ids, cannot grow the table without bound.
Each server process records one email's hits one at a time, so a burst
cannot pass the count together; with several server instances a few more
rows can land at the limit. The types: send outcomes `sent`, `failed`, `deferred`, `suppressed`;
delivery `delivered`, `bounced` (hard), `soft-bounce`, `complained`,
`dropped` (refused or rejected by the provider), `unsubscribed`; engagement
`open`, `click`. Each row carries the email's order, customer and channel,
its source (`smtp`, `pixel`, `redirect`, `bounce-webhook`, `postmark`,
`sendgrid`, `mailgun`, `ses`, `admin`), the time, the Message-ID and the
provider's id, the IP as stored (raw or hashed per `hashIpsInHistory`) plus
`ipHash`, the GeoLite2 location, the user agent (1 000 characters) with the
parsed client, the classification, the clicked URL and link, a detail line
(SMTP reply, bounce reason) and a small sanitised provider payload. The
recipient address is never stored there in clear — only a keyed hash: email
addresses in SMTP and provider text (bounce diagnostics often quote the
recipient) are replaced by `<address>`, message ids excepted, and a clicked
URL whose query holds an address is stored redacted. The IP and
recipient hashes are HMACs keyed with `ipSalt`, or with the install's
signing secret when `ipSalt` is not set (never the public default salt once
a secret exists); the IP is the validated, canonical address (one IP, one
hash, whatever the notation). Event rows are best-effort: a failed write
never stops a send, a pixel or a redirect.

Free tier: send outcomes, bounces, complaints and provider drops are
recorded, as the email log always has; opens, clicks, provider delivered /
deferred / unsubscribe and engagement events and the order activity views
need premium access.

**Status precedence.** `email_log.status` only ever moves up this order,
whatever order events arrive in: `sent` < `deferred` < `delivered` <
`bounced` < `complained` < `failed` < `suppressed`. A provider "delivered"
moves sent or deferred to `delivered` but never overwrites bounced,
complained or failed; a soft bounce or deferral only replaces `sent`; a late
hard bounce replaces `delivered`; a complaint replaces a bounce. `failed`
comes from the send path (refused at submit) and from a provider drop for a
reason other than a bad address (unsubscribed address, spam content, a bad
SMTPAPI header, quota) — such a drop moves only `sent` or `deferred` to
`failed`, never a delivered, bounced or complained email. `suppressed` comes
from the send path only. Nothing overwrites `failed` or `suppressed`.

**Emails sent before 0.16.0** have no event rows. The order timeline still
shows them: a `sent` (or `failed` / `suppressed`) entry from the log row, its
bounce or delivery status (shown at the send time and saying so: the time
it was set was never recorded), and the opens and clicks in `opensJson` /
`clicksJson`, marked `legacy`. No backfill runs. Since 0.16.3 only emails
created before the install's first send event are legacy; a later email
without a send event (still being sent, cut off before its reply, or its
event could not be written) is read from the log row too, as kind `log`,
without the badge (the evidence report marks it "from email log").

### Send attempts

Every send writes its `email_log` row before SMTP starts, and Vendure's
EmailPlugin runs a failed send job again (5 retries), each run with a row
of its own. Since 0.16.3 every view — the order card and timeline, the
exports, the evidence report, the Email Log list and cards, By template and
the weekly figures — reads a row with the other attempts of the same email:

- **Sending**: no reply and no error recorded yet, created in the last 15
  minutes. It is not counted as sent anywhere.
- **No reply recorded** (state `unknown`): still no reply or error after
  that, on an email created after the event timeline began — the send was
  cut off, for example by a worker restart mid-SMTP. It is not counted as
  sent. An older email without a reply is from before replies were recorded
  (0.14.3) and keeps its stored status.
- **Temporary refusal**: an SMTP 4xx reply, or a connection or timeout
  error. While the send job can still retry it (within 15 minutes of the
  failure, fewer than six attempts so far) it reads "Deferred, retrying".
- **Retry**: the next attempt of the same email — same channel, order, type,
  recipient and subject — created within 15 minutes of a refused attempt's
  failure (for an attempt without a reply, within 15 minutes after its
  sending window). The two are linked (`retryOf` / `retriedBy`): "Deferred, retried" (or
  "Send failed, retried" after a 5xx, "No reply recorded, retried"), then
  "Sent after 1 retry".
- **Failed**: a permanent refusal (SMTP 5xx or any other error) with no
  later attempt, or a temporary one whose retries are over ("Send failed
  after 5 retries"). A provider drop after acceptance is failed too.
- Everything else keeps its stored status (sent, delivered, deferred,
  bounced, complained, suppressed). A 4xx reply that did not throw stays
  `deferred`: the job does not run it again.

**Accepted by the mail server** means the SMTP server took the email (sent,
delivered, bounced, complained, or deferred by the provider afterwards).
Delivery to the inbox is only known when a provider webhook reports it (and
the free tier does not record a provider's deliveries); the order summary
and the Email Log summary say whether deliveries can be reported
(`deliveryEvents`).

The windows are measured with the database's clock (`createdAt` and
`updatedAt` are written by the database), so a database session in another
time zone than the Node process does not shift them.

### Human / machine classification

Every open and click is classified `human_likely`, `machine_likely` or
`unknown` by the licence SDK's classifier, with reason codes such as
`gmail-proxy`, `ampp`, `safelinks`, `proofpoint`, `bot-ua`, `headless`,
`prefetch`, `no-ua` and — with IP enrichment — `datacentre`, `vpn`, `proxy`,
`tor`. An open or click through an unsigned (bare-id) link is classified
`unverified` instead — never human or machine — with `unsigned-token` first
among its reasons (the user-agent reasons follow). The classification is
advisory: nothing is blocked. With IP enrichment on, the event is classified
again once the network flags arrive.

### Order activity, exports and the evidence report

`GET /email-track/orders/:orderId/activity` builds the order's timeline from
its email events, the legacy entries above and Vendure's own order history
(state transitions, payments with amount and method, fulfilments, refunds,
cancellations, modifications, coupons, customer changes and notes —
private notes included, each note whole), sorted by time. Filters: `all`, `emails`, `opens`,
`clicks`, `delivery` (delivered, deferred, bounces, complaints, dropped,
failed, suppressed), `order` (order and payment history) and `notes`.
Cursor pagination, 100 per page by default (`take` up to 500,
`order=desc` for newest first). The first page carries the summary: order
code, customer, placed at, total (in the host's `MoneyStrategy` precision),
payment state, emails (a retried email counts once; `attempts` counts
rows) accepted by the mail server (`sent`) / delivered as a provider
webhook reported it / sending / retrying / deferred / without a reply
(`unknown`) / failed / suppressed / opened (with the first open) / clicked
/ bounced or complained — the engagement figures from the
`email_log` counters, which hits through bare ids never move —, whether
deliveries can be reported at all (`deliveryEvents`: a provider webhook is
configured, and not the free tier) and human vs machine opens and clicks (`unverified` events from
bare ids are counted apart, as `unsigned`). Send items carry `sendState`,
`retryOf` and `retriedBy` (see [Send attempts](#send-attempts)). Every
response carries a cautionary note: IP-derived location is approximate and
may show a mail proxy, VPN or scanner. When Vendure's order history cannot
be read (the server log says why), the response says so
(`historyUnavailable: true`) and the page and the PDF show a notice instead
of silently leaving those entries out.

Exports:

- `activity.csv` — redacted (IP as stored, sensitive URLs redacted, no
  payloads). Every cell is quoted and a leading `= + - @` (also after
  spaces or invisible characters) is neutralised, so no spreadsheet runs a
  formula, whatever its list separator; the file starts with a UTF-8
  byte-order mark so Excel shows `→`, `—` and accented names correctly.
- `activity.json` — the same fields as JSON, plus the summary and
  `timelineSha256`.
- Both take `?filter=` (the timeline filters above); a filtered export says
  so in its file name (`order-<code>-activity-clicks-<date>.csv`) and its
  `timelineSha256` is `null`. Without `filter` they cover the whole timeline.
  The page's **Export CSV** follows the active filter.
- `activity.json?full=1` — every stored column, provider payloads and full
  user agents (the page's **Full export** always asks for the whole
  timeline). Needs the `ExportEmailEvidence` permission.
- `activity.json?evidence=1` (`&internalNotes=1`) — exactly the items the
  evidence report prints (below), with their `timelineSha256`.
- **"Order activity and delivery evidence report" (PDF).**
  `POST /email-track/orders/:orderId/evidence-link` returns a URL to
  `…/evidence.pdf?exp=&uid=&sig=`: an HMAC over the order id, the expiry,
  the admin's user id and whether internal notes are included, signed with
  the plugin's signing secret, valid for five minutes. The PDF route needs no
  session, so the report opens in a new tab under bearer-token auth too; a
  tampered, re-pointed, widened or expired link gets 403. The report is meant
  to be handed to a payment processor or a customer, so private (internal)
  order notes are left out unless the link was minted with
  `{ "internalNotes": true }` (the page's **Include internal notes**); they
  are then printed as "Note (internal)", and the header says either way.
  Order-history entries of a type the plugin does not know show their type
  only, never their raw data. The A4 report has the shop, order, customer,
  placed at, total, payment state, generated at (UTC) and by whom, the
  internal-notes line, the summary, the timeline (time, event, detail,
  approximate location, client and classification), a "How to read this
  report" note and page numbers, and ends with the SHA-256 of the canonical
  JSON (sorted keys, no whitespace) of the items it printed — the `items` of
  `activity.json?evidence=1` (with `&internalNotes=1` when they were
  included); an export of the unchanged timeline gives the same value. A
  table cell longer than a page (about 85 lines, some 4 000 characters of
  ordinary text) is cut and says how many characters are missing, spaces
  and line breaks included ("… (truncated, N more characters: see
  activity.json)"), its author line always kept; the timeline,
  `activity.json` and `activity.csv` keep every character of a note. The
  hash line and its explanation are never split across pages. Rows from
  unsigned links are marked "unverified (unsigned link)" and explained in
  the note. It is written by a small built-in PDF writer (standard
  Helvetica in WinAnsi, no dependencies, nothing stored): `→` prints as `->`, accented Latin letters outside Latin-1 as
  their base letter (`Ł` as `L`), and scripts outside it (Cyrillic, Greek,
  CJK, emoji) as `?` — the CSV and JSON exports keep every character.

All of these need ReadOrder and ReadCustomer, see only orders on the admin's
active channel (404 otherwise) and are premium (402 unlicensed). The admin
UI sends the active channel token (`vendure-token`) and, under bearer-token
auth, the `Authorization` header with every call, as Vendure does for its
GraphQL calls; other API clients must send them too.

### Provider delivery webhooks

`POST /email-track/webhook/:provider` takes delivery events from
**Postmark**, **SendGrid**, **Mailgun** and **Amazon SES** (through SNS).
Each provider is off until configured in `providerWebhooks`:

| Provider | Configure | Verification |
| --- | --- | --- |
| Postmark | `postmark: { username, password }`; webhook URL `https://user:pass@shop.example.com/email-track/webhook/postmark` | HTTP Basic credentials, constant-time compare |
| SendGrid | `sendgrid: { verificationKey }` — Mail Settings → Event Webhook → "Signed Event Webhook" key (base64 DER as shown, or PEM) | ECDSA P-256 / SHA-256 over the timestamp header + the exact raw body; a timestamp more than 72 hours from now is refused |
| Mailgun | `mailgun: { signingKey }` — the HTTP webhook signing key; JSON webhooks | HMAC-SHA256 over timestamp + token; timestamps more than 15 minutes off refused; each token accepted once (reserved the moment it verifies, so concurrent copies are refused too) |
| Amazon SES | `ses: { topicArns, autoConfirmSubscription? }` (full topic ARNs); subscribe the URL to the SNS topic (HTTPS) | SNS message signature (v1 SHA1withRSA, v2 SHA256withRSA — prefer 2); body `TopicArn` on the list; `Timestamp` at most 24 hours old; certificate only from the topic's own region, `https://sns.<region>.amazonaws.com(.cn)/SimpleNotificationService-<hex>.pem` |

An unknown provider answers 404 before a byte of the body is read. Every
known provider slug, configured or not, then goes through the same body
checks, which depend on the slug only — `application/json` (`text/plain`
for SNS only), uncompressed (415), at most 1 MB for SendGrid (batches of up
to 768 KB) and Postmark (which can add the bounce dump), 320 KB for SES and
256 KB for Mailgun (413), arriving within 10 seconds (408) — and a provider
that is not configured answers 401 exactly like a failed check: same body
read, empty body, same headers (`Connection: close`), so nothing reveals
which providers are on. It also runs the signature check a configured one
would, against throwaway credentials, so the time the check takes does not
give it away either (an unconfigured SES has no topic list and stops where a
configured one stops for a topic not on its list). SendGrid and Postmark
put their signature or credentials outside the body, so their body is
parsed only once the check has passed; Mailgun and SNS sign fields inside
it, so a body to those two is parsed first — after a scan that refuses
(400) one nested deeper than 32 levels or holding more than 1 000 arrays
and objects (a Mailgun event has about 25, an SNS envelope 4), the shapes
that make parsing slow. Accepted requests answer 204, also for a retry of an
event already recorded (the provider's event id is a unique `dedupeKey`).
If the status or suppression update fails, the event row is removed again
and the answer is 500, so the provider's retry is processed in full.

Rate limits, per client IP (`providerWebhooks.rateLimit`): requests that
fail a body check or verification spend the address's **failure** allowance
(default: your `rateLimit`, 60 a minute); an address that has used it up is
answered 429 before its body is read. Verified requests never touch it:
they spend only their provider's **verified** allowance for that address
(default 1 200 a minute; 429 when used up, so the provider retries later).
Junk from anyone therefore cannot throttle real bounce and complaint
processing — as long as the plugin sees the real client address: behind a
reverse proxy, set `trustedIpHeaders` (or Express `trust proxy`), otherwise
every request, the providers' included, shares the proxy's address. Mailgun,
Postmark and SNS post one request per event: size `verified` for your peak
per provider IP. SNS retries an HTTPS endpoint only a few times (about 20 s
apart, by default) before it drops a message, so for SES keep `verified`
generous or give the subscription a delivery policy with more retries.

Replays: a signed request captured somewhere (a proxy log, a second consumer
of the same webhook) is refused once it is outside the provider's window
(SendGrid 72 hours, SNS 24 hours, Mailgun 15 minutes); inside it, it is a
no-op while its event row exists — the retention sweeper keeps event rows at
least 3 days. Mailgun signs only the timestamp and token, not the event
data, so its replay protection is the token memory, which is per server
process: with several server instances behind a load balancer, one captured
Mailgun token could be used once on each within its 15 minutes.

What each event does:

- **Hard bounce, complaint, or a drop for a bad address** (SES Permanent,
  SendGrid `bounce` / `spamreport` / dropped with exactly the reason
  "Bounced Address", "Invalid" or "Spam Reporting Address", Mailgun failed +
  permanent with reason `bounce`, `suppress-bounce` or `suppress-complaint`,
  Mailgun `complained`, Postmark HardBounce / BadEmailAddress /
  SpamComplaint): the recipient joins the suppression list — also when no
  email matched, because a verified provider says the address is bad.
  Processed in every tier.
- **A drop for any other reason** (SendGrid "Invalid SMTPAPI header", "Spam
  Content", "Unsubscribed Address", "Recipient List over Package Quota";
  Mailgun `suppress-unsubscribe`, `old`, …; SES Reject; Postmark
  ManuallyDeactivated, …): recorded, never suppresses; moves a sent or
  deferred email to `failed`. Processed in every tier.
- **Soft bounce / deferral** (SES Transient and DeliveryDelay, SendGrid
  `blocked` and `deferred`, Mailgun failed + temporary, Postmark SoftBounce,
  Transient, DnsError, …): recorded, never suppresses.
- **Delivered**: status `delivered` (premium).
- **Unsubscribe**: recorded only (this is transactional mail).
- **Opens and clicks the provider reports**: ignored unless
  `recordEngagement: true`; then recorded as events (premium) but never
  counted in `email_log`, because the plugin's own pixel and redirector
  already count them. A reported click URL that is one of the plugin's own
  tracked links is stored as its destination, redacted (and named by its
  link index and text); any other is redacted too.

Events find their email by, in order: the correlation id the sender adds to
outgoing mail for each configured provider (SendGrid `X-SMTPAPI`
unique_args, Mailgun `X-Mailgun-Variables`, Postmark
`X-PM-Metadata-hulo-log-id`, SES `X-SES-MESSAGE-TAGS`; the value is
`<email_log id>-<HMAC>` signed with the install's signing secret, so an
event a shared provider account reports for another shop's mail never links
to one of yours — it is not personal data, and some providers pass the header
on to the recipient), the Message-ID (with or without brackets), then the
provider id parsed from the SMTP reply (`queued as <id>`, SES `250 Ok <id>`).
The JSON headers go out as raw JSON (nodemailer would otherwise RFC
2047-encode them), non-ASCII `\u`-escaped and folded only between tokens; the
Postmark metadata key is read whatever its case, since nodemailer sends that
header as `X-Pm-Metadata-Hulo-Log-ID`. These header formats follow the
providers' documentation and are covered by tests that serialise a real
message; they have not yet been checked against live provider accounts. An
event that matches nothing is still recorded, with a keyed hash of the
recipient. For SES, a SubscriptionConfirmation is
confirmed automatically after verification (only a `SubscribeURL` on the
topic's own `https://sns.<region>.amazonaws.com` for the same topic is
fetched); `autoConfirmSubscription: false` logs it for you to confirm
instead.

### IP enrichment (opt-in)

Off unless `ipEnrichment` is set — with no value the plugin calls no
third-party service. When set, each open and click with a public IP is
looked up asynchronously after its row is written: country, region, city,
ASN, organisation, timezone and proxy / VPN / Tor / datacentre / mobile
flags, stored on the event, and the event is re-classified with those flags.
The location is merged as a unit, so no place is shown that no source
reported: a GeoLite2 city is kept whole; with only a GeoLite2 country, the
provider's region / city / timezone are taken only when it names the same
country; without GeoLite2, the provider's location is taken whole. Private
and reserved addresses (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16,
100.64/10, 0/8, multicast, the documentation and other reserved ranges,
`::1`, `fc00::/7`, `fe80::/10`, local-use NAT64 `64:ff9b:1::/48`, and the
IPv4-mapped, NAT64 `64:ff9b::/96` and 6to4 `2002::/16` forms of the private
IPv4 ranges) are never sent. Only the validated address is looked up, in its
canonical form (an address with a `%zone` suffix is not looked up at all), so
the cache key, the provider URL and a `custom` lookup all see the same
value. Results are cached per IP (`cacheTtlMs`, default 24 h); a lookup over
`maxLookupsPerMinute` is dropped, not queued; each lookup times out after
5 s; every value is clamped to its column (the AS number only). Events from
unsigned links are never looked up. The raw IP lives in memory only for the
lookup, so it works with `hashIpsInHistory: true`.

```ts
ipEnrichment: { provider: 'ipinfo', token: '…' }            // https://ipinfo.io
ipEnrichment: { provider: 'ip-api', key: '…' }              // https://pro.ip-api.com
ipEnrichment: { provider: 'ip-api' }                         // free endpoint: HTTP, 45/min, non-commercial only
ipEnrichment: { provider: 'custom', lookup: async ip => ({ country: 'GB', asn: 'AS5089', isHosting: false }) }
```

The free ip-api endpoint logs a warning at boot: it is plain HTTP, limited to
45 requests a minute and licensed for non-commercial use only.

### Suppression list

- New `EmailSuppression` entity. Hard bounces and complaints
  auto-populate — from `/email-track/bounce` and from verified provider
  webhooks; `sendTracked()` refuses suppressed recipients and
  writes `status='suppressed'` rather than calling SMTP.
- Admin CRUD at `GET/POST/DELETE /email-track/suppression`.

### Per-template analytics

- `GET /email-track/log/stats/by-template?fromDays=30` returns open
  rate, click rate and click-to-open per email type.

### Bounce webhook

- `POST /email-track/bounce` with `{ messageId, status, reason }` as
  `application/json` (at most 100 KB, gzip or deflate accepted, as before).
  Other content types answer 415, so a web page cannot post a cross-site
  `text/plain` or form request to it; over the rate limit, 429 before the
  body is read.
- Verifies `X-Signature` (HMAC-SHA256) against `bounceWebhookSecret` or a
  *configured* `signingSecret` (a generated one is never used here, since
  the sender could not know it). Postmaster integrations stay loose-coupled.
- Since 0.16.0 the HMAC is checked over the exact request bytes (the plugin
  captures the raw body on this route); a signature over the compact JSON
  form, which earlier versions verified, is still accepted.
- `bounceType: 'soft'` (or `transient`) records a soft bounce and never
  suppresses. Each call is an event on the timeline.

### Admin UI

- Global **Email Log** page (Customers → Email Log) with the set-up
  checklist, weekly-report card, state totals over the period and filters
  of the list (the period's total over every row; **Sent** = sent +
  delivered, in flight left out, then Delivered — "not reported" without a
  provider webhook, "not recorded on the free tier" there —, In progress
  (sending or waiting for a retry), Failed (for good), No reply (shown when
  a send was cut off before its reply), Retried (refused attempts sent
  again), Deferred, Bounced, Complained, Suppressed — each card opens
  exactly the emails it counts), a period choice (7, 30, 90 or 365 days, or
  all time; all time when opened for a customer or an order; a search by
  recipient, type, customer or order says which period it covers and
  offers **Search all time**), a **By template** table (emails accepted per
  email type with their open and click rates, and failures for good,
  premium), **Export CSV**, filter row, paginated list (each row's state,
  with "retry of #…" / "retried as #…"), and an expand-row detail showing
  both the open and click history tables with location + device + client
  per row.
- **Order detail → Email activity** card: the email summary (emails, a
  retried one once, with its attempts; accepted by the mail server;
  delivered only when a provider webhook can report it; sending, retrying,
  deferred, no reply recorded, failed and suppressed when there are any;
  opened, clicked, bounced / complained, human vs machine opens),
  the latest ten rows — "Sending…", "Deferred, retrying", "Sent after 1
  retry"; consecutive identical machine-likely opens or clicks
  (a mail proxy fetching the pixel again and again) fold into one row with a
  count — **Refresh**, **Open full activity** and **Evidence report (PDF)**
  (private notes left out). While an email is sending or retrying the card
  refreshes itself every 10 seconds, for up to 3 minutes. Shown to admins
  with ReadOrder and ReadCustomer; unlicensed installs see the premium
  notice.
- **Order activity page** (Email Log → `/extensions/email-log/orders/:orderId`,
  also linked from Email Log rows): filters, the timeline with classification
  badges ("Unverified" for bare-id hits) and reason chips, approximate
  location under a cautionary note, client and the clicked link ("Link #2:
  …"), notes with their line breaks, **Load more**, **Export CSV** (of the
  active filter), **Evidence
  report (PDF)** with **Include internal notes**, and, for admins with
  `ExportEmailEvidence`, **Full export**; downloads get the server's file
  names (filter and date included). Unlicensed installs see the premium
  notice instead; a timeline that cannot be loaded (role, channel) says so,
  with **Try again**, and missing order history gets its own notice.
- The premium screens (order card, activity page, the Email Log's
  per-template table) read the licence state first and show the premium
  notice without calling a premium endpoint on an unlicensed install.
- The plugin's admin screens call its REST endpoints with the admin's active
  channel token and, on bearer-token hosts, the bearer token, and show their
  own messages for expected answers (an unlicensed install's 402, a role's
  403) instead of Vendure's generic error notification.
- **Per-customer Emails tab** (Customers → a customer → Emails): every email
  logged for that customer, with status, opens, clicks and links to each
  order and its activity (all seven columns fit a 1280 px screen; narrower,
  the table scrolls inside its card). Email Log rows with a customer but no
  order link to this tab.
- **Dashboard widget** — Dashboard → Add widget → **Email Tracking**:
  emails tracked, opens and clicks for the last 7 days plus a link to the
  page.
- **Licence banner** with the trial countdown, "Email me before it ends",
  the premium feature list, what the plugin has done so far, and an amber
  notice in the last days of a trial or key.
- **Update banner** when a new plugin version is published to npm
  (Dismiss remembers the version).

### CSV export

- `GET /email-track/log/export.csv?status=sent&from=2026-05-01` (premium;
  the Email Log's **Export CSV**) — same filters as the list endpoint
  (`status` takes one stored status or a comma-separated list, e.g.
  `sent,delivered`; `state` how the send went, e.g. `failed` or
  `sending,retrying`; `fromDays` a period), up to 50 000 rows, with each
  row's `state` as the last column. Every cell is quoted, with the
  formula-injection guard, after a UTF-8 byte-order mark. From 0.3.0 to
  0.15.4 this route never answered: `log/:id`, declared first, took it and
  replied 400 "Invalid id".

### Privacy + safety

- `hashIpsInHistory: true` (default) stores hashed IPs. Set `ipSalt` to a
  long random value: without it, the open / click history in `email_log`
  hashes with a public default salt (anyone holding a hash can recover the
  IP by trying addresses) and a boot warning says so; `email_event` hashes
  are keyed with the signing secret then.
- Every admin REST response, refusals included, gets the licence SDK's
  security headers and `Cache-Control: private, no-store`, so neither a
  browser nor a CDN keeps one (some CDNs cache by URL extension, `.csv` or
  `.pdf`, even for signed-in users); `GET /email-track/log/:id` takes digits
  only (`/log/1.csv` is 404, not email #1).
- Rate limiter on every public endpoint (default 60/60s per IP). The
  provider webhooks have their own: failed requests 60/60s, verified ones
  1 200/60s per provider (`providerWebhooks.rateLimit`, above).
- The per-IP limits, and the IPs stored on opens and clicks, use `req.ip`
  unless you list the proxy headers your edge sets in `trustedIpHeaders`
  (or set Express `trust proxy`): behind a reverse proxy without either,
  every visitor and every provider shares the proxy's address.

### Retention (default 365 days)

```ts
retention: { days: 180, maxRows: 1_000_000 } // default { days: 365 }; { days: null } keeps everything
```

The sweeper runs once a day on the worker only, deletes in batches of
5 000 rows (oldest id first, with a short pause between batches so the
sender is never stalled by one long DELETE; each batch is counted from the
rows it selected, so PostgreSQL prunes as fully as MySQL), prunes
`email_link` rows past their `expiresAt` or older than `days`, prunes
`email_event` rows older than `days` (at least 3 days, so a provider's
replay window never outlives the dedupe row) — by their own age, so an open
recorded after its email was sent outlives the email's row for a while and
then shows without its email type —, those of emails `maxRows` removed, and
— under `maxRows` — unlinked events (admin suppressions, unmatched provider
events) older than the oldest email kept; it is `.unref()`'d so it never
blocks shutdown, and fails soft on DB hiccups. The event timeline is the
evidence trail: a shop that may need it for chargebacks raised more than a
year later should raise `days`.

## Weekly report, setup checklist and dashboard widget

**Weekly report.** Every Monday at 08:00 (server-local time) the worker
emails a short report for the previous seven days: emails tracked, opens
recorded, link clicks, bounces and complaints caught, and the open rate —
each with the change against the week before — followed by up to three
next steps taken from the set-up checklist and a link to the Email Log
page. Trial and free-tier installs also see what a licence switches on.
The report is sent once per install (safe with several workers).

- **Who gets it.** The address in the "Weekly report" card on the Email Log
  page; when empty, the licence's customer email, else the address given
  for the trial reminder. The card shows the default as a placeholder.
- **Turning it off / changing the recipient.** Email Log → Weekly report:
  toggle, recipient box, **Send me a test** (sends this week's figures now;
  does not move the weekly clock) and **Preview** (opens the HTML in a new
  tab). The same via the API: `GET /email-track/digest/settings`,
  `POST /email-track/digest/settings` `{ enabled?, recipient? }`,
  `POST /email-track/digest/send-test` `{ to? }`, `GET /email-track/digest/preview`.
- **SMTP requirement.** The plugin has no mailer of its own: it uses the
  host's `SMTP_SERVER` (or `SMTP_HOST`), `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASSWORD` (or `SMTP_PASS`) and `SMTP_FROM` environment variables
  through `nodemailer` (already a peer dependency). With no SMTP host set
  the report is simply not sent; every failure is logged, never thrown.
- Settings live in the shared `hulo_plugin_prefs` table (one row per
  plugin and key), created at boot if missing.

**Set-up checklist.** The first card on the Email Log page
(`GET /email-track/setup`) runs four real checks: the tracking sender is
wrapped (a log row in the last 30 days), `publicBaseUrl` points at a public
host, a bounce webhook secret is configured, and at least one open or
click has been recorded. Each row has a hint and a docs link; **Hide**
puts it away in that browser once everything is done, and it comes back if
a check fails again. The undone items are the weekly report's tips.

**Dashboard widget.** Dashboard → Add widget → **Email Tracking** shows
emails tracked, opens and clicks for the last 7 days (`GET /email-track/widget`),
the licence notice when a trial or key is about to end, and an
"Open Email Tracking" link. Needs the `ReadCustomer` permission, like the
page.

**Usage stats.** The same five figures for the last 30 days
(`emailsTracked`, `emailOpens`, `emailClicks`, `emailsBounced`,
`openRatePct` — counts only, never addresses) go with the evaluation ping
and the daily heartbeat so renewal and trial emails can say what the
plugin did. `HULO_HEARTBEAT_DISABLED=true` stops the heartbeat as before.

## Permissions

| Permission | Grants |
| --- | --- |
| `ReadCustomer` | the Email Log page, its list / detail / summary endpoints, the customer Emails tab, the widget, licence status |
| `UpdateCustomer` | adding and lifting suppressions, weekly-report settings, the trial reminder |
| `ReadOrder` **and** `ReadCustomer` | order activity, its CSV / JSON exports and the evidence report link |
| `ExportEmailEvidence` | the full export (`activity.json?full=1`): every stored column, payloads, full user agents. Registered by the plugin (Settings → Roles); SuperAdmin has it |
| `SuperAdmin` | licence activation / purchase / billing portal, the in-app update |

## External services

Without any of the 0.16.0 options below, this version calls exactly what
0.15.4 did:

- **HULO licence server** (`elite.charity`): the evaluation registration
  (daily while unlicensed), the heartbeat (daily; `HULO_HEARTBEAT_DISABLED=true`
  stops it), the revocation list (weekly) and — only when an admin starts a
  purchase or opts in — the purchase claim and the trial reminder (which
  sends the address the admin typed). Usage figures are numbers only; no
  customer data is sent.
- **npm registry**: the daily "update available" check.
- **GitHub** (`raw.githubusercontent.com`) — only when `geolite2-redist` is
  installed (it is not a dependency of this plugin; the visitor-analytics
  plugin brings it): its auto-updater fetches the GeoLite2 database checksum
  (and, when it changed, the database) from the GitSquared/node-geolite2-redist
  repository the first time an open or click from a public IP is looked up,
  then every 48 hours. Nothing about the open or click is sent. If GitHub
  cannot be reached, lookups return no location after waiting at most one
  second, and recording carries on.

Opt-in, 0.16.0:

- **IP enrichment** — only with `ipEnrichment`. Sent: the IP address of an
  open or click (nothing else), once per IP per `cacheTtlMs`, never for
  private or reserved addresses. ipinfo.io:
  [terms](https://ipinfo.io/terms-of-service), [privacy](https://ipinfo.io/privacy-policy).
  ip-api.com: [terms and privacy](https://ip-api.com/docs/legal); the free
  endpoint is plain HTTP and for non-commercial use only. A `custom` lookup
  is your own code.
- **Amazon SNS** — only with `providerWebhooks.ses`: the signing certificate
  named in a message whose topic is on your list and whose timestamp is
  fresh (only from the topic's own `https://sns.<region>.amazonaws.com`,
  written exactly as AWS writes it, 5 s timeout, at most 64 KB read, cached;
  a failed fetch is not retried for 15 s; at most 2 new certificate URLs a
  minute from one client address and 60 a minute in all, so one address
  that knows a topic ARN cannot use up the fetches the real SNS deliveries
  need after a restart or a certificate rotation — it would take 30
  addresses, and a certificate already cached still serves, also past its
  24 hours),
  and the subscription confirmation URL (unless
  `autoConfirmSubscription: false`).
  [AWS service terms](https://aws.amazon.com/service-terms/), [privacy](https://aws.amazon.com/privacy/).

The provider webhooks themselves are inbound: Postmark, SendGrid, Mailgun and
SNS call you.

## HTTP endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/email-track/open/:token.gif` | public | tracking pixel |
| `GET` | `/email-track/click/:token?u=…` | public | click redirector |
| `POST` | `/email-track/bounce` | HMAC | bounce / complaint webhook (`application/json`, 100 KB) |
| `POST` | `/email-track/webhook/:provider` | provider signature | `postmark`, `sendgrid`, `mailgun`, `ses` delivery events (404 unknown and 429 failure allowance used up — before the body is read; by slug, whether configured or not: 415 compressed or not JSON, 413 over 1 MB (SendGrid, Postmark) / 320 KB (SES) / 256 KB (Mailgun), 400 nested over 32 levels or over 1 000 arrays and objects (Mailgun, SES), 408 slow body; 401 unconfigured or bad signature; 429 verified allowance used up; 204 accepted) |
| `GET` | `/email-track/orders/:orderId/activity` | ReadOrder + ReadCustomer, premium | timeline page: `filter`, `cursor`, `take`, `order` |
| `GET` | `/email-track/orders/:orderId/activity.csv` | ReadOrder + ReadCustomer, premium | redacted CSV of the timeline; `?filter=` narrows it |
| `GET` | `/email-track/orders/:orderId/activity.json` | ReadOrder + ReadCustomer, premium | redacted JSON + `timelineSha256` (`null` when filtered); `?filter=`; `?evidence=1[&internalNotes=1]` the PDF's items; `?full=1` (every stored column) also needs `ExportEmailEvidence` |
| `POST` | `/email-track/orders/:orderId/evidence-link` | ReadOrder + ReadCustomer, premium | a 5-minute signed URL for the PDF; body `{ "internalNotes": true }` to print private notes |
| `GET` | `/email-track/orders/:orderId/evidence.pdf` | signed URL (`exp`, `uid`, `notes`, `sig`) | the evidence report PDF (403 tampered, widened or expired) |
| `GET` | `/email-track/log` | admin | paginated list with filters (`status` stored, `state` how the send went — both one or comma-separated —, `fromDays` days or `all`); rows carry `state`, `attempt`, `retryOf`, `retriedBy` |
| `GET` | `/email-track/log/summary` | admin | counts per state and their `total`, over the list's filters and period (`fromDays`, default 30, or `all`), plus `deliveryEvents` and `deliveryEventsReason` |
| `GET` | `/email-track/log/:id` | admin | full detail incl. opens + clicks (`:id` digits only, else 404) |
| `GET` | `/email-track/log/stats/by-template` | admin, premium | per-template aggregates (MySQL / PostgreSQL) |
| `GET` | `/email-track/log/export.csv` | admin, premium | CSV export |
| `GET` | `/email-track/suppression` | admin | list suppressions |
| `POST` | `/email-track/suppression` | admin | add a suppression |
| `DELETE` | `/email-track/suppression/:recipient` | admin | lift a suppression |
| `GET` | `/email-track/status` | admin | version + licence + update status |
| `GET` | `/email-track/licence/status` | admin | licence/evaluation state, lifecycle notice, premium features, recent stats |
| `POST` | `/email-track/eval/remind-me` | admin | `{ email }` — trial-ending reminder opt-in |
| `GET` | `/email-track/setup` | admin | set-up checklist |
| `GET` | `/email-track/widget` | admin | dashboard widget figures (7 days) |
| `GET` | `/email-track/digest/settings` | admin | weekly report settings |
| `POST` | `/email-track/digest/settings` | admin | `{ enabled?, recipient? }` |
| `POST` | `/email-track/digest/send-test` | admin | `{ to? }` — send this week's report now |
| `GET` | `/email-track/digest/preview` | admin | this week's report as HTML |

## Upgrading to 0.16.0

One new table, `email_event`; nothing else changes in the schema
(`delivered` is a new value of the existing `email_log.status` column).
Hosts with `synchronize: true` get it automatically. On `synchronize: false`
create it before (or with) the upgrade — this is exactly what TypeORM
generates for the entity, so `vendure migrate` / a generated migration
reports no further changes for `email_event` afterwards. Until the table
exists the plugin logs one warning (and the daily retention sweep notes
that `email_event` was not pruned) and keeps working as 0.15.4 (no event
rows, an empty order timeline apart from legacy entries and order history).

Time zones: run the Node process and the database session in the same time
zone (UTC recommended). The timeline merges times this process writes
(`email_event.occurredAt`) with times the database sets itself (Vendure's
order history, `email_log.createdAt`); on `timestamp without time zone` /
`datetime` columns they agree only when both use the same zone, and the
evidence report prints them as UTC. The plugin compares the database's
`LOCALTIMESTAMP` with its own clock at boot and logs a warning when they are
two minutes or more apart.

`email_link.linkToken` is now declared unique once (its unique index
`IDX_d58a6a97b688ff39bf86a0f051`) instead of twice: since 0.14 a fresh MySQL /
MariaDB database with `synchronize: true` failed to boot ("Duplicate key
name"). Existing MySQL / MariaDB tables already have exactly that index, so
nothing changes there. On PostgreSQL the old column-level declaration also
created a unique constraint (`UQ_d58a6a97b688ff39bf86a0f051b`); a generated
migration drops that now-redundant constraint (the unique index stays), and
`synchronize` hosts drop it on their own. Nothing else is needed.

MySQL / MariaDB:

```sql
CREATE TABLE `email_event` (
    `createdAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updatedAt` datetime(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),
    `emailLogId` int NULL,
    `orderId` int NULL,
    `customerId` int NULL,
    `channelId` int NULL,
    `type` varchar(32) NOT NULL,
    `source` varchar(32) NOT NULL,
    `occurredAt` datetime(3) NOT NULL,
    `messageId` varchar(255) NULL,
    `providerMessageId` varchar(255) NULL,
    `dedupeKey` varchar(64) NULL,
    `recipientHash` varchar(64) NULL,
    `ip` varchar(64) NULL,
    `ipHash` varchar(64) NULL,
    `country` varchar(8) NULL,
    `region` varchar(64) NULL,
    `city` varchar(128) NULL,
    `timezone` varchar(64) NULL,
    `asn` varchar(16) NULL,
    `org` varchar(255) NULL,
    `isProxy` tinyint NULL,
    `isVpn` tinyint NULL,
    `isTor` tinyint NULL,
    `isHosting` tinyint NULL,
    `isMobile` tinyint NULL,
    `enrichedBy` varchar(32) NULL,
    `enrichedAt` datetime(3) NULL,
    `userAgent` text NULL,
    `client` varchar(64) NULL,
    `platform` varchar(32) NULL,
    `isBot` tinyint NULL,
    `classification` varchar(16) NULL,
    `classificationReasons` varchar(255) NULL,
    `url` text NULL,
    `linkIndex` int NULL,
    `linkText` varchar(128) NULL,
    `detail` text NULL,
    `payload` text NULL,
    `id` int NOT NULL AUTO_INCREMENT,
    UNIQUE INDEX `UQ_email_event_dedupe` (`dedupeKey`),
    INDEX `IDX_email_event_created` (`createdAt`),
    INDEX `IDX_email_event_provider_message` (`providerMessageId`),
    INDEX `IDX_email_event_log` (`emailLogId`, `occurredAt`),
    INDEX `IDX_email_event_order` (`orderId`, `occurredAt`),
    PRIMARY KEY (`id`)
) ENGINE=InnoDB;
```

PostgreSQL:

```sql
CREATE TABLE "email_event" (
    "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
    "emailLogId" integer,
    "orderId" integer,
    "customerId" integer,
    "channelId" integer,
    "type" character varying(32) NOT NULL,
    "source" character varying(32) NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "messageId" character varying(255),
    "providerMessageId" character varying(255),
    "dedupeKey" character varying(64),
    "recipientHash" character varying(64),
    "ip" character varying(64),
    "ipHash" character varying(64),
    "country" character varying(8),
    "region" character varying(64),
    "city" character varying(128),
    "timezone" character varying(64),
    "asn" character varying(16),
    "org" character varying(255),
    "isProxy" boolean,
    "isVpn" boolean,
    "isTor" boolean,
    "isHosting" boolean,
    "isMobile" boolean,
    "enrichedBy" character varying(32),
    "enrichedAt" TIMESTAMP(3),
    "userAgent" text,
    "client" character varying(64),
    "platform" character varying(32),
    "isBot" boolean,
    "classification" character varying(16),
    "classificationReasons" character varying(255),
    "url" text,
    "linkIndex" integer,
    "linkText" character varying(128),
    "detail" text,
    "payload" text,
    "id" SERIAL NOT NULL,
    CONSTRAINT "PK_6620d7d3a9919b2ca7b12ba423e" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "UQ_email_event_dedupe" ON "email_event" ("dedupeKey");
CREATE INDEX "IDX_email_event_created" ON "email_event" ("createdAt");
CREATE INDEX "IDX_email_event_provider_message" ON "email_event" ("providerMessageId");
CREATE INDEX "IDX_email_event_log" ON "email_event" ("emailLogId", "occurredAt");
CREATE INDEX "IDX_email_event_order" ON "email_event" ("orderId", "occurredAt");
```

## Lost your licence key?

Re-send every active key on file at
[elite.charity/licence/forgot](https://elite.charity/licence/forgot).

## Documentation

User manual + screenshots:
[huloglobal.com/vendure-plugins/email-tracking/docs/](https://huloglobal.com/vendure-plugins/email-tracking/docs/)

## Licence

Commercial. Buy at
[elite.charity/licence/buy/vendure-plugin-email-tracking](https://elite.charity/licence/buy/vendure-plugin-email-tracking).
