// ============================================================
// Order lifecycle — creation, fulfillment, inventory, promos — plus the
// admin orders UI and per-guest purchase-link minting.
//
// State machine (status attr on ticket_order pages):
//   pending          Stripe Checkout in flight (holds inventory)
//   pending_offline  awaiting offline payment  (holds inventory)
//   paid             fulfilled                 (holds inventory)
//   expired          Stripe session lapsed     (released)
//   cancelled        admin/void                (released)
//   refunded         paid then refunded        (released)
// Transitions are idempotent: every mutator re-reads the order and no-ops
// unless the current status allows the move (Stripe retries webhooks).
// ============================================================

import {
  CmsClient,
  attr,
  formatAmount,
  history,
  intAttr,
  listByEvent,
  localized,
  orderStatus,
  pointer,
  withHistory,
  type CmsPage,
  type OrderStatus,
} from './cms';
import { signPayload, verifyPayload } from './crypto';
import { forbidden, type TicketAdminAccess } from './permissions';
import { createCheckoutSession, createRefund, StripeError, type StripeEnv } from './stripe';
import { ADMIN_BASE, DEFAULT_CURRENCY, pageId, settingsForEvent, text } from './tickets';
import { adminView } from './templates/views';
import { redirect } from '@lionrockjs/worker-cms-plugin';

export interface OutboundEmail {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  replyTo?: string;
}

export interface TicketEnv extends StripeEnv {
  PLUGIN_SECRET?: string;
  CMS_URL?: string;
  /** Public origin of worker-rsvp — purchase links and order pages live there. */
  PUBLIC_BASE_URL?: string;
  VIEWS: Fetcher;
  EMAIL?: { send(message: OutboundEmail): Promise<unknown> };
  EMAIL_FROM?: string;
}

/** Stripe Checkout sessions lapse after 30 minutes (Stripe's minimum). */
const CHECKOUT_EXPIRY_SECONDS = 30 * 60;

// ── Signed tokens ───────────────────────────────────────────────────────────
// Purchase link:  tkt:{eventId}:{listId}:{guestId}  → /ticket/buy/... on worker-rsvp
// Order page:     tko:{orderCode}                   → /ticket/order/... on worker-rsvp

export function purchasePayload(eventId: number | string, listId: number | string, guestId: number | string): string {
  return `tkt:${eventId}:${listId}:${guestId}`;
}

export function orderPayload(orderCode: string): string {
  return `tko:${orderCode}`;
}

export async function purchaseUrl(env: TicketEnv, eventId: number, listId: number, guestId: number): Promise<string> {
  const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const signature = await signPayload(env.PLUGIN_SECRET ?? '', purchasePayload(eventId, listId, guestId));
  return `${base}/ticket/buy/${eventId}/${listId}/${guestId}/${signature}`;
}

export async function orderUrl(env: TicketEnv, orderCode: string): Promise<string> {
  const base = (env.PUBLIC_BASE_URL ?? '').replace(/\/+$/, '');
  const signature = await signPayload(env.PLUGIN_SECRET ?? '', orderPayload(orderCode));
  return `${base}/ticket/order/${orderCode}/${signature}`;
}

/** Public, unguessable order code; doubles as the page name and the check-in QR value. */
export function newOrderCode(): string {
  const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  let code = '';
  for (const byte of bytes) code += alphabet[byte % alphabet.length];
  return `T${code}`;
}

// ── Lookups ─────────────────────────────────────────────────────────────────

/** Orders are named by their code, so the host's `q` search finds them. */
export async function orderByCode(cms: CmsClient, code: string): Promise<CmsPage | null> {
  if (!code) return null;
  const { pages } = await cms.list('ticket_order', { q: code, limit: 10 });
  return pages.find((page) => attr(page.lect, 'order_code') === code) ?? null;
}

export interface SaleableType {
  page: CmsPage;
  price: number;
  currency: string;
  /** null = unlimited. */
  remaining: number | null;
  onSale: boolean;
}

