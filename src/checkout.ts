// ============================================================
// Public API — the endpoints worker-rsvp calls to render checkout and place
// orders, plus the Stripe webhook receiver. All JSON in/out.
//
//   GET  /api/checkout/:eventId/:listId/:guestId/:sig   checkout context
//   POST /api/orders                                    place an order
//   GET  /api/orders/:orderCode/:sig                    order status (e-ticket page)
//   POST /webhook/stripe                                Stripe events
//
// The guest-link signature (tkt:event:list:guest) authenticates the first two;
// the order signature (tko:code) authenticates the status endpoint. worker-rsvp
// simply relays the signatures from its URLs — the plugin re-verifies, so the
// public site holds no write credentials of its own.
// ============================================================

import {
  CmsClient,
  attr,
  formatAmount,
  intAttr,
  listByEvent,
  localized,
  orderStatus,
  pointer,
} from './cms';
import { verifyPayload } from './crypto';
import {
  createOrder,
  expireOrder,
  fulfillOrder,
  markRefundedFromWebhook,
  orderByCode,
  orderPayload,
  purchasePayload,
  saleableType,
  ticketSignKey,
  verifiedGuest,
  type TicketEnv,
} from './orders';
import { getCheckoutSession, verifyStripeWebhook } from './stripe';
import { pageId, settingsForEvent, DEFAULT_CURRENCY } from './tickets';

function json(data: unknown, status = 200): Response {
  return Response.json(data, { status, headers: { 'cache-control': 'no-store' } });
}

// ── GET /api/checkout/:eventId/:listId/:guestId/:sig ───────────────────────

export async function handleCheckoutContext(cms: CmsClient, env: TicketEnv, segments: string[]): Promise<Response> {
  const [eventId, listId, guestId] = segments.slice(0, 3).map((value) => pageId(value));
  const signature = segments[3] ?? '';
  const signKey = ticketSignKey(env);
  if (!eventId || !listId || !guestId || !signature || !signKey) return json({ error: 'not found' }, 404);
  if (!(await verifyPayload(signKey, purchasePayload(eventId, listId, guestId), signature))) {
    return json({ error: 'not found' }, 404);
  }

  const chain = await verifiedGuest(cms, eventId, listId, guestId);
  if (!chain) return json({ error: 'not found' }, 404);

  const [types, settings] = await Promise.all([
    listByEvent(cms, 'ticket_type', eventId),
    settingsForEvent(cms, eventId),
  ]);
  const saleable = types.map((type) => saleableType(type)).filter((type) => type.onSale);

  return json({
    event: { id: chain.event.id, name: chain.event.name, description: localized(chain.event.lect, 'description') },
    guest: { id: chain.guest.id, name: chain.guest.name, email: attr(chain.guest.lect, 'email') },
    stripe_enabled: settings ? attr(settings.lect, 'stripe_enabled') === 'true' : true,
    offline_enabled: settings ? attr(settings.lect, 'offline_enabled') === 'true' : true,
    types: saleable.map((type) => ({
      id: type.page.id,
      name: type.page.name,
      description: localized(type.page.lect, 'description'),
      price: type.price,
      price_label: formatAmount(type.price, type.currency),
      currency: type.currency,
      remaining: type.remaining,
    })),
  });
}

// ── POST /api/orders ────────────────────────────────────────────────────────

interface OrderRequestBody {
  event_id?: unknown;
  list_id?: unknown;
  guest_id?: unknown;
  sig?: unknown;
  ticket_type_id?: unknown;
  quantity?: unknown;
  promo_code?: unknown;
  payment_method?: unknown;
  email?: unknown;
}

export async function handleCreateOrder(request: Request, cms: CmsClient, env: TicketEnv): Promise<Response> {
  const body = await request.json().catch(() => null) as OrderRequestBody | null;
  if (!body || !ticketSignKey(env)) return json({ error: 'bad request' }, 400);

  const eventId = pageId(body.event_id);
  const listId = pageId(body.list_id);
  const guestId = pageId(body.guest_id);
  const ticketTypeId = pageId(body.ticket_type_id);
  const signature = typeof body.sig === 'string' ? body.sig : '';
  if (!eventId || !listId || !guestId || !ticketTypeId || !signature) return json({ error: 'bad request' }, 400);
  if (!(await verifyPayload(ticketSignKey(env), purchasePayload(eventId, listId, guestId), signature))) {
    return json({ error: 'not found' }, 404);
  }

  const result = await createOrder(cms, env, {
    eventId,
    listId,
    guestId,
    ticketTypeId,
    quantity: Number(body.quantity ?? 1),
    promoCode: typeof body.promo_code === 'string' ? body.promo_code : '',
    paymentMethod: body.payment_method === 'offline' ? 'offline' : 'stripe',
    email: typeof body.email === 'string' ? body.email : '',
  });
  if (!result.ok) return json({ error: result.error }, result.status);
  return json({
    order_code: result.orderCode,
    order_url: result.orderUrl,
    ...(result.checkoutUrl ? { checkout_url: result.checkoutUrl } : {}),
  });
}

