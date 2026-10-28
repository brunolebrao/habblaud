// Estúdio pelo escritório (opcional, HABBLAUD_STUDIO=1): pedidos de imagem (POST /api/studio {project, prompt}), o
// andamento (GET /api/studio/jobs/:id) e a galeria de <raiz>/<projeto>/<data>/ (GET /api/studio e /api/studio/file/…).
// Quem gera é o Codex (studio/generate.ts):
// - modo Node: o próprio servidor, se achou o codex;
// - Docker: o auxiliar do host (scripts/codex-bridge.ts) busca em POST /api/host/studio/poll e devolve o resultado em
//   POST /api/host/studio/ack. A galeria vem da raiz montada somente leitura no container (/estudio).
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { extname, join, sep } from 'node:path';
import { tr } from '../../shared/i18n';
import { HostWait, pollWithWait } from '../host-wait';
import { parseStudioRequest, type StudioGenerator, type StudioRequest } from './generate';

export const HOST_PRESENCE_MS = 10_000;
const QUEUED_TIMEOUT_MS = 60_000;
/** O Codex leva de 1 a 3 min; o prazo dele é de 10 (generate.ts). */
const SENT_TIMEOUT_MS = 11 * 60_000;
const KEEP_MS = 30 * 60_000;
const MAX_OPEN = 3;
const ERROR_MAX = 300;
const GALLERY_MAX = 300;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const FILE_MAX_BYTES = 25 * 1024 * 1024;
const REL_RE = /^[a-z0-9][a-z0-9-]{0,39}\/\d{4}-\d{2}-\d{2}\/[\w.-]{1,120}$/;

export type StudioJobStatus = 'queued' | 'sent' | 'done' | 'failed';

export interface StudioJob {
  id: string;
  project: string;
  prompt: string;
  status: StudioJobStatus;
  at: number;
  file?: string;
  error?: string;
}

export interface StudioItem {
  /** "<projeto>/<data>/<nome>.png" (relativo à raiz). */
  file: string;
  project: string;
  date: string;
  prompt?: string;
  model?: string;
  createdAt?: string;
  at: number;
}

export interface StudioServiceOptions {
  root: string;
  /** Modo Node com o Codex: gera aqui. Ausente: fila para o auxiliar do host. */
  generator?: StudioGenerator;
  now?: () => number;
  newId?: () => string;
}

export type StudioSubmit = { job: StudioJob } | { error: 'invalid' | 'unavailable' | 'too-many'; reason: string };

interface Entry {
  job: StudioJob;
  req: StudioRequest;
  touched: number;
}

function readMeta(path: string): Record<string, unknown> {
  try {
    const v = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown, max = 4_000): string | undefined => (typeof v === 'string' && v ? v.slice(0, max) : undefined);

/** Imagens da raiz, da mais nova para a mais antiga (até GALLERY_MAX). */
export function listGallery(root: string): StudioItem[] {
  const out: StudioItem[] = [];
  const dirs = (p: string) => {
    try {
      return readdirSync(p, { withFileTypes: true }).filter((d) => d.isDirectory() && !d.name.startsWith('.')).map((d) => d.name);
    } catch {
      return [];
    }
  };
  for (const project of dirs(root)) {
    for (const date of dirs(join(root, project))) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
      const dir = join(root, project, date);
      let names: string[];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const ext = extname(name).toLowerCase();
        if (!IMAGE_TYPES[ext]) continue;
        let at = 0;
        try {
          at = statSync(join(dir, name)).mtimeMs;
        } catch {
          continue;
        }
        const meta = readMeta(join(dir, `${name.slice(0, -ext.length)}.json`));
        out.push({ file: `${project}/${date}/${name}`, project, date, prompt: str(meta.prompt), model: str(meta.model, 60), createdAt: str(meta.createdAt, 40), at });
      }
    }
  }
  return out.sort((a, b) => b.at - a.at).slice(0, GALLERY_MAX);
}

/** Lê uma imagem da galeria; só "<projeto>/<data>/<nome>.<png|jpg|webp>" dentro da raiz (links resolvidos). */
export function readGalleryFile(root: string, rel: string): { data: Buffer; type: string; name: string } | { status: number; error: string } {
  const type = IMAGE_TYPES[extname(rel).toLowerCase()];
  if (!REL_RE.test(rel) || rel.includes('..') || !type) return { status: 400, error: tr('arquivo inválido') };
  try {
    const realRoot = realpathSync(root);
    const real = realpathSync(join(root, rel));
    if (!real.startsWith(realRoot + sep)) return { status: 403, error: tr('fora do Estúdio') };
    const st = statSync(real);
    if (!st.isFile() || st.size > FILE_MAX_BYTES) return { status: 404, error: tr('arquivo não encontrado') };
    return { data: readFileSync(real), type, name: rel.split('/').pop()! };
  } catch {
    return { status: 404, error: tr('arquivo não encontrado') };
  }
}