export function saleableType(type: CmsPage, now = new Date()): SaleableType {
  const quantityRaw = attr(type.lect, 'quantity');
  const remaining = quantityRaw === '' ? null : Math.max(0, intAttr(type.lect, 'quantity') - intAttr(type.lect, 'sold'));
  const startsOk = !type.start || new Date(type.start) <= now;
  const endsOk = !type.end || now <= new Date(type.end);
  return {
    page: type,
    price: intAttr(type.lect, 'price'),
    currency: attr(type.lect, 'currency') || DEFAULT_CURRENCY,
    remaining,
    onSale: attr(type.lect, 'active') === 'true' && startsOk && endsOk && (remaining == null || remaining > 0),
  };
}

/** Loads a guest and confirms the list/event chain the signed link claims. */
export async function verifiedGuest(
  cms: CmsClient,
  eventId: number,
  listId: number,
  guestId: number,
): Promise<{ event: CmsPage; list: CmsPage; guest: CmsPage } | null> {
  const [event, list, guest] = await Promise.all([cms.get(eventId), cms.get(listId), cms.get(guestId)]);
  if (event.page_type !== 'event' || list.page_type !== 'mail_list' || guest.page_type !== 'guest') return null;
  if (pointer(list.lect, 'event') !== String(eventId)) return null;
  if (pointer(guest.lect, 'mail_list') !== String(listId)) return null;
  return { event, list, guest };
}

// ── Promos ──────────────────────────────────────────────────────────────────

export interface PromoResult {
  promo: CmsPage | null;
  /** Total discount in minor units (0 when no/invalid promo). */
  discount: number;
  error?: string;
}

export async function resolvePromo(
  cms: CmsClient,
  eventId: number,
  code: string,
  currency: string,
  subtotal: number,
  now = new Date(),
): Promise<PromoResult> {
  const normalized = code.trim().toUpperCase();
  if (!normalized) return { promo: null, discount: 0 };
  const promos = await listByEvent(cms, 'ticket_promo', eventId, { limit: 200 });
  const promo = promos.find((page) => attr(page.lect, 'code') === normalized);
  if (!promo) return { promo: null, discount: 0, error: 'Unknown promo code.' };

  const startsOk = !promo.start || new Date(promo.start) <= now;
  const endsOk = !promo.end || now <= new Date(promo.end);
  if (!startsOk || !endsOk) return { promo: null, discount: 0, error: 'This promo code is not currently valid.' };

  const maxUses = attr(promo.lect, 'max_uses');
  if (maxUses !== '' && intAttr(promo.lect, 'used_count') >= intAttr(promo.lect, 'max_uses')) {
    return { promo: null, discount: 0, error: 'This promo code has been fully redeemed.' };
  }

  if (attr(promo.lect, 'kind') === 'fixed') {
    const promoCurrency = attr(promo.lect, 'currency') || DEFAULT_CURRENCY;
    if (promoCurrency.toLowerCase() !== currency.toLowerCase()) {
      return { promo: null, discount: 0, error: 'This promo code does not apply to this currency.' };
    }
    return { promo, discount: Math.min(subtotal, intAttr(promo.lect, 'amount')) };
  }
  const percent = Math.min(100, Math.max(0, intAttr(promo.lect, 'amount')));
  return { promo, discount: Math.floor((subtotal * percent) / 100) };
}

// ── Inventory & counters ────────────────────────────────────────────────────
// Read-modify-write on a lect attr; the Plugin API has no transactions, so two
// simultaneous checkouts can oversell by one request's worth — accepted for v1.

async function bumpCounter(cms: CmsClient, page: CmsPage, key: string, delta: number): Promise<void> {
  const fresh = await cms.get(page.id);
  const next = Math.max(0, intAttr(fresh.lect, key) + delta);
  await cms.update(page.id, { lect: { [key]: String(next) } });
}

export function releaseInventory(cms: CmsClient, order: CmsPage): Promise<void> {
  return adjustOrderInventory(cms, order, -1);
}

async function adjustOrderInventory(cms: CmsClient, order: CmsPage, sign: 1 | -1): Promise<void> {
  const typeId = pageId(pointer(order.lect, 'ticket_type'));
  if (!typeId) return;
  const type = await cms.get(typeId).catch(() => null);
  if (!type || type.page_type !== 'ticket_type') return;
  await bumpCounter(cms, type, 'sold', sign * Math.max(1, intAttr(order.lect, 'quantity', 1)));
}

