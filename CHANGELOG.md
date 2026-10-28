# Changelog

All notable changes to `@huloglobal/vendure-plugin-email-tracking` are
documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project
adheres to [semantic versioning](https://semver.org/spec/v2.0.0.html).

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
