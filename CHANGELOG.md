# Changelog

All notable changes to `@huloglobal/vendure-plugin-email-tracking` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

## [0.16.0] — 2026-11-04

Delivery evidence: every email event is now recorded as its own row, the
order page shows an email activity timeline with exports and a PDF evidence
report, and provider delivery webhooks are verified and ingested. One new
table (`email_event`); `email_log` is unchanged. Hosts on `synchronize: false`
must create the table first — see README → "Upgrading to 0.16.0". Without new
options the plugin behaves as 0.15.4 apart from the new event rows and admin
panels and the changes listed below: no new third-party calls, no provider
webhook accepted, same link format. One counting change: opens and clicks
through bare (unsigned) ids are recorded as `unverified` events only and no
longer counted in `email_log` (see Security).

### Added
- **Event timeline (`email_event`).** One row per event, never deduplicated:
  send outcomes (sent, failed, deferred, suppressed) from `TrackingEmailSender`
  and `sendTracked`; every pixel open and every click — up to 100 of each per
  email per UTC day (10 through bare ids), after which one marker row
  (reason `events-capped`, with the count it saw) stands for the rest of the
  day while signed hits keep incrementing the `email_log` counters; a server
  process records one email's hits one at a time, so a burst cannot pass the
  count together; bounces from
  `/email-track/bounce`; provider events; manual suppressions by an
  administrator. Rows carry the order / customer / channel links of the email,
  the canonical IP as stored (raw, or hashed per `hashIpsInHistory`) plus
  `ipHash` (hashes are HMACs keyed with `ipSalt`, or with the signing secret
  when `ipSalt` is unset), the local GeoLite2 location, the parsed client, the
  clicked URL (secrets and email addresses redacted) with link index and
  text, the bounce or SMTP detail and a small sanitised provider payload
  (never a message body; the recipient only as a keyed hash, and every email
  address in SMTP / provider text replaced by `<address>`, message ids
  excepted). Writes are best-effort: a failed event row never affects a
  send, a pixel or a redirect. The existing `email_log` counters and
  `opensJson` / `clicksJson` are written as before, except for bare-id hits
  (see Security).
- **Human / machine / unknown classification** of every open and click
  (`classification` + reason codes such as gmail-proxy, safelinks, bot-ua,
  datacentre, vpn) from the licence SDK classifier; re-classified when IP
  enrichment adds network flags. A hit through a bare (unsigned) id is
  `unverified` instead — never human or machine — in the JSON, the UI and
  the PDF.