// ── Order creation ──────────────────────────────────────────────────────────

export interface CreateOrderInput {
  eventId: number;
  listId: number;
  guestId: number;
  ticketTypeId: number;
  quantity: number;
  promoCode: string;
  paymentMethod: 'stripe' | 'offline';
  email: string;
}

export type CreateOrderResult =
  | { ok: true; orderCode: string; orderUrl: string; checkoutUrl?: string }
  | { ok: false; status: number; error: string };

export async function createOrder(cms: CmsClient, env: TicketEnv, input: CreateOrderInput): Promise<CreateOrderResult> {
  const chain = await verifiedGuest(cms, input.eventId, input.listId, input.guestId);
  if (!chain) return { ok: false, status: 404, error: 'Unknown guest or event.' };

  const settings = await settingsForEvent(cms, input.eventId);
  const stripeEnabled = settings ? attr(settings.lect, 'stripe_enabled') === 'true' : true;
  const offlineEnabled = settings ? attr(settings.lect, 'offline_enabled') === 'true' : true;
  if (input.paymentMethod === 'stripe' && !stripeEnabled) return { ok: false, status: 400, error: 'Card payment is not available for this event.' };
  if (input.paymentMethod === 'offline' && !offlineEnabled) return { ok: false, status: 400, error: 'Offline payment is not available for this event.' };

  const typePage = await cms.get(input.ticketTypeId).catch(() => null);
  if (!typePage || typePage.page_type !== 'ticket_type' || pointer(typePage.lect, 'event') !== String(input.eventId)) {
    return { ok: false, status: 404, error: 'Unknown ticket type.' };
  }
  const type = saleableType(typePage);
  if (!type.onSale) return { ok: false, status: 400, error: 'This ticket is not on sale.' };

  const quantity = Math.floor(input.quantity);
  if (!Number.isFinite(quantity) || quantity < 1 || quantity > 20) return { ok: false, status: 400, error: 'Invalid quantity.' };
  if (type.remaining != null && quantity > type.remaining) {
    return { ok: false, status: 400, error: `Only ${type.remaining} left.` };
  }

  const email = input.email.trim() || attr(chain.guest.lect, 'email');
  const subtotal = type.price * quantity;
  const promo = await resolvePromo(cms, input.eventId, input.promoCode, type.currency, subtotal);
  if (promo.error) return { ok: false, status: 400, error: promo.error };
  const total = subtotal - promo.discount;

  const code = newOrderCode();
  const status: OrderStatus = input.paymentMethod === 'offline' ? 'pending_offline' : 'pending';
  const order = await cms.create({
    page_type: 'ticket_order',
    name: code,
    lect: {
      _type: 'ticket_order',
      order_code: code,
      status,
      payment_method: input.paymentMethod,
      quantity: String(quantity),
      unit_amount: String(type.price),
      discount_amount: String(promo.discount),
      total_amount: String(total),
      currency: type.currency,
      promo_code: promo.promo ? attr(promo.promo.lect, 'code') : '',
      email,
      history: [{ status, date: new Date().toISOString(), message: `Order created (${input.paymentMethod}).` }],
      _pointers: {
        event: String(input.eventId),
        mail_list: String(input.listId),
        guest: String(input.guestId),
        ticket_type: String(typePage.id),
      },
    },
  });

  await adjustOrderInventory(cms, order, 1);
  if (promo.promo) await bumpCounter(cms, promo.promo, 'used_count', 1);

  const publicOrderUrl = await orderUrl(env, code);

  // Free after discount — no payment leg needed; fulfill immediately.
  if (total <= 0) {
    await fulfillOrder(cms, env, await cms.get(order.id), 'Free order — no payment required.');
    return { ok: true, orderCode: code, orderUrl: publicOrderUrl };
  }

  if (input.paymentMethod === 'offline') {
    return { ok: true, orderCode: code, orderUrl: publicOrderUrl };
  }

  try {
    // With a promo the total may not divide evenly per unit, so charge one
    // line item for the exact total instead of a rounded per-unit price.
    const session = await createCheckoutSession(env, {
      name: promo.discount > 0
        ? `${typePage.name} × ${quantity} — ${chain.event.name}`
        : `${typePage.name} — ${chain.event.name}`,
      currency: type.currency,
      unitAmount: promo.discount > 0 ? total : type.price,
      quantity: promo.discount > 0 ? 1 : quantity,
      customerEmail: email || undefined,
      clientReferenceId: String(order.id),
      metadata: { order_code: code },
      successUrl: publicOrderUrl,
      cancelUrl: `${publicOrderUrl}?cancelled=1`,
      expiresAt: Math.floor(Date.now() / 1000) + CHECKOUT_EXPIRY_SECONDS,
    });
    await cms.update(order.id, {
      lect: {
        stripe_session_id: session.id,
        ...(session.payment_intent ? { stripe_payment_intent: session.payment_intent } : {}),
      },
    });
    return { ok: true, orderCode: code, orderUrl: publicOrderUrl, checkoutUrl: session.url };
  } catch (error) {
    // Roll the reservation back so a Stripe outage doesn't strand inventory.
    await cms.update(order.id, {
      lect: { status: 'cancelled', history: withHistory(order.lect, 'cancelled', 'Stripe session creation failed.') },
    });
    await releaseInventory(cms, order);
    if (promo.promo) await bumpCounter(cms, promo.promo, 'used_count', -1);
    const message = error instanceof StripeError ? error.message : 'Payment provider unavailable.';
    return { ok: false, status: 502, error: message };
  }
}

