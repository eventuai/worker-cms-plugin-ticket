// ============================================================
// Worker CMS plugin — "ticket" suite.
//
// Sells event tickets to existing guests of the events plugin. Admin UI
// (ticket types, promo codes, settings, orders) rides the CMS plugin proxy;
// the public checkout pages live on worker-rsvp, which calls the /api/*
// endpoints here; Stripe webhooks land on this Worker's own public URL
// (the CMS host has no inbound webhook proxy).
// ============================================================

import { CmsClient, CmsApiError, CmsNotConfiguredError } from './cms';
import { handleCheckoutContext, handleCreateOrder, handleOrderStatus, handleStripeWebhook } from './checkout';
import { handleLinksAdmin, handleOrdersAdmin, type TicketEnv } from './orders';
import { forbidden, ticketAdminAccessForRequest } from './permissions';
import { handleTicketsAdmin, pageId } from './tickets';
import { adminView } from './templates/views';
import { requirePluginSecret, serveViewAsset } from '@lionrockjs/worker-cms-plugin';
// The plugin manifest (content types, nav, permissions) is plain data, served
// verbatim at /__plugin/manifest.
import MANIFEST from './manifest.json';

export default {
  async fetch(request: Request, env: TicketEnv): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const secretRequired = path.startsWith('/__plugin/hooks/')
      || path.startsWith('/__plugin/publish/')
      || path.startsWith('/__plugin/admin');
    if (secretRequired) {
      const denied = requirePluginSecret(request, env.PLUGIN_SECRET);
      if (denied) return denied;
    }

    if (path === '/__plugin/manifest') {
      return Response.json(MANIFEST);
    }

    // Plugin-owned view templates, served to the CMS's composite view resolver.
    if (path.startsWith('/__plugin/views/')) {
      const assetPath = path.slice('/__plugin/views'.length) || '/';
      return serveViewAsset(env.VIEWS, assetPath);
    }

    if (path.startsWith('/__plugin/hooks/')) {
      const event = path.split('/').pop();
      const payload = await request.json().catch(() => ({}));
      console.log(`[ticket] hook ${event}:`, JSON.stringify(payload));
      return new Response('ok');
    }

    if (path.startsWith('/__plugin/admin')) {
      return handleAdmin(request, env, url);
    }

    // ── Public routes (this Worker's own domain) ──────────────────────────
    // worker-rsvp calls /api/* relaying the HMAC signatures from its URLs;
    // Stripe calls /webhook/stripe directly.

    if (path.startsWith('/api/') || path === '/webhook/stripe') {
      let cms: CmsClient;
      try {
        cms = new CmsClient(env);
      } catch (error) {
        if (error instanceof CmsNotConfiguredError) return new Response('not found', { status: 404 });
        throw error;
      }
      try {
        if (path === '/webhook/stripe' && request.method === 'POST') {
          return await handleStripeWebhook(request, cms, env);
        }
        if (path === '/api/orders' && request.method === 'POST') {
          return await handleCreateOrder(request, cms, env);
        }
        if (path.startsWith('/api/checkout/') && request.method === 'GET') {
          return await handleCheckoutContext(cms, env, segmentsAfter(path, '/api/checkout/'));
        }
        if (path.startsWith('/api/orders/') && request.method === 'GET') {
          return await handleOrderStatus(cms, env, segmentsAfter(path, '/api/orders/'));
        }
      } catch (error) {
        if (error instanceof CmsApiError) {
          console.error('[ticket] CMS error on public route', error.message);
          return Response.json({ error: 'temporarily unavailable' }, { status: 503 });
        }
        throw error;
      }
    }

    return new Response('not found', { status: 404 });
  },
};

function segmentsAfter(path: string, prefix: string): string[] {
  return path.slice(prefix.length).split('/').filter(Boolean);
}

async function handleAdmin(request: Request, env: TicketEnv, url: URL): Promise<Response> {
  const rest = url.pathname.replace(/^\/__plugin\/admin\/?/, '');
  const segments = rest.split('/').filter(Boolean);
  const section = segments[0] || 'tickets';
  const jsonOnly = url.searchParams.get('json') === '1';

  let cms: CmsClient;
  try {
    cms = new CmsClient(env);
  } catch (error) {
    if (error instanceof CmsNotConfiguredError) {
      return adminView(env.VIEWS, 'Tickets', 'error', {
        heading: 'Cannot reach the CMS',
        message: 'This plugin is not configured yet.',
        showConfig: true,
      }, jsonOnly);
    }
    throw error;
  }

  const access = ticketAdminAccessForRequest(request);
  if (!access.canView) return forbidden();

  try {
    if (section === 'tickets') {
      // /tickets/<eventId>/orders|links dispatch here (they need env for
      // Stripe/email); everything else lives in tickets.ts.
      const eventId = pageId(segments[1]);
      const sub = segments[2] ?? '';
      if (eventId && (sub === 'orders' || sub === 'links')) {
        const event = await cms.get(eventId);
        if (event.page_type !== 'event') return new Response('not found', { status: 404 });
        if (sub === 'orders') {
          return await handleOrdersAdmin(request, cms, env, env.VIEWS, event, segments.slice(3), url, access, jsonOnly);
        }
        return await handleLinksAdmin(request, cms, env, env.VIEWS, event, access, jsonOnly);
      }
      return await handleTicketsAdmin(request, cms, env.VIEWS, segments.slice(1), url, access, jsonOnly);
    }
    return new Response('not found', { status: 404 });
  } catch (error) {
    if (error instanceof CmsApiError) {
      return adminView(env.VIEWS, 'Tickets', 'error', {
        heading: `CMS responded ${error.status}`,
        message: error.message,
        showConfig: error.status === 401 || error.status === 403,
      }, jsonOnly);
    }
    throw error;
  }
}
