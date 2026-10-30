// Imagem da galeria -> modelo 3D para impressão, pela API da Tripo (https://developers.tripo3d.ai, v3). Roda no
// auxiliar do host, só a pedido do painel. Aceita uma imagem (a frente) ou multi-view (frente + esquerda/costas/direita).
//
//   1. POST /v3/files (multipart) para cada imagem                                    -> file_token
//   2. POST /v3/generation/image-to-model {input}  ou  /multiview-to-model {inputs}   -> task_id (só a forma, sem textura)
//   3. GET  /v3/tasks/<id> até success                                                -> output.model_url (.glb)
//   4. POST /v3/models/convert {input: <task da geração>, format: "STL"}              -> task_id -> output.model_url (.stl)
//   5. Baixa logo (os links valem poucos minutos) para o lado da imagem: <nome>.glb, <nome>.stl e <nome>.3d.json.
//
// A Tripo não cobra trabalho que falha. A chave (HABBLAUD_TRIPO_KEY) é do usuário: do ambiente ou do .env, nunca de um pedido.
import { readFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { tr } from '../../shared/i18n';
import { VIEW_KEYS, type StudioGenerator } from './generate';
import { downloadModel, envKey, finishModel, modelSource } from './model3d';

/** Conta internacional (platform.tripo3d.ai); a da China continental usa openapi.tripo3d.com e recusa estas chaves. */
const API = 'https://openapi.tripo3d.ai/v3';
const MODEL = 'v3.1-20260211';
const POLL_MS = 5_000;
/** Geração de 1 a 5 min e conversão de ~1 min; o Estúdio dá 45 min ao pedido (studio.ts). */
const TASK_TIMEOUT_MS = 20 * 60_000;
const UPLOAD_MAX_BYTES = 20 * 1024 * 1024;
const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
const FAILED = ['failed', 'banned', 'expired', 'cancelled'];
const CONVERT_CREDITS = 5;

/** Preço (créditos da Tripo) de um modelo só com a forma, já com a conversão para STL. Visto na conta (out/2026): geração 20 e conversão 5; o multi-view sem textura custa o mesmo que uma imagem. */
export const TRIPO_CREDITS = { single: 20 + CONVERT_CREDITS, multi: 20 + CONVERT_CREDITS };

/** Saldo da conta na Tripo (GET /v3/account/balance), ou undefined se não deu para saber. */
export async function tripoBalance(key: string, doFetch: typeof fetch = fetch): Promise<number | undefined> {
  try {
    const res = await doFetch(`${API}/account/balance`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
    const j = (await res.json()) as { code?: number; data?: { balance?: unknown } };
    return res.ok && j.code === 0 && typeof j.data?.balance === 'number' ? j.data.balance : undefined;
  } catch {
    return undefined;
  }
}

/** A chave da Tripo: HABBLAUD_TRIPO_KEY. */
export const tripoKey = (env: NodeJS.ProcessEnv = process.env, envFile?: string) => envKey('HABBLAUD_TRIPO_KEY', env, envFile);

export interface TripoOptions {
  key: string;
  root: string;
  mirror?: string;
  now?: () => Date;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

type Json = Record<string, unknown>;

export function createTripoGenerator(opts: TripoOptions): StudioGenerator {
  const doFetch = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((ok) => setTimeout(ok, ms)));
  const auth = { Authorization: `Bearer ${opts.key}` };

  const call = async (method: 'GET' | 'POST', path: string, body?: Json | FormData): Promise<Json> => {
    const json = body && !(body instanceof FormData);
    const res = await doFetch(`${API}${path}`, {
      method,
      headers: json ? { ...auth, 'Content-Type': 'application/json' } : auth,
      ...(body ? { body: json ? JSON.stringify(body) : (body as FormData) } : {}),
    });
    const text = await res.text();
    let j: Json = {};
    try {
      j = JSON.parse(text) as Json;
    } catch {
      // resposta sem JSON: vale o status
    }
    const why = typeof j.message === 'string' ? j.message : text.slice(0, 200);
    if (res.status === 401) throw new Error(tr('a Tripo recusou a chave (HABBLAUD_TRIPO_KEY): {0}', [why]));
    if (j.code === 2010 || res.status === 402) throw new Error(tr('Tripo: créditos insuficientes'));
    if (!res.ok || (j.code !== undefined && j.code !== 0)) throw new Error(tr('a Tripo respondeu {0}: {1}', [j.code ?? res.status, why]));
    return j.data && typeof j.data === 'object' ? (j.data as Json) : {};
  };

  const upload = async (path: string): Promise<string> => {
    const data = readFileSync(path);
    if (data.length > UPLOAD_MAX_BYTES) throw new Error(tr('imagem grande demais para a Tripo (até 20 MB)'));
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(data)], { type: MIME[extname(path).toLowerCase()] ?? 'image/png' }), basename(path));
    const token = (await call('POST', '/files', form)).file_token;
    if (typeof token !== 'string' || !token) throw new Error(tr('a Tripo não devolveu o arquivo enviado'));
    return token;
  };

  /** Cria o trabalho e espera terminar: devolve o número dele e o endereço do modelo. */
  const task = async (path: string, body: Json): Promise<{ id: string; url: string }> => {
    const id = (await call('POST', path, body)).task_id;
    if (typeof id !== 'string' || !/^[\w-]{6,80}$/.test(id)) throw new Error(tr('a Tripo não devolveu o número do trabalho'));
    const deadline = Date.now() + TASK_TIMEOUT_MS;
    for (;;) {
      const t = await call('GET', `/tasks/${id}`);
      const status = String(t.status ?? '');
      if (status === 'success') {
        const out = t.output && typeof t.output === 'object' ? (t.output as Json) : {};
        const url = [out.model_url, out.pbr_model_url, out.base_model_url].find((u): u is string => typeof u === 'string' && u.startsWith('https://'));
        if (!url) throw new Error(tr('a Tripo terminou sem o arquivo do modelo'));
        return { id, url };
      }
      if (FAILED.includes(status)) {
        const why = typeof t.error_message === 'string' && t.error_message ? t.error_message : status;
        throw new Error(status === 'banned' ? tr('a Tripo recusou a imagem (política de conteúdo)') : tr('a Tripo falhou: {0}', [why]));
      }
      if (Date.now() > deadline) throw new Error(tr('a Tripo passou de {0} min sem terminar', [TASK_TIMEOUT_MS / 60_000]));
      await sleep(POLL_MS);
    }
  };

  return async (req) => {
    const { path: front, stem } = modelSource(opts.root, req.source);
    const views = VIEW_KEYS.flatMap((k) => (req.views?.[k] ? [[k, modelSource(opts.root, req.views[k]).path] as const] : []));
    // Só a forma (sem textura nem PBR): é o que vai para a impressora, e custa menos.
    const shape = { model: MODEL, texture: false, pbr: false };
    const gen = views.length
      ? await task('/generation/multiview-to-model', {
          ...shape,
          inputs: [{ front: await upload(front) }, ...(await Promise.all(views.map(async ([k, p]) => ({ [k]: await upload(p) }))))],
        })
      : await task('/generation/image-to-model', { ...shape, input: await upload(front) });
    await downloadModel(doFetch, gen.url, join(opts.root, `${stem}.glb`));
    const stl = await task('/models/convert', { input: gen.id, format: 'STL' });
    await downloadModel(doFetch, stl.url, join(opts.root, `${stem}.stl`));
    finishModel(opts, req.source!, stem, req.title, `tripo-${MODEL}`, views.length ? { views: Object.fromEntries(VIEW_KEYS.flatMap((k) => (req.views?.[k] ? [[k, req.views[k]]] : []))) } : {});
    return { file: req.source! };
  };
}
