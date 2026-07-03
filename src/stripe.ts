// ============================================================
// Minimal Stripe REST client — Checkout Sessions, refunds and webhook
// signature verification. Deliberately fetch-based (no stripe-node): the
// plugin needs three endpoints, and the official SDK's Node shims outweigh
// them. Amounts are minor units throughout, matching cms.ts money helpers.
// ============================================================

export interface StripeEnv {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
}

export class StripeError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'StripeError';
  }
}

export interface CheckoutSessionInput {
  /** Line item shown on the Stripe-hosted page. */
  name: string;
  currency: string;
  /** Per-unit amount in minor units, after any promo discount. */
  unitAmount: number;
  quantity: number;
  customerEmail?: string;
  /** Our order page id — echoed back in the webhook. */
  clientReferenceId: string;
  /** Extra lookup keys echoed back in the webhook. */
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  /** Unix seconds; Stripe enforces a 30-minute minimum. */
  expiresAt?: number;
}

export interface CheckoutSession {
  id: string;
  url: string;
  payment_intent?: string;
}

export async function createCheckoutSession(env: StripeEnv, input: CheckoutSessionInput): Promise<CheckoutSession> {
  const params: Record<string, string> = {
    mode: 'payment',
    'line_items[0][quantity]': String(input.quantity),
    'line_items[0][price_data][currency]': input.currency.toLowerCase(),
    'line_items[0][price_data][unit_amount]': String(input.unitAmount),
    'line_items[0][price_data][product_data][name]': input.name,
    client_reference_id: input.clientReferenceId,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  };
  if (input.customerEmail) params.customer_email = input.customerEmail;
  if (input.expiresAt) params.expires_at = String(input.expiresAt);
  for (const [key, value] of Object.entries(input.metadata)) {
    params[`metadata[${key}]`] = value;
  }
  const session = await stripeCall<CheckoutSession & { url: string | null }>(env, 'POST', '/v1/checkout/sessions', params);
  if (!session.url) throw new StripeError(500, 'checkout session has no redirect url');
  return { id: session.id, url: session.url, payment_intent: stringOrEmpty(session.payment_intent) || undefined };
}

/** Full refund of a payment intent. */
export async function createRefund(env: StripeEnv, paymentIntent: string): Promise<{ id: string; status: string }> {
  return stripeCall(env, 'POST', '/v1/refunds', { payment_intent: paymentIntent });
}

/** Fetches a checkout session (used to backfill payment_intent after completion). */
export async function getCheckoutSession(env: StripeEnv, sessionId: string): Promise<{ id: string; payment_intent?: string; payment_status?: string }> {
  const session = await stripeCall<{ id: string; payment_intent?: unknown; payment_status?: string }>(
    env, 'GET', `/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
  );
  return { id: session.id, payment_intent: stringOrEmpty(session.payment_intent) || undefined, payment_status: session.payment_status };
}

async function stripeCall<T>(env: StripeEnv, method: 'GET' | 'POST', path: string, params?: Record<string, string>): Promise<T> {
  if (!env.STRIPE_SECRET_KEY) throw new StripeError(500, 'STRIPE_SECRET_KEY is not configured');
  const body = params && method === 'POST' ? new URLSearchParams(params).toString() : undefined;
  const query = params && method === 'GET' ? `?${new URLSearchParams(params)}` : '';
  const response = await fetch(`https://api.stripe.com${path}${query}`, {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      ...(body !== undefined ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
    },
    body,
  });
  const payload = await response.json().catch(() => ({})) as T & { error?: { message?: string } };
  if (!response.ok) {
    throw new StripeError(response.status, payload.error?.message ?? `Stripe ${path} failed with ${response.status}`);
  }
  return payload;
}

// ── Webhooks ────────────────────────────────────────────────────────────────

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

/**
 * Verifies a `stripe-signature` header (t=...,v1=...) against the raw body and
 * returns the parsed event, or null when the signature is missing/forged/stale.
 * crypto.subtle.verify gives the constant-time comparison.
 */
export async function verifyStripeWebhook(
  env: StripeEnv,
  rawBody: string,
  signatureHeader: string | null,
  toleranceSeconds = 300,
  now = () => Date.now(),
): Promise<StripeEvent | null> {
  if (!env.STRIPE_WEBHOOK_SECRET || !signatureHeader) return null;

  let timestamp = '';
  const signatures: string[] = [];
  for (const part of signatureHeader.split(',')) {
    const [key, value] = part.split('=', 2).map((piece) => piece?.trim() ?? '');
    if (key === 't') timestamp = value;
    if (key === 'v1' && value) signatures.push(value);
  }
  if (!timestamp || !signatures.length) return null;
  const age = Math.abs(now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > toleranceSeconds) return null;

  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(env.STRIPE_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'],
  );
  const signedPayload = new TextEncoder().encode(`${timestamp}.${rawBody}`);
  for (const signature of signatures) {
    const bytes = signature.match(/.{1,2}/g)?.map((hex) => parseInt(hex, 16));
    if (!bytes || bytes.length !== 32 || bytes.some(Number.isNaN)) continue;
    if (await crypto.subtle.verify('HMAC', key, new Uint8Array(bytes), signedPayload)) {
      try {
        return JSON.parse(rawBody) as StripeEvent;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function stringOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
