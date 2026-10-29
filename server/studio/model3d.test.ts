import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createModel3dGenerator, model3dKey } from './model3d';
import { listGallery, readGalleryFile, StudioService } from './studio';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'hb-3d-'));
  mkdirSync(join(root, 'p/2026-10-29'), { recursive: true });
  writeFileSync(join(root, 'p/2026-10-29/a.png'), PNG);
  return root;
}

/** API falsa: gera (1 consulta em andamento), converte e serve os arquivos. */
function fakeApi(opts: { status?: number } = {}) {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown>; auth?: string }> = [];
  let polls = 0;
  const fake = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    if (opts.status) return json({ detail: 'sem créditos' }, opts.status);
    if (url.endsWith('/tencent/generate/pro/')) return json({ task_id: 'gen-123456' });
    if (url.endsWith('/tools/convert/')) return json({ task_id: 'conv-123456' });
    if (url.includes('/gen-123456/status/')) return json(polls++ ? { status: 'FINISHED', results: [{ asset: 'https://cdn.example/m.glb', asset_type: '3D_MODEL' }] } : { status: 'IN_PROGRESS', progress: 40 });
    if (url.includes('/conv-123456/status/')) return json({ status: 'FINISHED', results: [{ asset: 'https://cdn.example/m.stl' }] });
    if (url === 'https://cdn.example/m.glb') return new Response('GLB');
    if (url === 'https://cdn.example/m.stl') return new Response('STL');
    return json({}, 404);
  }) as typeof fetch;
  return { fake, calls };
}

describe('modelo 3D pelo 3D AI Studio', () => {
  it('manda a imagem em base64, espera, converte para STL e grava ao lado da imagem', async () => {
    const root = setup();
    const mirror = join(setup(), 'drive');
    const { fake, calls } = fakeApi();
    const gen = createModel3dGenerator({ key: 'k-test', root, mirror, fetch: fake, sleep: async () => {} });
    const out = await gen({ project: 'p', title: 'A (3D)', prompt: '', source: 'p/2026-10-29/a.png', kind: 'model3d' });
    expect(out.file).toBe('p/2026-10-29/a.png');
    expect(calls[0]!.body).toMatchObject({ model: '3.1', image: `data:image/png;base64,${PNG.toString('base64')}` });
    expect(calls[0]!.auth).toBe('Bearer k-test');
    expect(calls.find((c) => c.url.endsWith('/tools/convert/'))!.body).toEqual({ model_url: 'https://cdn.example/m.glb', output_format: 'stl' });
    expect(readFileSync(join(root, 'p/2026-10-29/a.stl'), 'utf8')).toBe('STL');
    expect(readFileSync(join(mirror, 'p/2026-10-29/a.glb'), 'utf8')).toBe('GLB');
    expect(listGallery(root, 'p')[0]!.models).toEqual(['p/2026-10-29/a.glb', 'p/2026-10-29/a.stl']);
    expect(readGalleryFile(root, 'p/2026-10-29/a.stl')).toMatchObject({ type: 'model/stl' });
  });

  it('sem créditos: a mensagem diz isso', async () => {
    const { fake } = fakeApi({ status: 402 });
    const gen = createModel3dGenerator({ key: 'k', root: setup(), fetch: fake, sleep: async () => {} });
    await expect(gen({ project: 'p', title: 't', prompt: '', source: 'p/2026-10-29/a.png', kind: 'model3d' })).rejects.toThrow(/créditos/);
  });

  it('a chave vem do ambiente ou da linha do .env', () => {
    const dir = setup();
    writeFileSync(join(dir, '.env'), 'OUTRA=1\nHABBLAUD_3DAI_KEY="abc"\n');
    expect(model3dKey({}, join(dir, '.env'))).toBe('abc');
    expect(model3dKey({ HABBLAUD_3DAI_KEY: 'env' }, join(dir, '.env'))).toBe('env');
    expect(model3dKey({}, join(dir, 'nada'))).toBeUndefined();
  });

  it('agente não pede modelo 3D (gasta créditos): só o painel', () => {
    const studio = new StudioService({ root: setup() });
    expect(studio.submit({ project: 'p', kind: 'model3d', source: 'p/2026-10-29/a.png', session: 'sessao-123' })).toMatchObject({ error: 'invalid' });
    expect(studio.submit({ project: 'p', kind: 'model3d', prompt: 'x' }, { direct: true })).toMatchObject({ error: 'invalid' });
  });
});
