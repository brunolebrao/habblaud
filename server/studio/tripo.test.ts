import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseStudioRequest } from './generate';
import { listGallery, parseModel3dInfo, StudioService } from './studio';
import { createTripoGenerator, tripoKey } from './tripo';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'hb-tripo-'));
  mkdirSync(join(root, 'p/2026-10-29'), { recursive: true });
  for (const n of ['a', 'b', 'c']) writeFileSync(join(root, `p/2026-10-29/${n}.png`), PNG);
  return root;
}

/** API falsa da Tripo (v3): envio de arquivo, geração (1 consulta em andamento), conversão e os arquivos. */
function fakeApi(opts: { code?: number; status?: number; fail?: string } = {}) {
  const calls: Array<{ method: string; url: string; body?: Record<string, unknown>; form?: FormData; auth?: string }> = [];
  let uploads = 0;
  let polls = 0;
  const fake = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    const form = init?.body instanceof FormData ? init.body : undefined;
    const body = init?.body && !form ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method: init?.method ?? 'GET', url, body, form, auth: (init?.headers as Record<string, string> | undefined)?.Authorization });
    const json = (v: unknown, status = 200) => new Response(JSON.stringify(v), { status });
    const ok = (data: unknown) => json({ code: 0, data });
    if (opts.code) return json({ code: opts.code, status: 'error', message: 'sem créditos' }, opts.status ?? 403);
    if (url.endsWith('/v3/files')) return ok({ file_token: `file_${++uploads}` });
    if (url.endsWith('/generation/image-to-model') || url.endsWith('/generation/multiview-to-model')) return ok({ task_id: 'task_gen123' });
    if (url.endsWith('/models/convert')) return ok({ task_id: 'task_conv123' });
    if (url.endsWith('/tasks/task_gen123')) {
      if (opts.fail) return ok({ task_id: 'task_gen123', status: opts.fail, error_message: 'quebrou' });
      return ok(polls++ ? { status: 'success', progress: 100, output: { model_url: 'https://cdn.example/m.glb' } } : { status: 'running', progress: 40 });
    }
    if (url.endsWith('/tasks/task_conv123')) return ok({ status: 'success', output: { model_url: 'https://cdn.example/m.stl' } });
    if (url === 'https://cdn.example/m.glb') return new Response('GLB');
    if (url === 'https://cdn.example/m.stl') return new Response('STL');
    return json({}, 404);
  }) as typeof fetch;
  return { fake, calls };
}

const req = { project: 'p', title: 'A (3D)', prompt: '', source: 'p/2026-10-29/a.png', kind: 'model3d' as const };

describe('modelo 3D pela Tripo', () => {
  it('uma imagem: envia o arquivo, gera só a forma, converte para STL e grava ao lado da imagem', async () => {
    const root = setup();
    const mirror = join(setup(), 'drive');
    const { fake, calls } = fakeApi();
    const out = await createTripoGenerator({ key: 'k-test', root, mirror, fetch: fake, sleep: async () => {} })(req);
    expect(out.file).toBe('p/2026-10-29/a.png');
    expect(calls[0]!.url).toBe('https://openapi.tripo3d.ai/v3/files');
    expect(calls[0]!.auth).toBe('Bearer k-test');
    expect((calls[0]!.form!.get('file') as File).name).toBe('a.png');
    expect(calls.find((c) => c.url.endsWith('/image-to-model'))!.body).toEqual({ model: 'v3.1-20260211', texture: false, pbr: false, input: 'file_1' });
    expect(calls.find((c) => c.url.endsWith('/models/convert'))!.body).toEqual({ input: 'task_gen123', format: 'STL' });
    expect(readFileSync(join(root, 'p/2026-10-29/a.stl'), 'utf8')).toBe('STL');
    expect(readFileSync(join(mirror, 'p/2026-10-29/a.glb'), 'utf8')).toBe('GLB');
    expect(JSON.parse(readFileSync(join(root, 'p/2026-10-29/a.3d.json'), 'utf8'))).toMatchObject({ model: 'tripo-v3.1-20260211', files: ['p/2026-10-29/a.glb', 'p/2026-10-29/a.stl'] });
    expect(listGallery(root, 'p').find((i) => i.file === 'p/2026-10-29/a.png')!.models).toEqual(['p/2026-10-29/a.glb', 'p/2026-10-29/a.stl']);
  });

  it('multi-view: a imagem do cartão é a frente e as outras vão com a vista delas', async () => {
    const root = setup();
    const { fake, calls } = fakeApi();
    await createTripoGenerator({ key: 'k', root, fetch: fake, sleep: async () => {} })({ ...req, views: { back: 'p/2026-10-29/b.png', left: 'p/2026-10-29/c.png' } });
    expect(calls.filter((c) => c.url.endsWith('/v3/files'))).toHaveLength(3);
    const body = calls.find((c) => c.url.endsWith('/multiview-to-model'))!.body!;
    expect(body.inputs).toEqual([{ front: 'file_1' }, { left: expect.stringMatching(/^file_/) }, { back: expect.stringMatching(/^file_/) }]);
    expect(JSON.parse(readFileSync(join(root, 'p/2026-10-29/a.3d.json'), 'utf8')).views).toEqual({ left: 'p/2026-10-29/c.png', back: 'p/2026-10-29/b.png' });
  });

  it('sem créditos e trabalho que falhou: a mensagem diz isso', async () => {
    const gen = (o: Parameters<typeof fakeApi>[0]) => createTripoGenerator({ key: 'k', root: setup(), fetch: fakeApi(o).fake, sleep: async () => {} })(req);
    await expect(gen({ code: 2010 })).rejects.toThrow(/créditos/);
    await expect(gen({ code: 1002, status: 401 })).rejects.toThrow(/HABBLAUD_TRIPO_KEY/);
    await expect(gen({ fail: 'failed' })).rejects.toThrow(/quebrou/);
    await expect(gen({ fail: 'banned' })).rejects.toThrow(/política/);
  });

  it('a chave vem do ambiente ou da linha do .env', () => {
    const dir = setup();
    writeFileSync(join(dir, '.env'), 'HABBLAUD_3DAI_KEY=x\nHABBLAUD_TRIPO_KEY=tsk_abc\n');
    expect(tripoKey({}, join(dir, '.env'))).toBe('tsk_abc');
    expect(tripoKey({ HABBLAUD_TRIPO_KEY: 'env' }, join(dir, '.env'))).toBe('env');
  });
});