- **Provider webhooks** at `POST /email-track/webhook/:provider` for `postmark`
  (HTTP Basic auth), `sendgrid` (signed event webhook), `mailgun` (signed HTTP
  webhooks) and `ses` (Amazon SES through SNS), configured with the new
  `providerWebhooks` option. Mapped events: delivered, deferred, hard and soft
  bounces (SES Permanent / Transient, SendGrid bounce / blocked, Mailgun failed
  permanent / temporary, Postmark HardBounce / SoftBounce / Transient …),
  complaints, dropped / rejected and unsubscribes; provider opens and clicks
  only with `recordEngagement: true` (recorded, never counted in `email_log`;
  a click on one of the plugin's own tracked links is stored as its
  destination, redacted, with its link index and text). Retries are
  idempotent (unique `dedupeKey` from the provider's event id); when a
  status or suppression update fails, the event row is removed again and the
  answer is 500, so the retry is processed in full.
  Events are matched to the email by a correlation header the sender adds only
  for configured providers (SendGrid `X-SMTPAPI` unique_args, Mailgun
  `X-Mailgun-Variables`, Postmark `X-PM-Metadata-hulo-log-id`, SES
  `X-SES-MESSAGE-TAGS`; the value is the email_log id with an HMAC of the
  install's signing secret, so a provider account shared with another shop
  cannot link its events to your emails), then the Message-ID, then the
  provider id parsed from the SMTP reply. The JSON headers are handed to
  nodemailer prepared, so they go out as raw JSON rather than RFC 2047
  encoded-words; the Postmark metadata key is read whatever its case. Hard
  bounces, complaints and drops for a bad address (SendGrid: exactly
  "Bounced Address", "Invalid" or "Spam Reporting Address") add the recipient
  to the suppression list — also when no email matched; soft bounces,
  deferrals and other drops ("Invalid SMTPAPI header", "Unsubscribed
  Address", …) never do; unsubscribes are recorded only. Bounces and
  complaints are processed in every tier, delivered / deferred / unsubscribe
  / engagement events need premium access. Per-IP limits of their own
  (`providerWebhooks.rateLimit`): failed requests spend a failure allowance
  (default `rateLimit`, 60 a minute) that is checked before a body is read;
  verified requests spend only a per-provider verified allowance (default
  1 200 a minute).
- **`delivered` status** on `email_log`, with a fixed precedence for every
  status update (`sent < deferred < delivered < bounced < complained < failed
  < suppressed`), applied in one guarded UPDATE that always equals the
  precedence: a provider "delivered" moves sent / deferred to delivered and
  never overwrites bounced, complained or failed. A provider drop for a
  reason other than a bad address moves only sent / deferred to failed.
- **IP enrichment (opt-in, off by default)** with the new `ipEnrichment`
  option: `{ provider: 'ipinfo', token }`, `{ provider: 'ip-api', key? }` or
  `{ provider: 'custom', lookup(ip) }`, plus `cacheTtlMs` (default 24 h) and
  `maxLookupsPerMinute` (default 40 for the free ip-api endpoint, else 120).
  Asynchronous after the event row is written; adds country, region, city,
  ASN, organisation, timezone and proxy / VPN / Tor / datacentre / mobile
  flags, with the location merged as a unit (GeoLite2 first; the provider's
  city only for the same country); private and reserved addresses (incl. the
  IPv4-mapped, NAT64 and 6to4 forms of private IPv4) are never sent; only the
  validated, canonical address is looked up (no `%zone` suffixes), cached per
  address; over-budget lookups are dropped, not queued; 5 s timeout; every
  value clamped to its column (the AS number only). A boot warning explains
  the free ip-api endpoint's terms (HTTP, 45/min, non-commercial).
- **Order activity** — `GET /email-track/orders/:orderId/activity` merges the
  order's email events, legacy rows synthesised from `email_log` for emails sent
  before 0.16.0 (marked `legacy`; no backfill runs) and Vendure's order history
  (state, payment with amounts, fulfilment, refund, cancellation, modification,
  coupon, customer changes and notes — each note whole —, private ones
  included). Filters all /
  emails / opens / clicks / delivery / order / notes, cursor pagination (100 by
  default, `order=desc` for the latest first) and a header summary (order,
  customer, total in the host's `MoneyStrategy` precision, payment state,
  emails sent / delivered / opened with the first open / clicked / bounced or
  complained — from the `email_log` counters, which bare-id hits never move —
  and human vs machine opens and clicks, `unverified` ones apart). History
  is read in pages no larger than the API's list limit, and a response says
  `historyUnavailable: true` (the page and the PDF show a notice) when it
  could not be read. Needs ReadOrder and ReadCustomer, is scoped to the
  admin's channel (404 outside it) and is premium (402 unlicensed).
- **Exports**: `activity.csv` (redacted: IP as stored, sensitive URLs
  redacted, no payloads; every cell quoted with the formula-injection guard;
  UTF-8 byte-order mark), `activity.json` (redacted, with `timelineSha256`) —
  both take `?filter=`, name it in the file name and then return
  `timelineSha256: null` —, `activity.json?evidence=1` (`&internalNotes=1`):
  exactly the items the PDF prints, with the hash printed on it, and
  `activity.json?full=1` — every stored column, provider payloads and full
  user agents — behind the new **`ExportEmailEvidence`** permission
  (Settings → Roles; SuperAdmin has it).
- **"Order activity and delivery evidence report" (PDF)** from
  `POST /email-track/orders/:orderId/evidence-link`: a 5-minute HMAC-signed
  URL (order id, expiry, admin user id and the internal-notes choice, signed
  with the active signing secret) to `GET …/evidence.pdf`, which needs no
  session, so it opens in a new tab under bearer-token auth. A4, generated by
  a built-in dependency-free PDF writer: order and customer header,
  generated-at (UTC), generated-by and whether internal notes are included,
  summary (bare-id hits on a line of their own, not counted in any figure),
  the timeline table, a "How to read this report" note, page numbers and the
  SHA-256 of the canonical JSON of the printed items, which matches a later
  `activity.json?evidence=1` export of the unchanged timeline. Private
  (internal) order notes are left out unless the link was minted with
  `{ "internalNotes": true }` (then printed as "Note (internal)"); order
  history of a type the plugin does not know shows its type only. Clicks
  name their link ("Link #2: …"). A cell longer than a page (about 85
  lines, some 4 000 characters of text) is cut with "… (truncated, N more
  characters: see activity.json)" — N counts every character after the
  lines shown, spaces and line breaks included — its author line kept; the
  SHA-256 line and its explanation are never split across pages. Characters
  outside WinAnsi print as a stand-in (`→` as `->`, `Ł` as `L`) or, for
  other scripts, as `?`.
- **Admin UI**: an "Email activity" card on the order detail page (summary,
  latest ten rows with repeated proxy opens folded into one, Open full
  activity, Evidence report (PDF); shown to admins with ReadOrder and
  ReadCustomer); a full page at Email Log → order activity
  (`/extensions/email-log/orders/:orderId`) with filters, classification
  badges ("Unverified" for bare-id hits) and reason chips, approximate
  location under a cautionary note, the clicked link, Load more, Export CSV
  (of the active filter), notes with their line breaks, PDF with an
  "Include internal notes" choice and —
  for admins with `ExportEmailEvidence` — Full export (downloads named as the
  server names them, date included), and an error state with Try again; the
  per-customer **Emails** tab on the customer detail page (the README
  promised it; it now exists; its seven columns fit a 1280 px screen); an
  "activity" link on Email Log rows linked to an order. On an unlicensed
  install the premium screens show their notice without calling a premium
  endpoint (no 402 in the browser console). Dates follow the admin UI
  locale; status colours meet WCAG AA, also in the dark theme, and the
  premium notice's link is underlined in the notice colour; the page title is
  the page's `h1`; the activity page fits a 390 px screen (its table scrolls
  inside its box, the summary cards wrap long addresses).
- **Link metadata** for wrapped mail: the send event stores each rewritten
  link's index, anchor text (120 characters), whether it carries a secret,
  a keyed URL fingerprint and whether the email's tokens are signed, so click
  events show which link was clicked. URLs and signatures are unchanged;
  links in emails already sent keep working.
- A boot warning when the database's clock (`LOCALTIMESTAMP`, read through
  the driver) and the process's differ by two minutes or more — different
  time zones make the timeline mix two clocks. README → Upgrading: run both
  in the same zone, UTC recommended.
- Exports: `EmailEvent`, `EmailEventService`, `OrderActivityService`,
  `exportEmailEvidencePermission`, the option and event types. The plugin
  module exports `EmailTrackingService`, `EmailEventService`,
  `EmailLinkService` and `OrderActivityService`, so a host plugin that
  imports `EmailTrackingPlugin` injects the plugin's own instances (README →
  Universal capture).

### Changed
- Recorded click URLs (the event and `clicksJson`) have secrets redacted:
  `https://host/path?[redacted]` when the URL carries user info, a query
  parameter whose name holds a secret (token, code, key, sig, signature,
  auth, password, reset, otp, session, sid, jwt, apikey, pin, magic, nonce,
  hash, ticket, …), a parameter whose value is a URL that does
  (`?next=/reset?token=…`, also encoded), a `key=value` fragment, or an
  account-action path (reset, verify, confirm, login, magic, auth, invite,
  unsubscribe, …) with a query; token-like path segments after such a segment
  become `[redacted]`. The redirect still goes to the real URL. The Email Log
  detail shows click history written before 0.16.0 redacted the same way.
- `/email-track/bounce` applies the status precedence: a soft bounce no
  longer turns a bounced, complained or delivered email back into
  `deferred`, and a hard bounce no longer overwrites a complaint. Each call
  is also recorded as an event (a retried call with the same facts once).
