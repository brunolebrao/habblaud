// Andares de outros computadores (peers.json, server/peers/config.ts). A central junta o escritório de cada um ao seu
// (ids prefixados, shared/hosts.ts) SÓ no que vai para a página (Hub.merged): estatísticas, linha do tempo, o mod e o
// Habblaud World continuam lendo só este computador (Office). As ações da página num agente de lá (mensagem, permissão,
// Novo agente, terminal) são encaminhadas pela porta com login de lá, depois de passar pelas mesmas travas daqui.
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hostOf, namespaceAgent, namespaceOffice, splitHost, withHost } from '../../shared/hosts';
import type { FeedItem, HostInfo, Notice, OfficeSnapshot } from '../../shared/types';
import { tr } from '../../shared/i18n';
import type { RemoteFeature } from '../http/remote';
import type { SpawnFolder } from '../spawn/folders';
import type { PeersFile } from './config';
import { PeerLink, type PeerResponse } from './link';

const FEED_KEEP = 50;
/** Anexo em base64 (o mesmo limite das rotas daqui; ver spawn/attachments.ts). */
const ATTACHMENT_BODY = 21 * 1024 * 1024;

/** O que as rotas encaminhadas usam do handler da API (http/app.ts). */
export interface PeerRouteHelpers {
  trusted(req: IncomingMessage, feature?: RemoteFeature): boolean;
  /**
   * O recurso está ligado AQUI (mesma chave das rotas locais: terminal, mensagens e permissões só existem com bind local).
   * Desligado = a central não encaminha, nem com Host local (o Host se imita quando a porta está aberta à rede).
   */
  enabled(feature: RemoteFeature): boolean;
  denied(req: IncomingMessage, localMessage: string): string;
  readJson(req: IncomingMessage, max?: number): Promise<unknown>;
  sendJson(res: ServerResponse, status: number, body: unknown): void;
}

export class PeerSet {
  readonly links: PeerLink[];
  private readonly self: string;
  private rev = 0;
  private feed: FeedItem[] = [];
  private changeCbs = new Set<() => void>();
  private feedCbs = new Set<(items: FeedItem[]) => void>();
  private noticeCbs = new Set<(n: Notice) => void>();

  constructor(file: PeersFile, log?: { info(m: string): void; warn(m: string): void }) {
    this.self = file.self ?? tr('Este computador');
    this.links = file.peers.map(
      (cfg) =>
        new PeerLink(cfg, {
          log,
          onChange: () => this.changed(),
          onFeed: (items) => this.addFeed(cfg.id, items),
          onNotice: (n) => this.noticeCbs.forEach((cb) => cb(prefixNotice(n, cfg.id))),
        }),
    );
  }

  get size(): number {
    return this.links.length;
  }

  start(): void {
    for (const l of this.links) l.start();
  }

  stop(): void {
    for (const l of this.links) l.stop();
  }

  onChange(cb: () => void): () => void {
    this.changeCbs.add(cb);
    return () => void this.changeCbs.delete(cb);
  }

  onFeed(cb: (items: FeedItem[]) => void): () => void {
    this.feedCbs.add(cb);
    return () => void this.feedCbs.delete(cb);
  }

  onNotice(cb: (n: Notice) => void): () => void {
    this.noticeCbs.add(cb);
    return () => void this.noticeCbs.delete(cb);
  }

  hosts(): HostInfo[] {
    return [{ name: this.self, state: 'online' }, ...this.links.map((l) => l.info)];
  }

  /** O escritório daqui com os andares de lá (para a página). `rev` cresce com qualquer um dos dois. */
  merge(local: OfficeSnapshot): OfficeSnapshot {
    if (!this.links.length) return local;
    const out: OfficeSnapshot = {
      ...local,
      rev: local.rev + this.rev,
      rooms: [...local.rooms],
      agents: [...local.agents],
      accounts: [...local.accounts],
      meta: { ...local.meta, hosts: this.hosts() },
    };
    for (const l of this.links) {
      if (!l.snapshot) continue;
      const ns = namespaceOffice(l.snapshot, l.config.id);
      out.rooms.push(...ns.rooms);
      out.agents.push(...ns.agents);
      out.accounts.push(...ns.accounts);
    }
    return out;
  }

  recentFeed(n: number): FeedItem[] {
    return this.feed.slice(-n);
  }

