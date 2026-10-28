import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { codexInstruction, createCodexImageGenerator, imageBaseName, parseStudioRequest, projectSlug } from './generate';
import { listGallery, readGalleryFile, StudioService } from './studio';

const tmp = () => mkdtempSync(join(tmpdir(), 'estudio-'));
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

describe('pedido', () => {
  it('projeto vira slug; prompt é obrigatório', () => {
    expect(projectSlug('Lebre HQ — Logo!')).toBe('lebre-hq-logo');
    expect(parseStudioRequest({ project: 'Lebre HQ', title: ' Logo  da lebre ', prompt: ' uma lebre ' })).toEqual({ project: 'lebre-hq', title: 'Logo da lebre', prompt: 'uma lebre' });
    expect(parseStudioRequest({ project: '../x', prompt: 'a' })).toEqual({ project: 'x', title: 'a', prompt: 'a' });
    expect('error' in parseStudioRequest({ project: '!!!', prompt: 'a' })).toBe(true);
    expect('error' in parseStudioRequest({ project: 'a', prompt: '' })).toBe(true);
  });

  it('nome do arquivo: hora e começo do prompt', () => {
    expect(imageBaseName('Uma lebre de pixel art segurando um martelo grande', '134502')).toBe('134502-uma-lebre-de-pixel-art-segurando-um-martelo');
    expect(codexInstruction('x', 'a.png')).toContain('"a.png"');
  });
});

