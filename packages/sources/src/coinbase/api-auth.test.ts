import { createPrivateKey, createPublicKey, createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
    buildJwtUri,
    createCoinbaseJwt,
    normalizePrivateKey,
} from './api-auth.js';

describe('Coinbase API auth', () => {
  it('builds the Coinbase REST JWT URI from method, host, and path', () => {
    expect(buildJwtUri({
      method: 'get',
      host: 'api.coinbase.com',
      path: '/api/v3/brokerage/accounts',
    })).toBe('GET api.coinbase.com/api/v3/brokerage/accounts');
  });

  it('normalizes escaped PEM newlines from environment variables', () => {
    expect(normalizePrivateKey('-----BEGIN\\nKEY\\n-----END')).toBe(
      '-----BEGIN\nKEY\n-----END',
    );
  });

  it('creates an ES256 JWT with Coinbase CDP claims', () => {
    const { privateKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
      privateKeyEncoding: { type: 'sec1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const keyName = 'organizations/org/apiKeys/key';
    const token = createCoinbaseJwt(
      { keyName, privateKey },
      {
        method: 'GET',
        host: 'api.coinbase.com',
        path: '/v2/accounts',
      },
      new Date('2026-05-09T12:00:00Z'),
      'fixednonce',
    );

    const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
    expect(JSON.parse(decodeBase64Url(encodedHeader!))).toEqual({
      alg: 'ES256',
      typ: 'JWT',
      kid: keyName,
      nonce: 'fixednonce',
    });
    expect(JSON.parse(decodeBase64Url(encodedPayload!))).toEqual({
      sub: keyName,
      iss: 'cdp',
      nbf: 1778328000,
      exp: 1778328120,
      uri: 'GET api.coinbase.com/v2/accounts',
    });

    const verifier = createVerify('SHA256');
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    expect(verifier.verify(
      {
        key: createPublicKey(createPrivateKey(privateKey)),
        dsaEncoding: 'ieee-p1363',
      },
      decodeBase64UrlBuffer(encodedSignature!),
    )).toBe(true);
  });
});

function decodeBase64Url(value: string): string {
  return decodeBase64UrlBuffer(value).toString('utf-8');
}

function decodeBase64UrlBuffer(value: string): Buffer {
  return Buffer.from(
    value.replace(/-/g, '+').replace(/_/g, '/'),
    'base64',
  );
}