// ── Transitions ─────────────────────────────────────────────────────────────

/** pending / pending_offline → paid. Idempotent; also writes the guest's QR + status. */
export async function fulfillOrder(cms: CmsClient, env: TicketEnv, order: CmsPage, note: string): Promise<CmsPage> {
  const current = orderStatus(order.lect);
  if (current === 'paid') return order;
  if (current !== 'pending' && current !== 'pending_offline') return order;

  const updated = await cms.update(order.id, {
    lect: { status: 'paid', history: withHistory(order.lect, 'paid', note) },
  });

  const guestId = pageId(pointer(order.lect, 'guest'));
  if (guestId) {
    // The order code becomes the guest's third-party QR string, so the events
    // plugin's existing check-in scanner resolves the holder without changes.
    await cms.update(guestId, {
      lect: { qrcode: attr(order.lect, 'order_code'), status: 'confirmed' },
    }).catch((error) => console.error('[ticket] guest update failed', error));
  }

  await sendConfirmationEmail(cms, env, updated).catch((error) => console.error('[ticket] confirmation email failed', error));
  return updated;
}

/** pending → expired (Stripe session lapsed). Releases inventory once. */
export async function expireOrder(cms: CmsClient, order: CmsPage): Promise<void> {
  if (orderStatus(order.lect) !== 'pending') return;
  await cms.update(order.id, {
    lect: { status: 'expired', history: withHistory(order.lect, 'expired', 'Checkout session expired.') },
  });
  await releaseInventory(cms, order);
}

/** pending / pending_offline → cancelled. Releases inventory. */
export async function cancelOrder(cms: CmsClient, order: CmsPage, note: string): Promise<boolean> {
  const current = orderStatus(order.lect);
  if (current !== 'pending' && current !== 'pending_offline') return false;
  await cms.update(order.id, {
    lect: { status: 'cancelled', history: withHistory(order.lect, 'cancelled', note) },
  });
  await releaseInventory(cms, order);
  return true;
}

/** paid → refunded. Stripe orders refund via API first; offline flip directly. */
export async function refundOrder(cms: CmsClient, env: TicketEnv, order: CmsPage, note: string): Promise<{ ok: boolean; error?: string }> {
  if (orderStatus(order.lect) !== 'paid') return { ok: false, error: 'Only paid orders can be refunded.' };

  if (attr(order.lect, 'payment_method') === 'stripe') {
    const paymentIntent = attr(order.lect, 'stripe_payment_intent');
    if (!paymentIntent) return { ok: false, error: 'No payment intent recorded for this order.' };
    try {
      await createRefund(env, paymentIntent);
    } catch (error) {
      return { ok: false, error: error instanceof StripeError ? error.message : 'Refund failed.' };
    }
  }

  await cms.update(order.id, {
    lect: { status: 'refunded', history: withHistory(order.lect, 'refunded', note) },
  });
  await releaseInventory(cms, order);
  return { ok: true };
}

