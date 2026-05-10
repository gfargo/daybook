import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RawEvent } from '@daybook/ledger';
import { createRepo, openDatabase } from '@daybook/ledger';
import { syncCommand } from './sync.js';
import { renderCsvSyncOutput } from './SyncOutput.js';

const syncCoinbaseApiMock = vi.hoisted(() => vi.fn());

vi.mock('@daybook/sources/coinbase', () => ({
  syncCoinbaseApi: syncCoinbaseApiMock,
}));

vi.mock('./SyncOutput.js', () => ({
  renderCsvSyncOutput: vi.fn(),
  renderEvmSyncOutput: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe('syncCommand generic CSV', () => {
  it('imports generic CSV rows into the configured CSV account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-csv-'));
    const dbPath = join(dir, 'data.db');
    const configPath = join(dir, 'config.json');
    const csvPath = join(dir, 'ledger.csv');

    writeFileSync(configPath, JSON.stringify({
      dbPath,
      accounts: [
        { id: 'csv-imports', source: 'csv', identifier: 'manual-ledger' },
      ],
    }), 'utf-8');

    const db = openDatabase(dbPath);
    const repo = createRepo(db.raw);
    repo.upsertAccount({
      id: 'csv-imports',
      source: 'csv',
      identifier: 'manual-ledger',
    });
    db.close();

    writeFileSync(csvPath, [
      'Date,Sent Amount,Sent Currency,Received Amount,Received Currency,ID',
      '2024-01-01T00:00:00Z,1000,USD,0.5,ETH,buy-001',
    ].join('\n'), 'utf-8');

    await syncCommand({ source: 'csv', file: csvPath, config: configPath });

    const verifyDb = openDatabase(dbPath);
    const verifyRepo = createRepo(verifyDb.raw);
    const events = verifyRepo.getRawEvents({ source: 'csv', limit: 10 });
    verifyDb.close();

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('csv:buy-001');
    expect(events[0]!.type).toBe('trade');
    expect(events[0]!.legs).toEqual([
      { asset: 'USD', amount: '-1000' },
      { asset: 'ETH', amount: '0.5' },
    ]);

    expect(renderCsvSyncOutput).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Generic CSV',
      accountId: 'csv-imports',
      totalRows: 1,
      eventCount: 1,
      inserted: 1,
      skipped: 0,
    }));
  });

  it('rejects --from for generic CSV imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-csv-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      dbPath: join(dir, 'data.db'),
      accounts: [],
    }), 'utf-8');

    await expect(syncCommand({
      source: 'csv',
      file: join(dir, 'ledger.csv'),
      config: configPath,
      from: '2024-01-01',
    })).rejects.toThrow('`--from` is not supported for Generic CSV imports');
  });
});

describe('syncCommand Binance CSV', () => {
  it('imports Binance ledger CSV rows into the configured Binance account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-binance-'));
    const dbPath = join(dir, 'data.db');
    const configPath = join(dir, 'config.json');
    const csvPath = join(dir, 'binance.csv');

    writeFileSync(configPath, JSON.stringify({
      dbPath,
      accounts: [
        { id: 'main-binance', source: 'binance', identifier: 'user@example.com' },
      ],
    }), 'utf-8');

    const db = openDatabase(dbPath);
    const repo = createRepo(db.raw);
    repo.upsertAccount({
      id: 'main-binance',
      source: 'binance',
      identifier: 'user@example.com',
    });
    db.close();

    writeFileSync(csvPath, [
      'User_ID,UTC_Time,Account,Operation,Coin,Change,Remark',
      '123,2024-01-01 00:00:00,Spot,Buy,ETH,0.5,order-001',
      '123,2024-01-01 00:00:00,Spot,Sell,USDT,-1000,order-001',
    ].join('\n'), 'utf-8');

    await syncCommand({ source: 'binance', file: csvPath, config: configPath });

    const verifyDb = openDatabase(dbPath);
    const verifyRepo = createRepo(verifyDb.raw);
    const events = verifyRepo.getRawEvents({ source: 'binance', limit: 10 });
    verifyDb.close();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('trade');
    expect(events[0]!.legs).toEqual([
      { asset: 'ETH', amount: '0.5' },
      { asset: 'USDT', amount: '-1000' },
    ]);

    expect(renderCsvSyncOutput).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Binance',
      accountId: 'main-binance',
      totalRows: 2,
      eventCount: 1,
      inserted: 1,
      skipped: 0,
    }));
  });

  it('rejects --from for Binance.US CSV imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-binance-us-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      dbPath: join(dir, 'data.db'),
      accounts: [],
    }), 'utf-8');

    await expect(syncCommand({
      source: 'binance-us',
      file: join(dir, 'ledger.csv'),
      config: configPath,
      from: '2024-01-01',
    })).rejects.toThrow('`--from` is not supported for Binance.US CSV imports');
  });
});

