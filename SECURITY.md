# Security Policy

## Supported versions

daybook is a personal tool under active development. Only the **latest published version** receives security fixes. Older versions are not patched.

| Version | Supported |
| ------- | --------- |
| 0.4.x   | ✅ |
| < 0.4   | ❌ |

## Reporting a vulnerability

**Please do not open public GitHub issues for security vulnerabilities.**

If you find a vulnerability — particularly one that could:

- Leak wallet addresses, transaction history, or other PII from a user's local database
- Result in incorrect tax computations that could mislead a filing
- Allow remote code execution via a malicious CSV / 1099-DA file
- Compromise stored API keys (Coinbase CDP, Alchemy, CoinGecko)

…report it privately via GitHub's [private security advisory](https://github.com/gfargo/daybook/security/advisories/new) feature, or email **ghfargo@gmail.com** with `[daybook security]` in the subject.

Expect an acknowledgement within 7 days. Fixes for confirmed issues will be released in a patch version with credit to the reporter (if desired).

## Scope

daybook runs locally — your data never leaves your machine except for outbound calls to:

- **Exchange APIs** (Coinbase only, with your CDP keys)
- **Block explorers / RPC** (Alchemy, Etherscan, with your API keys)
- **Price oracles** (CoinGecko)

No telemetry, no analytics, no cloud sync. Bugs that affect any of these external integration boundaries are in scope.

Out of scope: vulnerabilities in our upstream dependencies (`viem`, `pdf-lib`, etc.) — please report those to the respective projects. We monitor `npm audit` and ship dependency updates as needed.