/** Marks the refund state when Stripe reports a refund we did not initiate here. */
export async function markRefundedFromWebhook(cms: CmsClient, order: CmsPage): Promise<void> {
  if (orderStatus(order.lect) !== 'paid') return;
  await cms.update(order.id, {
    lect: { status: 'refunded', history: withHistory(order.lect, 'refunded', 'Refund reported by Stripe.') },
  });
  await releaseInventory(cms, order);
}

// ── Confirmation email ──────────────────────────────────────────────────────

export async function sendConfirmationEmail(cms: CmsClient, env: TicketEnv, order: CmsPage): Promise<void> {
  const to = attr(order.lect, 'email');
  if (!to || !env.EMAIL || !env.EMAIL_FROM) return;

  const eventId = pageId(pointer(order.lect, 'event'));
  const event = eventId ? await cms.get(eventId).catch(() => null) : null;
  const eventName = event?.name ?? 'the event';
  const code = attr(order.lect, 'order_code');
  const link = await orderUrl(env, code);
  const amount = formatAmount(intAttr(order.lect, 'total_amount'), attr(order.lect, 'currency') || DEFAULT_CURRENCY);
  const quantity = attr(order.lect, 'quantity') || '1';

  const settings = eventId ? await settingsForEvent(cms, eventId) : null;
  const replyTo = settings ? attr(settings.lect, 'reply_to') : '';

  const textBody = [
    `Your ${quantity} ticket(s) for ${eventName} are confirmed.`,
    '',
    `Order ${code} — ${amount}`,
    `Your e-ticket (show the QR code at the door): ${link}`,
  ].join('\n');
  await env.EMAIL.send({
    from: env.EMAIL_FROM,
    to,
    subject: `Your tickets for ${eventName} (${code})`,
    text: textBody,
    html: [
      `<p>Your ${escapeHtml(quantity)} ticket(s) for <strong>${escapeHtml(eventName)}</strong> are confirmed.</p>`,
      `<p>Order <strong>${escapeHtml(code)}</strong> — ${escapeHtml(amount)}</p>`,
      `<p><a href="${escapeHtml(link)}">View your e-ticket</a> and show the QR code at the door.</p>`,
    ].join('\n'),
    ...(replyTo ? { replyTo } : {}),
  });
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character] as string
  ));
}

// ── Admin: orders list / detail / actions, link minting ────────────────────

export async function handleOrdersAdmin(
  request: Request,
  cms: CmsClient,
  env: TicketEnv,
  views: Fetcher,
  event: CmsPage,
  segments: string[],
  url: URL,
  access: TicketAdminAccess,
  jsonOnly = false,
): Promise<Response> {
  const base = `${ADMIN_BASE}/tickets/${event.id}`;

  if (!segments.length) return ordersList(cms, views, event, url, jsonOnly);

  const orderId = pageId(segments[0]);
  if (!orderId) return new Response('not found', { status: 404 });
  const order = await cms.get(orderId);
  if (order.page_type !== 'ticket_order' || pointer(order.lect, 'event') !== String(event.id)) {
    return new Response('not found', { status: 404 });
  }

  const action = segments[1] ?? '';
  if (request.method === 'POST') {
    if (!access.canEdit) return forbidden();
    const detail = `${base}/orders/${order.id}`;
    if (action === 'paid') {
      await fulfillOrder(cms, env, order, 'Offline payment confirmed by admin.');
      return redirect(`${detail}?flash=${encodeURIComponent('Order marked as paid.')}`);
    }
    if (action === 'cancel') {
      const cancelled = await cancelOrder(cms, order, 'Cancelled by admin.');
      return redirect(`${detail}?flash=${encodeURIComponent(cancelled ? 'Order cancelled.' : 'Order cannot be cancelled.')}`);
    }
    if (action === 'refund') {
      const result = await refundOrder(cms, env, order, 'Refunded by admin.');
      return redirect(`${detail}?flash=${encodeURIComponent(result.ok ? 'Order refunded.' : `Refund failed: ${result.error}`)}`);
    }
    if (action === 'resend') {
      await sendConfirmationEmail(cms, env, order);
      return redirect(`${detail}?flash=${encodeURIComponent('Confirmation email resent.')}`);
    }
    return new Response('not found', { status: 404 });
  }

  return orderDetail(cms, env, views, event, order, url, access, jsonOnly);
}