describe('syncCommand Coinbase API', () => {
  it('syncs Coinbase API events into the configured Coinbase account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-coinbase-api-'));
    const dbPath = join(dir, 'data.db');
    const configPath = join(dir, 'config.json');

    writeFileSync(configPath, JSON.stringify({
      dbPath,
      accounts: [
        { id: 'main-coinbase', source: 'coinbase', identifier: 'user@example.com' },
      ],
    }), 'utf-8');

    const db = openDatabase(dbPath);
    const repo = createRepo(db.raw);
    repo.upsertAccount({
      id: 'main-coinbase',
      source: 'coinbase',
      identifier: 'user@example.com',
    });
    db.close();

    syncCoinbaseApiMock.mockResolvedValue({
      events: [coinbaseApiEvent()],
      totalRows: 1,
      countsByType: { trade: 1 },
      unparsedRowCount: 0,
      warnings: [],
      fetched: { accounts: 1, transactions: 1, fills: 1 },
    });
    vi.stubEnv('COINBASE_CDP_KEY_NAME', 'organizations/org/apiKeys/key');
    vi.stubEnv('COINBASE_CDP_PRIVATE_KEY', 'test-private-key');

    await syncCommand({
      source: 'coinbase',
      config: configPath,
      from: '2024-01-01',
    });

    const verifyDb = openDatabase(dbPath);
    const verifyRepo = createRepo(verifyDb.raw);
    const events = verifyRepo.getRawEvents({ source: 'coinbase', limit: 10 });
    const syncState = verifyRepo.getSyncState('coinbase', 'main-coinbase');
    verifyDb.close();

    expect(syncCoinbaseApiMock).toHaveBeenCalledWith({
      accountId: 'main-coinbase',
      credentials: {
        keyName: 'organizations/org/apiKeys/key',
        privateKey: 'test-private-key',
      },
      from: new Date('2024-01-01'),
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('coinbase:api:v3:fill:fill-1');
    expect(syncState?.lastSyncedAt).toBe(1_704_067_200);
    expect(renderCsvSyncOutput).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Coinbase API',
      accountId: 'main-coinbase',
      totalRows: 1,
      eventCount: 1,
      inserted: 1,
      skipped: 0,
    }));
  });

  it('requires Coinbase CDP credentials for API sync', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-coinbase-api-'));
    const dbPath = join(dir, 'data.db');
    const configPath = join(dir, 'config.json');

    writeFileSync(configPath, JSON.stringify({
      dbPath,
      accounts: [
        { id: 'main-coinbase', source: 'coinbase', identifier: 'user@example.com' },
      ],
    }), 'utf-8');

    const db = openDatabase(dbPath);
    const repo = createRepo(db.raw);
    repo.upsertAccount({
      id: 'main-coinbase',
      source: 'coinbase',
      identifier: 'user@example.com',
    });
    db.close();

    await expect(syncCommand({
      source: 'coinbase',
      config: configPath,
    })).rejects.toThrow('COINBASE_CDP_KEY_NAME and COINBASE_CDP_PRIVATE_KEY');
  });

  it('keeps --from rejected for Coinbase CSV imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-coinbase-csv-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      dbPath: join(dir, 'data.db'),
      accounts: [],
    }), 'utf-8');

    await expect(syncCommand({
      source: 'coinbase',
      file: join(dir, 'Coinbase.csv'),
      config: configPath,
      from: '2024-01-01',
    })).rejects.toThrow('`--from` is not supported for Coinbase CSV imports');
  });
});

