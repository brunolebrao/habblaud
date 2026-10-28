// A conexão da central com outro computador (PeerConfig): entra pela porta remota de lá com usuário e senha (como o
// celular), acompanha o escritório pelo /api/stream e faz as requisições que a central encaminha (server/peers/proxy.ts).
// HTTPS só com a CA de lá (peers.json "ca"): o nome no certificado não é conferido (o endereço é um IP da rede local), mas
// só um certificado assinado por aquela CA é aceito. Node puro.
import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';
import type { FeedItem, HostInfo, Notice, OfficeSnapshot } from '../../shared/types';
import { tr } from '../../shared/i18n';
import type { PeerConfig } from './config';

const COOKIE = 'habblaud_remote';
const RETRY_MIN_MS = 2_000;
const RETRY_MAX_MS = 30_000;
/** Sem nada no stream (o servidor manda ": ping" a cada 15 s) por este tempo: a conexão caiu sem avisar. */
const SILENCE_MS = 45_000;
const REQUEST_TIMEOUT_MS = 20_000;
/** Um snapshot de outro computador maior que isto é recusado (proteção de memória). */
const MAX_EVENT = 16 * 1024 * 1024;

export interface PeerResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export interface PeerLinkEvents {
  /** Snapshot novo ou mudança de estado da conexão. */
  onChange(): void;
  onFeed(items: FeedItem[]): void;
  onNotice(n: Notice): void;
  log?: { info(m: string): void; warn(m: string): void };
}

export class PeerLink {
  private cookie: string | undefined;
  private login: Promise<void> | null = null;
  private stream: IncomingMessage | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private attempts = 0;
  private stopped = true;
  private readonly base: URL;
  /** O último escritório recebido (ids de lá, sem prefixo). */
  snapshot: OfficeSnapshot | undefined;
  state: HostInfo['state'] = 'connecting';
  error: string | undefined;

  constructor(
    readonly config: PeerConfig,
    private readonly events: PeerLinkEvents,
  ) {
    this.base = new URL(config.url);
  }

  get info(): HostInfo {
    return { id: this.config.id, name: this.config.name, state: this.state, ...(this.error ? { error: this.error } : {}) };
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.retryTimer = this.silenceTimer = null;
    this.stream?.destroy();
    this.stream = null;
  }

  /** Requisição à API de lá, já com o login (refeito uma vez se a sessão venceu). */
  async request(method: string, path: string, body?: unknown): Promise<PeerResponse> {
    const data = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const once = async () => collect(await this.raw(method, path, data));
    if (!this.cookie) await this.ensureLogin();
    let r = await once();
    if (r.status === 401) {
      this.cookie = undefined;
      await this.ensureLogin();
      r = await once();
    }
    return r;
  }

  /** Abre uma resposta em fluxo (SSE do terminal), já com o login. Quem chama lê e fecha. */
  async open(path: string): Promise<IncomingMessage> {
    if (!this.cookie) await this.ensureLogin();
    let res = await this.raw('GET', path, undefined, { Accept: 'text/event-stream' }, 0);
    if (res.statusCode === 401) {
      res.resume();
      this.cookie = undefined;
      await this.ensureLogin();
      res = await this.raw('GET', path, undefined, { Accept: 'text/event-stream' }, 0);
    }
    return res;
  }

  // ---------------------------------------------------------------- internos