- `/email-track/bounce` takes `application/json` only (415 otherwise) and at
  most 100 KB (gzip / deflate still inflated) — what the global parser
  accepted before, minus form posts.
- A bare (unsigned) open / click id is accepted for every email without a
  0.16.0 send event saying its links were signed (every email sent before
  0.16.0, signed or not). While a signing secret exists (always, unless the
  licence store was unavailable at boot) such a hit is an `unverified` event
  only — reason `unsigned-token`, never enriched — and no longer increments
  `openCount` / `clickCount`, sets `firstOpenedAt` / `firstClickedAt` or
  joins `opensJson` / `clicksJson`; a bare id of an email whose own links
  were signed is not recorded at all. The pixel and the own-host redirect
  are still served. Without any secret, every link is a bare id and is
  counted as before.
- The click redirect answers first and records the click afterwards (as
  the pixel always did), so a slow database or lookup never holds the
  customer up.
- The GeoLite2 lookup (when `geolite2-redist` is installed) loads its
  database once per process and waits for it at most one second: its
  updater resolves only after reaching GitHub, and when GitHub could not be
  reached every public-IP open went unrecorded and click redirects hung
  (also in 0.15.x).
- The SMTP reply no longer overwrites a status a provider event set while
  the send was in flight: the reply's Message-ID and text are always stored,
  its status (deferred / failed) only replaces the optimistic `sent`, in one
  guarded UPDATE (`sendTracked` and `TrackingEmailSender`).
- CSV exports (`log/export.csv` and the order activity CSV) quote every cell
  and start with a UTF-8 byte-order mark.
- The Email Log page counts every status in its period total (it left out
  `delivered` and `suppressed`); **Sent** shows sent + delivered and filters
  on both, with new Delivered, Complained and Suppressed cards.
  `GET /email-track/log/summary` returns `total`, `delivered` and
  `suppressed`; `status` on the list and CSV export takes a comma-separated
  list. Its two tables scroll inside their own box, so the page no longer
  stretches the admin wider than the screen (it did from 390 px up to
  1280 px).
- The plugin's admin screens (Email Log, order panel and page, customer
  tab, dashboard widget) send the admin's active channel token and, on
  bearer-token hosts, the bearer token with every REST call, and no longer
  trigger Vendure's generic red error notification for expected answers
  (402 unlicensed, 403 role); they show their own messages. The premium
  notices say "subscribe or activate a key".
- The retention sweeper also prunes `email_event` (older than `days` — at
  least 3 — the events of emails `maxRows` removes, and under `maxRows` the
  unlinked events older than the oldest email kept), in the same batches.
- `EmailTrackingService.recordClick()` takes an optional fifth argument with
  the link's index and text, and `recordOpen()` / `recordClick()` an optional
  last `{ signed }`; existing callers are unaffected. Its constructor's new
  `EmailEventService` dependency is optional: a host plugin that lists
  `EmailTrackingService` in its own `providers`, as 0.15.x hosts do, still
  boots, and its instance writes the timeline through an event writer of its
  own.
- Opens and clicks are recorded on sqlite / sql.js too (Date parameters are
  bound as UTC strings there; MySQL, MariaDB and Postgres are unchanged).
- The premium feature list (licence banner, weekly report) and the free-tier
  boot warning name the new premium features (provider delivery, deferral,
  unsubscribe and engagement events among them; bounces, complaints and
  drops stay free).
- A boot warning when `ipSalt` is not set: the `email_log` IP hashes then use
  the public default salt. The option docs no longer say hashed IPs cannot be
  de-anonymised.
- README "Buy": every install gets the 14-day evaluation with all features on
  and no card (since 0.15.2); prices unchanged.

### Fixed
- The Email Log's **Export CSV** (`GET /email-track/log/export.csv`) never
  answered since it was added in 0.3.0: `GET /email-track/log/:id`, declared
  before it, took the request and replied 400 "Invalid id". The fixed
  `log/…` routes are declared first now, and `log/:id` takes digits only
  (anything else is 404).
- A fresh MySQL / MariaDB database with `synchronize: true` failed to boot
  ("Duplicate key name 'IDX_d58a6a97b688ff39bf86a0f051'"): `email_link.linkToken`
  was declared unique twice (since 0.14). It is declared once now; existing
  tables keep their index — see README → "Upgrading to 0.16.0" for the
  redundant PostgreSQL constraint a generated migration drops.
- Retention on PostgreSQL pruned at most one batch (5 000 rows) per table per
  sweep, because TypeORM reports every DELETE there as affecting 2 rows; each
  batch is now counted from the rows it selected.
- Email Log: the hero's Help and Refresh buttons were white on Vendure 3.7's
  light button background (unreadable); they are outlined now. "cust #N" on
  rows without an order linked to `/customers/:id`, a route Vendure 3 does
  not have; it opens the customer's Emails tab.

