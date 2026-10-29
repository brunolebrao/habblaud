import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { createRemoteGate, loginPage, parseRemoteConfig, RemoteSessions } from '../http/remote';
import { setQuiet } from '../log';
import { hashPassword, parsePasswordHash } from './password';
import { base32Decode, base32Encode, newTotpSecret, otpauthUri, parseTotpSecret, totpCode, verifyTotp } from './totp';

setQuiet(true);

// RFC 6238, apêndice B (SHA1): a chave é "12345678901234567890"; os 6 últimos dígitos dos códigos de 8.
const RFC_KEY = Buffer.from('12345678901234567890');

describe('TOTP', () => {
  it('bate com os vetores da RFC 6238', () => {
    expect(totpCode(RFC_KEY, Math.floor(59 / 30))).toBe('287082');
    expect(totpCode(RFC_KEY, Math.floor(1111111109 / 30))).toBe('081804');
    expect(totpCode(RFC_KEY, Math.floor(2000000000 / 30))).toBe('279037');
  });

  it('base32 vai e volta; segredo novo tem 160 bits; segredo curto ou inválido é recusado', () => {
    expect(base32Encode(RFC_KEY)).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode('gezd gnbv gy3t qojq gezd gnbv gy3t qojq')).toEqual(RFC_KEY);
    expect(base32Decode('GEZ1')).toBeUndefined();
    const s = newTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(parseTotpSecret(s)?.length).toBe(20);
    expect(parseTotpSecret('GEZDGNBV')).toBeUndefined();
    expect(parseTotpSecret('ok!')).toBeUndefined();
  });

  it('aceita o passo anterior e o seguinte, e nada além', () => {
    const t = 1_700_000_000_000;
    const step = Math.floor(t / 30_000);
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, step), t)).toBe(step);
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, step - 1), t)).toBe(step - 1);
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, step + 1).replace(/^(\d{3})/, '$1 '), t)).toBe(step + 1);
    expect(verifyTotp(RFC_KEY, totpCode(RFC_KEY, step - 2), t)).toBeUndefined();
    expect(verifyTotp(RFC_KEY, '', t)).toBeUndefined();
    expect(verifyTotp(RFC_KEY, 'abcdef', t)).toBeUndefined();
  });

  it('otpauth:// com conta e emissor', () => {
    expect(otpauthUri('ABCD', 'ana', 'Habblaud')).toBe('otpauth://totp/Habblaud%3Aana?secret=ABCD&issuer=Habblaud&algorithm=SHA1&digits=6&period=30');
  });
});

describe('parseRemoteConfig com segundo fator', () => {
  const base = { HABBLAUD_REMOTE_USER: 'ana', HABBLAUD_REMOTE_PASSWORD_HASH: '', HABBLAUD_REMOTE_INSECURE_HTTP: '1' };
  it('liga com segredo válido e desliga tudo com segredo inválido', async () => {
    const hash = await hashPassword('correct horse battery', 10);
    const on = parseRemoteConfig({ ...base, HABBLAUD_REMOTE_PASSWORD_HASH: hash, HABBLAUD_REMOTE_TOTP_SECRET: base32Encode(RFC_KEY) }, false, () => false);
    expect(on.config?.totp).toEqual(RFC_KEY);
    const bad = parseRemoteConfig({ ...base, HABBLAUD_REMOTE_PASSWORD_HASH: hash, HABBLAUD_REMOTE_TOTP_SECRET: 'curto' }, false, () => false);
    expect(bad.config).toBeUndefined();
    expect(bad.warning).toMatch(/TOTP/);
    expect(parseRemoteConfig({ ...base, HABBLAUD_REMOTE_PASSWORD_HASH: hash }, false, () => false).config?.totp).toBeUndefined();
  });
});

describe('login remoto com código', () => {
  const closers: Array<() => Promise<void>> = [];
  afterEach(async () => {
    while (closers.length) await closers.pop()!();
  });

  async function serve(now: { t: number }) {
    const hashText = await hashPassword('correct horse battery', 10);
    const totpText = base32Encode(RFC_KEY);
    const cfg = { user: 'ana', passwordHash: parsePasswordHash(hashText)!, passwordHashText: hashText, totp: RFC_KEY, totpText };
    const gate = createRemoteGate({ config: cfg, sessions: new RemoteSessions(Buffer.alloc(32, 7), cfg), secure: false, now: () => now.t });
    const server = http.createServer((req, res) => {
      if (gate(req, res, new URL(req.url ?? '/', 'http://x'))) return;
      res.end('ok');
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    closers.push(() => new Promise<void>((ok) => server.close(() => ok())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    return (body: unknown) =>
      fetch(`${base}/api/remote/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  }

  it('sem código, código errado ou repetido não entra; o código certo entra uma vez', async () => {
    const now = { t: 1_700_000_000_000 };
    const login = await serve(now);
    const creds = { user: 'ana', password: 'correct horse battery' };
    const code = totpCode(RFC_KEY, Math.floor(now.t / 30_000));
    expect((await login(creds)).status).toBe(401);
    const wrong = await login({ ...creds, code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(401);
    expect(((await wrong.json()) as { error: string }).error).toBe('Usuário, senha ou código incorretos.');
    const ok = await login({ ...creds, code });
    expect(ok.status).toBe(200);
    expect(ok.headers.get('set-cookie')).toMatch(/habblaud_remote=v1\./);
    expect((await login({ ...creds, code })).status).toBe(401);
    // Senha errada com código certo: a mesma recusa (não revela qual dos três errou).
    now.t += 30_000;
    const next = totpCode(RFC_KEY, Math.floor(now.t / 30_000));
    const badPw = await login({ user: 'ana', password: 'errada', code: next });
    expect(((await badPw.json()) as { error: string }).error).toBe('Usuário, senha ou código incorretos.');
  });

  it('tela de login pede o código só com o segundo fator ligado', () => {
    expect(loginPage({ caDownload: false, totp: true })).toContain('autocomplete="one-time-code"');
    expect(loginPage({ caDownload: false })).not.toContain('one-time-code');
  });

  it('ligar o código encerra os logins de antes', () => {
    const cfg = { user: 'ana', passwordHashText: 'h' };
    const token = new RemoteSessions(Buffer.alloc(32, 7), cfg).issue().token;
    expect(new RemoteSessions(Buffer.alloc(32, 7), cfg).verify(token)).toBe(true);
    expect(new RemoteSessions(Buffer.alloc(32, 7), { ...cfg, totpText: 'X' }).verify(token)).toBe(false);
  });
});
