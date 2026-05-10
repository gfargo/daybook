import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CoinbaseApiClient, CoinbaseApiError, type CoinbaseFetch } from './api-client.js';

describe('CoinbaseApiClient', () => {
  it('sends authenticated JSON GET requests', async () => {
    const calls: Array<{ url: string; auth: string | undefined }> = [];
    const fetchImpl: CoinbaseFetch = async (url, init) => {
      calls.push({ url, auth: init.headers.Authorization });
      return {
        ok: true,
        status: 200,
        async text() {
          return JSON.stringify({ data: [{ id: 'acct-1' }] });
        },
      };
    };
    const client = new CoinbaseApiClient({
      credentials: makeCredentials(),
      fetch: fetchImpl,
    });

    const result = await client.getJson<{ data: Array<{ id: string }> }>(
      '/v2/accounts',
      { limit: 100 },
    );

    expect(result.data[0]!.id).toBe('acct-1');
    expect(calls[0]!.url).toBe('https://api.coinbase.com/v2/accounts?limit=100');
    expect(calls[0]!.auth).toMatch(/^Bearer .+\..+\..+$/);
  });

  it('throws CoinbaseApiError for non-2xx responses', async () => {
    const client = new CoinbaseApiClient({
      credentials: makeCredentials(),
      fetch: async () => ({
        ok: false,
        status: 401,
        async text() {
          return '{"error":"unauthorized"}';
        },
      }),
    });

    await expect(client.getJson('/v2/accounts')).rejects.toMatchObject({
      name: 'CoinbaseApiError',
      status: 401,
      body: '{"error":"unauthorized"}',
    } satisfies Partial<CoinbaseApiError>);
  });
});

function makeCredentials() {
  const { privateKey } = generateKeyPairSync('ec', {
    namedCurve: 'P-256',
    privateKeyEncoding: { type: 'sec1', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return {
    keyName: 'organizations/org/apiKeys/key',
    privateKey,
  };
}