### Security
- **Webhook verification design.** Unknown provider → 404; every known
  provider slug, configured or not, gets the same body checks (415 / 413 /
  408 / 400), and a provider that is not configured and a failed
  verification both answer 401 — after the same body read, with an empty
  body and identical headers (`Connection: close`) — so nothing reveals which
  providers are enabled. An unconfigured SendGrid, Postmark or Mailgun also
  runs the signature check a configured one would, against throwaway
  credentials, so the time the check takes does not reveal it either.
  Per-IP limits: only rejected requests spend the failure allowance
  (checked before a body is read), verified ones a per-provider allowance of
  their own, so junk cannot throttle real bounces and complaints.
  Postmark: Basic credentials compared in constant time (both halves always
  compared). SendGrid: ECDSA P-256 / SHA-256 over the timestamp header plus the
  exact raw request body, key accepted as base64 DER or PEM, anything but an EC
  P-256 key refused — never a re-serialised body; a timestamp more than 72
  hours from now is refused, so a captured request cannot be replayed later.
  Mailgun: HMAC-SHA256 over timestamp + token in constant time, timestamps
  more than 15 minutes off rejected, and a bounded replay cache refuses a
  token seen before — the token is reserved the moment it verifies, so
  concurrent requests replaying one signature with other event data are
  refused too (released if processing fails, so Mailgun's retry passes; the
  cache is per server process). Amazon SES: the SNS message signature is
  verified (SignatureVersion 1 SHA1withRSA, 2 SHA256withRSA) over the
  canonical string for its Type; the body's `TopicArn` must be on
  `ses.topicArns` and its `Timestamp` at most 24 hours old before anything is
  fetched; `SigningCertURL` must be https on exactly the topic's own
  `sns.<region>.amazonaws.com(.cn)` with a `/SimpleNotificationService-<hex>.pem`
  path (no other host under amazonaws.com, such as an S3 bucket called
  "sns"), written in canonical form (no `:443`, dot-segments, encoded dots
  or embedded tabs: each spelling would be its own cache entry and fetch),
  and is fetched with a 5 s timeout, no redirects and a 64 KB cap enforced
  while streaming, then cached; a failed fetch is remembered for 15 s,
  concurrent messages share one fetch, and at most 2 new fetches a minute
  per client address and 60 a minute in all run (an expired cached copy of
  the same certificate serves meanwhile), so unsigned messages naming
  made-up certificate URLs from one address that knows a topic ARN cannot
  use up the fetches the real SNS deliveries need after a restart or a
  certificate rotation (it would take 30 addresses); the certificate must be
  within its validity dates. The spoofable
  `x-amz-sns-topic-arn` header is never trusted, and a `SubscribeURL` is
  fetched only after verification, only on the topic's own SNS host with
  `Action=ConfirmSubscription` for the same topic
  (`autoConfirmSubscription: false` logs it for manual confirmation
  instead).
- **Exact raw bodies, read only when needed.** The plugin registers a
  dependency-free body capture for `/email-track/webhook` and
  `/email-track/bounce` as `beforeListen` middleware (the way Vendure's
  StripePlugin does). Before reading a byte it answers 404 for an unknown
  provider and 429 for an address that has used up its failure allowance
  (and, on the bounce route, 429 over the rate limit), and it closes the
  connection rather than draining. Webhook bodies, by slug and never by
  configuration: `application/json` (`text/plain` for SNS only), no
  compression, at most 1 MB (SendGrid, Postmark), 320 KB (SES) or 256 KB
  (Mailgun). SendGrid and Postmark carry their signature or credentials
  outside the body, so their body is parsed only after verification: an
  unauthenticated request never costs a JSON parse. Mailgun and SNS sign
  fields inside the body, so it is parsed first — after a byte scan that
  refuses (400, charged to the failure allowance) a body nested deeper than
  32 levels or holding more than 1 000 arrays and objects, the shapes that
  make `JSON.parse` slow (a real Mailgun event has about 25, an SNS envelope
  4). Bounce bodies: `application/json`, at most 100 KB (compressed bytes
  counted too). Every body must arrive within 10 s (408). The bounce HMAC is
  checked over the exact bytes; a signature over the compact JSON form, which
  is what 0.15.x verified, is still accepted so existing senders keep working.
- **No secrets at rest from provider clicks.** Provider-reported click URLs
  (SendGrid `url`, Postmark `OriginalLink`, Mailgun `url`, SES `click.link`)
  are unwrapped from the plugin's own tracked links and redacted before they
  are stored, so a reset or magic-link token never reaches the database, the
  exports or the PDF. The full export of legacy click history is redacted
  too.
- **Keyed hashes.** The `email_event` IP and recipient hashes are HMACs keyed
  with `ipSalt` or, when it is not set, the install's signing secret (never
  the public default salt once a secret exists). The link fingerprints in the
  send event are HMACs keyed with the signing secret and taken over the
  redacted URL of a sensitive link, so a short code cannot be recovered from
  an export or a database copy.
- **CSV injection.** Every exported cell is quoted (no list separator — comma
  or semicolon — can split it into a formula cell), and a leading
  `= + - @` is neutralised also after spaces or invisible characters.
- **IP enrichment input.** Only the validated, canonical address is looked
  up or used as the cache key (a `%zone` suffix is refused); NAT64 and 6to4
  addresses are classified by the IPv4 address they embed.
- **Unsigned ids.** Opens and clicks through bare ids cannot pass as
  evidence: while a signing secret exists they are `unverified` events only
  (never enriched, at most 10 per email per type per day), never counted in
  `email_log` — so enumerating ids cannot move the opened / first open /
  clicked figures of the Email Log, the order summary or the evidence
  report — and ignored entirely for an email whose links were signed.
- **Storage.** Opens and clicks stored per email are capped per UTC day
  (100 each; 10 through bare ids), so one tracked URL, or enumerated ids,
  cannot grow `email_event` without bound.
- **Privacy.** Email addresses in SMTP / provider text are replaced by
  `<address>` before an event is stored (bounce diagnostics often quote the
  recipient); a recorded URL whose query holds an address is redacted.
- **Evidence report contents.** Private (internal) order notes, and the raw
  data of order history the plugin does not know, stay out of the PDF —
  a document meant to be handed to others — unless notes are explicitly
  asked for; that choice is bound into the link's HMAC.
- The evidence-report link is checked in constant time; a tampered, re-pointed
  or expired link gets 403, and one claiming a longer lifetime than five
  minutes is refused.
