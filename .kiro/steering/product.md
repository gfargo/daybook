# Product Steering

daybook is a self-hosted crypto wallet auditing and tax reporting CLI for users who want a private, inspectable ledger instead of uploading all transaction history to a hosted tax product.

## Current Positioning

- Normalize exchange exports and wallet history into one local SQLite ledger.
- Classify transfers, trades, swaps, income, internal moves, NFT acquisitions/disposals, and gas/fee events.
- Compute cost basis with FIFO, HIFO, LIFO, and Specific ID.
- Export tax-ready CSV, Form 8949 PDF, Schedule D PDF, and TXF.
- Keep USD fiat distinct from crypto-denominated stablecoins such as USDC and USDT.

## Supported Ingestion

- Coinbase CSV
- Kraken CSV
- Binance CSV
- Binance.US CSV
- Generic universal/manual crypto ledger CSV
- Ethereum wallet history via Alchemy
- Polygon wallet history via Alchemy
- Base wallet history via Alchemy
- Arbitrum wallet history via Alchemy
- Optimism wallet history via Alchemy
- BNB Chain wallet history via Alchemy
- Failed Ethereum transaction gas via Etherscan

## Near-Term Priorities

- Expand high-value source coverage where existing architecture can be reused.
- Keep importers explicit about source formats to avoid silent mis-parsing.
- Prefer deterministic IDs and idempotent re-sync behavior for every adapter.
- Validate parser assumptions with anonymized real exports before presenting support as fully battle-tested.