  /** Pastas do Novo agente nos outros computadores (com `host`), dos que estão no ar. A trava é da rota (http/app.ts). */
  async folders(): Promise<SpawnFolder[]> {
    const lists = await Promise.all(
      this.links
        .filter((l) => l.state === 'online')
        .map(async (l) => {
          try {
            const r = await l.request('GET', '/api/spawn/folders');
            const folders = r.status === 200 ? ((json(r) as { folders?: SpawnFolder[] })?.folders ?? []) : [];
            return folders.map((f) => ({ ...f, host: l.config.id }));
          } catch {
            return [];
          }
        }),
    );
    return lists.flat();
  }

  /**
   * Rotas da página que miram outro computador (id com "@<computador>:" ou `host` no corpo/consulta). Devolve false
   * quando a requisição é daqui (segue para as rotas normais).
   */
  route(req: IncomingMessage, res: ServerResponse, url: URL, h: PeerRouteHelpers): boolean {
    // Já passou por aqui (corpo lido, destino daqui): segue para as rotas normais.
    if (!this.links.length || 'habblaudBody' in req) return false;
    const path = url.pathname;
    const method = req.method ?? 'GET';
    const seg = path.split('/').map((s) => {
      try {
        return decodeURIComponent(s);
      } catch {
        return s;
      }
    });
    // seg: ['', 'api', recurso, id?, ação?]
    const target = (id: string | undefined) => (id ? this.link(hostOf(id)) : undefined);
    const fail = (status: number, error: string) => {
      req.resume();
      h.sendJson(res, status, { error });
      return true;
    };
    const guard = (feature: RemoteFeature, localMessage: string) =>
      !h.enabled(feature) ? fail(403, tr('recurso desligado neste computador')) : h.trusted(req, feature) ? null : fail(403, h.denied(req, localMessage));
    const run = (p: Promise<void>) => {
      p.catch((err: Error) => {
        if (!res.headersSent) h.sendJson(res, 502, { error: tr('outro computador: {0}', [err.message]) });
        else res.destroy();
      });
      return true;
    };

    // ---- agentes: detalhe, terminal; o resto só no próprio computador
    if (seg[2] === 'agents' && seg[3] && hostOf(seg[3])) {
      const link = target(seg[3]);
      if (!link) return fail(404, tr('outro computador desconhecido'));
      const inner = splitHost(seg[3]).id;
      if (seg.length === 4 && (method === 'GET' || method === 'HEAD')) {
        return run(
          link.request('GET', `/api/agents/${encodeURIComponent(inner)}`).then((r) => {
            const body = json(r) as { agent?: unknown } | undefined;
            if (r.status === 200 && body?.agent) body.agent = namespaceAgent(body.agent as never, link.config.id);
            h.sendJson(res, r.status, body ?? {});
          }),
        );
      }
      if (seg[4] === 'terminal' && seg.length === 5) {
        if (guard('terminal', tr('o terminal só é aberto pelo próprio computador (http://localhost)'))) return true;
        return run(this.pipe(link, `/api/agents/${encodeURIComponent(inner)}/terminal${url.search}`, req, res));
      }
      return fail(403, tr('isso só dá para fazer no próprio computador do agente'));
    }

    // ---- sessões do histórico (terminal de uma sessão encerrada): /api/sessions/:conta/:sessão/terminal
    if (seg[2] === 'sessions' && seg[3] && hostOf(seg[3]) && seg[5] === 'terminal') {
      const link = target(seg[3]);
      if (!link) return fail(404, tr('outro computador desconhecido'));
      if (guard('terminal', tr('o terminal só é aberto pelo próprio computador (http://localhost)'))) return true;
      const p = `/api/sessions/${encodeURIComponent(splitHost(seg[3]).id)}/${encodeURIComponent(seg[4])}/terminal${url.search}`;
      return run(this.pipe(link, p, req, res));
    }

    // ---- permissões
    if (seg[2] === 'permissions' && seg[3] && hostOf(seg[3])) {
      const link = target(seg[3]);
      if (!link) return fail(404, tr('outro computador desconhecido'));
      if (guard('permissions', tr('pedidos de permissão só são respondidos pelo próprio computador (http://localhost)'))) return true;
      const inner = encodeURIComponent(splitHost(seg[3]).id);
      if (seg.length === 4 && method === 'GET') return run(link.request('GET', `/api/permissions/${inner}`).then((r) => this.reply(res, h, r, link.config.id)));
      if (seg[4] === 'decision' && method === 'POST') {
        return run(h.readJson(req).then((body) => link.request('POST', `/api/permissions/${inner}/decision`, body)).then((r) => this.reply(res, h, r, link.config.id)));
      }
      return fail(405, tr('método não permitido'));
    }

    // ---- mensagens
    if (seg[2] === 'messages') {
      const feature = 'messages';
      const local = tr('mensagens só são mandadas pelo próprio computador (http://localhost)');
      if (seg[3] === 'attachments' && seg.length === 4) {
        const link = this.link(url.searchParams.get('host') ?? undefined);
        if (!url.searchParams.get('host')) return false;
        if (!link) return fail(404, tr('outro computador desconhecido'));
        if (guard(feature, local)) return true;
        return run(h.readJson(req, ATTACHMENT_BODY).then((body) => link.request('POST', '/api/messages/attachments', body)).then((r) => this.reply(res, h, r, link.config.id)));
      }
      if (seg.length === 4 && seg[3] && hostOf(seg[3]) && method === 'GET') {
        const link = target(seg[3]);
        if (!link) return fail(404, tr('outro computador desconhecido'));
        if (guard(feature, local)) return true;
        return run(link.request('GET', `/api/messages/${encodeURIComponent(splitHost(seg[3]).id)}`).then((r) => this.reply(res, h, r, link.config.id)));
      }
      if (seg.length === 3 && method === 'POST') {
        // O destino está no corpo: lê aqui e, se for daqui, não dá para devolver à rota normal (o corpo já foi lido).
        return this.withBody(req, res, h, (body) => {
          const agentId = typeof body.agentId === 'string' ? body.agentId : '';
          return hostOf(agentId);
        }, feature, local, async (link, body) => {
          const fwd = { ...body, agentId: splitHost(String(body.agentId)).id, attachments: stripAll(body.attachments, link.config.id) };
          this.reply(res, h, await link.request('POST', '/api/messages', fwd), link.config.id);
        });
      }
      return false;
    }

    // ---- novo agente
    if (seg[2] === 'spawn') {
      const feature = 'spawn';
      const local = tr('agentes novos só são abertos pelo próprio computador (http://localhost)');
      if (seg[3] === 'attachments' && seg.length === 4) {
        if (!url.searchParams.get('host')) return false;
        const link = this.link(url.searchParams.get('host') ?? undefined);
        if (!link) return fail(404, tr('outro computador desconhecido'));
        if (guard(feature, local)) return true;
        return run(h.readJson(req, ATTACHMENT_BODY).then((body) => link.request('POST', '/api/spawn/attachments', body)).then((r) => this.reply(res, h, r, link.config.id)));
      }
      if (seg.length === 4 && seg[3] && hostOf(seg[3]) && method === 'GET') {
        const link = target(seg[3]);
        if (!link) return fail(404, tr('outro computador desconhecido'));
        if (guard(feature, local)) return true;
        return run(link.request('GET', `/api/spawn/${encodeURIComponent(splitHost(seg[3]).id)}`).then((r) => this.reply(res, h, r, link.config.id)));
      }
      if (seg.length === 3 && method === 'POST') {
        return this.withBody(req, res, h, (body) => (typeof body.host === 'string' && body.host ? body.host : undefined), feature, local, async (link, body) => {
          const mode = body.mode;
          if (mode !== undefined && mode !== 'default' && !h.trusted(req, 'permissions')) {
            return h.sendJson(res, 403, { error: h.denied(req, tr('escolher o modo da sessão exige poder aprovar permissões por aqui')) });
          }
          const fwd = { ...body, host: undefined, attachments: stripAll(body.attachments, link.config.id) };
          this.reply(res, h, await link.request('POST', '/api/spawn', fwd), link.config.id);
        });
      }
      return false;
    }

    // ---- salas: renomear só no próprio computador
    if (path === '/api/rooms/rename' && method === 'POST') {
      return this.withBody(req, res, h, (body) => (typeof body.id === 'string' ? hostOf(body.id) : undefined), undefined, '', async () => {
        h.sendJson(res, 403, { error: tr('isso só dá para fazer no próprio computador do agente') });
      });
    }
    return false;
  }

