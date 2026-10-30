// Imagem da galeria -> modelo 3D para impressão, pela API do 3D AI Studio (https://www.3daistudio.com/Platform/API).
// Roda no auxiliar do host (a pasta do Estúdio é somente leitura no Docker), só a pedido do painel.
//
//   1. POST /v1/3d-models/tencent/generate/pro/ {model: "3.1", image: data URI}   -> task_id (Hunyuan 3.1 Pro, 60 créditos)
//   2. GET  /v1/generation-request/<id>/status/ até FINISHED                        -> results[].asset (.glb)
//   3. POST /v1/tools/convert/ {model_url: <glb>, output_format: "stl"}            -> task_id (10 créditos)
//   4. Baixa o .glb e o .stl para o lado da imagem: <nome>.glb, <nome>.stl e <nome>.3d.json.
//
// A chave (HABBLAUD_3DAI_KEY) é do usuário: vem do ambiente ou do .env do Habblaud, nunca de um pedido. Com a chave da
// Tripo (tripo.ts), é ela quem gera; daqui também saem as partes comuns (chave, download, metadados).
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { isImageFile, mirrorFiles, type StudioGenerator } from './generate';
import { tr } from '../../shared/i18n';

const API = 'https://api.3daistudio.com';
const POLL_MS = 10_000;
/** Geração de 1 a 5 min e conversão de ~1 min; o Estúdio dá 30 min ao pedido (studio.ts). */
const TASK_TIMEOUT_MS = 20 * 60_000;
const DOWNLOAD_MAX_BYTES = 300 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

/** Preço aproximado (créditos) de imagem -> STL: Hunyuan 3.1 Pro (60) + conversão (10). */
export const MODEL3D_CREDITS = 70;