describe('vistas do multi-view no pedido', () => {
  it('só no modelo 3D, só imagens da galeria do projeto, diferentes da frente', () => {
    expect(parseStudioRequest({ ...req, views: { left: 'p/2026-10-29/b.png', right: '' } })).toMatchObject({ views: { left: 'p/2026-10-29/b.png' } });
    expect(parseStudioRequest({ project: 'p', prompt: 'x', views: { left: 'p/2026-10-29/b.png' } })).toHaveProperty('error');
    expect(parseStudioRequest({ ...req, views: { top: 'p/2026-10-29/b.png' } })).toHaveProperty('error');
    expect(parseStudioRequest({ ...req, views: { left: 'q/2026-10-29/b.png' } })).toHaveProperty('error');
    expect(parseStudioRequest({ ...req, views: { left: req.source } })).toHaveProperty('error');
    expect(parseStudioRequest({ ...req, views: { left: '../etc/2026-10-29/b.png' } })).toHaveProperty('error');
  });

  it('o Estúdio guarda as vistas e manda ao auxiliar; vista que sumiu é recusada', () => {
    const studio = new StudioService({ root: setup() });
    studio.poll(); // o auxiliar está por perto
    const r = studio.submit({ ...req, views: { back: 'p/2026-10-29/b.png' } }, { direct: true });
    expect(r).toHaveProperty('job');
    expect(studio.poll()[0]).toMatchObject({ kind: 'model3d', views: { back: 'p/2026-10-29/b.png' } });
    const other = new StudioService({ root: setup() });
    other.poll();
    expect(other.submit({ ...req, views: { back: 'p/2026-10-29/zz.png' } }, { direct: true })).toMatchObject({ error: 'invalid' });
  });
});

describe('vistas geradas com o prompt pronto', () => {
  it('pedido com `view` usa o prompt pronto da vista e exige a imagem da frente', () => {
    const r = parseStudioRequest({ project: 'p', title: 'A · Costas', source: 'p/2026-10-29/a.png', view: 'back' });
    expect(r).toMatchObject({ view: 'back', source: 'p/2026-10-29/a.png' });
    expect((r as { prompt: string }).prompt).toMatch(/COSTAS/);
    expect(parseStudioRequest({ project: 'p', title: 't', view: 'back' })).toHaveProperty('error');
    expect(parseStudioRequest({ project: 'p', title: 't', source: 'p/2026-10-29/a.png', view: 'top' })).toHaveProperty('error');
    expect(parseStudioRequest({ ...req, view: 'back' })).toHaveProperty('error');
  });

  it('a galeria diz de qual imagem a vista é; o Estúdio manda a vista ao auxiliar', () => {
    const root = setup();
    writeFileSync(join(root, 'p/2026-10-29/b.json'), JSON.stringify({ title: 'A · Costas', viewOf: 'p/2026-10-29/a.png', view: 'back' }));
    writeFileSync(join(root, 'p/2026-10-29/c.json'), JSON.stringify({ viewOf: 'p/2026-10-29/a.png', view: 'cima' }));
    const items = listGallery(root, 'p');
    expect(items.find((i) => i.file.endsWith('b.png'))).toMatchObject({ viewOf: 'p/2026-10-29/a.png', view: 'back' });
    expect(items.find((i) => i.file.endsWith('c.png'))).not.toHaveProperty('view');
    const studio = new StudioService({ root });
    studio.poll();
    expect(studio.submit({ project: 'p', title: 'A · Esquerda', source: 'p/2026-10-29/a.png', view: 'left' }, { direct: true })).toHaveProperty('job');
    expect(studio.poll()[0]).toMatchObject({ view: 'left', source: 'p/2026-10-29/a.png' });
  });
});

describe('preço e saldo do 3D no painel', () => {
  it('o auxiliar conta o serviço, o preço e o saldo; o painel só vê enquanto ele está por perto', () => {
    const studio = new StudioService({ root: setup() });
    expect(studio.model3d()).toBeUndefined();
    studio.ack({ results: [], model3d: { provider: 'tripo', single: 25, multi: 25, balance: 975.5 } });
    expect(studio.model3d()).toEqual({ provider: 'tripo', single: 25, multi: 25, balance: 975.5 });
    studio.ack({ results: [], model3d: { provider: 'outro', balance: -1 } });
    expect(studio.model3d()?.provider).toBe('tripo');
    expect(parseModel3dInfo({ provider: 'none', balance: 'muito' })).toEqual({ provider: 'none' });
  });
});
