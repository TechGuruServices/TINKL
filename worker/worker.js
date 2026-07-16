// worker/worker.js - Cloudflare Worker entrypoint
// Routes backup/restore requests to the Durable Object
// This is the "router" — the Durable Object does the actual work

export { TinklBackup } from './durable-object.js';

// CORS headers for cross-origin requests from the PWA.
// Authorization must be listed here or the browser's preflight (OPTIONS)
// check will reject the real request before it's ever sent.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Main Worker request handler
 * Routes /api/backup/* requests to a Durable Object instance
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Handle CORS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Route all /api/backup/* paths to the Durable Object
    if (url.pathname.startsWith('/api/backup/')) {
      // --- Auth check ---
      // Require a shared secret sent as "Authorization: Bearer <secret>".
      // Set the real value with: npx wrangler secret put API_SECRET
      // and make sure it exactly matches SYNC.API_SECRET in index.html.
      const authHeader = request.headers.get('Authorization') || '';
      const providedSecret = authHeader.replace(/^Bearer\s+/i, '');

      if (!env.API_SECRET || providedSecret !== env.API_SECRET) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
          }
        );
      }

      // Use a stable ID for this user's backup (e.g., based on a device ID or API key)
      // For now, we use a simple "default" ID — fine for a single-user deployment.
      // For multi-user, derive this from the authenticated identity instead.
      const backupId = 'default';

      // Get the Durable Object stub for this backup
      const id = env.TINKL_BACKUP.idFromName(backupId);
      const backup = env.TINKL_BACKUP.get(id);

      // Forward the request (path gets stripped of /api/backup prefix by DO)
      const doUrl = new URL(request.url);
      doUrl.pathname = doUrl.pathname.replace('/api/backup', '');

      const response = await backup.fetch(new Request(doUrl.toString(), request));

      // Add CORS headers to the response
      const newHeaders = new Headers(response.headers);
      for (const [key, value] of Object.entries(CORS_HEADERS)) {
        newHeaders.set(key, value);
      }
      return new Response(response.body, {
        status: response.status,
        headers: newHeaders,
      });
    }

    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', ts: Date.now() }), {
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
      });
    }

    return new Response('TINKL Sync Worker is running', {
      status: 200,
      headers: { 'Content-Type': 'text/plain', ...CORS_HEADERS },
    });
  },
};
