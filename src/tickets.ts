// ============================================================
// Admin UI — ticket types, promo codes and per-event settings.
//
// Routes (segments after /__plugin/admin/tickets):
//   ''                         → event picker
//   <eventId>                  → per-event dashboard (types + promos + links)
//   <eventId>/types/new        → GET form / POST create
//   <eventId>/types/<id>       → GET form / POST update
//   <eventId>/types/<id>/delete → POST soft-delete
//   <eventId>/promos/...       → same shape as types
//   <eventId>/settings         → GET form / POST upsert (singleton per event)
// Orders and link minting live in orders.ts.
// ============================================================

import {
  CmsClient,
  attr,
  currencyDecimals,
  formatAmount,
  intAttr,
  listByEvent,
  localized,
  toMinorUnits,
  type CmsPage,
} from './cms';
import { adminView, notFoundView } from './templates/views';
import { redirect } from '@lionrockjs/worker-cms-plugin';
import type { TicketAdminAccess } from './permissions';

export const ADMIN_BASE = '/admin/plugins/ticket';

export const DEFAULT_CURRENCY = 'hkd';

export async function handleTicketsAdmin(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  segments: string[],
  url: URL,
  access: TicketAdminAccess,
  jsonOnly = false,
): Promise<Response> {
  if (!segments.length) return eventsIndex(cms, views, jsonOnly);

  const eventId = pageId(segments[0]);
  if (!eventId) return new Response('not found', { status: 404 });
  const event = await cms.get(eventId);
  if (event.page_type !== 'event') return new Response('not found', { status: 404 });

  const section = segments[1] ?? '';
  if (!section) return eventDashboard(cms, views, event, url, access, jsonOnly);

  if (section === 'types') return handleCrud(request, cms, views, event, segments.slice(2), access, jsonOnly, TYPE_CRUD);
  if (section === 'promos') return handleCrud(request, cms, views, event, segments.slice(2), access, jsonOnly, PROMO_CRUD);
  if (section === 'settings') {
    if (request.method === 'POST') {
      if (!access.canEdit) return new Response('Forbidden', { status: 403 });
      return saveSettings(request, cms, event);
    }
    return settingsForm(cms, views, event, jsonOnly);
  }
  return new Response('not found', { status: 404 });
}

// ── Event picker ────────────────────────────────────────────────────────────

async function eventsIndex(cms: CmsClient, views: Fetcher, jsonOnly: boolean): Promise<Response> {
  const { pages } = await cms.list('event', { limit: 500 });
  return adminView(views, 'Tickets', 'ticket-events', {
    events: pages.map((event) => ({
      name: event.name,
      start: (event.start ?? '').slice(0, 10),
      href: `${ADMIN_BASE}/tickets/${event.id}`,
    })),
  }, jsonOnly);
}

// ── Per-event dashboard ─────────────────────────────────────────────────────

