import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrainClient } from '../src/modules/brain/brain.client.js';

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; vi.restoreAllMocks(); });

describe('mock BRAIN adapter', () => {
  it('logs in without forwarding user credentials to the local provider', async () => {
    const fetch = vi.fn(async (_url, options) => {
      expect(options.method).toBe('POST');
      expect(options.auth).toBeUndefined();
      return new Response(JSON.stringify({ status: 'connected' }), {
        status: 201,
        headers: { 'content-type': 'application/json', 'set-cookie': 'mock-session=test-token; HttpOnly; Path=/' }
      });
    });
    globalThis.fetch = fetch;

    const result = await BrainClient.login('user@example.com', 'private-password');

    expect(result).toEqual({ status: 'connected', cookie: 'mock-session=test-token' });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('loads and validates datafield and operator catalogs', async () => {
    globalThis.fetch = vi.fn(async (url) => {
      const path = new URL(url).pathname;
      if (path === '/catalog/datafields') return Response.json({ items: [{ name: 'close' }] });
      if (path === '/catalog/operators') return Response.json({ items: [{ name: 'rank' }] });
      throw new Error(`Unexpected request: ${path}`);
    });
    const client = await BrainClient.fromSession('mock-session=test-token');

    await expect(client.getCatalog()).resolves.toEqual({
      datafields: [{ name: 'close' }],
      operators: [{ name: 'rank' }]
    });
  });

  it('rejects a progress URL outside the configured mock origin', async () => {
    const fetch = vi.fn();
    globalThis.fetch = fetch;
    const client = await BrainClient.fromSession('mock-session=test-token');

    await expect(client.runSimulation({ expression: 'rank(close)', settings: {}, progressUrl: 'https://example.com/simulations/1' }))
      .rejects.toMatchObject({ code: 'INVALID_PROGRESS_URL' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('maps expired provider sessions to a stable error code', async () => {
    globalThis.fetch = vi.fn(async () => new Response('{}', { status: 401 }));
    const client = await BrainClient.fromSession('mock-session=test-token');

    await expect(client.getCatalog()).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
  });
});