function coinbaseApiEvent(): RawEvent {
  return {
    id: 'coinbase:api:v3:fill:fill-1',
    source: 'coinbase',
    accountId: 'main-coinbase',
    timestamp: new Date('2024-01-01T00:00:00Z'),
    type: 'trade',
    legs: [
      { asset: 'BTC', amount: '0.01' },
      { asset: 'USD', amount: '-420' },
    ],
    raw: { fill: { entry_id: 'fill-1' } },
  };
}

describe('syncCommand Crypto.com CSV', () => {
  it('imports Crypto.com CSV rows into the configured Crypto.com account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-crypto-com-'));
    const dbPath = join(dir, 'data.db');
    const configPath = join(dir, 'config.json');
    const csvPath = join(dir, 'crypto-com.csv');

    writeFileSync(configPath, JSON.stringify({
      dbPath,
      accounts: [
        { id: 'main-crypto-com', source: 'crypto-com', identifier: 'user@example.com' },
      ],
    }), 'utf-8');

    const db = openDatabase(dbPath);
    const repo = createRepo(db.raw);
    repo.upsertAccount({
      id: 'main-crypto-com',
      source: 'crypto-com',
      identifier: 'user@example.com',
    });
    db.close();

    writeFileSync(csvPath, [
      'Timestamp (UTC),Transaction Description,Currency,Amount,To Currency,To Amount,Native Currency,Native Amount,Native Amount (in USD),Transaction Kind,Transaction Hash',
      '2024-01-01 00:00:00,Buy BTC,BTC,0.01,USD,-420,USD,420,420,crypto_purchase,',
    ].join('\n'), 'utf-8');

    await syncCommand({ source: 'crypto-com', file: csvPath, config: configPath });

    const verifyDb = openDatabase(dbPath);
    const verifyRepo = createRepo(verifyDb.raw);
    const events = verifyRepo.getRawEvents({ source: 'crypto-com', limit: 10 });
    verifyDb.close();

    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe('trade');
    expect(events[0]!.legs).toEqual([
      { asset: 'BTC', amount: '0.01' },
      { asset: 'USD', amount: '-420' },
    ]);

    expect(renderCsvSyncOutput).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Crypto.com',
      accountId: 'main-crypto-com',
      totalRows: 1,
      eventCount: 1,
      inserted: 1,
      skipped: 0,
    }));
  });

  it('rejects --from for Crypto.com CSV imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-crypto-com-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      dbPath: join(dir, 'data.db'),
      accounts: [],
    }), 'utf-8');

    await expect(syncCommand({
      source: 'crypto-com',
      file: join(dir, 'ledger.csv'),
      config: configPath,
      from: '2024-01-01',
    })).rejects.toThrow('`--from` is not supported for Crypto.com CSV imports');
  });
});

