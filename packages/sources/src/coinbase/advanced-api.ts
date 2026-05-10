import type { CoinbaseApiClient } from './api-client.js';

export interface CoinbaseAdvancedFill {
  entry_id?: string;
  trade_id?: string;
  order_id?: string;
  trade_time?: string;
  trade_type?: string;
  price?: string;
  size?: string;
  commission?: string;
  product_id?: string;
  sequence_timestamp?: string;
  side?: string;
  size_in_quote?: boolean;
}

export interface ListCoinbaseFillsOptions {
  startSequenceTimestamp?: string;
  endSequenceTimestamp?: string;
  productId?: string;
  orderId?: string;
}

interface CoinbaseFillsPage {
  fills?: CoinbaseAdvancedFill[];
  cursor?: string;
  has_next?: boolean;
}

export class CoinbaseAdvancedTradeApi {
  constructor(private readonly client: CoinbaseApiClient) {}

  async listFills(
    options: ListCoinbaseFillsOptions = {},
  ): Promise<CoinbaseAdvancedFill[]> {
    const fills: CoinbaseAdvancedFill[] = [];
    let cursor: string | undefined;

    while (true) {
      const previousCursor = cursor;
      const page = await this.client.getJson<CoinbaseFillsPage>(
        '/api/v3/brokerage/orders/historical/fills',
        {
          limit: 100,
          ...(cursor ? { cursor } : {}),
          ...(options.startSequenceTimestamp
            ? { start_sequence_timestamp: options.startSequenceTimestamp }
            : {}),
          ...(options.endSequenceTimestamp
            ? { end_sequence_timestamp: options.endSequenceTimestamp }
            : {}),
          ...(options.productId ? { product_ids: options.productId } : {}),
          ...(options.orderId ? { order_ids: options.orderId } : {}),
        },
      );
      fills.push(...(page.fills ?? []));
      cursor = page.cursor;
      if (!cursor || cursor === previousCursor || page.has_next === false) break;
    }

    return fills;
  }
}