- **No admin response is cached.** Every admin REST response, refusals
  included — the Email Log list, detail, summary and CSV export, the order
  activity JSON / CSV, the evidence link, settings, licence and status
  routes — and the evidence PDF send `Cache-Control: private, no-store`;
  every admin REST response also carries the licence SDK's security headers
  (the README promised those, but only the weekly-report preview had them).
  `GET /email-track/log/:id` takes digits only: since 0.1.0,
  `/email-track/log/1.csv` (or `.pdf`, `.css`, `.js`, `.jpg`) returned the
  full detail of email 1 — recipient, subject, SMTP reply, IPs, user agents,
  opens and clicks — as uncached JSON, under a URL that a CDN caching by file
  extension (Cloudflare's default) could store and serve to anyone after a
  signed-in admin merely opened a crafted link to the shop.

## [0.15.4] — 2026-11-04

### Documentation
- The README now shows the plugin logo, hosted on huloglobal.com so it displays on npm and GitHub alike, linking to the product page. No code changes.

## [0.15.3] — 2026-11-03

### Security
- **Open redirect through signed click links.** The `<id>.<hmac>` token on
  `/email-track/click/:token?u=…` authenticated only the email, not the
  destination, so anyone holding one tracked email (or any link from it)
  could swap `u` for any http(s) URL and use the shop's domain to redirect to
  a phishing site whenever `clickRedirectAllowedDomains` was empty (the
  default). Rewritten links now carry `s`, an HMAC over the token and the
  destination; a link without a valid `s` (bare legacy ids, and links in
  emails sent before 0.15.3) only redirects to the shop's own hosts
  (`publicBaseUrl`, `trackedHosts`, `clickRedirectAllowedDomains`).
  Behaviour change: old emails whose links point at third-party sites now
  get a 400 for those links; add the domains to `clickRedirectAllowedDomains`
  to keep them working.
- **Client IP from `X-Forwarded-For`.** With `trustedIpHeaders` including
  `x-forwarded-for`, the left-most entry (written by the client itself) was
  used, so a fresh spoofed value per request bypassed the per-IP rate limit
  on the pixel, click and bounce endpoints and poisoned stored open/click
  IPs. The right-most public hop (the one your proxy appended) is used now.
- **Channel scoping of single-row reads.** `GET /email-track/log/:id` and the
  `huloEmailLog` / `huloEmailStatsByTemplate` admin queries ignored the
  channel scope the list views apply, so a channel admin with `ReadCustomer`
  could read another channel's emails (recipient, subject, context, opens and
  clicks) by id. They now see only their channel; the default channel still
  sees everything.

## [0.15.2] — 2026-10-28

### Changed
- Every install now gets a 14-day evaluation with all features on and no card (granted by the HULO licence server). The licence banner's buttons read **Subscribe**: during the evaluation the first charge falls on the day it ends, so there is no second free trial.

## [0.15.1] — 2026-10-12

### Fixed
- Decode HTML-escaped equals signs as well as ampersands before wrapping tracked
  links, so password-reset and other query-string URLs retain their parameters.

## [0.15.0] — 2026-10-11

Retention pass: the plugin now tells the merchant what it did for them and
walks them through finishing the set-up. One new table (`hulo_plugin_prefs`,
shared by every HULO plugin; created fail-soft at boot). Requires
`@huloglobal/vendure-licence-sdk` 0.15.0.

### Added
- **Weekly report.** Every Monday at 08:00 (server-local) the worker emails
  last week's figures — emails tracked, opens, link clicks, bounces and
  complaints, open rate — each against the previous week, plus next steps
  taken from the set-up checklist and a link to the admin page. Sent through
  the host's `SMTP_SERVER`/`SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASSWORD`/`SMTP_PASS` and `SMTP_FROM` environment (the plugin has no
  mailer of its own); without SMTP nothing is sent and nothing breaks. The
  recipient defaults to the licence's customer email, else the address given
  for the trial reminder. Admin endpoints under `/email-track/digest/`:
  `GET settings`, `POST settings` (`{enabled?, recipient?}`), `POST
  send-test` (`{to?}`) and `GET preview` (HTML). The Email Log page has a
  "Weekly report" card (toggle, recipient, last/next send, Send me a test,
  Preview).
- **Set-up checklist** at the top of the Email Log page and
  `GET /email-track/setup`: sender wrapped (a log row in the last 30 days),
  `publicBaseUrl` set to a public host, bounce webhook secret configured,
  first open or click recorded. The undone items become the weekly report's
  tips. "Hide" (per browser) once everything is done; the card returns if
  an item comes undone.
- **Dashboard widget** "Email Tracking" (Dashboard → Add widget): emails
  tracked, opens and clicks for the last 7 days, the licence notice when a
  trial or key is about to end, and a link to the page. Backed by
  `GET /email-track/widget`.
- **Usage stats to the licence server.** `emailsTracked`, `emailOpens`,
  `emailClicks`, `emailsBounced` and `openRatePct` for the last 30 days
  (numbers only, no addresses) go with the evaluation ping and, from this
  version, with the daily heartbeat too, so renewal mail can say what the
  plugin did. `HULO_HEARTBEAT_DISABLED=true` still stops the heartbeat.
- **Licence banner.** `GET /email-track/licence/status` now carries
  `notice` (trial ending / key expiring / evaluation ended),
  `premiumFeatures` and `recentStats` (top three non-zero 30-day figures).
  The licensed banner shows "renews automatically — current key valid
  until <date>" for subscriptions and the notice in an amber strip; the
  trial banner has "Email me before it ends" (`POST /email-track/eval/remind-me`
  `{email}`, forwarded to the licence server and kept as the report's
  default recipient), the premium feature list and a "So far: …" line; the
  free banner shows the same with "During your evaluation: …" once the
  evaluation has run.
- **By template** table (30 days: sent, opened, open rate, clicked, click
  rate, bounced, failed) under the summary cards, and an **Export CSV**
  button that downloads the current filter. Both are premium: on the free
  tier they show an unlock chip instead of an error toast.
- Every "needs a licence" failure (HTTP 402, or an error code of
  `premium-feature`, `licence-required` or `licence_required`) renders one
  message in the admin: "<what you tried> needs a licence — start the free
  trial or activate a key at the top of this page."

### Changed
- One update banner instead of two. "Dismiss" now remembers the dismissed
  version in the browser; the banner returns for the next release.
- The help drawer no longer promises a resend action that does not exist;
  the third card describes the per-message open and click history.

### Fixed
- The second update banner was fed by a status request the page never
  made, so it could never appear; removed with its dead code.

## [0.14.3] — 2026-09-28

Follow-up to the 0.14.2 hardening pass. No new tables or columns.

