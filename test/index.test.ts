import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { currencyDecimals, formatAmount, history, toMinorUnits } from '../src/cms';
import { signPayload } from '../src/crypto';
import worker from '../src/index';
import type { TicketEnv } from '../src/orders';

const plugin = worker as { fetch(request: Request, env: TicketEnv): Promise<Response> };

const SECRET = 'shared-secret';

function views(): Fetcher {
  return {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = typeof input === 'string' ? new URL(input) : input instanceof URL ? input : new URL(input.url);
      try {
        return new Response(await readFile(fileURLToPath(new URL(`../views${url.pathname}`, import.meta.url).href), 'utf8'));
      } catch {
        return new Response('not found', { status: 404 });
      }
    },
  } as Fetcher;
}

function env(overrides: Partial<TicketEnv> = {}): TicketEnv {
  return {
    VIEWS: views(),
    CMS_URL: 'https://cms.test',
    PLUGIN_SECRET: SECRET,
    PUBLIC_BASE_URL: 'https://rsvp.test',
    STRIPE_SECRET_KEY: 'sk_test_123',
    STRIPE_WEBHOOK_SECRET: 'whsec_test',
    ...overrides,
  };
}

function request(path: string, init?: RequestInit): Request {
  return new Request(`https://ticket.test${path}`, init);
}

function adminRequest(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('x-plugin-secret', SECRET);
  return request(`/__plugin/admin${path}`, { ...init, headers });
}

// ── Fake CMS (in-memory /__cms implementation) ─────────────────────────────

interface FakePage {
  id: number;
  uuid: string;
  page_type: string;
  name: string;
  slug: string;
  weight: number;
  start: string | null;
  end: string | null;
  timezone: string | null;
  page_id: number | null;
  created_at: string;
  updated_at: string;
  lect: Record<string, unknown>;
}

class FakeCms {
  pages = new Map<number, FakePage>();
  requests: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  private nextId = 1000;

  add(input: Partial<FakePage> & { page_type: string; name: string }): FakePage {
    const id = this.nextId++;
    const page: FakePage = {
      uuid: `uuid-${id}`,
      slug: `page-${id}`,
      weight: 0,
      start: null,
      end: null,
      timezone: null,
      page_id: null,
      created_at: '2026-07-03T00:00:00.000Z',
      updated_at: '2026-07-03T00:00:00.000Z',
      lect: {},
      ...input,
      id,
    };
    this.pages.set(id, page);
    return page;
  }

  async handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    this.requests.push({ method, path: url.pathname + url.search, body });

    const match = url.pathname.match(/^\/__cms\/pages\/(\d+)$/);
    if (match) {
      const page = this.pages.get(Number(match[1]));
      if (!page) return Response.json({ error: 'not_found' }, { status: 404 });
      if (method === 'GET') return Response.json({ page });
      if (method === 'PUT') {
        if (body?.name !== undefined) page.name = String(body.name);
        if (body?.start !== undefined) page.start = body.start as string | null;
        if (body?.end !== undefined) page.end = body.end as string | null;
        // The host merges incoming lect keys over the stored lect.
        if (body?.lect) page.lect = { ...page.lect, ...(body.lect as Record<string, unknown>) };
        return Response.json({ page });
      }
      if (method === 'DELETE') {
        this.pages.delete(page.id);
        return Response.json({ ok: true });
      }
    }

    if (url.pathname === '/__cms/pages' && method === 'POST') {
      const lect = { ...(body?.lect as Record<string, unknown> ?? {}) };
      // Simulate the host's blueprint seeding: nested blocks get one empty row
      // when the creating payload does not provide the block.
      if (body?.page_type === 'ticket_order' && lect.history === undefined) lect.history = [{}];
      const page = this.add({
        page_type: String(body?.page_type),
        name: String(body?.name ?? ''),
        start: (body?.start as string | undefined) ?? null,
        end: (body?.end as string | undefined) ?? null,
        lect,
      });
      return Response.json({ page });
    }