async function eventDashboard(
  cms: CmsClient,
  views: Fetcher,
  event: CmsPage,
  url: URL,
  access: TicketAdminAccess,
  jsonOnly: boolean,
): Promise<Response> {
  const base = `${ADMIN_BASE}/tickets/${event.id}`;
  const [types, promos, settings] = await Promise.all([
    listByEvent(cms, 'ticket_type', event.id),
    listByEvent(cms, 'ticket_promo', event.id),
    settingsForEvent(cms, event.id),
  ]);
  return adminView(views, `Tickets — ${event.name}`, 'ticket-dashboard', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/tickets`,
    canEdit: access.canEdit,
    flash: url.searchParams.get('flash') ?? '',
    settingsHref: `${base}/settings`,
    ordersHref: `${base}/orders`,
    linksHref: `${base}/links`,
    newTypeHref: `${base}/types/new`,
    newPromoHref: `${base}/promos/new`,
    stripeEnabled: settings ? attr(settings.lect, 'stripe_enabled') === 'true' : false,
    offlineEnabled: settings ? attr(settings.lect, 'offline_enabled') === 'true' : false,
    types: types.map((type) => {
      const quantity = attr(type.lect, 'quantity');
      const sold = intAttr(type.lect, 'sold');
      return {
        name: type.name,
        href: `${base}/types/${type.id}`,
        price: formatAmount(intAttr(type.lect, 'price'), attr(type.lect, 'currency') || DEFAULT_CURRENCY),
        active: attr(type.lect, 'active') === 'true',
        saleWindow: window(type),
        sold,
        quantity: quantity === '' ? '∞' : quantity,
        soldOut: quantity !== '' && sold >= intAttr(type.lect, 'quantity'),
      };
    }),
    promos: promos.map((promo) => ({
      name: promo.name,
      href: `${base}/promos/${promo.id}`,
      code: attr(promo.lect, 'code'),
      discount: promoDiscountLabel(promo),
      window: window(promo),
      used: `${intAttr(promo.lect, 'used_count')}${attr(promo.lect, 'max_uses') ? ` / ${attr(promo.lect, 'max_uses')}` : ''}`,
    })),
  }, jsonOnly);
}

function window(page: CmsPage): string {
  const start = (page.start ?? '').slice(0, 16).replace('T', ' ');
  const end = (page.end ?? '').slice(0, 16).replace('T', ' ');
  if (!start && !end) return 'always';
  return `${start || '…'} → ${end || '…'}`;
}

function promoDiscountLabel(promo: CmsPage): string {
  const amount = intAttr(promo.lect, 'amount');
  if (attr(promo.lect, 'kind') === 'percent') return `${amount}% off`;
  return `${formatAmount(amount, attr(promo.lect, 'currency') || DEFAULT_CURRENCY)} off`;
}

// ── Generic child CRUD (ticket types & promo codes share the shape) ────────

interface CrudConfig {
  pageType: 'ticket_type' | 'ticket_promo';
  segment: 'types' | 'promos';
  template: string;
  label: string;
  /** Parses the form into { name, lect attrs }; returns null when invalid. */
  parse(form: FormData): { name: string; attrs: Record<string, string> } | null;
  /** Form values for the template (existing page or blank defaults). */
  values(page?: CmsPage): Record<string, string>;
}

const TYPE_CRUD: CrudConfig = {
  pageType: 'ticket_type',
  segment: 'types',
  template: 'ticket-type-form',
  label: 'ticket type',
  parse(form) {
    const name = text(form, 'name');
    const currency = (text(form, 'currency') || DEFAULT_CURRENCY).toLowerCase();
    const price = toMinorUnits(text(form, 'price') || '0', currency);
    if (!name || price == null) return null;
    const quantityRaw = text(form, 'quantity');
    const quantity = quantityRaw === '' ? '' : String(Math.max(0, Number.parseInt(quantityRaw, 10) || 0));
    return {
      name,
      attrs: {
        description: text(form, 'description'),
        price: String(price),
        currency,
        quantity,
        active: form.get('active') ? 'true' : 'false',
      },
    };
  },
  values(page) {
    const lect = page?.lect ?? {};
    const currency = attr(lect, 'currency') || DEFAULT_CURRENCY;
    const decimals = currencyDecimals(currency);
    const price = page ? (intAttr(lect, 'price') / 10 ** decimals).toFixed(decimals) : '';
    return {
      name: page?.name ?? '',
      description: attr(lect, 'description'),
      price,
      currency,
      quantity: attr(lect, 'quantity'),
      active: page ? attr(lect, 'active') : 'true',
      sold: page ? String(intAttr(lect, 'sold')) : '0',
      start: (page?.start ?? '').slice(0, 16),
      end: (page?.end ?? '').slice(0, 16),
    };
  },
};

const PROMO_CRUD: CrudConfig = {
  pageType: 'ticket_promo',
  segment: 'promos',
  template: 'ticket-promo-form',
  label: 'promo code',
  parse(form) {
    const name = text(form, 'name');
    const code = text(form, 'code').toUpperCase().replace(/\s+/g, '');
    const kind = text(form, 'kind') === 'fixed' ? 'fixed' : 'percent';
    const currency = (text(form, 'currency') || DEFAULT_CURRENCY).toLowerCase();
    const amount = kind === 'percent'
      ? String(Math.min(100, Math.max(0, Number.parseInt(text(form, 'amount'), 10) || 0)))
      : String(toMinorUnits(text(form, 'amount') || '0', currency) ?? 0);
    if (!name || !code) return null;
    return {
      name,
      attrs: {
        code,
        kind,
        amount,
        currency,
        max_uses: text(form, 'max_uses'),
      },
    };
  },
  values(page) {
    const lect = page?.lect ?? {};
    const kind = attr(lect, 'kind') || 'percent';
    const currency = attr(lect, 'currency') || DEFAULT_CURRENCY;
    const amount = !page
      ? ''
      : kind === 'percent'
        ? String(intAttr(lect, 'amount'))
        : (intAttr(lect, 'amount') / 100).toFixed(2);
    return {
      name: page?.name ?? '',
      code: attr(lect, 'code'),
      kind,
      amount,
      currency,
      max_uses: attr(lect, 'max_uses'),
      used_count: page ? String(intAttr(lect, 'used_count')) : '0',
      start: (page?.start ?? '').slice(0, 16),
      end: (page?.end ?? '').slice(0, 16),
    };
  },
};

async function handleCrud(
  request: Request,
  cms: CmsClient,
  views: Fetcher,
  event: CmsPage,
  segments: string[],
  access: TicketAdminAccess,
  jsonOnly: boolean,
  config: CrudConfig,
): Promise<Response> {
  const base = `${ADMIN_BASE}/tickets/${event.id}`;

  if (segments[0] === 'new') {
    if (request.method === 'POST') {
      if (!access.canEdit) return new Response('Forbidden', { status: 403 });
      return createChild(request, cms, event, config);
    }
    return crudForm(views, event, config, access, undefined, jsonOnly);
  }

  const childId = pageId(segments[0]);
  if (!childId) return new Response('not found', { status: 404 });
  const child = await cms.get(childId);
  if (child.page_type !== config.pageType || childPointer(child) !== String(event.id)) {
    return new Response('not found', { status: 404 });
  }

  if (segments[1] === 'delete' && request.method === 'POST') {
    if (!access.canEdit) return new Response('Forbidden', { status: 403 });
    await cms.remove(child.id);
    return redirect(`${base}?flash=${encodeURIComponent(`Deleted ${config.label} “${child.name}”.`)}`);
  }
  if (request.method === 'POST') {
    if (!access.canEdit) return new Response('Forbidden', { status: 403 });
    return updateChild(request, cms, event, child, config);
  }
  return crudForm(views, event, config, access, child, jsonOnly);
}

function childPointer(page: CmsPage): string {
  const pointers = page.lect._pointers;
  if (!pointers || typeof pointers !== 'object' || Array.isArray(pointers)) return '';
  return String((pointers as Record<string, unknown>).event ?? '');
}

async function crudForm(
  views: Fetcher,
  event: CmsPage,
  config: CrudConfig,
  access: TicketAdminAccess,
  page: CmsPage | undefined,
  jsonOnly: boolean,
): Promise<Response> {
  const base = `${ADMIN_BASE}/tickets/${event.id}`;
  return adminView(views, page ? `Edit ${page.name}` : `New ${config.label}`, config.template, {
    title: page ? `Edit ${config.label}` : `New ${config.label}`,
    eventName: event.name,
    canEdit: access.canEdit,
    backHref: base,
    action: page ? `${base}/${config.segment}/${page.id}` : `${base}/${config.segment}/new`,
    deleteAction: page ? `${base}/${config.segment}/${page.id}/delete` : '',
    values: config.values(page),
  }, jsonOnly);
}

async function createChild(request: Request, cms: CmsClient, event: CmsPage, config: CrudConfig): Promise<Response> {
  const base = `${ADMIN_BASE}/tickets/${event.id}`;
  const form = await request.formData();
  const input = config.parse(form);
  if (!input) return redirect(`${base}/${config.segment}/new`);
  await cms.create({
    page_type: config.pageType,
    name: input.name,
    start: datetime(form, 'start'),
    end: datetime(form, 'end'),
    lect: {
      _type: config.pageType,
      name: { en: input.name },
      ...input.attrs,
      _pointers: { event: String(event.id) },
    },
  });
  return redirect(`${base}?flash=${encodeURIComponent(`Created ${config.label} “${input.name}”.`)}`);
}

async function updateChild(
  request: Request,
  cms: CmsClient,
  event: CmsPage,
  child: CmsPage,
  config: CrudConfig,
): Promise<Response> {
  const base = `${ADMIN_BASE}/tickets/${event.id}`;
  const form = await request.formData();
  const input = config.parse(form);
  if (!input) return redirect(`${base}/${config.segment}/${child.id}`);
  await cms.update(child.id, {
    name: input.name,
    start: datetime(form, 'start'),
    end: datetime(form, 'end'),
    lect: { name: { en: input.name }, ...input.attrs },
  });
  return redirect(`${base}?flash=${encodeURIComponent(`Saved ${config.label} “${input.name}”.`)}`);
}

// ── Settings (singleton ticket_settings page per event) ────────────────────

export async function settingsForEvent(cms: CmsClient, eventId: number): Promise<CmsPage | null> {
  const pages = await listByEvent(cms, 'ticket_settings', eventId, { limit: 5 });
  return pages[0] ?? null;
}

async function settingsForm(cms: CmsClient, views: Fetcher, event: CmsPage, jsonOnly: boolean): Promise<Response> {
  const settings = await settingsForEvent(cms, event.id);
  const lect = settings?.lect ?? {};
  return adminView(views, `Ticket settings — ${event.name}`, 'ticket-settings-form', {
    eventName: event.name,
    backHref: `${ADMIN_BASE}/tickets/${event.id}`,
    action: `${ADMIN_BASE}/tickets/${event.id}/settings`,
    values: {
      stripe_enabled: settings ? attr(lect, 'stripe_enabled') : 'true',
      offline_enabled: settings ? attr(lect, 'offline_enabled') : 'true',
      reply_to: attr(lect, 'reply_to'),
      offline_instructions: localized(lect, 'offline_instructions'),
    },
  }, jsonOnly);
}

async function saveSettings(request: Request, cms: CmsClient, event: CmsPage): Promise<Response> {
  const form = await request.formData();
  const attrs = {
    stripe_enabled: form.get('stripe_enabled') ? 'true' : 'false',
    offline_enabled: form.get('offline_enabled') ? 'true' : 'false',
    reply_to: text(form, 'reply_to'),
    offline_instructions: { en: text(form, 'offline_instructions') },
  };
  const existing = await settingsForEvent(cms, event.id);
  if (existing) {
    await cms.update(existing.id, { lect: attrs });
  } else {
    await cms.create({
      page_type: 'ticket_settings',
      name: `Ticket settings — ${event.name}`,
      lect: { _type: 'ticket_settings', ...attrs, _pointers: { event: String(event.id) } },
    });
  }
  return redirect(`${ADMIN_BASE}/tickets/${event.id}?flash=${encodeURIComponent('Settings saved.')}`);
}

// ── Shared form helpers ─────────────────────────────────────────────────────

export function pageId(value: unknown): number | null {
  const id = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

export function text(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === 'string' ? value.trim() : '';
}

/** datetime-local input → ISO string, or undefined to leave the column unset. */
function datetime(form: FormData, key: string): string | undefined {
  const value = text(form, key);
  if (!value) return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

export { notFoundView };