### Added
- **Signing secret on by default.** Without `signingSecret` a random
  per-install secret is generated once at boot and stored in
  `hulo_licence_store` (key `vendure-plugin-email-tracking:signing-secret`;
  first writer wins so server and worker sign and verify alike), then
  applied as if configured. Bare-id links in already-sent emails behave
  exactly as in 0.14.2 (pixel served, clicks to own hosts only). A boot
  warning explains that setting `signingSecret` keeps links valid across
  reinstalls. A generated secret is never used to authenticate the bounce
  webhook.
- **Per-link tokens are live.** `/email-track/click/:token` accepts the
  64-hex tokens minted by `EmailLinkService.issueLinkToken()` (`?u=…&s=…`):
  the row must exist and be unexpired, and both the HMAC and the stored
  destination hash must match, so the token binds its URL. Sensitive links
  are recorded by their redacted form. `EmailLinkService` signs with the
  env override, else the plugin's `signingSecret`.
- Postgres corpus test (`src/pg-corpus.test.ts`, runs when `HULO_PG_URL`
  is set): every raw SQL statement in `src/` is translated by the dialect
  adapter and executed against PostgreSQL 17 with TypeORM-quoted stand-ins.

### Fixed
- **Bounces could not be matched to pipeline mail.** `TrackingEmailSender`
  delegated to `NodemailerEmailSender`, which discards nodemailer's result,
  so rows for order confirmations, OTPs and password resets never had a
  `smtpMessageId`/`smtpResponse`. A `CapturingSender` subclass keeps the
  result per send; the row now gets the Message-ID (stored without angle
  brackets, also for `sendTracked`) and the SMTP reply, and its status is
  set from the reply code like `sendTracked` does.

### Changed
- **Retention** is now plugin-side: it runs daily on the worker only,
  deletes `email_log` in batches of 5 000 (oldest id first, short pause
  between batches) instead of one unbounded statement, applies `maxRows`
  the same way, and prunes `email_link` rows past `expiresAt` or older
  than `days`.
- Tests are no longer compiled into `dist`.

## [0.14.2] — 2026-09-28

Reliability and security pass — no new features. Three indexes on
`email_log` and one on `smtpMessageId` are declared (run your migrations).

### Fixed
- **Postgres boot.** Date columns were declared as `datetime`, which
  TypeORM rejects on Postgres at start-up; they are now portable `Date`
  columns. Raw SQL quotes every camelCase column and uses `SUM(CASE …)`
  instead of `SUM(boolean)`, so the log, summaries, exports and the
  GraphQL list work on Postgres.
- **GraphQL `huloEmailLogs`** selected a `lastClickedAt` column that does
  not exist and failed on every database.
- **Open redirect.** The click redirector no longer redirects for a token
  it cannot tie to an email; unsigned legacy ids may only redirect to the
  shop's own hosts (`publicBaseUrl`, `trackedHosts`,
  `clickRedirectAllowedDomains`); signed links are unchanged. Bare ids
  must be plain decimals (a 64-hex link token no longer resolves to row 7).
- **A database hiccup no longer blocks the email.** The tracking sender
  now sends untracked when the log row cannot be written, and column caps
  match the schema (a long subject used to make MariaDB refuse the row and
  the OTP/password-reset email was never sent).
- **Permissions.** Self-update, licence activate/deactivate, purchase and
  portal links need SuperAdmin (they were reachable with UpdateCustomer).
  Admins in a non-default channel only see their channel's rows; the
  sender records the order's channel instead of always channel 1.
- **Bounce webhook** is refused without a secret unless
  `allowUnauthenticatedBounceWebhook: true`; it is rate limited;
  Message-IDs match with or without angle brackets; soft/transient
  bounces (`bounceType: 'soft'`) are recorded as deferred and never
  suppress the address; suppression inserts are race-safe.
- Opens and clicks are counted with atomic `UPDATE … + 1` statements
  (concurrent pixel fetches from Gmail's proxy and Apple MPP used to lose
  increments); the pixel is no longer `display:none` (Outlook skips hidden
  images) and no longer carries a same-origin resource policy.
- Links whose `href` contains `&amp;` are decoded before being wrapped,
  so click-through query strings survive.
- Admin list/export/summary inputs are validated (400 instead of 500 on
  bad ids or dates); CSV cells starting with `=`, `+`, `-`, `@` are quoted
  so they cannot run as spreadsheet formulas; suppression reasons are
  checked against the known set.
- Deactivating a runtime licence restarts the evaluation client instead
  of leaving it stopped.
- Admin UI: the update banner is no longer shown twice, the copy button
  copies a real `@`, the restart poll is cancelled on destroy.

### Changed
- `retention` defaults to `{ days: 365 }` (was: keep everything).
- New options `trustedIpHeaders` (proxy headers that may override
  `req.ip`; default none) and `allowUnauthenticatedBounceWebhook`.
- The list orders by `id DESC` (same order, uses the primary key).

## [0.14.1] — 2026-09-02

### Changed
- **Branding.** The bundled `hulo-global-logo.svg` is now the HG wordmark on the HULO black rounded square (the same mark as the huloglobal.com header), with explicit `-light` and `-dark` variants alongside the auto-switching default.

## [0.14.0] — 2026-09-02

### Added
- **Licence & billing card in the admin.** Always visible: the current state (free tier, free trial with first-charge date, monthly/annual subscription, lifetime, or master licence) with the actions that apply — start the 14-day free trial or subscribe, buy lifetime, **Manage billing** (Stripe customer portal: update card, cancel, switch plan) and **Upgrade to lifetime** (the old subscription stops billing at the end of its paid period). Requires licence SDK ^0.14.0.

## [0.13.1] — 2026-09-02

### Changed
- **The 14-day free trial is now card-backed.** Unlicensed installs run in the free tier; start the trial from the admin banner (monthly or annual → *Start 14-day free trial*) — Stripe collects a card, nothing is charged until day 15, cancel any time before then, one trial per customer — and the licence installs itself within a minute. The automatic no-card evaluation window is retired (licence SDK ^0.13.0).

## [0.13.0] — 2026-09-02

### Added
- **Buy licence from the admin.** The evaluation / free-tier banner now has a plan picker and a **Buy licence** button: checkout opens in a new tab and, once payment completes, the licence **installs itself** — no email round-trip, no `.env` edit, no restart. Renewed subscription keys are picked up automatically too. New admin endpoints `licence/purchase-link` and `licence/claim-status`.

