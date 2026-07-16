// src/durable-object.js - Durable Objects class for TINKL. backups
// Stores the latest snapshot of all pet care data (encrypted in transit, plain at rest)
// Cloudflare Durable Objects = strongly consistent, low-latency storage per user

export class TinklBackup {
  constructor(state, env) {
    // Cloudflare's new SQLite-backed DOs pass (ctx, env).
    // The legacy KV-backed DOs passed (state, env) where state.storage was the KV store.
    // Both APIs expose .storage in the same place — this works for both.
    this.state = state;
    this.storage = state.storage;
  }

  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method;

    // PUT /backup/latest (iPhone/laptop pushes full backup snapshot)
    if (path === '/backup/latest' && method === 'PUT') {
      return this.putBackup(req);
    }

    // GET /backup/latest (iPhone/laptop pulls latest snapshot from other device)
    if (path === '/backup/latest' && method === 'GET') {
      return this.getBackup(req);
    }

    // GET /backup/metadata (what devices have this backup? when was it last touched?)
    if (path === '/backup/metadata' && method === 'GET') {
      return this.getMetadata(req);
    }

    // DELETE /backup/latest (user taps "delete cloud data" in settings)
    if (path === '/backup/latest' && method === 'DELETE') {
      return this.deleteBackup(req);
    }

    return new Response('Not found', { status: 404 });
  }

  async putBackup(req) {
    try {
      const body = await req.json();

      // body format: { ts: Date.now(), device: "iPhone", data: { pets: [], logs: [...], ... } }
      // Store in Durable Object storage (survives across requests, strongly consistent)
      await this.storage.put('backup:latest', {
        ts: body.ts || Date.now(),
        device: body.device || 'unknown',
        dataVersion: body.dataVersion || 1,
        data: body.data || {},
      });

      // Also store metadata (helps UI show "last synced X seconds ago")
      await this.storage.put('backup:meta', {
        lastBackupTime: Date.now(),
        lastBackupDevice: body.device || 'unknown',
        backupCount: (await this.getMetadataCount()) + 1,
      });

      return new Response(
        JSON.stringify({
          ok: true,
          message: 'Backup saved',
          ts: body.ts || Date.now(),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  async getBackup(req) {
    try {
      const backup = await this.storage.get('backup:latest');

      if (!backup) {
        return new Response(
          JSON.stringify({ data: null, message: 'No backup found' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }

      return new Response(JSON.stringify(backup), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  async getMetadata(req) {
    try {
      const meta = await this.storage.get('backup:meta');
      return new Response(JSON.stringify(meta || { backupCount: 0 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  async deleteBackup(req) {
    try {
      await this.storage.delete('backup:latest');
      await this.storage.delete('backup:meta');
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    } catch (err) {
      return new Response(
        JSON.stringify({ error: err.message }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }
  }

  async getMetadataCount() {
    const meta = await this.storage.get('backup:meta');
    return meta?.backupCount || 0;
  }
}