    if (url.pathname === '/__cms/pages' && method === 'GET') {
      const type = url.searchParams.get('page_type');
      const pointerKey = url.searchParams.get('pointer_key');
      const pointerValue = url.searchParams.get('pointer_value');
      const q = url.searchParams.get('q')?.toLowerCase() ?? '';
      let pages = [...this.pages.values()].filter((page) => page.page_type === type);
      if (pointerKey) {
        pages = pages.filter((page) => {
          const pointers = page.lect._pointers as Record<string, unknown> | undefined;
          return String(pointers?.[pointerKey] ?? '') === pointerValue;
        });
      }
      if (q) pages = pages.filter((page) => page.name.toLowerCase().includes(q));
      return Response.json({ pages, total: pages.length });
    }

    return Response.json({ error: 'unhandled' }, { status: 500 });
  }
}

// ── Stripe stub ─────────────────────────────────────────────────────────────

class FakeStripe {
  requests: Array<{ method: string; path: string; params: URLSearchParams }> = [];
  failSessions = false;

  async handle(url: URL, init?: RequestInit): Promise<Response> {
    const method = (init?.method ?? 'GET').toUpperCase();
    const params = new URLSearchParams(init?.body ? String(init.body) : url.search);
    this.requests.push({ method, path: url.pathname, params });

    if (url.pathname === '/v1/checkout/sessions' && method === 'POST') {
      if (this.failSessions) return Response.json({ error: { message: 'stripe down' } }, { status: 503 });
      return Response.json({ id: 'cs_test_1', url: 'https://checkout.stripe.com/pay/cs_test_1', payment_intent: null });
    }
    if (url.pathname === '/v1/checkout/sessions' && method === 'GET') {
      return Response.json({ data: [{ id: 'cs_test_1', client_reference_id: params.get('payment_intent') ? this.sessionOwner : null }] });
    }
    if (url.pathname === '/v1/refunds' && method === 'POST') {
      return Response.json({ id: 're_test_1', status: 'succeeded' });
    }
    return Response.json({ error: { message: 'unhandled' } }, { status: 500 });
  }

  sessionOwner: string | null = null;
}

function stubFetch(cms: FakeCms, stripe = new FakeStripe()): FakeStripe {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'cms.test') return cms.handle(url, init);
    if (url.hostname === 'api.stripe.com') return stripe.handle(url, init);
    throw new Error(`Unexpected fetch: ${url.href}`);
  });
  return stripe;
}

// ── Fixtures ────────────────────────────────────────────────────────────────

function seedEventChain(cms: FakeCms) {
  const event = cms.add({ page_type: 'event', name: 'Gala Dinner' });
  const list = cms.add({
    page_type: 'mail_list',
    name: 'VIP',
    lect: { _pointers: { event: String(event.id) } },
  });
  const guest = cms.add({
    page_type: 'guest',
    name: 'Ada Lovelace',
    lect: { email: 'ada@example.com', _pointers: { mail_list: String(list.id) } },
  });
  const type = cms.add({
    page_type: 'ticket_type',
    name: 'Early bird',
    lect: {
      price: '12050', currency: 'hkd', quantity: '10', sold: '0', active: 'true',
      _pointers: { event: String(event.id) },
    },
  });
  return { event, list, guest, type };
}

async function purchaseSig(eventId: number, listId: number, guestId: number): Promise<string> {
  return signPayload(SECRET, `tkt:${eventId}:${listId}:${guestId}`);
}