### Changed
- Requires `@huloglobal/vendure-licence-sdk` ^0.12.0.
- The 7-day card trial at checkout has been retired: every install already gets the 14-day no-card evaluation, and paid plans now bill from day one.

## [0.12.2] — 2026-09-02

### Changed
- **Pricing.** Email Tracking is now £6.95/month, £69.50/year or £139 lifetime (was £9.95 / £99.50 / £199). README updated; the 14-day evaluation is unchanged.

## [0.12.1] — 2026-09-02

### Changed
- **Licence SDK ^0.11.0.** Master licences (one key that activates every HULO plugin) and hardware-bound keys are now accepted by the runtime licence check.
- **Branding.** Refreshed HULO Global logo (inline HG monogram) in the admin UI.

## [0.12.0] — 2026-08-25

### Added
- **PostgreSQL support.** All of the plugin's SQL now runs on Postgres as
  well as MySQL/MariaDB — the licence SDK's new dialect adapter translates
  queries transparently at runtime, so no configuration is needed: the
  plugin follows whatever database your Vendure `dbConnectionOptions` use.
  Verified against PostgreSQL 17. MySQL/MariaDB installs are unaffected
  (byte-identical passthrough).

## [0.11.1] — 2026-08-25

### Changed
- The update banner's "What's new" link now opens the plugin's
  changelog page on huloglobal.com, so you can read exactly what a
  release contains before updating.

## [0.11.0] — 2026-08-23

### Added
- **One-click in-app updates.** The update banner now has an "Update
  now" button: the plugin installs the new version via your project's
  own package manager (yarn/npm/pnpm auto-detected), verifies it landed,
  and gracefully restarts under your process supervisor (pm2/systemd).
  Admin-only; the target version is verified against the npm registry;
  a failed install never restarts anything. Disable with
  HULO_SELF_UPDATE=off; force restart without a detected supervisor
  with HULO_SELF_UPDATE=force. Note: a separate worker process picks
  the update up on its next restart, and the admin UI itself refreshes
  after your next admin build.

## [0.10.1] — 2026-08-23

### Added
- **Update notifications in the admin UI.** When a newer version is on
  npm, a dismissible banner shows current → latest with a copy-ready
  install command and a link to what's new. (Update data comes from the
  existing daily registry check — no new network calls.)

## [0.10.0] — 2026-08-21

### Added
- **In-admin licence activation.** A banner on the admin page shows the
  evaluation countdown (or free-tier state) with a paste-your-key box:
  the key is verified with the exact boot-time checks and activates
  instantly — no .env edit, no redeploy. Persisted in the shared
  hulo_licence_store table and restored on boot; env/init keys always
  take precedence. New licence/status, licence/activate and
  licence/deactivate admin endpoints.

## [0.9.0] — 2026-08-21

### Added
- **14-day full-featured evaluation.** Unlicensed installs now get the
  complete feature set for 14 days instead of the restricted free tier.
  Premium tracking features now also run during the evaluation window. The clock is anchored server-side (a hashed
  instance id — no personal data), so reinstalling does not restart it,
  and it fails open: if the licence server is unreachable the plugin
  keeps running fully. After the window the plugin drops to the free
  tier; all configuration is kept and reactivates instantly with a key.
## [0.8.2] — 2026-07-04

### Added
- Recipient-email → `customerId` lookup in `TrackingEmailSender`. If
  the subject doesn't contain an order code (password reset, OTP,
  email verification, account welcome, etc.) the sender now does a
  case-insensitive `Customer.emailAddress` lookup so the row still
  links to the right customer. Combined with 0.8.1's order-code
  extraction, this means the per-customer Emails view now surfaces
  every send the customer ever received — order-related and
  non-order-related.

## [0.8.1] — 2026-07-04

### Fixed
- `TrackingEmailSender` now populates `orderCode`, `orderId` and
  `customerId` on every EmailLog row it creates. Before this fix, only
  emails sent by our own service code (which passed those ids in
  explicitly) had them set — the Vendure email-plugin's built-in
  order-confirmation, invoice, password-reset etc. handlers do not
  hand order/customer entities through to the sender, so those rows
  saved with all three ids as `NULL`. That broke the per-order and
  per-customer Emails buttons on the admin (they filter by
  `orderCode` / `customerId`), showing an empty list even though the
  emails were sent.

  The sender now extracts the order code from the email subject via a
  `#<code>` regex (Vendure's default order-related templates render
  it there — e.g. `"Order confirmation for #S2BZ54TEK91HUUBA"`), then
  looks up the corresponding Order row to backfill `orderId` and
  `customerId`. Best-effort: unmatched subjects fall back to the
  previous behaviour (envelope-only row).

## [0.8.0] — 2026-07-04

### Added
- Boot-time compatibility check via the new SDK helper
  `warnIfIncompatibleVendure()`. Logs a non-fatal warning when the runtime
  `@vendure/core` version is outside the tested range. Silent when inside;
  fail-open on unparseable versions.

### Changed
- Peer dep on `@vendure/core` tightened to `>=3.5.0 <4.0.0` — Vendure 3.5,
  3.6 and 3.7 are all covered. Anything under 3.5 has never been tested
  by us; anything from 4.0 upwards is deferred until we've seen the
  changelog.
- Uses `@huloglobal/vendure-licence-sdk@^0.6.0`.

## [0.7.0] — 2026-06-30

### Added
- **`EmailLink` entity** — per-link metadata for tracked transactional
  emails. Each clickable link in each email gets its own random 32-byte
  token. Records the link's type, human label, visible text, position
  index, template section (`main_cta`, `footer`, etc.), destination host,
  path, and a SHA-256 hash of the full destination URL.
- **`EmailLinkService`** — issues per-link tokens, verifies HMAC
  signatures on click, looks up link metadata at redirect time. Graceful
  degradation: if the host doesn't have the migration yet, the redirect
  still works via signature verification alone; the click event just
  won't carry server-side link metadata.
