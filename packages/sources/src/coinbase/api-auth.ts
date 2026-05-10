import { createSign, randomBytes } from 'node:crypto';

export interface CoinbaseApiCredentials {
  keyName: string;
  privateKey: string;
}

export interface CoinbaseJwtRequest {
  method: string;
  host: string;
  path: string;
}

export function normalizePrivateKey(value: string): string {
  return value.replace(/\\n/g, '\n');
}

export function buildJwtUri(request: CoinbaseJwtRequest): string {
  return `${request.method.toUpperCase()} ${request.host}${request.path}`;
}

export function createCoinbaseJwt(
  credentials: CoinbaseApiCredentials,
  request: CoinbaseJwtRequest,
  now = new Date(),
  nonce = randomBytes(16).toString('hex'),
): string {
  const nbf = Math.floor(now.getTime() / 1000);
  const header = {
    alg: 'ES256',
    typ: 'JWT',
    kid: credentials.keyName,
    nonce,
  };
  const payload = {
    sub: credentials.keyName,
    iss: 'cdp',
    nbf,
    exp: nbf + 120,
    uri: buildJwtUri(request),
  };

  const signingInput = [
    base64UrlJson(header),
    base64UrlJson(payload),
  ].join('.');

  const signer = createSign('SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({
    key: normalizePrivateKey(credentials.privateKey),
    dsaEncoding: 'ieee-p1363',
  });

  return `${signingInput}.${base64Url(signature)}`;
}

function base64UrlJson(value: unknown): string {
  return base64Url(Buffer.from(JSON.stringify(value)));
}

function base64Url(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}
