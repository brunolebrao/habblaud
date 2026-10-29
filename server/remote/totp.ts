// Segundo fator do login remoto: código de 6 dígitos de app autenticador (TOTP, RFC 6238: HMAC-SHA1, 30 s).
// O segredo fica no .env (HABBLAUD_REMOTE_TOTP_SECRET, base32), gravado pelo npm run remote:totp; nunca sai do computador
// a não ser pelo QR que o próprio comando mostra no terminal.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_STEP_S = 30;
const DIGITS = 6;

export function base32Encode(data: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of data) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Base32 sem padding (espaços e "=" ignorados, maiúsculas ou minúsculas); undefined se tiver outro caractere. */
export function base32Decode(text: string): Buffer | undefined {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) return undefined;
    value = ((value << 5) | i) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** Segredo novo (160 bits, o tamanho que os apps esperam), em base32. */
export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

/** Segredo do .env: base32 com pelo menos 128 bits; undefined se inválido. */
export function parseTotpSecret(text: string | undefined): Buffer | undefined {
  if (!text?.trim()) return undefined;
  const key = base32Decode(text);
  return key && key.length >= 16 ? key : undefined;
}

export function totpCode(key: Buffer, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', key).update(counter).digest();
  const off = mac[mac.length - 1] & 15;
  const n = (mac.readUInt32BE(off) & 0x7fffffff) % 10 ** DIGITS;
  return String(n).padStart(DIGITS, '0');
}

/**
 * Confere o código (aceita o passo anterior e o seguinte, para relógio um pouco fora). Devolve o passo que bateu, ou
 * undefined. Quem chama recusa um passo já usado (o mesmo código não entra duas vezes).
 */
export function verifyTotp(key: Buffer, code: string, nowMs: number): number | undefined {
  const digits = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(digits)) return undefined;
  const now = Math.floor(nowMs / 1000 / TOTP_STEP_S);
  let hit: number | undefined;
  for (const step of [now - 1, now, now + 1]) {
    const a = Buffer.from(totpCode(key, step));
    if (timingSafeEqual(a, Buffer.from(digits)) && hit === undefined) hit = step;
  }
  return hit;
}

/** Endereço otpauth:// que o app autenticador lê pelo QR. */
export function otpauthUri(secret: string, account: string, issuer: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${DIGITS}&period=${TOTP_STEP_S}`;
}
