import type { CoinbaseApiClient } from './api-client.js';

export interface CoinbaseMoney {
  amount?: string;
  currency?: string;
}

export interface CoinbaseTrackAccount {
  id: string;
  name?: string;
  type?: string;
  currency?: {
    code?: string;
    name?: string;
  };
  primary?: boolean;
  active?: boolean;
}

export interface CoinbaseTrackTransaction {
  id: string;
  type: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
  amount?: CoinbaseMoney;
  native_amount?: CoinbaseMoney;
  description?: string;
  details?: {
    title?: string;
    subtitle?: string;
  };
  network?: {
    hash?: string;
    transaction_url?: string;
  };
  from?: unknown;
  to?: unknown;
  buy?: { id?: string };
  sell?: { id?: string };
  trade?: { id?: string };
  advanced_trade_fill?: {
    fill_id?: string;
    order_id?: string;
    trade_id?: string;
    product_id?: string;
  };
}

export interface CoinbaseTrackTransactionRecord {
  account: CoinbaseTrackAccount;
  transaction: CoinbaseTrackTransaction;
}

interface CoinbasePage<T> {
  data?: T[];
  pagination?: {
    next_uri?: string | null;
  };
}

export class CoinbaseTrackApi {
  constructor(private readonly client: CoinbaseApiClient) {}

  async listAccounts(): Promise<CoinbaseTrackAccount[]> {
    return this.collect<CoinbaseTrackAccount>('/v2/accounts', { limit: 100 });
  }

  async listTransactions(
    account: CoinbaseTrackAccount,
  ): Promise<CoinbaseTrackTransactionRecord[]> {
    const transactions = await this.collect<CoinbaseTrackTransaction>(
      `/v2/accounts/${encodeURIComponent(account.id)}/transactions`,
      { limit: 100 },
    );
    return transactions.map(transaction => ({ account, transaction }));
  }

  private async collect<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T[]> {
    const items: T[] = [];
    let nextPath: string | undefined = path;
    let nextQuery:
      | Record<string, string | number | boolean | undefined>
      | undefined = query;

    while (nextPath) {
      const page: CoinbasePage<T> = await this.client.getJson<CoinbasePage<T>>(
        nextPath,
        nextQuery ?? {},
      );
      items.push(...(page.data ?? []));
      nextPath = page.pagination?.next_uri
        ? toPathAndSearch(page.pagination.next_uri)
        : undefined;
      nextQuery = undefined;
    }

    return items;
  }
}

function toPathAndSearch(uri: string): string {
  const url = new URL(uri, 'https://api.coinbase.com');
  return `${url.pathname}${url.search}`;
}
