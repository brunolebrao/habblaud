// Avisos no celular (Web Push): guarda as assinaturas dos aparelhos (push.json) e as chaves VAPID (push-vapid.json) na
// pasta de dados, e manda um aviso curto a todos quando um agente precisa de você ou o Estúdio termina uma geração.
// O conteúdo vai cifrado para cada aparelho; o serviço de push do navegador só o repassa.
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { isPushEndpoint, newVapidKeys, parseVapidKeys, sendPush, type PushSubscription, type VapidKeys } from './webpush';

/** O que o service worker (client/public/sw.js) mostra. */
export interface PushMessage {
  title: string;
  body: string;
  /** Avisos com a mesma tag se substituem no aparelho. */
  tag?: string;
  /** Agente a abrir ao tocar no aviso. */
  agentId?: string;
  /** Abre o Estúdio ao tocar. */
  studio?: boolean;
}

interface Stored extends PushSubscription {
  at: number;
}

export const MAX_SUBSCRIPTIONS = 20;
const TEXT_MAX = 300;

export interface PushServiceOptions {
  file: string;
  keysFile: string;
  /** Contato do VAPID (mailto: ou https:), exigido pela Apple. */
  subject?: string;
  fetch?: typeof fetch;
  now?: () => number;
  warn?: (text: string) => void;
}

function isSubscription(v: unknown): v is PushSubscription {
  const s = v as Partial<PushSubscription> | null;
  return (
    !!s &&
    typeof s.endpoint === 'string' &&
    s.endpoint.length <= 2048 &&
    isPushEndpoint(s.endpoint) &&
    !!s.keys &&
    typeof s.keys.p256dh === 'string' &&
    /^[A-Za-z0-9_-]{80,100}$/.test(s.keys.p256dh) &&
    typeof s.keys.auth === 'string' &&
    /^[A-Za-z0-9_-]{16,32}$/.test(s.keys.auth)
  );
}

function writePrivate(file: string, data: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

export class PushService {
  private readonly vapid: VapidKeys;
  private subs: Stored[] = [];

  constructor(private readonly opts: PushServiceOptions) {
    let keys: VapidKeys | undefined;
    try {
      keys = parseVapidKeys(JSON.parse(readFileSync(opts.keysFile, 'utf8')));
    } catch {
      // sem chaves ainda
    }
    if (!keys) {
      keys = newVapidKeys();
      writePrivate(opts.keysFile, keys);
    }
    this.vapid = keys;
    try {
      const list: unknown = JSON.parse(readFileSync(opts.file, 'utf8'));
      if (Array.isArray(list)) this.subs = list.filter(isSubscription).map((s) => ({ endpoint: s.endpoint, keys: s.keys, at: Number((s as Stored).at) || 0 }));
    } catch {
      // nenhum aparelho ainda
    }
  }

  publicKey(): string {
    return this.vapid.publicKey;
  }

  count(): number {
    return this.subs.length;
  }

  has(endpoint: string): boolean {
    return this.subs.some((s) => s.endpoint === endpoint);
  }

  /** Grava o aparelho (o mesmo endpoint troca as chaves). false = assinatura inválida. */
  subscribe(raw: unknown): boolean {
    if (!isSubscription(raw)) return false;
    this.subs = this.subs.filter((s) => s.endpoint !== raw.endpoint);
    this.subs.push({ endpoint: raw.endpoint, keys: { p256dh: raw.keys.p256dh, auth: raw.keys.auth }, at: (this.opts.now ?? Date.now)() });
    // O mais antigo sai quando passa do limite.
    while (this.subs.length > MAX_SUBSCRIPTIONS) this.subs.shift();
    this.save();
    return true;
  }

  unsubscribe(endpoint: unknown): void {
    if (typeof endpoint !== 'string') return;
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
  }

  /** Manda a todos os aparelhos (ou só a um endpoint); apaga os que o serviço diz que não valem mais. */
  async send(msg: PushMessage, only?: string): Promise<number> {
    const payload = { ...msg, title: msg.title.slice(0, 120), body: msg.body.slice(0, TEXT_MAX) };
    const targets = only ? this.subs.filter((s) => s.endpoint === only) : [...this.subs];
    let sent = 0;
    const gone: string[] = [];
    await Promise.all(
      targets.map(async (s) => {
        try {
          const r = await sendPush(s, payload, this.vapid, { subject: this.opts.subject ?? 'https://habblaud.com', fetch: this.opts.fetch });
          if (r.gone) gone.push(s.endpoint);
          else if (r.status >= 200 && r.status < 300) sent++;
          else this.opts.warn?.(`push ${new URL(s.endpoint).hostname}: HTTP ${r.status}`);
        } catch (err) {
          this.opts.warn?.(`push ${new URL(s.endpoint).hostname}: ${(err as Error).message}`);
        }
      }),
    );
    if (gone.length) {
      this.subs = this.subs.filter((s) => !gone.includes(s.endpoint));
      this.save();
    }
    return sent;
  }

  private save(): void {
    try {
      writePrivate(this.opts.file, this.subs);
    } catch (err) {
      this.opts.warn?.(`push.json: ${(err as Error).message}`);
    }
  }
}
