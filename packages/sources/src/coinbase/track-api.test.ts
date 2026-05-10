import { describe, expect, it } from 'vitest';
import type { CoinbaseApiClient } from './api-client.js';
import { CoinbaseTrackApi } from './track-api.js';

describe('CoinbaseTrackApi', () => {
  it('collects accounts through next_uri pagination', async () => {
    const paths: string[] = [];
    const client = {
      async getJson(path: string) {
        paths.push(path);
        if (path === '/v2/accounts') {
          return {
            data: [{ id: 'acct-1' }],
            pagination: {
              next_uri: '/v2/accounts?starting_after=acct-1',
            },
          };
        }
        return { data: [{ id: 'acct-2' }] };
      },
    } as CoinbaseApiClient;
    const api = new CoinbaseTrackApi(client);

    const accounts = await api.listAccounts();

    expect(accounts.map(account => account.id)).toEqual(['acct-1', 'acct-2']);
    expect(paths).toEqual(['/v2/accounts', '/v2/accounts?starting_after=acct-1']);
  });

  it('attaches account metadata to transaction records', async () => {
    const client = {
      async getJson() {
        return {
          data: [{
            id: 'tx-1',
            type: 'receive',
            amount: { amount: '1', currency: 'ETH' },
          }],
        };
      },
    } as CoinbaseApiClient;
    const api = new CoinbaseTrackApi(client);

    const records = await api.listTransactions({
      id: 'acct-eth',
      currency: { code: 'ETH' },
    });

    expect(records).toEqual([{
      account: {
        id: 'acct-eth',
        currency: { code: 'ETH' },
      },
      transaction: {
        id: 'tx-1',
        type: 'receive',
        amount: { amount: '1', currency: 'ETH' },
      },
    }]);
  });
});