// ── GET /api/orders/:orderCode/:sig ─────────────────────────────────────────

export async function handleOrderStatus(cms: CmsClient, env: TicketEnv, segments: string[]): Promise<Response> {
  const code = (segments[0] ?? '').trim().toUpperCase();
  const signature = segments[1] ?? '';
  const signKey = ticketSignKey(env);
  if (!code || !signature || !signKey) return json({ error: 'not found' }, 404);
  if (!(await verifyPayload(signKey, orderPayload(code), signature))) return json({ error: 'not found' }, 404);

  const order = await orderByCode(cms, code);
  if (!order) return json({ error: 'not found' }, 404);

  const eventId = pageId(pointer(order.lect, 'event'));
  const [event, settings] = await Promise.all([
    eventId ? cms.get(eventId).catch(() => null) : null,
    eventId ? settingsForEvent(cms, eventId) : null,
  ]);
  const currency = attr(order.lect, 'currency') || DEFAULT_CURRENCY;
  return json({
    order_code: code,
    status: orderStatus(order.lect),
    payment_method: attr(order.lect, 'payment_method'),
    quantity: intAttr(order.lect, 'quantity', 1),
    total: intAttr(order.lect, 'total_amount'),
    total_label: formatAmount(intAttr(order.lect, 'total_amount'), currency),
    currency,
    email: attr(order.lect, 'email'),
    event: event ? { id: event.id, name: event.name } : null,
    offline_instructions: settings ? localized(settings.lect, 'offline_instructions') : '',
  });
}

// ── POST /webhook/stripe ────────────────────────────────────────────────────

export async function handleStripeWebhook(request: Request, cms: CmsClient, env: TicketEnv): Promise<Response> {
  const rawBody = await request.text();
  const event = await verifyStripeWebhook(env, rawBody, request.headers.get('stripe-signature'));
  if (!event) return new Response('bad signature', { status: 400 });

  try {
    if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.expired') {
      const session = event.data.object as { id?: unknown; client_reference_id?: unknown; payment_intent?: unknown };
      const orderId = pageId(session.client_reference_id);
      if (!orderId) return new Response('ok');
      const order = await cms.get(orderId).catch(() => null);
      if (!order || order.page_type !== 'ticket_order') return new Response('ok');
      // Guard against a spoofed reference: the session must be the one we stored.
      if (typeof session.id === 'string' && attr(order.lect, 'stripe_session_id') !== session.id) return new Response('ok');

      if (event.type === 'checkout.session.completed') {
        const paymentIntent = typeof session.payment_intent === 'string' ? session.payment_intent : '';
        if (paymentIntent && attr(order.lect, 'stripe_payment_intent') !== paymentIntent) {
          await cms.update(order.id, { lect: { stripe_payment_intent: paymentIntent } });
          order.lect.stripe_payment_intent = paymentIntent;
        }
        await fulfillOrder(cms, env, order, 'Stripe payment completed.');
      } else {
        await expireOrder(cms, order);
      }
      return new Response('ok');
    }

    if (event.type === 'charge.refunded') {
      const charge = event.data.object as { payment_intent?: unknown };
      const paymentIntent = typeof charge.payment_intent === 'string' ? charge.payment_intent : '';
      if (!paymentIntent) return new Response('ok');
      // Resolve the order via the session that owns this payment intent.
      const sessions = await listSessionsForPaymentIntent(env, paymentIntent);
      for (const session of sessions) {
        const orderId = pageId(session.client_reference_id);
        if (!orderId) continue;
        const order = await cms.get(orderId).catch(() => null);
        if (order && order.page_type === 'ticket_order') await markRefundedFromWebhook(cms, order);
      }
      return new Response('ok');
    }

    return new Response('ok');
  } catch (error) {
    // Non-2xx makes Stripe retry with backoff — desirable for transient CMS errors.
    console.error('[ticket] webhook processing failed', error);
    return new Response('retry', { status: 500 });
  }
}

async function listSessionsForPaymentIntent(
  env: TicketEnv,
  paymentIntent: string,
): Promise<Array<{ client_reference_id?: unknown }>> {
  if (!env.STRIPE_SECRET_KEY) return [];
  const response = await fetch(`https://api.stripe.com/v1/checkout/sessions?payment_intent=${encodeURIComponent(paymentIntent)}`, {
    headers: { authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  });
  if (!response.ok) return [];
  const payload = await response.json().catch(() => ({})) as { data?: Array<{ client_reference_id?: unknown }> };
  return payload.data ?? [];
}

export { getCheckoutSession };
