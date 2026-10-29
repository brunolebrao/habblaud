import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify } from 'node:crypto';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../test/fixtures';
import { PushService } from './service';
import { encryptPayload, isPushEndpoint, newVapidKeys, vapidJwt, type PushSubscription } from './webpush';
import { createPrivateKey } from 'node:crypto';

const hmac = (key: Buffer, data: Buffer) => createHmac('sha256', key).update(data).digest();

/** O lado do navegador (RFC 8291): decifra o que o servidor mandou. */
function decrypt(body: Buffer, uaPrivate: ReturnType<typeof createECDH>, auth: Buffer): string {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const data = body.subarray(21 + idlen);
  const shared = uaPrivate.computeSecret(asPublic);
  const uaPublic = uaPrivate.getPublicKey();
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  const d = createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(data.subarray(data.length - 16));
  const plain = Buffer.concat([d.update(data.subarray(0, data.length - 16)), d.final()]);
  expect(plain[plain.length - 1]).toBe(2);
  return plain.subarray(0, -1).toString('utf8');
}

function device(endpoint = 'https://fcm.googleapis.com/fcm/send/abc') {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = randomBytes(16);
  const sub: PushSubscription = { endpoint, keys: { p256dh: ua.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } };
  return { ua, auth, sub };
}

describe('Web Push', () => {
  it('o navegador decifra o conteúdo (aes128gcm)', () => {
    const { ua, auth, sub } = device();
    const body = encryptPayload(sub, Buffer.from('{"title":"oi"}'));
    expect(body.readUInt32BE(16)).toBe(4096);
    expect(decrypt(body, ua, auth)).toBe('{"title":"oi"}');
  });

  it('JWT do VAPID assinado com a chave, aud = origem do serviço', () => {
    const keys = newVapidKeys();
    const jwt = vapidJwt('https://web.push.apple.com/abc', createPrivateKey({ key: keys.privateJwk, format: 'jwk' }), 'https://habblaud.com', 1000);
    const [h, c, s] = jwt.split('.');
    expect(JSON.parse(Buffer.from(c, 'base64url').toString())).toEqual({ aud: 'https://web.push.apple.com', exp: 1000 + 12 * 3600, sub: 'https://habblaud.com' });
    const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: keys.privateJwk.x, y: keys.privateJwk.y }, format: 'jwk' });
    expect(verify('sha256', Buffer.from(`${h}.${c}`), { key: pub, dsaEncoding: 'ieee-p1363' }, Buffer.from(s, 'base64url'))).toBe(true);
    expect(Buffer.from(keys.publicKey, 'base64url').length).toBe(65);
  });

  it('só manda para serviços de push conhecidos, por https', () => {
    expect(isPushEndpoint('https://fcm.googleapis.com/fcm/send/x')).toBe(true);
    expect(isPushEndpoint('https://web.push.apple.com/x')).toBe(true);
    expect(isPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x')).toBe(true);
    expect(isPushEndpoint('http://fcm.googleapis.com/x')).toBe(false);
    expect(isPushEndpoint('https://fcm.googleapis.com:8443/x')).toBe(false);
    expect(isPushEndpoint('https://localhost/x')).toBe(false);
    expect(isPushEndpoint('https://evilpush.apple.com.example.com/x')).toBe(false);
    expect(isPushEndpoint('nada')).toBe(false);
  });
});

describe('PushService', () => {
  it('guarda aparelhos (arquivo 600), reaproveita as chaves, manda cifrado e apaga quem sumiu', async () => {
    const tmp = tempDir();
    const file = join(tmp.dir, 'push.json');
    const keysFile = join(tmp.dir, 'push-vapid.json');
    const calls: Array<{ url: string; headers: Record<string, string>; body: Buffer }> = [];
    const status = new Map<string, number>();
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, headers: init.headers as Record<string, string>, body: Buffer.from(init.body as Uint8Array) });
      return new Response(null, { status: status.get(url) ?? 201 });
    }) as unknown as typeof fetch;
    const a = device('https://fcm.googleapis.com/fcm/send/a');
    const b = device('https://web.push.apple.com/b');
    const s1 = new PushService({ file, keysFile, fetch: fakeFetch });
    expect(s1.subscribe({ endpoint: 'https://example.com/x', keys: a.sub.keys })).toBe(false);
    expect(s1.subscribe(a.sub)).toBe(true);
    expect(s1.subscribe(b.sub)).toBe(true);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(keysFile).mode & 0o777).toBe(0o600);

    const s2 = new PushService({ file, keysFile, fetch: fakeFetch });
    expect(s2.publicKey()).toBe(s1.publicKey());
    expect(s2.count()).toBe(2);
    status.set(b.sub.endpoint, 410);
    expect(await s2.send({ title: 'T', body: 'B', agentId: 'x' })).toBe(1);
    expect(s2.count()).toBe(1);
    expect(s2.has(b.sub.endpoint)).toBe(false);
    const first = calls.find((c) => c.url === a.sub.endpoint)!;
    expect(first.headers['Content-Encoding']).toBe('aes128gcm');
    expect(first.headers.Authorization).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${s2.publicKey()}$`));
    expect(JSON.parse(decrypt(first.body, a.ua, a.auth))).toEqual({ title: 'T', body: 'B', agentId: 'x' });

    s2.unsubscribe(a.sub.endpoint);
    expect(new PushService({ file, keysFile }).count()).toBe(0);
    tmp.cleanup();
  });
});
