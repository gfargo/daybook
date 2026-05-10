import { createCoinbaseJwt, type CoinbaseApiCredentials } from './api-auth.js';

export type CoinbaseFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
  },
) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

export interface CoinbaseApiClientOptions {
  credentials: CoinbaseApiCredentials;
  fetch?: CoinbaseFetch;
  host?: string;
  baseUrl?: string;
}

export class CoinbaseApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
    this.name = 'CoinbaseApiError';
  }
}

export class CoinbaseApiClient {
  private readonly credentials: CoinbaseApiCredentials;
  private readonly fetchImpl: CoinbaseFetch;
  private readonly host: string;
  private readonly baseUrl: string;

  constructor(options: CoinbaseApiClientOptions) {
    this.credentials = options.credentials;
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.host = options.host ?? 'api.coinbase.com';
    this.baseUrl = options.baseUrl ?? `https://${this.host}`;
  }

  async getJson<T>(
    path: string,
    query: Record<string, string | number | boolean | undefined> = {},
  ): Promise<T> {
    const requestPath = buildRequestPath(path, query);
    const authPath = new URL(requestPath, 'https://api.coinbase.com').pathname;
    const token = createCoinbaseJwt(this.credentials, {
      method: 'GET',
      host: this.host,
      path: authPath,
    });
    const response = await this.fetchImpl(`${this.baseUrl}${requestPath}`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    const body = await response.text();
    if (!response.ok) {
      throw new CoinbaseApiError(
        `Coinbase API request failed (${response.status}) for GET ${requestPath}`,
        response.status,
        body.slice(0, 1_000),
      );
    }
    if (!body.trim()) return {} as T;
    return JSON.parse(body) as T;
  }
}

function buildRequestPath(
  path: string,
  query: Record<string, string | number | boolean | undefined>,
): string {
  const url = new URL(path, 'https://api.coinbase.com');
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return `${url.pathname}${url.search}`;
}
