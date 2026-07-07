# worker-cms-plugin-ticket

Ticket sales for the Workers CMS events suite. Sells tickets to **existing
guests** of cms-plugin-events (invitation-driven, HMAC-signed purchase links),
paid by **Stripe Checkout** or **offline payment** (bank transfer / cash,
confirmed by an admin). Includes inventory caps + sale windows, promo codes,
refunds/cancellation, and a QR e-ticket delivered by confirmation email.

## Architecture

```
Admin ──/admin/plugins/ticket/*──▶ CMS host ──proxy──▶ this Worker /__plugin/admin/*
Guest ──signed link──▶ worker-rsvp /ticket/buy/... ──▶ this Worker /api/*
Guest ──redirect──▶ Stripe Checkout ──return──▶ worker-rsvp /ticket/order/...
Stripe ──webhook──▶ this Worker /webhook/stripe   (own public URL — the CMS has no inbound proxy)
this Worker ──/__cms──▶ CMS host D1 (ticket pages, guest updates)
```

- **worker-rsvp renders, this plugin decides.** The public checkout pages live
  on worker-rsvp; every `/api/*` call relays the HMAC signature embedded in the
  visitor's URL and this plugin re-verifies it, so worker-rsvp holds no
  ticket credentials (only `TICKET_PLUGIN_URL`).
- **Page types** (all pointered to their event, never parented):
  `ticket_type` (price in minor units, `quantity` cap, `sold` counter, sale
  window on native start/end), `ticket_order` (state machine:
  pending / pending_offline / paid / cancelled / refunded / expired, with a
  `history` audit block), `ticket_promo` (percent or fixed, `max_uses`),
  `ticket_settings` (per-event toggles + offline instructions).
- **Fulfillment** writes the order code into the guest's `qrcode` attr and sets
  the guest `confirmed`, so the events plugin's existing check-in scanning
  works unchanged; a confirmation email links the e-ticket page (QR).
- **Purchase links** ("Purchase links" admin page) write a signed `ticket_url`
  onto every guest in a list — usable directly as the `{{ticket_url}}` merge
  token in EDMs.

## Caveats

- Inventory is a read-modify-write `sold` counter through the Plugin API (no
  transactions): simultaneous checkouts can oversell by a request's worth.
- One order = one ticket type × quantity; buying two types means two orders.
- Stripe webhook events handled: `checkout.session.completed`,
  `checkout.session.expired`, `charge.refunded` (all idempotent).

## Setup

```bash
npm install
wrangler secret put PLUGIN_SECRET          # shared with the CMS (Plugins → ticket → Shared secret)
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_WEBHOOK_SECRET  # endpoint: {this worker}/webhook/stripe
wrangler deploy
```

Then: register the plugin in the CMS admin (Plugins → Manage) with this
Worker's URL; approve its `readTypes` (event, guest, mail_list) and
`writeTypes` (guest); set `PUBLIC_BASE_URL` in wrangler.toml to the worker-rsvp
origin and `TICKET_PLUGIN_URL` on worker-rsvp to this Worker's origin.

In the Stripe dashboard add a webhook endpoint for
`checkout.session.completed`, `checkout.session.expired` and `charge.refunded`.

## Local development

Run three dev servers (ports as in `.dev.vars`): the CMS host (`:8787`), this
plugin (`:8789`), worker-rsvp (`:8790`). Copy `.dev.vars.example` to
`.dev.vars`; the `PLUGIN_SECRET` must match the secret stored for the
registered plugin in the CMS. For Stripe:

```bash
stripe listen --forward-to localhost:8789/webhook/stripe   # gives whsec_... for .dev.vars
```

Always use `localhost` URLs — the CMS host 404s non-GETs from non-canonical
origins.

## Tests

```bash
npx tsc --noEmit && npm test
```

The suite drives the Worker directly against an in-memory fake of the CMS
`/__cms` API and a stubbed `api.stripe.com` (see `test/index.test.ts`).