/** Badge classes limited to the host-emitted Tailwind subset (see cms-plugin-tailwind). */
export function statusClass(status: OrderStatus): string {
  switch (status) {
    case 'paid': return 'bg-green-100 text-green-800';
    case 'pending': return 'bg-yellow-100 text-amber-800';
    case 'pending_offline': return 'bg-amber-50 text-amber-800';
    case 'refunded': return 'bg-red-100 text-red-800';
    case 'expired': return 'bg-gray-100 text-gray-500';
    default: return 'bg-gray-100 text-gray-700';
  }
}

async function ordersList(cms: CmsClient, views: Fetcher, event: CmsPage, url: URL, jsonOnly: boolean): Promise<Response> {
  const base = `${ADMIN_BASE}/tickets/${event.id}`;
  const filter = (url.searchParams.get('status') ?? '').trim().toLowerCase();
  const orders = await listByEvent(cms, 'ticket_order', event.id, { limit: 500 });
  const filtered = filter ? orders.filter((order) => orderStatus(order.lect) === filter) : orders;
  const totals = { paid: 0, pending: 0 };
  for (const order of orders) {
    const status = orderStatus(order.lect);
    if (status === 'paid') totals.paid += intAttr(order.lect, 'total_amount');
    if (status === 'pending' || status === 'pending_offline') totals.pending += intAttr(order.lect, 'total_amount');
  }
  const currency = orders.length ? attr(orders[0].lect, 'currency') || DEFAULT_CURRENCY : DEFAULT_CURRENCY;
  return adminView(views, `Orders — ${event.name}`, 'ticket-orders', {
    eventName: event.name,
    backHref: base,
    flash: url.searchParams.get('flash') ?? '',
    filter,
    filters: ['', 'pending', 'pending_offline', 'paid', 'cancelled', 'refunded', 'expired'].map((value) => ({
      value,
      label: value === '' ? 'All' : value.replace('_', ' '),
      href: value ? `${base}/orders?status=${value}` : `${base}/orders`,
      active: filter === value,
    })),
    paidTotal: formatAmount(totals.paid, currency),
    pendingTotal: formatAmount(totals.pending, currency),
    orders: filtered.map((order) => ({
      href: `${base}/orders/${order.id}`,
      code: attr(order.lect, 'order_code'),
      status: orderStatus(order.lect),
      statusClass: statusClass(orderStatus(order.lect)),
      method: attr(order.lect, 'payment_method'),
      email: attr(order.lect, 'email'),
      quantity: attr(order.lect, 'quantity'),
      total: formatAmount(intAttr(order.lect, 'total_amount'), attr(order.lect, 'currency') || DEFAULT_CURRENCY),
      created: order.created_at.slice(0, 16).replace('T', ' '),
    })),
  }, jsonOnly);
}

