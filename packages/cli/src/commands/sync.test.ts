import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createRepo, openDatabase } from '@daybook/ledger';
import { syncCommand } from './sync.js';
import { renderCsvSyncOutput } from './SyncOutput.js';

vi.mock('./SyncOutput.js', () => ({
  renderCsvSyncOutput: vi.fn(),
  renderEvmSyncOutput: vi.fn(),
}));

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
