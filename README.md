# @huloglobal/vendure-plugin-email-tracking

Track delivery, opens and clicks on every transactional email a Vendure
server sends. Wraps `@vendure/email-plugin`, persists every send + open
+ click in dedicated tables, hashes IPs, suppresses bounced recipients
automatically, exports CSV — and ships an admin UI to audit the trail
per customer / order / invoice.

Maintained by Wayne Garrison.

## Buy

14-day free trial (card required, start it from the admin — nothing charged until day 15), then **£6.95/month**, or **£139 one-off lifetime** at
[elite.charity/licence/buy/vendure-plugin-email-tracking](https://elite.charity/licence/buy/vendure-plugin-email-tracking).
Start the trial (or buy) from the plugin's admin page — checkout opens in a new tab and the key installs itself.

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

            // -- Retention (opt-in) --
            retention: { days: 365, maxRows: 5_000_000 },
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

## Feature tour

### Universal capture

Every email produced by `@vendure/email-plugin` (order confirmation,
password reset, OTP, invoice, etc.) is logged automatically — no
per-handler wiring. Inject `EmailTrackingService` for ad-hoc sends from
your own plugin code and get the same engagement tracking.

### Open + click tracking with full history

- **1×1 pixel** at `/email-track/open/:token.gif` — the token is
  `<id>.<hmac>` (signed with `signingSecret`, or the generated per-install
  secret) and forged ids are rejected.
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
  `failed` from the reply code.
- **Per-row history** of the last 50 opens and clicks. Each entry includes
  timestamp, IP (raw or hashed), parsed email client (Gmail web, Outlook
  desktop, Apple Mail iOS, Thunderbird, …), bot flag for prefetch
  proxies, and best-effort country / city via MaxMind GeoLite2 (when
  installed via the visitor-analytics plugin or directly).

### Suppression list

- New `EmailSuppression` entity. Hard bounces and complaints
  auto-populate; `sendTracked()` refuses suppressed recipients and
  writes `status='suppressed'` rather than calling SMTP.
- Admin CRUD at `GET/POST/DELETE /email-track/suppression`.

### Per-template analytics

- `GET /email-track/log/stats/by-template?fromDays=30` returns open
  rate, click rate and click-to-open per email type.

### Bounce webhook

- `POST /email-track/bounce` with `{ messageId, status, reason }`.
- Verifies `X-Signature` (HMAC-SHA256) against `bounceWebhookSecret` or a
  *configured* `signingSecret` (a generated one is never used here, since
  the sender could not know it). Postmaster integrations stay loose-coupled.

### Admin UI

- Global **Email Log** page (Customers → Email Log) with the set-up
  checklist, weekly-report card, status totals, a **By template** table
  (open and click rates per email type, premium), **Export CSV**, filter
  row, paginated list, and an expand-row detail showing both the open and
  click history tables with location + device + client per row.
- **Per-customer Emails tab** filtered to that customer.
- **Dashboard widget** — Dashboard → Add widget → **Email Tracking**:
  emails tracked, opens and clicks for the last 7 days plus a link to the
  page.
- **Licence banner** with the trial countdown, "Email me before it ends",
  the premium feature list, what the plugin has done so far, and an amber
  notice in the last days of a trial or key.
- **Update banner** when a new plugin version is published to npm
  (Dismiss remembers the version).

### CSV export

- `GET /email-track/log/export.csv?status=sent&from=2026-05-01` — same
  filters as the list endpoint, up to 50 000 rows.

### Privacy + safety

- `hashIpsInHistory: true` (default) stores SHA-256 hashed IPs.
- All admin endpoints get security headers via the licence-sdk helper.
- Rate limiter on every public endpoint (default 60/60s per IP).

### Opt-in retention

```ts
retention: { days: 180, maxRows: 1_000_000 }
```

The sweeper runs once a day on the worker only, deletes in batches of
5 000 rows (oldest id first, with a short pause between batches so the
sender is never stalled by one long DELETE), prunes `email_link` rows
past their `expiresAt` or older than `days`, is `.unref()`'d so it never
blocks shutdown, and fails soft on DB hiccups.

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

## HTTP endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| `GET` | `/email-track/open/:token.gif` | public | tracking pixel |
| `GET` | `/email-track/click/:token?u=…` | public | click redirector |
| `POST` | `/email-track/bounce` | HMAC | bounce / complaint webhook |
| `GET` | `/email-track/log` | admin | paginated list with filters |
| `GET` | `/email-track/log/summary` | admin | status totals tile |
| `GET` | `/email-track/log/:id` | admin | full detail incl. opens + clicks |
| `GET` | `/email-track/log/stats/by-template` | admin | per-template aggregates |
| `GET` | `/email-track/log/export.csv` | admin | CSV export |
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

## Lost your licence key?

Re-send every active key on file at
[elite.charity/licence/forgot](https://elite.charity/licence/forgot).

## Documentation

User manual + screenshots:
[huloglobal.com/vendure-plugins/email-tracking/docs/](https://huloglobal.com/vendure-plugins/email-tracking/docs/)

## Licence

Commercial. Buy at
[elite.charity/licence/buy/vendure-plugin-email-tracking](https://elite.charity/licence/buy/vendure-plugin-email-tracking).