async function orderDetail(
  cms: CmsClient,
  env: TicketEnv,
  views: Fetcher,
  event: CmsPage,
  order: CmsPage,
  url: URL,
  access: TicketAdminAccess,
  jsonOnly: boolean,
): Promise<Response> {
  const base = `${ADMIN_BASE}/tickets/${event.id}`;
  const detail = `${base}/orders/${order.id}`;
  const status = orderStatus(order.lect);
  const guestId = pageId(pointer(order.lect, 'guest'));
  const typeId = pageId(pointer(order.lect, 'ticket_type'));
  const [guest, type] = await Promise.all([
    guestId ? cms.get(guestId).catch(() => null) : null,
    typeId ? cms.get(typeId).catch(() => null) : null,
  ]);
  const currency = attr(order.lect, 'currency') || DEFAULT_CURRENCY;
  return adminView(views, `Order ${attr(order.lect, 'order_code')}`, 'ticket-order-detail', {
    eventName: event.name,
    backHref: `${base}/orders`,
    flash: url.searchParams.get('flash') ?? '',
    canEdit: access.canEdit,
    code: attr(order.lect, 'order_code'),
    status,
    statusClass: statusClass(status),
    method: attr(order.lect, 'payment_method'),
    email: attr(order.lect, 'email'),
    promo: attr(order.lect, 'promo_code'),
    quantity: attr(order.lect, 'quantity'),
    typeName: type?.name ?? '',
    guestName: guest?.name ?? '',
    guestHref: guest ? `/admin/pages/${guest.id}/edit?return_to=${encodeURIComponent(detail)}` : '',
    unit: formatAmount(intAttr(order.lect, 'unit_amount'), currency),
    discount: formatAmount(intAttr(order.lect, 'discount_amount'), currency),
    total: formatAmount(intAttr(order.lect, 'total_amount'), currency),
    stripeSession: attr(order.lect, 'stripe_session_id'),
    stripePaymentIntent: attr(order.lect, 'stripe_payment_intent'),
    publicUrl: env.PUBLIC_BASE_URL ? await orderUrl(env, attr(order.lect, 'order_code')) : '',
    canMarkPaid: status === 'pending_offline' || status === 'pending',
    canCancel: status === 'pending' || status === 'pending_offline',
    canRefund: status === 'paid',
    paidAction: `${detail}/paid`,
    cancelAction: `${detail}/cancel`,
    refundAction: `${detail}/refund`,
    resendAction: `${detail}/resend`,
    history: history(order.lect).map((entry) => ({
      status: String(entry.status ?? ''),
      date: String(entry.date ?? '').slice(0, 19).replace('T', ' '),
      message: String(entry.message ?? ''),
    })),
  }, jsonOnly);
}

// ── Purchase-link minting ───────────────────────────────────────────────────

export async function handleLinksAdmin(
  request: Request,
  cms: CmsClient,
  env: TicketEnv,
  views: Fetcher,
  event: CmsPage,
  access: TicketAdminAccess,
  jsonOnly = false,
): Promise<Response> {
  const base = `${ADMIN_BASE}/tickets/${event.id}`;
  const lists = await listByEvent(cms, 'mail_list', event.id);

  if (request.method === 'POST') {
    if (!access.canEdit) return forbidden();
    if (!env.PUBLIC_BASE_URL || !env.PLUGIN_SECRET) {
      return redirect(`${base}/links?flash=${encodeURIComponent('Set PUBLIC_BASE_URL and PLUGIN_SECRET before minting links.')}`);
    }
    const form = await request.formData();
    const listId = pageId(text(form, 'list_id'));
    const list = lists.find((candidate) => candidate.id === listId);
    if (!list) return redirect(`${base}/links?flash=${encodeURIComponent('Choose a guest list.')}`);

    // Sequential per-guest updates: each write is one CMS subrequest, mirroring
    // the events plugin's import chunking to stay inside the request budget.
    const { pages: guests } = await cms.list('guest', { pointer: { key: 'mail_list', value: String(list.id) }, limit: 500 });
    let minted = 0;
    for (const guest of guests) {
      const link = await purchaseUrl(env, event.id, list.id, guest.id);
      if (attr(guest.lect, 'ticket_url') === link) continue;
      await cms.update(guest.id, { lect: { ticket_url: link } });
      minted += 1;
    }
    return redirect(`${base}/links?flash=${encodeURIComponent(`Wrote ticket_url for ${minted} of ${guests.length} guest(s) in “${list.name}”.`)}`);
  }

  return adminView(views, `Purchase links — ${event.name}`, 'ticket-links', {
    eventName: event.name,
    backHref: base,
    canEdit: access.canEdit,
    action: `${base}/links`,
    configured: Boolean(env.PUBLIC_BASE_URL && env.PLUGIN_SECRET),
    lists: lists.map((list) => ({ id: list.id, name: list.name })),
  }, jsonOnly);
}

export { verifyPayload, localized };