/** Chave de API do usuário: a variável do ambiente ou a linha dela no .env (sem expandir nada). */
export function envKey(name: string, env: NodeJS.ProcessEnv = process.env, envFile = join(process.cwd(), '.env')): string | undefined {
  const direct = env[name]?.trim();
  if (direct) return direct;
  try {
    const line = readFileSync(envFile, 'utf8')
      .split('\n')
      .find((l) => new RegExp(`^\\s*${name}\\s*=`).test(l));
    const v = line?.slice(line.indexOf('=') + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
    return v || undefined;
  } catch {
    return undefined;
  }
}

/** A chave do 3D AI Studio: HABBLAUD_3DAI_KEY. */
export const model3dKey = (env: NodeJS.ProcessEnv = process.env, envFile?: string) => envKey('HABBLAUD_3DAI_KEY', env, envFile);

/** Baixa um modelo pronto (https, até 300 MB) e grava com troca atômica. */
export async function downloadModel(doFetch: typeof fetch, url: string, target: string): Promise<void> {
  if (!url.startsWith('https://')) throw new Error(tr('endereço do modelo inválido'));
  const res = await doFetch(url);
  if (!res.ok) throw new Error(tr('não deu para baixar o modelo ({0})', [res.status]));
  const data = Buffer.from(await res.arrayBuffer());
  if (!data.length || data.length > DOWNLOAD_MAX_BYTES) throw new Error(tr('modelo vazio ou grande demais'));
  const tmp = `${target}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { flag: 'wx' });
  renameSync(tmp, target);
}

/** Grava <nome>.3d.json e copia os arquivos para o espelho (Google Drive). */
export function finishModel(opts: { root: string; mirror?: string; now?: () => Date }, source: string, stem: string, title: string, model: string, extra: Record<string, unknown> = {}): void {
  const files = [`${stem}.glb`, `${stem}.stl`];
  const meta = { source, title, model, ...extra, createdAt: (opts.now?.() ?? new Date()).toISOString(), files };
  writeFileSync(join(opts.root, `${stem}.3d.json`), `${JSON.stringify(meta, null, 2)}\n`);
  if (opts.mirror) mirrorFiles(opts.root, opts.mirror, [...files, `${stem}.3d.json`]);
}

/** A imagem da galeria que vira modelo: caminho absoluto e o nome sem extensão. */
export function modelSource(root: string, rel: string | undefined): { path: string; stem: string } {
  if (!rel) throw new Error(tr('escolha a imagem da galeria'));
  const path = join(root, rel);
  if (!existsSync(path) || !isImageFile(path)) throw new Error(tr('a imagem base não está mais na galeria'));
  return { path, stem: rel.slice(0, -extname(path).length) };
}

export interface Model3dOptions {
  key: string;
  root: string;
  mirror?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;

export function createModel3dGenerator(opts: Model3dOptions): StudioGenerator {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const headers = { Authorization: `Bearer ${opts.key}`, 'Content-Type': 'application/json' };

  const call = async (method: 'GET' | 'POST', path: string, body?: Json): Promise<Json> => {
    const res = await doFetch(`${API}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await res.text();
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // resposta sem JSON: vale o status
    }
    if (!res.ok) {
      const why = typeof json.detail === 'string' ? json.detail : typeof json.error === 'string' ? json.error : text.slice(0, 200);
      if (res.status === 401 || res.status === 403) throw new Error(tr('3D AI Studio recusou a chave (HABBLAUD_3DAI_KEY): {0}', [why]));
      if (res.status === 402) throw new Error(tr('3D AI Studio: créditos insuficientes'));
      throw new Error(tr('3D AI Studio respondeu {0}: {1}', [res.status, why]));
    }
    return json;
  };

  const task = async (path: string, body: Json): Promise<string> => {
    const started = await call('POST', path, body);
    const id = typeof started.task_id === 'string' ? started.task_id : '';
    if (!/^[\w-]{6,80}$/.test(id)) throw new Error(tr('3D AI Studio não devolveu o número do trabalho'));
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    for (;;) {
      const s = await call('GET', `/v1/generation-request/${id}/status/`);
      const status = String(s.status ?? '').toUpperCase();
      if (status === 'FINISHED') {
        const results = Array.isArray(s.results) ? (s.results as Json[]) : [];
        const asset = results.map((r) => r?.asset).find((a): a is string => typeof a === 'string' && a.startsWith('https://'));
        if (!asset) throw new Error(tr('3D AI Studio terminou sem o arquivo do modelo'));
        return asset;
      }
      if (status === 'FAILED' || status === 'ERROR' || status === 'CANCELLED' || (typeof s.failure_reason === 'string' && s.failure_reason)) {
        throw new Error(tr('3D AI Studio falhou: {0}', [String(s.failure_reason || status)]));
      }
      if (Date.now() > deadline) throw new Error(tr('3D AI Studio passou de {0} min sem terminar', [TASK_TIMEOUT_MS / 60_000]));
      await sleep(POLL_MS);
    }
  };

  return async (req) => {
    if (req.views && Object.keys(req.views).length) throw new Error(tr('multi-view só pela Tripo: ponha HABBLAUD_TRIPO_KEY no .env do Habblaud e reinicie o auxiliar'));
    const { path: image, stem } = modelSource(opts.root, req.source);
    const ext = extname(image).toLowerCase();
    const dataUri = `data:${MIME[ext] ?? 'image/png'};base64,${readFileSync(image).toString('base64')}`;
    const glbUrl = await task('/v1/3d-models/tencent/generate/pro/', { model: '3.1', image: dataUri, enable_pbr: false });
    await downloadModel(doFetch, glbUrl, join(opts.root, `${stem}.glb`));
    const stlUrl = await task('/v1/tools/convert/', { model_url: glbUrl, output_format: 'stl' });
    await downloadModel(doFetch, stlUrl, join(opts.root, `${stem}.stl`));
    finishModel(opts, req.source!, stem, req.title, 'hunyuan-3.1-pro');
    return { file: req.source! };
  };
}
