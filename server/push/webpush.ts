// Web Push sem dependências: VAPID (RFC 8292, JWT ES256) e conteúdo cifrado aes128gcm (RFC 8291), com o crypto do Node.
// O serviço de push do navegador (Google, Apple, Mozilla, Microsoft) só repassa o aviso cifrado ao aparelho.
import { createECDH, createCipheriv, createHmac, generateKeyPairSync, createPrivateKey, randomBytes, sign, type KeyObject } from 'node:crypto';

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  /** Chave pública crua (65 bytes, 0x04||x||y) em base64url: vai para o navegador (applicationServerKey). */
  publicKey: string;
  /** Chave privada em JWK (d, x, y). */
  privateJwk: { kty: 'EC'; crv: 'P-256'; d: string; x: string; y: string };
}

const b64u = (b: Buffer) => b.toString('base64url');

export function newVapidKeys(): VapidKeys {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' }) as { d: string; x: string; y: string };
  const raw = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  return { publicKey: b64u(raw), privateJwk: { kty: 'EC', crv: 'P-256', d: jwk.d, x: jwk.x, y: jwk.y } };
}

/** Chaves lidas do disco: confere o formato (undefined se estragado). */
export function parseVapidKeys(v: unknown): VapidKeys | undefined {
  const k = v as Partial<VapidKeys> | null;
  const j = k?.privateJwk as Partial<VapidKeys['privateJwk']> | undefined;
  if (!k || typeof k.publicKey !== 'string' || !j || typeof j.d !== 'string' || typeof j.x !== 'string' || typeof j.y !== 'string') return undefined;
  try {
    createPrivateKey({ key: { kty: 'EC', crv: 'P-256', d: j.d, x: j.x, y: j.y }, format: 'jwk' });
  } catch {
    return undefined;
  }
  return { publicKey: k.publicKey, privateJwk: { kty: 'EC', crv: 'P-256', d: j.d, x: j.x, y: j.y } };
}

/** JWT do VAPID para o serviço de push deste endpoint (aud = origem do endpoint). */
export function vapidJwt(endpoint: string, key: KeyObject, subject: string, nowS: number): string {
  const header = b64u(Buffer.from(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(Buffer.from(JSON.stringify({ aud: new URL(endpoint).origin, exp: nowS + 12 * 3600, sub: subject })));
  const sig = sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64u(sig)}`;
}

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** Cifra o conteúdo para a assinatura (RFC 8291, um registro só). `salt` e `ecdh` injetáveis nos testes. */
export function encryptPayload(
  sub: PushSubscription,
  payload: Buffer,
  opts: { salt?: Buffer; ecdh?: ReturnType<typeof createECDH> } = {},
): Buffer {
  const uaPublic = Buffer.from(sub.keys.p256dh, 'base64url');
  const authSecret = Buffer.from(sub.keys.auth, 'base64url');
  if (uaPublic.length !== 65 || authSecret.length < 16) throw new Error('assinatura de push inválida');
  const ecdh = opts.ecdh ?? createECDH('prime256v1');
  if (!opts.ecdh) ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const salt = opts.salt ?? randomBytes(16);
  const prkKey = hmac(authSecret, shared);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const cipher = createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([payload, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/** Serviços de push conhecidos: o servidor só manda para eles (o endpoint vem do navegador). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

export function isPushEndpoint(endpoint: string): boolean {
  try {
    const u = new URL(endpoint);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((re) => re.test(u.hostname));
  } catch {
    return false;
  }
}

export interface SendResult {
  status: number;
  /** A assinatura não vale mais (404/410): apagar. */
  gone: boolean;
}

export async function sendPush(
  sub: PushSubscription,
  payload: unknown,
  vapid: VapidKeys,
  opts: { subject: string; ttlS?: number; fetch?: typeof fetch; nowS?: number },
): Promise<SendResult> {
  if (!isPushEndpoint(sub.endpoint)) return { status: 0, gone: true };
  const key = createPrivateKey({ key: vapid.privateJwk, format: 'jwk' });
  const jwt = vapidJwt(sub.endpoint, key, opts.subject, opts.nowS ?? Math.floor(Date.now() / 1000));
  const body = encryptPayload(sub, Buffer.from(JSON.stringify(payload)));
  const res = await (opts.fetch ?? fetch)(sub.endpoint, {
    method: 'POST',
    headers: {
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttlS ?? 3600),
      Urgency: 'high',
      Authorization: `vapid t=${jwt}, k=${vapid.publicKey}`,
    },
    body: new Uint8Array(body),
    redirect: 'error',
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}
