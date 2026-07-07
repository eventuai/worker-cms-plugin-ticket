// ============================================================
// Ticket plugin CMS bridge.
//
// Shared Plugin API client/types and neutral lect readers live in
// @lionrockjs/worker-cms-plugin. This file adds only the ticket-specific
// helpers: money formatting, order history filtering, and per-event lookups.
// ============================================================

import {
  CmsClient as BaseCmsClient,
  attr,
  compareByWeightThenName,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsPage,
  type CmsPageInput,
  CmsApiError,
  CmsNotConfiguredError,
  blocks,
} from '@lionrockjs/worker-cms-plugin';

/** Manifest id — must equal MANIFEST.id and the CMS-registered plugin id. */
export const PLUGIN_ID = 'ticket';

export {
  CmsApiError,
  CmsNotConfiguredError,
  attr,
  blocks,
  compareByWeightThenName,
  items,
  localized,
  pointer,
  type CmsClientEnv,
  type CmsPage,
  type CmsPageInput,
};

export class CmsClient extends BaseCmsClient {
  constructor(env: CmsClientEnv) {
    super({
      cmsUrl: env.CMS_URL,
      pluginSecret: env.PLUGIN_SECRET,
      pluginId: PLUGIN_ID,
      fetcher: (input, init) => globalThis.fetch(input, init),
    });
  }
}

/** Order lifecycle states. `pending` = Stripe Checkout in flight. */
export type OrderStatus = 'pending' | 'pending_offline' | 'paid' | 'cancelled' | 'refunded' | 'expired';

export const ORDER_STATUSES: OrderStatus[] = ['pending', 'pending_offline', 'paid', 'cancelled', 'refunded', 'expired'];

/** Statuses that hold inventory (count toward a ticket type's `sold`). */
export const HOLDING_STATUSES: OrderStatus[] = ['pending', 'pending_offline', 'paid'];

export function orderStatus(lect: Record<string, unknown>): OrderStatus {
  const value = attr(lect, 'status').trim().toLowerCase();
  return (ORDER_STATUSES as string[]).includes(value) ? value as OrderStatus : 'pending';
}

/**
 * Lists the pages of a type that belong to an event by `lect._pointers.event`
 * (ticket types, promos, settings and orders all pointer to their event rather
 * than parenting under it, mirroring mail_list/edm in the events plugin).
 */
export async function listByEvent(
  cms: CmsClient,
  pageType: string,
  eventId: number,
  opts: { limit?: number } = {},
): Promise<CmsPage[]> {
  const { pages } = await cms.list(pageType, {
    pointer: { key: 'event', value: String(eventId) },
    limit: opts.limit ?? 500,
  });
  return pages;
}

/**
 * Real history entries for an order. The host seeds every blueprint block,
 * including `history`, with one empty row when a page is created. A row counts
 * only once it carries an actual status or date.
 */
export function history(lect: Record<string, unknown>): Array<Record<string, unknown>> {
  return items(lect, 'history').filter(
    (entry) => String(entry.status ?? '').trim() !== '' || String(entry.date ?? '').trim() !== '',
  );
}

/** Appends a history row, preserving existing (real) rows. */
export function withHistory(
  lect: Record<string, unknown>,
  status: string,
  message = '',
): Array<Record<string, unknown>> {
  return [...history(lect), { status, date: new Date().toISOString(), message }];
}

// ── Money ──────────────────────────────────────────────────────────────────
// Amounts are stored (and sent to Stripe) in minor units — integer cents —
// so no float arithmetic ever touches a price.

/** ISO 4217 currencies without minor units (Stripe's zero-decimal list, common subset). */
const ZERO_DECIMAL = new Set(['jpy', 'krw', 'vnd', 'clp', 'isk', 'twd', 'ugx', 'rwf', 'xaf', 'xof', 'xpf', 'bif', 'djf', 'gnf', 'kmf', 'mga', 'pyg', 'vuv']);

export function currencyDecimals(currency: string): number {
  return ZERO_DECIMAL.has(currency.trim().toLowerCase()) ? 0 : 2;
}

/** Parses an admin-entered decimal price ("120", "120.50") into minor units; null when invalid. */
export function toMinorUnits(value: string, currency: string): number | null {
  const decimals = currencyDecimals(currency);
  const match = value.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const whole = Number(match[1]);
  const fractionRaw = match[2] ?? '';
  if (fractionRaw.length > decimals) return null;
  const fraction = decimals ? Number(fractionRaw.padEnd(decimals, '0')) : 0;
  const minor = whole * 10 ** decimals + fraction;
  return Number.isSafeInteger(minor) ? minor : null;
}

/** Formats minor units for display, e.g. (12050, 'hkd') → "HKD 120.50". */
export function formatAmount(minor: number, currency: string): string {
  const code = currency.trim().toUpperCase() || 'USD';
  const decimals = currencyDecimals(code);
  const value = decimals ? (minor / 10 ** decimals).toFixed(decimals) : String(minor);
  return `${code} ${value}`;
}

/** Reads an integer lect attr; fallback when absent or malformed. */
export function intAttr(lect: Record<string, unknown>, key: string, fallback = 0): number {
  const value = Number.parseInt(attr(lect, key), 10);
  return Number.isFinite(value) ? value : fallback;
}