async function placeOfflineOrder(cms: FakeCms, chain: ReturnType<typeof seedEventChain>) {
  const sig = await purchaseSig(chain.event.id, chain.list.id, chain.guest.id);
  const response = await plugin.fetch(request('/api/orders', {
    method: 'POST',
    body: JSON.stringify({
      event_id: chain.event.id,
      list_id: chain.list.id,
      guest_id: chain.guest.id,
      sig,
      ticket_type_id: chain.type.id,
      quantity: 2,
      payment_method: 'offline',
      email: 'ada@example.com',
    }),
  }), env());
  return response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Tests ───────────────────────────────────────────────────────────────────

describe('plugin contract', () => {
  it('serves the manifest without a secret', async () => {
    const response = await plugin.fetch(request('/__plugin/manifest'), env());
    expect(response.status).toBe(200);
    const manifest = await response.json() as Record<string, unknown>;
    expect(manifest).toMatchObject({
      id: 'ticket',
      nav: [{ label: 'Tickets', href: 'tickets', roles: ['admin', 'editor', 'moderator'] }],
      contentTypes: {
        readTypes: ['event', 'guest', 'mail_list'],
        writeTypes: ['guest'],
        blueprint: {
          ticket_type: expect.any(Array),
          ticket_order: expect.any(Array),
          ticket_promo: expect.any(Array),
          ticket_settings: expect.any(Array),
        },
      },
    });
  });

  it('rejects admin calls without the shared secret', async () => {
    const response = await plugin.fetch(request('/__plugin/admin/tickets'), env());
    expect(response.status).toBe(403);
  });
});

describe('money helpers', () => {
  it('parses decimal prices into minor units per currency', () => {
    expect(toMinorUnits('120.50', 'hkd')).toBe(12050);
    expect(toMinorUnits('120', 'hkd')).toBe(12000);
    expect(toMinorUnits('120', 'jpy')).toBe(120);
    expect(toMinorUnits('120.5', 'jpy')).toBeNull();
    expect(toMinorUnits('12.345', 'hkd')).toBeNull();
    expect(toMinorUnits('-5', 'hkd')).toBeNull();
  });

  it('formats minor units for display', () => {
    expect(formatAmount(12050, 'hkd')).toBe('HKD 120.50');
    expect(formatAmount(120, 'jpy')).toBe('JPY 120');
    expect(currencyDecimals('usd')).toBe(2);
    expect(currencyDecimals('KRW')).toBe(0);
  });
});

describe('history helper (blueprint seeding gotcha)', () => {
  it('ignores the seeded empty row', () => {
    expect(history({ history: [{}] })).toEqual([]);
    expect(history({ history: [{}, { status: 'paid', date: '2026-07-03' }] })).toHaveLength(1);
  });
});

describe('admin CRUD', () => {
  it('creates a ticket type pointered to the event with minor-unit price', async () => {
    const cms = new FakeCms();
    const { event } = seedEventChain(cms);
    stubFetch(cms);

    const form = new URLSearchParams({
      name: 'VIP table', description: 'Front row', price: '999.50', currency: 'hkd', quantity: '5',
      active: 'true', start: '', end: '',
    });
    const response = await plugin.fetch(adminRequest(`/tickets/${event.id}/types/new`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }), env());

    expect(response.status).toBe(302);
    const created = [...cms.pages.values()].find((page) => page.name === 'VIP table');
    expect(created).toBeDefined();
    expect(created!.lect).toMatchObject({
      price: '99950',
      currency: 'hkd',
      quantity: '5',
      active: 'true',
      _pointers: { event: String(event.id) },
    });
  });

  it('renders the dashboard as a client view', async () => {
    const cms = new FakeCms();
    const { event } = seedEventChain(cms);
    stubFetch(cms);

    const response = await plugin.fetch(adminRequest(`/tickets/${event.id}`), env());
    expect(response.status).toBe(200);
    expect(response.headers.get('x-cms-client-view')).toBe('1');
    expect(response.headers.get('x-cms-view-path')).toBe('/templates/ticket-dashboard.json');
    const data = await response.json() as { types: Array<{ name: string; price: string }> };
    expect(data.types).toEqual([expect.objectContaining({ name: 'Early bird', price: 'HKD 120.50' })]);
  });
});