- **Sensitive-link handling** — `isSensitive: true` on password-reset,
  invoice-access, or licence-delivery URLs. The raw destination never
  lands on an admin-visible event row; only the redacted form and hash.
- **Zero runtime coupling to invoice / support-ticket / order plugins.**
  All foreign-id fields are nullable ints with no FK constraints; hosts
  without those plugins simply never pass the id.
- Uses `@huloglobal/vendure-licence-sdk@^0.5.0` for the shared
  `classifyEmailEvent()` classifier.

## [0.6.0] — 2026-06-23

### Added
- Vendure Admin API GraphQL extensions. All of the operator endpoints
  are now available as first-class GraphQL queries and mutations
  alongside the existing REST admin endpoints:
  `huloEmailLogs`, `huloEmailLog`, `huloEmailStatsByTemplate` (paid),
  `huloEmailSuppressions`, `huloAddEmailSuppression`,
  `huloRemoveEmailSuppression`.
- Storefront paths (open pixel, click redirector, DSN webhook) stay
  REST — they're anonymous, high-frequency, and return non-JSON in
  some cases. GraphQL was never the right shape for those.

## [0.5.0] — 2026-06-23

### Changed
- Relicensed the GitHub source to AGPL-3.0. Published npm builds remain
  under the commercial licence documented at
  <https://huloglobal.com/legal/terms/>.
- npm builds now include Sigstore provenance attestations. Consumers can
  verify a tarball came from the official source repo with
  `npm view --json <pkg> dist.attestations`.

## [0.4.3] — 2026-06-21

### Fixed
- Dropped the conflicting `display: block` on mobile tables that broke
  the row / cell alignment. Table now scrolls horizontally inside its
  card at narrow widths.

## [0.4.2] — 2026-06-21

### Changed
- 44px minimum tap targets on every interactive element in the admin UI.
  Buttons, checkboxes, chip filters, expand toggles.

## [0.4.1] — 2026-06-21

### Changed
- Comprehensive README refresh — documents the full v0.4 feature set
  with copy-paste config including every security and retention option.

## [0.4.0] — 2026-06-20

### Added
- Signed open + click URLs — when `signingSecret` is configured, the URLs
  embed an HMAC tag and forged ids are rejected.
- Click redirector domain allowlist (`clickRedirectAllowedDomains`).
- HMAC verification on the `POST /email-track/bounce` webhook
  (`bounceWebhookSecret`).
- IP hashing on opens + clicks history (`hashIpsInHistory`, default
  true; `ipSalt` setting).
- Best-effort MaxMind geo lookup (country / region / city / timezone)
  on every recorded open and click, surfaced in the admin detail.
- Rate limiter (60 requests / 60s default) on `/open` + `/click`.
- Security headers on every response via the licence-sdk helper.
- Opt-in retention sweeper via `options.retention`.

## [0.3.3] — 2026-06-20

### Changed
- Mobile-friendly admin UI — summary cards reflow, filters stack with
  44px tap targets, tables overflow-x scroll inside the card. Update
  banner reflows on mobile.

## [0.3.2] — 2026-06-20

### Changed
- Republish targeting `@huloglobal/vendure-licence-sdk@^0.2.0`.

## [0.3.1] — 2026-06-20

### Added
- `UpdateChecker` integration via the licence-sdk — `/email-track/status`
  endpoint returns version + update info, admin UI shows a banner when
  a new version is available.

## [0.3.0] — 2026-06-20

### Added
- **Suppression list** — new `EmailSuppression` entity. Hard bounces
  and complaints auto-add to the table; `sendTracked()` refuses
  recipients on the list and writes `status='suppressed'`. CRUD
  endpoints (`GET /email-track/suppression`,
  `POST /email-track/suppression`,
  `DELETE /email-track/suppression/:recipient`).
- **Per-template analytics** — `GET /email-track/log/stats/by-template`
  returns open rate, click rate and click-to-open per email type.
- **Device + client detection** — every open is classified (Gmail web,
  Outlook desktop, Apple Mail iOS, Thunderbird, Yahoo, prefetch proxies,
  bots / scanners). Stored on each open history entry.
- **CSV export** — `GET /email-track/log/export.csv` mirrors the list
  endpoint's filters (max 50 000 rows).

### Changed
- Admin UI Email Log detail view now renders the full open and click
  history tables (was just clicks before).

## [0.2.0] — 2026-06-19

### Added
- Full per-event open history (`opensJson`) alongside the existing click
  history. Capped to the last 50 opens per email — older opens still
  contribute to `openCount`. Surfaced as `opens: []` on
  `GET /email-track/log/:id`.

## [0.1.0] — 2026-06-19

### Added
- `EmailTrackingPlugin` — wraps `@vendure/email-plugin` and persists every
  send to the `email_log` table.
- `TrackingEmailSender` — drop-in `EmailSender` replacement that wraps
  the default Nodemailer sender and injects an open-tracking pixel and a
  click redirector into the outgoing HTML.
- `EmailTrackingService` — exposed for custom controllers that send
  transactional email outside the email-plugin pipeline.
- Public endpoints `/email-track/open/:id.gif` (1×1 pixel),
  `/email-track/click/:id?u=<encoded>` (302 redirect), and
  `/email-track/bounce` (webhook hook for DSN parsers).
- Admin endpoints `/email-track/log` (paginated list with filters),
  `/email-track/log/summary` and `/email-track/log/:id`.
- Admin UI: standalone Email Log page + a per-customer Emails view.
- Licence verification via `@huloglobal/vendure-licence-sdk` with
  revocation polling against the HULO licence server.

[0.8.2]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.8.2
[0.8.1]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.8.1
[0.8.0]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.8.0
[0.7.0]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.7.0
[0.6.0]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.6.0
[0.5.0]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.5.0
[0.4.3]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.4.3
[0.4.2]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.4.2
[0.4.1]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.4.1
[0.4.0]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.4.0
[0.3.3]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.3.3
[0.3.2]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.3.2
[0.3.1]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.3.1
[0.3.0]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.3.0
[0.2.0]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.2.0
[0.1.0]: https://github.com/exceeded/vendure-plugin-email-tracking/releases/tag/v0.1.0
