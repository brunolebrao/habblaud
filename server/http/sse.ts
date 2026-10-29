// Transmissão em tempo real (Server-Sent Events) em GET /api/stream.
// Eventos nomeados: snapshot | feed | notice (o `data` é o JSON do protocolo em shared/types.ts).
// Snapshots saem com throttle (~200 ms); feed e avisos vão em lote logo depois do snapshot.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { FeedItem, Notice, OfficeSnapshot } from '../../shared/types';
import type { Office } from '../model/office';
import { isLoopbackHost } from './guard';

/** Cliente lento demais (buffer acumulado acima disto) é desconectado; o EventSource reconecta. */
const MAX_BUFFERED = 8 * 1024 * 1024;

/** Andares de outros computadores (server/peers/): entram só no que vai para a página. */
export interface HubPeers {
  merge(local: OfficeSnapshot): OfficeSnapshot;
  recentFeed(n: number): FeedItem[];
  onChange(cb: () => void): () => void;
  onFeed(cb: (items: FeedItem[]) => void): () => void;
  onNotice(cb: (n: Notice) => void): () => void;
}

export class Hub {
  private clients = new Set<ServerResponse>();
  /** Clientes que abriram a página por um Host local (os únicos que podem responder pedidos de permissão). */
  private local = new WeakSet<ServerResponse>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pinger: ReturnType<typeof setInterval> | null = null;
  private lastFlush = 0;
  private unsubscribe: (() => void) | null = null;
  private snapshotCbs = new Set<(snap: OfficeSnapshot) => void>();
  private noticeCbs = new Set<(n: Notice) => void>();
  private readonly throttleMs: number;
  private readonly pingMs: number;
  /** Quem pode responder pelo escritório; padrão: Host local. A porta remota (http/remote.ts) troca a regra. */
  private readonly canAnswer: (req: IncomingMessage) => boolean;
  private readonly peers: HubPeers | undefined;
  /** Os andares de lá mudaram desde a última transmissão. */
  private peersDirty = false;
  private peerUnsubs: Array<() => void> = [];

  constructor(
    private readonly office: Office,
    opts: { throttleMs?: number; pingMs?: number; canAnswer?: (req: IncomingMessage) => boolean; peers?: HubPeers } = {},
  ) {
    this.throttleMs = opts.throttleMs ?? 200;
    this.pingMs = opts.pingMs ?? 15_000;
    this.canAnswer = opts.canAnswer ?? ((req) => isLoopbackHost(req.headers.host));
    this.peers = opts.peers;
  }

  start(): void {
    this.unsubscribe = this.office.onChange(() => this.schedule());
    if (this.peers) {
      this.peerUnsubs = [
        this.peers.onChange(() => {
          this.peersDirty = true;
          this.schedule();
        }),
        this.peers.onFeed((items) => this.writeAll(frame('feed', items))),
        this.peers.onNotice((n) => this.writeAll(frame('notice', n))),
      ];
    }
    this.pinger = setInterval(() => this.writeAll(': ping\n\n'), this.pingMs);
    this.pinger.unref?.();
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    for (const u of this.peerUnsubs) u();
    this.peerUnsubs = [];
    if (this.timer) clearTimeout(this.timer);
    if (this.pinger) clearInterval(this.pinger);
    this.timer = null;
    this.pinger = null;
    for (const c of this.clients) c.end();
    this.clients.clear();
  }

  get size(): number {
    return this.clients.size;
  }

  /** Avisado a cada snapshot novo transmitido (ex.: o gravador da linha do tempo). */
  /** Avisos do escritório (os mesmos que vão às páginas): para os avisos no celular (server/push). */
  onNotice(cb: (n: Notice) => void): () => void {
    this.noticeCbs.add(cb);
    return () => void this.noticeCbs.delete(cb);
  }

  onSnapshot(cb: (snap: OfficeSnapshot) => void): () => void {
    this.snapshotCbs.add(cb);
    return () => void this.snapshotCbs.delete(cb);
  }

  /** Páginas conectadas por um Host local (localhost/127.x): quem pode responder pelo escritório. */
  get localSize(): number {
    let n = 0;
    for (const c of this.clients) if (this.local.has(c) && !c.destroyed && !c.writableEnded) n++;
    return n;
  }

  /** Conecta um cliente: snapshot completo + últimos 50 itens do feed, depois o fluxo ao vivo. */
  attach(req: IncomingMessage, res: ServerResponse): void {
    req.socket.setTimeout(0);
    req.socket.setNoDelay(true);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const snapshot = this.merged();
    res.write('retry: 2000\n\n');
    res.write(frame('snapshot', snapshot));
    const feed = this.office.recentFeed(50);
    res.write(frame('feed', this.peers ? [...feed, ...this.peers.recentFeed(50)] : feed));
    this.clients.add(res);
    if (this.canAnswer(req)) this.local.add(res);
    const drop = () => this.clients.delete(res);
    req.on('close', drop);
    res.on('close', drop);
    res.on('error', drop);
  }

  /** Fecha a revisão agora e transmite o que houver. Devolve o snapshot atual. */
  flush(): OfficeSnapshot {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.lastFlush = Date.now();
    const r = this.office.commit();
    const peersChanged = this.peersDirty;
    this.peersDirty = false;
    if (r.changed || peersChanged) this.writeAll(frame('snapshot', this.peers ? this.peers.merge(r.snapshot) : r.snapshot));
    if (r.changed) {
      for (const cb of this.snapshotCbs) {
        try {
          cb(r.snapshot);
        } catch {
          // quem escuta não atrapalha a transmissão
        }
      }
    }
    if (r.feed.length) this.writeAll(frame('feed', r.feed));
    for (const n of r.notices) {
      this.writeAll(frame('notice', n));
      for (const cb of this.noticeCbs) {
        try {
          cb(n);
        } catch {
          // quem escuta não atrapalha a transmissão
        }
      }
    }
    return r.snapshot;
  }

  /** O que a página recebe: o escritório daqui com os andares de outros computadores (sem eles, igual a current()). */
  merged(): OfficeSnapshot {
    const local = this.current();
    return this.peers ? this.peers.merge(local) : local;
  }

  /**
   * Snapshot atual DESTE computador (depois de transmitir o que estiver pendente), com `serverTime` de agora. Os andares
   * de outros computadores não entram: estatísticas, mod e Habblaud World leem só daqui.
   */
  current(): OfficeSnapshot {
    return { ...this.flush(), serverTime: Date.now() };
  }

  private schedule(): void {
    if (this.timer) return;
    const wait = Math.max(0, this.lastFlush + this.throttleMs - Date.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush();
    }, wait);
    this.timer.unref?.();
  }

  private writeAll(chunk: string): void {
    for (const c of this.clients) {
      if (c.destroyed || c.writableEnded) {
        this.clients.delete(c);
        continue;
      }
      if (c.writableLength > MAX_BUFFERED) {
        this.clients.delete(c);
        c.destroy();
        continue;
      }
      c.write(chunk);
    }
  }
}

export function frame(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}