describe('public checkout API', () => {
  it('returns checkout context for a correctly signed link', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    stubFetch(cms);

    const sig = await purchaseSig(chain.event.id, chain.list.id, chain.guest.id);
    const response = await plugin.fetch(
      request(`/api/checkout/${chain.event.id}/${chain.list.id}/${chain.guest.id}/${sig}`), env(),
    );
    expect(response.status).toBe(200);
    const context = await response.json() as Record<string, unknown>;
    expect(context).toMatchObject({
      event: expect.objectContaining({ name: 'Gala Dinner' }),
      guest: expect.objectContaining({ email: 'ada@example.com' }),
      types: [expect.objectContaining({ name: 'Early bird', price: 12050, remaining: 10 })],
    });
  });

  it('404s a forged signature', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    stubFetch(cms);

    const response = await plugin.fetch(
      request(`/api/checkout/${chain.event.id}/${chain.list.id}/${chain.guest.id}/${'0'.repeat(64)}`), env(),
    );
    expect(response.status).toBe(404);
  });
});

describe('offline orders', () => {
  it('creates a pending_offline order, holds inventory, and serves signed status', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    stubFetch(cms);

    const response = await placeOfflineOrder(cms, chain);
    expect(response.status).toBe(200);
    const payload = await response.json() as { order_code: string; order_url: string; checkout_url?: string };
    expect(payload.checkout_url).toBeUndefined();
    expect(payload.order_url).toContain(`/ticket/order/${payload.order_code}/`);

    const order = [...cms.pages.values()].find((page) => page.page_type === 'ticket_order')!;
    expect(order.lect).toMatchObject({
      status: 'pending_offline',
      payment_method: 'offline',
      quantity: '2',
      unit_amount: '12050',
      total_amount: '24100',
      _pointers: expect.objectContaining({ guest: String(chain.guest.id), ticket_type: String(chain.type.id) }),
    });
    expect(cms.pages.get(chain.type.id)!.lect.sold).toBe('2');

    const sig = await signPayload(SECRET, `tko:${payload.order_code}`);
    const status = await plugin.fetch(request(`/api/orders/${payload.order_code}/${sig}`), env());
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ status: 'pending_offline', total: 24100 });
  });

  it('admin mark-paid fulfills: order paid, guest QR + status written', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    stubFetch(cms);
    await placeOfflineOrder(cms, chain);
    const order = [...cms.pages.values()].find((page) => page.page_type === 'ticket_order')!;

    const response = await plugin.fetch(
      adminRequest(`/tickets/${chain.event.id}/orders/${order.id}/paid`, { method: 'POST' }), env(),
    );
    expect(response.status).toBe(302);
    expect(order.lect.status).toBe('paid');
    expect(history(order.lect).map((entry) => entry.status)).toEqual(['pending_offline', 'paid']);
    const guest = cms.pages.get(chain.guest.id)!;
    expect(guest.lect.qrcode).toBe(order.lect.order_code);
    expect(guest.lect.status).toBe('confirmed');
    // Inventory still held by the paid order.
    expect(cms.pages.get(chain.type.id)!.lect.sold).toBe('2');
  });

  it('admin cancel releases inventory', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    stubFetch(cms);
    await placeOfflineOrder(cms, chain);
    const order = [...cms.pages.values()].find((page) => page.page_type === 'ticket_order')!;

    await plugin.fetch(adminRequest(`/tickets/${chain.event.id}/orders/${order.id}/cancel`, { method: 'POST' }), env());
    expect(order.lect.status).toBe('cancelled');
    expect(cms.pages.get(chain.type.id)!.lect.sold).toBe('0');
  });

  it('rejects orders beyond the remaining quantity', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    cms.pages.get(chain.type.id)!.lect.sold = '9';
    stubFetch(cms);

    const response = await placeOfflineOrder(cms, chain); // quantity 2 > 1 remaining
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('Only 1 left');
  });
});