describe('createCodexImageGenerator', () => {
  const now = () => new Date(2026, 9, 28, 13, 45, 2);

  it('roda o Codex na pasta do projeto e grava prompt e metadados', async () => {
    const root = tmp();
    const calls: string[][] = [];
    const gen = createCodexImageGenerator({
      codexBin: '/bin/codex',
      root,
      model: 'gpt-6-luna',
      codexHome: tmp(),
      now,
      run: async (_bin, args, cwd) => {
        calls.push(args);
        writeFileSync(join(cwd, '134502-lebre.png'), PNG);
        return { ok: true, output: '' };
      },
    });
    const out = await gen({ project: 'lebre-hq', title: 'lebre', prompt: 'lebre' });
    expect(out.file).toBe('lebre-hq/2026-10-28/134502-lebre.png');
    expect(calls[0]!.slice(0, 7)).toEqual(['exec', '-m', 'gpt-6-luna', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-C']);
    const meta = JSON.parse(readFileSync(join(root, 'lebre-hq/2026-10-28/134502-lebre.json'), 'utf8'));
    expect(meta).toMatchObject({ project: 'lebre-hq', prompt: 'lebre', model: 'gpt-6-luna', file: '134502-lebre.png' });
    expect(readFileSync(join(root, 'lebre-hq/2026-10-28/134502-lebre.md'), 'utf8')).toBe('# lebre\n\nlebre\n');
  });

  const SID = '019a2b3c-4d5e-6f70-8192-a3b4c5d6e7f8';

  it('imagem só na pasta do Codex: copia a da sessão desta geração', async () => {
    const root = tmp();
    const codexHome = tmp();
    const gen = createCodexImageGenerator({
      codexBin: '/bin/codex',
      root,
      codexHome,
      now,
      run: async () => {
        mkdirSync(join(codexHome, 'generated_images', SID), { recursive: true });
        writeFileSync(join(codexHome, 'generated_images', SID, 'exec-1.png'), PNG);
        return { ok: true, output: `model: gpt-6-luna\nsession id: ${SID}\n` };
      },
    });
    const out = await gen({ project: 'p', title: 'lebre', prompt: 'lebre' });
    expect(readFileSync(join(root, out.file))).toEqual(PNG);
  });

  it('nunca copia a imagem de outra sessão do Codex', async () => {
    const codexHome = tmp();
    const gen = createCodexImageGenerator({
      codexBin: '/bin/codex',
      root: tmp(),
      codexHome,
      now,
      run: async () => {
        mkdirSync(join(codexHome, 'generated_images', 'outra'), { recursive: true });
        writeFileSync(join(codexHome, 'generated_images', 'outra', 'exec-1.png'), PNG);
        return { ok: true, output: `session id: ${SID}\n` };
      },
    });
    await expect(gen({ project: 'p', title: 'x', prompt: 'x' })).rejects.toThrow();
  });

  it('sem imagem: erro com o motivo do Codex', async () => {
    const gen = createCodexImageGenerator({ codexBin: '/bin/codex', root: tmp(), codexHome: tmp(), now, run: async () => ({ ok: false, error: 'model not supported', output: '' }) });
    await expect(gen({ project: 'p', title: 'x', prompt: 'x' })).rejects.toThrow(/model not supported/);
  });
});

describe('galeria', () => {
  function seed() {
    const root = tmp();
    const d = join(root, 'lebre-hq', '2026-10-28');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'a.png'), PNG);
    writeFileSync(join(d, 'a.json'), JSON.stringify({ prompt: 'lebre', model: 'gpt-6-luna' }));
    writeFileSync(join(d, 'b.webp'), PNG);
    utimesSync(join(d, 'b.webp'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    writeFileSync(join(d, 'notas.txt'), 'x');
    mkdirSync(join(root, 'lebre-hq', 'rascunhos'));
    return root;
  }

  it('lista as imagens com o prompt, da mais nova para a mais antiga', () => {
    const items = listGallery(seed());
    expect(items.map((i) => i.file)).toEqual(['lebre-hq/2026-10-28/a.png', 'lebre-hq/2026-10-28/b.webp']);
    expect(items[0]).toMatchObject({ project: 'lebre-hq', date: '2026-10-28', prompt: 'lebre', model: 'gpt-6-luna' });
  });

  it('só entrega imagens de dentro da raiz', () => {
    const root = seed();
    const outside = tmp();
    writeFileSync(join(outside, 'segredo.png'), PNG);
    symlinkSync(join(outside, 'segredo.png'), join(root, 'lebre-hq', '2026-10-28', 'link.png'));
    expect('data' in readGalleryFile(root, 'lebre-hq/2026-10-28/a.png')).toBe(true);
    expect(readGalleryFile(root, 'lebre-hq/2026-10-28/link.png')).toMatchObject({ status: 403 });
    expect(readGalleryFile(root, 'lebre-hq/2026-10-28/../../x.png')).toMatchObject({ status: 400 });
    expect(readGalleryFile(root, 'lebre-hq/2026-10-28/notas.txt')).toMatchObject({ status: 400 });
  });
});

describe('StudioService', () => {
  const svc = (over: Partial<ConstructorParameters<typeof StudioService>[0]> = {}) => {
    let n = 0;
    return new StudioService({ root: tmp(), newId: () => `j${++n}`, ...over });
  };
  const job = (s: StudioService, id: string) => s.jobs().find((j) => j.id === id);

  it('pedido de agente fica esperando; só gera depois de aprovado (com o título e o prompt editados)', () => {
    const s = svc();
    s.saveProject({ name: 'Funkos', style: 'Funko Pop, cabeça grande' });
    expect(s.submit({ project: 'funkos', title: 'Mago', prompt: 'um mago', requestedBy: 'Simone' })).toMatchObject({ job: { id: 'j1', status: 'pending', requestedBy: 'Simone' } });
    expect(s.poll()).toEqual([]);
    expect(s.approve('j1', { title: 'Mago azul', prompt: 'um mago de capa azul' })).toMatchObject({ job: { status: 'queued', title: 'Mago azul' } });
    expect(s.poll()).toEqual([{ id: 'j1', project: 'funkos', title: 'Mago azul', prompt: 'um mago de capa azul\n\nGuia de estilo do projeto (siga sempre): Funko Pop, cabeça grande' }]);
    s.ack({ results: [{ id: 'j1', ok: true, file: 'funkos/2026-10-28/a.png' }] });
    expect(job(s, 'j1')).toMatchObject({ status: 'done', file: 'funkos/2026-10-28/a.png' });
  });

  it('do painel: gera direto (com o auxiliar presente)', () => {
    const s = svc();
    expect(s.submit({ project: 'p', prompt: 'x' }, { direct: true })).toMatchObject({ error: 'unavailable' });
    s.poll();
    expect(s.submit({ project: 'p', prompt: 'x' }, { direct: true })).toMatchObject({ job: { status: 'queued' } });
  });

  it('pedir ajuste: o comentário vai à sessão do agente e o pedido sai da lista', () => {
    const sent: Array<[string, string]> = [];
    const s = svc({ notify: (session, text) => (sent.push([session, text]), { ok: true }), agentName: (session) => (session === '00ecdadc-2c4f-4679' ? 'Simone' : undefined) });
    s.submit({ project: 'p', title: 'Vaso', prompt: 'um vaso', session: '00ecdadc-2c4f-4679' });
    s.submit({ project: 'p', prompt: 'sem sessão' });
    expect(s.jobs().find((j) => j.id === 'j1')?.reviseTo).toBe('Simone');
    expect(s.revise('j1', { note: '' })).toMatchObject({ error: expect.any(String) });
    expect(s.revise('j2', { note: 'mais fofo' })).toMatchObject({ error: expect.any(String) });
    expect(s.revise('j1', { note: 'mais fofo' })).toEqual({ ok: true });
    expect(sent[0]![0]).toBe('00ecdadc-2c4f-4679');
    expect(sent[0]![1]).toContain('```text');
    expect(sent[0]![1]).toContain('mais fofo');
    expect(sent[0]![1]).toContain('um vaso');
    expect(s.jobs().map((j) => j.id)).toEqual(['j2']);
  });

  it('falhou: tentar de novo volta a esperar você', () => {
    const s = svc();
    s.poll();
    s.submit({ project: 'p', prompt: 'x' }, { direct: true });
    s.poll();
    s.ack({ results: [{ id: 'j1', ok: false, error: 'x' }] });
    expect(s.retry('j1')).toBe(true);
    expect(job(s, 'j1')).toMatchObject({ status: 'pending' });
    expect(job(s, 'j1')?.error).toBeUndefined();
    expect(s.retry('j1')).toBe(false);
  });

  it('descartar some com o pedido; aprovar de novo não vale', () => {
    const s = svc();
    s.submit({ project: 'p', prompt: 'x' });
    expect(s.discard('j1')).toBe(true);
    expect(s.approve('j1', {})).toMatchObject({ error: 'unknown' });
  });

  it('caminho estranho ou de outro projeto no ack: falha', () => {
    const s = svc();
    s.poll();
    s.submit({ project: 'p', prompt: 'x' }, { direct: true });
    s.poll();
    s.ack({ results: [{ id: 'j1', ok: true, file: 'q/2026-10-28/a.png' }] });
    expect(job(s, 'j1')).toMatchObject({ status: 'failed' });
  });

  it('projetos e pedidos esperando sobrevivem ao reinício', () => {
    const stateFile = join(tmp(), 'studio.json');
    const a = svc({ stateFile });
    a.saveProject({ name: 'D&D RPG', description: 'personagens', style: 'aquarela' });
    a.submit({ project: 'd-d-rpg', title: 'Anão', prompt: 'um anão ferreiro' });
    const b = svc({ stateFile });
    expect(b.projects()).toMatchObject([{ slug: 'd-d-rpg', name: 'D&D RPG', style: 'aquarela', pending: 1, count: 0 }]);
    expect(b.jobs()).toMatchObject([{ id: 'j1', status: 'pending', title: 'Anão' }]);
  });

  it('modo Node: gera aqui, já com o estilo', async () => {
    const seen: string[] = [];
    const s = svc({ generator: async (r) => (seen.push(r.prompt), { file: 'p/2026-10-28/a.png' }) });
    s.saveProject({ name: 'p', style: 'S' });
    s.submit({ project: 'p', prompt: 'x' }, { direct: true });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(job(s, 'j1')).toMatchObject({ status: 'done' });
    expect(seen[0]).toContain('S');
  });
});