  private raw(method: string, path: string, data?: Buffer, extra: Record<string, string> = {}, timeout = REQUEST_TIMEOUT_MS): Promise<IncomingMessage> {
    const secure = this.base.protocol === 'https:';
    const headers: Record<string, string | number> = { Host: this.base.host, ...extra };
    if (this.cookie) headers.Cookie = this.cookie;
    if (data) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = data.length;
    }
    const opts: https.RequestOptions = {
      method,
      hostname: this.base.hostname.replace(/^\[|\]$/g, ''),
      port: this.base.port || (secure ? 443 : 80),
      path,
      headers,
      // O nome no certificado só deixa de ser conferido com a CA de lá fixada (parsePeers exige "ca" em https).
      ...(secure ? { ca: this.config.ca, rejectUnauthorized: true, ...(this.config.ca ? { checkServerIdentity: () => undefined } : {}) } : {}),
    };
    return new Promise((ok, fail) => {
      const req = (secure ? https : http).request(opts, ok);
      if (timeout) req.setTimeout(timeout, () => req.destroy(new Error(tr('o outro computador não respondeu'))));
      req.on('error', fail);
      req.end(data);
    });
  }

  private ensureLogin(): Promise<void> {
    this.login ??= (async () => {
      const res = await collect(await this.raw('POST', '/api/remote/login', Buffer.from(JSON.stringify({ user: this.config.user, password: this.config.password }))));
      if (res.status !== 200) throw new Error(errorText(res) ?? tr('login recusado ({0})', [res.status]));
      const set = ([] as string[]).concat(res.headers['set-cookie'] ?? []);
      const pair = set.map((c) => c.split(';')[0]).find((c) => c.startsWith(`${COOKIE}=`));
      if (!pair) throw new Error(tr('o outro computador não devolveu a sessão do login'));
      this.cookie = pair;
    })().finally(() => {
      this.login = null;
    });
    return this.login;
  }

  private connect(): void {
    if (this.stopped) return;
    this.open('/api/stream').then(
      (res) => {
        if (this.stopped) return void res.destroy();
        if (res.statusCode !== 200) {
          res.resume();
          return this.failed(tr('o outro computador respondeu {0}', [res.statusCode ?? 0]));
        }
        this.stream = res;
        this.attempts = 0;
        this.read(res);
      },
      (err: Error) => this.failed(describe(err)),
    );
  }

  private read(res: IncomingMessage): void {
    let buf = '';
    let event = 'message';
    let data: string[] = [];
    let size = 0;
    this.alive();
    res.setEncoding('utf8');
    res.on('data', (chunk: string) => {
      this.alive();
      buf += chunk;
      // Linha sem fim (ou evento enorme) não cresce sem limite.
      if (buf.length + size > MAX_EVENT) return void res.destroy(new Error(tr('evento grande demais')));
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line) {
          if (data.length) this.dispatch(event, data.join('\n'));
          event = 'message';
          data = [];
          size = 0;
        } else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) {
          size += line.length;
          if (size > MAX_EVENT) return void res.destroy(new Error(tr('evento grande demais')));
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
    });
    const end = (err?: Error) => {
      if (this.stream !== res) return;
      this.stream = null;
      this.failed(err ? describe(err) : tr('a conexão caiu'));
    };
    res.on('end', () => end());
    res.on('close', () => end());
    res.on('error', (err) => end(err));
  }

  private dispatch(event: string, raw: string): void {
    let data: unknown;
    try {
      data = JSON.parse(raw);
    } catch {
      return;
    }
    if (event === 'snapshot' && data && typeof data === 'object' && Array.isArray((data as OfficeSnapshot).agents)) {
      this.snapshot = data as OfficeSnapshot;
      const was = this.state;
      this.state = 'online';
      this.error = undefined;
      if (was !== 'online') this.events.log?.info(tr('   Outro computador: {0} conectado.', [this.config.name]));
      this.events.onChange();
    } else if (event === 'feed' && Array.isArray(data)) this.events.onFeed(data as FeedItem[]);
    else if (event === 'notice' && data && typeof data === 'object') this.events.onNotice(data as Notice);
  }

  private alive(): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = setTimeout(() => this.stream?.destroy(new Error(tr('sem resposta do outro computador'))), SILENCE_MS);
    this.silenceTimer.unref?.();
  }

  private failed(reason: string): void {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    this.silenceTimer = null;
    if (this.stopped) return;
    const was = this.state;
    this.state = this.snapshot && was === 'online' ? 'connecting' : 'offline';
    if (this.error !== reason) this.events.log?.warn(tr('   Outro computador: {0} sem conexão ({1}).', [this.config.name, reason]));
    this.error = reason;
    // Fora do ar: o andar fica, mas vazio (ninguém de lá aparece trabalhando com dados velhos).
    if (this.state === 'offline') this.snapshot = undefined;
    this.events.onChange();
    const delay = Math.min(RETRY_MAX_MS, RETRY_MIN_MS * 2 ** this.attempts++);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      if (this.state === 'connecting') {
        this.state = 'offline';
        this.snapshot = undefined;
        this.events.onChange();
      }
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }
}

function collect(res: IncomingMessage, max = 32 * 1024 * 1024): Promise<PeerResponse> {
  return new Promise((ok, fail) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) res.destroy(new Error(tr('resposta grande demais')));
      else chunks.push(c);
    });
    res.on('end', () => ok({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
    res.on('error', fail);
  });
}

function errorText(r: PeerResponse): string | undefined {
  try {
    const e = (JSON.parse(r.body.toString('utf8')) as { error?: unknown }).error;
    return typeof e === 'string' ? e : undefined;
  } catch {
    return undefined;
  }
}

function describe(err: Error): string {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ECONNREFUSED') return tr('o Habblaud de lá não está rodando (conexão recusada)');
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ETIMEDOUT') return tr('o computador não está na rede');
  if (code && /CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) return tr('certificado não confere com a CA do peers.json');
  return err.message;
}