describe('stripe orders', () => {
  async function placeStripeOrder(cms: FakeCms, chain: ReturnType<typeof seedEventChain>, extra: Record<string, unknown> = {}) {
    const sig = await purchaseSig(chain.event.id, chain.list.id, chain.guest.id);
    return plugin.fetch(request('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        event_id: chain.event.id,
        list_id: chain.list.id,
        guest_id: chain.guest.id,
        sig,
        ticket_type_id: chain.type.id,
        quantity: 1,
        payment_method: 'stripe',
        email: 'ada@example.com',
        ...extra,
      }),
    }), env());
  }

  it('creates a Checkout Session and stores its id on the order', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    const stripe = stubFetch(cms);

    const response = await placeStripeOrder(cms, chain);
    expect(response.status).toBe(200);
    const payload = await response.json() as { checkout_url: string; order_code: string };
    expect(payload.checkout_url).toBe('https://checkout.stripe.com/pay/cs_test_1');

    const order = [...cms.pages.values()].find((page) => page.page_type === 'ticket_order')!;
    expect(order.lect.stripe_session_id).toBe('cs_test_1');
    expect(order.lect.status).toBe('pending');

    const session = stripe.requests.find((call) => call.path === '/v1/checkout/sessions')!;
    expect(session.params.get('line_items[0][price_data][unit_amount]')).toBe('12050');
    expect(session.params.get('client_reference_id')).toBe(String(order.id));
    expect(session.params.get('metadata[order_code]')).toBe(payload.order_code);
    expect(session.params.get('success_url')).toContain(`/ticket/order/${payload.order_code}/`);
  });

  it('rolls back the order and inventory when Stripe is down', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    const stripe = stubFetch(cms);
    stripe.failSessions = true;

    const response = await placeStripeOrder(cms, chain);
    expect(response.status).toBe(502);
    const order = [...cms.pages.values()].find((page) => page.page_type === 'ticket_order')!;
    expect(order.lect.status).toBe('cancelled');
    expect(cms.pages.get(chain.type.id)!.lect.sold).toBe('0');
  });

  it('applies a percent promo and charges the discounted total', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    cms.add({
      page_type: 'ticket_promo',
      name: 'Member',
      lect: { code: 'MEMBER20', kind: 'percent', amount: '20', used_count: '0', max_uses: '', _pointers: { event: String(chain.event.id) } },
    });
    const stripe = stubFetch(cms);

    const response = await placeStripeOrder(cms, chain, { promo_code: 'member20' });
    expect(response.status).toBe(200);
    const order = [...cms.pages.values()].find((page) => page.page_type === 'ticket_order')!;
    expect(order.lect).toMatchObject({ discount_amount: '2410', total_amount: '9640', promo_code: 'MEMBER20' });
    const promo = [...cms.pages.values()].find((page) => page.page_type === 'ticket_promo')!;
    expect(promo.lect.used_count).toBe('1');

    const session = stripe.requests.find((call) => call.path === '/v1/checkout/sessions')!;
    expect(session.params.get('line_items[0][price_data][unit_amount]')).toBe('9640');
    expect(session.params.get('line_items[0][quantity]')).toBe('1');
  });

  it('rejects an exhausted promo code', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    cms.add({
      page_type: 'ticket_promo',
      name: 'Member',
      lect: { code: 'MEMBER20', kind: 'percent', amount: '20', used_count: '3', max_uses: '3', _pointers: { event: String(chain.event.id) } },
    });
    stubFetch(cms);

    const response = await placeStripeOrder(cms, chain, { promo_code: 'MEMBER20' });
    expect(response.status).toBe(400);
    expect((await response.json() as { error: string }).error).toContain('fully redeemed');
  });
});

