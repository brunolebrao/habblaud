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
    expect(parseStudioRequest({ project: 'Lebre HQ', prompt: ' uma lebre ' })).toEqual({ project: 'lebre-hq', prompt: 'uma lebre' });
    expect(parseStudioRequest({ project: '../x', prompt: 'a' })).toEqual({ project: 'x', prompt: 'a' });
    expect('error' in parseStudioRequest({ project: '!!!', prompt: 'a' })).toBe(true);
    expect('error' in parseStudioRequest({ project: 'a', prompt: '' })).toBe(true);
  });

  it('nome do arquivo: hora e começo do prompt', () => {
    expect(imageBaseName('Uma lebre de pixel art segurando um martelo grande', '134502')).toBe('134502-uma-lebre-de-pixel-art-segurando');
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
        return { ok: true };
      },
    });
    const out = await gen({ project: 'lebre-hq', prompt: 'lebre' });
    expect(out.file).toBe('lebre-hq/2026-10-28/134502-lebre.png');
    expect(calls[0]!.slice(0, 7)).toEqual(['exec', '-m', 'gpt-6-luna', '--sandbox', 'danger-full-access', '--skip-git-repo-check', '-C']);
    const meta = JSON.parse(readFileSync(join(root, 'lebre-hq/2026-10-28/134502-lebre.json'), 'utf8'));
    expect(meta).toMatchObject({ project: 'lebre-hq', prompt: 'lebre', model: 'gpt-6-luna', file: '134502-lebre.png' });
    expect(readFileSync(join(root, 'lebre-hq/2026-10-28/134502-lebre.md'), 'utf8')).toBe('lebre\n');
  });

  it('imagem só na pasta do Codex: copia a desta geração', async () => {
    const root = tmp();
    const codexHome = tmp();
    const gen = createCodexImageGenerator({
      codexBin: '/bin/codex',
      root,
      codexHome,
      now,
      run: async () => {
        mkdirSync(join(codexHome, 'generated_images', 's1'), { recursive: true });
        writeFileSync(join(codexHome, 'generated_images', 's1', 'exec-1.png'), PNG);
        return { ok: true };
      },
    });
    const out = await gen({ project: 'p', prompt: 'lebre' });
    expect(readFileSync(join(root, out.file))).toEqual(PNG);
  });

  it('sem imagem: erro com o motivo do Codex', async () => {
    const gen = createCodexImageGenerator({ codexBin: '/bin/codex', root: tmp(), codexHome: tmp(), now, run: async () => ({ ok: false, error: 'model not supported' }) });
    await expect(gen({ project: 'p', prompt: 'x' })).rejects.toThrow(/model not supported/);
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
  it('Docker: fila para o auxiliar, que devolve o arquivo', () => {
    let t = 1_000;
    const s = new StudioService({ root: tmp(), now: () => t, newId: () => 'j1' });
    expect(s.submit({ project: 'p', prompt: 'x' })).toMatchObject({ error: 'unavailable' });
    expect(s.poll()).toEqual([]);
    expect(s.submit({ project: 'p', prompt: 'x' })).toMatchObject({ job: { id: 'j1', status: 'queued' } });
    expect(s.poll()).toEqual([{ id: 'j1', project: 'p', prompt: 'x' }]);
    s.ack({ results: [{ id: 'j1', ok: true, file: 'p/2026-10-28/a.png' }] });
    expect(s.get('j1')).toMatchObject({ status: 'done', file: 'p/2026-10-28/a.png' });
    t += 31 * 60_000;
    expect(s.get('j1')).toBeUndefined();
  });

  it('caminho estranho no ack: falha', () => {
    const s = new StudioService({ root: tmp(), newId: () => 'j1' });
    s.poll();
    s.submit({ project: 'p', prompt: 'x' });
    s.poll();
    s.ack({ results: [{ id: 'j1', ok: true, file: '../../etc/passwd' }] });
    expect(s.get('j1')).toMatchObject({ status: 'failed' });
  });

  it('modo Node: gera aqui', async () => {
    const s = new StudioService({ root: tmp(), newId: () => 'j1', generator: async () => ({ file: 'p/2026-10-28/a.png' }) });
    s.submit({ project: 'p', prompt: 'x' });
    await new Promise((ok) => setTimeout(ok, 0));
    expect(s.get('j1')).toMatchObject({ status: 'done' });
  });
});