describe('syncCommand Gemini CSV', () => {
  it('imports Gemini CSV rows into the configured Gemini account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-gemini-'));
    const dbPath = join(dir, 'data.db');
    const configPath = join(dir, 'config.json');
    const csvPath = join(dir, 'gemini.csv');

    writeFileSync(configPath, JSON.stringify({
      dbPath,
      accounts: [
        { id: 'main-gemini', source: 'gemini', identifier: 'user@example.com' },
      ],
    }), 'utf-8');

    const db = openDatabase(dbPath);
    const repo = createRepo(db.raw);
    repo.upsertAccount({
      id: 'main-gemini',
      source: 'gemini',
      identifier: 'user@example.com',
    });
    db.close();

    writeFileSync(csvPath, [
      'Date,Type,Symbol,Quantity,Price,Amount,Trade ID',
      '2024-01-01 00:00:00,Buy,BTCUSD,0.01,42000,420,gem-buy-1',
    ].join('\n'), 'utf-8');

    await syncCommand({ source: 'gemini', file: csvPath, config: configPath });

    const verifyDb = openDatabase(dbPath);
    const verifyRepo = createRepo(verifyDb.raw);
    const events = verifyRepo.getRawEvents({ source: 'gemini', limit: 10 });
    verifyDb.close();

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('gemini:gem-buy-1');
    expect(events[0]!.type).toBe('trade');
    expect(events[0]!.legs).toEqual([
      { asset: 'BTC', amount: '0.01' },
      { asset: 'USD', amount: '-420' },
    ]);

    expect(renderCsvSyncOutput).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Gemini',
      accountId: 'main-gemini',
      totalRows: 1,
      eventCount: 1,
      inserted: 1,
      skipped: 0,
    }));
  });

  it('rejects --from for Gemini CSV imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-gemini-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      dbPath: join(dir, 'data.db'),
      accounts: [],
    }), 'utf-8');

    await expect(syncCommand({
      source: 'gemini',
      file: join(dir, 'ledger.csv'),
      config: configPath,
      from: '2024-01-01',
    })).rejects.toThrow('`--from` is not supported for Gemini CSV imports');
  });
});

describe('syncCommand Robinhood CSV', () => {
  it('imports Robinhood CSV rows into the configured Robinhood account', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-robinhood-'));
    const dbPath = join(dir, 'data.db');
    const configPath = join(dir, 'config.json');
    const csvPath = join(dir, 'robinhood.csv');

    writeFileSync(configPath, JSON.stringify({
      dbPath,
      accounts: [
        { id: 'main-robinhood', source: 'robinhood', identifier: 'user@example.com' },
      ],
    }), 'utf-8');

    const db = openDatabase(dbPath);
    const repo = createRepo(db.raw);
    repo.upsertAccount({
      id: 'main-robinhood',
      source: 'robinhood',
      identifier: 'user@example.com',
    });
    db.close();

    writeFileSync(csvPath, [
      'Transaction Date,Transaction Type,Crypto Symbol,Crypto Amount,Crypto Price,Total,Transaction ID',
      '2024-01-01 00:00:00,Buy,BTC,0.01,42000,420,rh-buy-1',
    ].join('\n'), 'utf-8');

    await syncCommand({ source: 'robinhood', file: csvPath, config: configPath });

    const verifyDb = openDatabase(dbPath);
    const verifyRepo = createRepo(verifyDb.raw);
    const events = verifyRepo.getRawEvents({ source: 'robinhood', limit: 10 });
    verifyDb.close();

    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe('robinhood:rh-buy-1');
    expect(events[0]!.type).toBe('trade');
    expect(events[0]!.legs).toEqual([
      { asset: 'BTC', amount: '0.01' },
      { asset: 'USD', amount: '-420' },
    ]);

    expect(renderCsvSyncOutput).toHaveBeenCalledWith(expect.objectContaining({
      source: 'Robinhood',
      accountId: 'main-robinhood',
      totalRows: 1,
      eventCount: 1,
      inserted: 1,
      skipped: 0,
    }));
  });

  it('rejects --from for Robinhood CSV imports', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'daybook-sync-robinhood-'));
    const configPath = join(dir, 'config.json');
    writeFileSync(configPath, JSON.stringify({
      dbPath: join(dir, 'data.db'),
      accounts: [],
    }), 'utf-8');

    await expect(syncCommand({
      source: 'robinhood',
      file: join(dir, 'ledger.csv'),
      config: configPath,
      from: '2024-01-01',
    })).rejects.toThrow('`--from` is not supported for Robinhood CSV imports');
  });
});