describe('stripe webhook', () => {
  async function signedWebhook(secretBody: string): Promise<Request> {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = await signPayload('whsec_test', `${timestamp}.${secretBody}`);
    return request('/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': `t=${timestamp},v1=${signature}` },
      body: secretBody,
    });
  }

  async function stripePendingOrder(cms: FakeCms, chain: ReturnType<typeof seedEventChain>) {
    const sig = await purchaseSig(chain.event.id, chain.list.id, chain.guest.id);
    await plugin.fetch(request('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        event_id: chain.event.id, list_id: chain.list.id, guest_id: chain.guest.id, sig,
        ticket_type_id: chain.type.id, quantity: 1, payment_method: 'stripe', email: 'ada@example.com',
      }),
    }), env());
    return [...cms.pages.values()].find((page) => page.page_type === 'ticket_order')!;
  }

  it('rejects a bad signature', async () => {
    const cms = new FakeCms();
    stubFetch(cms);
    const response = await plugin.fetch(request('/webhook/stripe', {
      method: 'POST',
      headers: { 'stripe-signature': 't=1,v1=deadbeef' },
      body: '{}',
    }), env());
    expect(response.status).toBe(400);
  });

  it('checkout.session.completed fulfills the order and stores the payment intent', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    stubFetch(cms);
    const order = await stripePendingOrder(cms, chain);

    const body = JSON.stringify({
      id: 'evt_1',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_test_1', client_reference_id: String(order.id), payment_intent: 'pi_test_9' } },
    });
    const response = await plugin.fetch(await signedWebhook(body), env());
    expect(response.status).toBe(200);
    expect(order.lect.status).toBe('paid');
    expect(order.lect.stripe_payment_intent).toBe('pi_test_9');
    expect(cms.pages.get(chain.guest.id)!.lect.qrcode).toBe(order.lect.order_code);

    // Redelivery is a no-op.
    const again = await plugin.fetch(await signedWebhook(body), env());
    expect(again.status).toBe(200);
    expect(history(order.lect).filter((entry) => entry.status === 'paid')).toHaveLength(1);
  });

  it('checkout.session.expired releases inventory', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    stubFetch(cms);
    const order = await stripePendingOrder(cms, chain);

    const body = JSON.stringify({
      id: 'evt_2',
      type: 'checkout.session.expired',
      data: { object: { id: 'cs_test_1', client_reference_id: String(order.id) } },
    });
    await plugin.fetch(await signedWebhook(body), env());
    expect(order.lect.status).toBe('expired');
    expect(cms.pages.get(chain.type.id)!.lect.sold).toBe('0');
  });

  it('ignores a completed event whose session id does not match the order', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    stubFetch(cms);
    const order = await stripePendingOrder(cms, chain);

    const body = JSON.stringify({
      id: 'evt_3',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_spoofed', client_reference_id: String(order.id), payment_intent: 'pi_x' } },
    });
    await plugin.fetch(await signedWebhook(body), env());
    expect(order.lect.status).toBe('pending');
  });
});

describe('refunds', () => {
  it('refunds a paid stripe order via the API and releases inventory', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    const stripe = stubFetch(cms);

    const sig = await purchaseSig(chain.event.id, chain.list.id, chain.guest.id);
    await plugin.fetch(request('/api/orders', {
      method: 'POST',
      body: JSON.stringify({
        event_id: chain.event.id, list_id: chain.list.id, guest_id: chain.guest.id, sig,
        ticket_type_id: chain.type.id, quantity: 1, payment_method: 'stripe', email: 'ada@example.com',
      }),
    }), env());
    const order = [...cms.pages.values()].find((page) => page.page_type === 'ticket_order')!;
    order.lect.status = 'paid';
    order.lect.stripe_payment_intent = 'pi_test_9';

    const response = await plugin.fetch(
      adminRequest(`/tickets/${chain.event.id}/orders/${order.id}/refund`, { method: 'POST' }), env(),
    );
    expect(response.status).toBe(302);
    expect(order.lect.status).toBe('refunded');
    expect(cms.pages.get(chain.type.id)!.lect.sold).toBe('0');
    const refund = stripe.requests.find((call) => call.path === '/v1/refunds')!;
    expect(refund.params.get('payment_intent')).toBe('pi_test_9');
  });
});

describe('purchase links', () => {
  it('writes signed ticket_url onto every guest in the list', async () => {
    const cms = new FakeCms();
    const chain = seedEventChain(cms);
    stubFetch(cms);

    const form = new URLSearchParams({ list_id: String(chain.list.id) });
    const response = await plugin.fetch(adminRequest(`/tickets/${chain.event.id}/links`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    }), env());
    expect(response.status).toBe(302);

    const guest = cms.pages.get(chain.guest.id)!;
    const expected = await purchaseSig(chain.event.id, chain.list.id, chain.guest.id);
    expect(guest.lect.ticket_url).toBe(
      `https://rsvp.test/ticket/buy/${chain.event.id}/${chain.list.id}/${chain.guest.id}/${expected}`,
    );
  });
});