  // ---------------------------------------------------------------- internos

  private link(host: string | undefined): PeerLink | undefined {
    return host ? this.links.find((l) => l.config.id === host) : undefined;
  }

  private changed(): void {
    this.rev++;
    this.changeCbs.forEach((cb) => cb());
  }

  private addFeed(host: string, items: FeedItem[]): void {
    const fresh = items.map((f) => ({
      ...f,
      id: withHost(host, f.id),
      agentId: withHost(host, f.agentId),
      roomId: withHost(host, f.roomId),
      account: f.account && withHost(host, f.account),
    }));
    this.feed = [...this.feed, ...fresh].slice(-FEED_KEEP);
    this.feedCbs.forEach((cb) => cb(fresh));
  }

  /** Resposta JSON de lá, com os ids que identificam algo de lá prefixados. */
  private reply(res: ServerResponse, h: PeerRouteHelpers, r: PeerResponse, host: string): void {
    const body = json(r);
    h.sendJson(res, r.status || 502, body === undefined ? { error: tr('resposta inválida do outro computador') } : prefixIds(body, host));
  }

  /**
   * POST cujo destino está no corpo: lê o JSON e decide. Daqui (sem computador) = a rota normal não tem mais o corpo,
   * então o corpo lido é devolvido a ela por `req.habblaudBody` (ver http/app.ts readJson).
   */
  private withBody(
    req: IncomingMessage,
    res: ServerResponse,
    h: PeerRouteHelpers,
    hostFrom: (body: Record<string, unknown>) => string | undefined,
    feature: RemoteFeature | undefined,
    localMessage: string,
    act: (link: PeerLink, body: Record<string, unknown>) => Promise<void>,
  ): boolean {
    // A decisão depende do corpo, mas a rota normal também precisa dele: lê uma vez e guarda na requisição.
    h.readJson(req)
      .then(async (raw) => {
        const body = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
        const host = hostFrom(body);
        if (!host) {
          (req as BodyCarrier).habblaudBody = raw;
          return void this.localNext?.(req, res);
        }
        const link = this.link(host);
        if (!link) return h.sendJson(res, 404, { error: tr('outro computador desconhecido') });
        if (feature && !h.enabled(feature)) return h.sendJson(res, 403, { error: tr('recurso desligado neste computador') });
        if (feature && !h.trusted(req, feature)) return h.sendJson(res, 403, { error: h.denied(req, localMessage) });
        await act(link, body);
      })
      .catch((err: Error & { status?: number }) => {
        if (res.headersSent) return void res.destroy();
        h.sendJson(res, err.status ?? 502, { error: err.message });
      });
    return true;
  }