export class StudioService {
  private readonly entries = new Map<string, Entry>();
  private readonly host: HostWait;
  private readonly now: () => number;

  constructor(private readonly opts: StudioServiceOptions) {
    this.now = opts.now ?? Date.now;
    this.host = new HostWait(HOST_PRESENCE_MS, this.now);
  }

  available(): boolean {
    return !!this.opts.generator || this.host.present();
  }

  gallery(): StudioItem[] {
    return listGallery(this.opts.root);
  }

  file(rel: string): ReturnType<typeof readGalleryFile> {
    return readGalleryFile(this.opts.root, rel);
  }

  jobs(): StudioJob[] {
    this.prune();
    return [...this.entries.values()].map((e) => ({ ...e.job })).sort((a, b) => b.at - a.at);
  }

  submit(raw: unknown): StudioSubmit {
    this.prune();
    const req = parseStudioRequest(raw);
    if ('error' in req) return { error: 'invalid', reason: req.error };
    if (!this.available()) return { error: 'unavailable', reason: tr('Estúdio indisponível: o Codex não está instalado no computador ou o auxiliar (npm run codex:bridge) parou') };
    let open = 0;
    for (const e of this.entries.values()) if (e.job.status === 'queued' || e.job.status === 'sent') open++;
    if (open >= MAX_OPEN) return { error: 'too-many', reason: tr('imagens demais sendo geradas: aguarde uma terminar') };
    const job: StudioJob = { id: this.opts.newId?.() ?? randomUUID(), project: req.project, prompt: req.prompt, status: 'queued', at: this.now() };
    const entry: Entry = { job, req, touched: this.now() };
    this.entries.set(job.id, entry);
    if (this.opts.generator) void this.generateHere(entry, this.opts.generator);
    else this.host.wake();
    return { job: { ...job } };
  }

  get(id: string): StudioJob | undefined {
    this.prune();
    const e = this.entries.get(id);
    return e && { ...e.job };
  }

  /** Rodada do auxiliar: marca presença e entrega os pedidos da fila. */
  poll(): Array<{ id: string; project: string; prompt: string }> {
    this.host.seen();
    this.prune();
    const out: Array<{ id: string; project: string; prompt: string }> = [];
    for (const e of this.entries.values()) {
      if (e.job.status !== 'queued') continue;
      e.job.status = 'sent';
      e.touched = this.now();
      out.push({ id: e.job.id, project: e.req.project, prompt: e.req.prompt });
    }
    return out;
  }

  pollWait(ms: number, signal?: AbortSignal): Promise<Array<{ id: string; project: string; prompt: string }>> {
    return pollWithWait(this.host, () => this.poll(), ms, signal);
  }

  ack(raw: unknown): void {
    this.host.seen();
    const list = raw && typeof raw === 'object' && Array.isArray((raw as { results?: unknown }).results) ? (raw as { results: unknown[] }).results : [];
    for (const r of list) {
      const x = r && typeof r === 'object' ? (r as Record<string, unknown>) : {};
      const e = typeof x.id === 'string' ? this.entries.get(x.id) : undefined;
      if (!e || e.job.status !== 'sent') continue;
      if (x.ok === true && typeof x.file === 'string' && REL_RE.test(x.file)) this.finish(e, x.file);
      else this.fail(e, typeof x.error === 'string' && x.error ? x.error : tr('o auxiliar não gerou a imagem'));
    }
  }

  private async generateHere(e: Entry, generate: StudioGenerator): Promise<void> {
    e.job.status = 'sent';
    e.touched = this.now();
    try {
      this.finish(e, (await generate(e.req)).file);
    } catch (err) {
      this.fail(e, (err as Error).message || tr('o Codex falhou'));
    }
  }

  private finish(e: Entry, file: string): void {
    e.job.status = 'done';
    e.job.file = file;
    e.touched = this.now();
  }

  private fail(e: Entry, error: string): void {
    e.job.status = 'failed';
    e.job.error = error.slice(0, ERROR_MAX);
    e.touched = this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [id, e] of this.entries) {
      const age = now - e.touched;
      if (e.job.status === 'queued' && age > QUEUED_TIMEOUT_MS) this.fail(e, tr('o auxiliar do computador não buscou o pedido'));
      else if (e.job.status === 'sent' && age > SENT_TIMEOUT_MS) this.fail(e, tr('a geração demorou demais'));
      else if ((e.job.status === 'done' || e.job.status === 'failed') && age > KEEP_MS) this.entries.delete(id);
    }
  }
}