  /** Quem trata a requisição daqui depois que o corpo já foi lido (http/app.ts liga isto ao próprio handler). */
  localNext: ((req: IncomingMessage, res: ServerResponse) => void) | undefined;

  /** Repassa um SSE de lá (terminal) para a página, até um dos lados fechar. */
  private async pipe(link: PeerLink, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const up = await link.open(path);
    if (up.statusCode !== 200) {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const c of up) {
        size += (c as Buffer).length;
        if (size > 64 * 1024) {
          up.destroy();
          break;
        }
        chunks.push(c as Buffer);
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = { error: tr('o outro computador respondeu {0}', [up.statusCode ?? 0]) };
      }
      res.writeHead(up.statusCode ?? 502, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(body));
      return;
    }
    req.socket.setTimeout(0);
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    up.pipe(res);
    const close = () => up.destroy();
    req.on('close', close);
    res.on('close', close);
  }
}

/** Requisição cujo corpo JSON já foi lido pelo PeerSet (a rota daqui o pega em vez de ler de novo). */
export interface BodyCarrier extends IncomingMessage {
  habblaudBody?: unknown;
}

function json(r: PeerResponse): unknown {
  try {
    return JSON.parse(r.body.toString('utf8'));
  } catch {
    return undefined;
  }
}

/** Ids de anexos/pedidos que a página recebeu prefixados: tira o prefixo (só os do mesmo computador). */
function stripAll(list: unknown, host: string): unknown {
  if (!Array.isArray(list)) return list;
  return list.filter((x) => typeof x === 'string' && hostOf(x) === host).map((x) => splitHost(x as string).id);
}

const ID_KEYS = new Set(['id', 'agentId', 'roomId', 'account', 'parentId', 'fromAgent']);

/** Prefixa os ids (id, agentId, roomId, account...) de uma resposta de lá, em qualquer profundidade. */
export function prefixIds(value: unknown, host: string): unknown {
  if (Array.isArray(value)) return value.map((v) => prefixIds(v, host));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) out[k] = ID_KEYS.has(k) && typeof v === 'string' && v ? withHost(host, v) : prefixIds(v, host);
  return out;
}

function prefixNotice(n: Notice, host: string): Notice {
  return { ...n, id: withHost(host, n.id), agentId: n.agentId && withHost(host, n.agentId), roomId: n.roomId && withHost(host, n.roomId) };
}
