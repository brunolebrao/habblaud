import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { brandFile, brandText, loadBrand, parseBrand } from './brand';
import { loginPage } from './http/remote';
import { createStaticHandler } from './http/static';
import { tempDir } from './test/fixtures';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tmp(): string {
  const t = tempDir('habblaud-brand-');
  cleanups.push(t.cleanup);
  return t.dir;
}

describe('marca própria (brand.json)', () => {
  it('valida nome, imagens e cor; campo inválido fica de fora com aviso', () => {
    expect(parseBrand({ name: '  Lebre   HQ ', logo: 'logo.png', sign: 'placa@4x.png', accent: '#7CC8FF' })).toEqual({
      brand: { name: 'Lebre HQ', logo: 'logo.png', sign: 'placa@4x.png', accent: '#7cc8ff' },
      warnings: [],
    });
    const bad = parseBrand({ name: 'Lebre HQ', logo: '../segredo.png', sign: '/etc/passwd', accent: 'red' });
    expect(bad.brand).toEqual({ name: 'Lebre HQ' });
    expect(bad.warnings).toHaveLength(3);
  });

  it('nome vazio, longo demais ou com caracteres de HTML/JSON: sem marca', () => {
    for (const name of ['', '   ', 'x'.repeat(25), '<b>HQ</b>', 'A & B', 'Aspas "x"', 'barra\\', 42]) {
      expect(parseBrand({ name }).brand).toBeUndefined();
    }
    expect(parseBrand(null).brand).toBeUndefined();
    expect(parseBrand(['Lebre']).brand).toBeUndefined();
  });

  it('lê da pasta: sem arquivo não avisa; JSON quebrado avisa', () => {
    const dir = tmp();
    expect(loadBrand(dir)).toEqual({ warnings: [] });
    writeFileSync(join(dir, 'brand.json'), '{ nome');
    expect(loadBrand(dir).brand).toBeUndefined();
    expect(loadBrand(dir).warnings).toHaveLength(1);
    writeFileSync(join(dir, 'brand.json'), JSON.stringify({ name: 'Lebre HQ' }));
    expect(loadBrand(dir).brand).toEqual({ name: 'Lebre HQ' });
  });

  it('/brand/<arquivo>: só imagens soltas da pasta, nada de caminho', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'logo.png'), 'png');
    writeFileSync(join(dir, 'brand.json'), '{}');
    mkdirSync(join(dir, 'sub'));
    writeFileSync(join(dir, 'sub', 'x.png'), 'png');
    expect(brandFile(dir, '/brand/logo.png')).toBe(join(dir, 'logo.png'));
    expect(brandFile(dir, '/brand/brand.json')).toBeUndefined();
    expect(brandFile(dir, '/brand/sub/x.png')).toBeUndefined();
    expect(brandFile(dir, '/brand/..%2Fsegredo.png')).toBeUndefined();
    expect(brandFile(dir, '/brand/%E0.png')).toBeUndefined();
    expect(brandFile(dir, '/brand/falta.png')).toBeUndefined();
    expect(brandFile(dir, '/assets/logo.png')).toBeUndefined();
  });

  it('troca Habblaud pelo nome, mas não "Habblaud World"', () => {
    expect(brandText('<title>Habblaud</title> no Habblaud World', 'Lebre HQ')).toBe('<title>Lebre HQ</title> no Habblaud World');
  });

  it('login do celular com o nome da marca', () => {
    const html = loginPage({ caDownload: false, brandName: 'Lebre HQ' });
    expect(html).toContain('<h1>Lebre HQ</h1>');
    expect(html).toContain('content="Lebre HQ"');
    expect(loginPage({ caDownload: false })).toContain('<h1>Habblaud</h1>');
  });

  it('index.html e manifest saem com o nome da marca; o resto, igual', async () => {
    const dist = tmp();
    writeFileSync(join(dist, 'index.html'), '<title>Habblaud</title>');
    writeFileSync(join(dist, 'manifest.webmanifest'), '{"name":"Habblaud"}');
    writeFileSync(join(dist, 'outro.txt'), 'Habblaud');
    const branded = createStaticHandler(dist, { brandName: 'Lebre HQ' });
    const plain = createStaticHandler(dist);
    let serve = branded;
    const server = http.createServer((req, res) => serve(req, res, new URL(req.url ?? '/', 'http://x').pathname));
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    cleanups.push(() => server.close());
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    const page = await fetch(`${base}/qualquer/rota`);
    expect(await page.text()).toBe('<title>Lebre HQ</title>');
    const etag = page.headers.get('etag')!;
    expect(await (await fetch(`${base}/manifest.webmanifest`)).text()).toBe('{"name":"Lebre HQ"}');
    expect(await (await fetch(`${base}/outro.txt`)).text()).toBe('Habblaud');
    expect((await fetch(`${base}/`, { headers: { 'If-None-Match': etag } })).status).toBe(304);

    // Sem marca, o ETag é outro: o navegador não reaproveita a página com o nome antigo.
    serve = plain;
    const again = await fetch(`${base}/`, { headers: { 'If-None-Match': etag } });
    expect(again.status).toBe(200);
    expect(await again.text()).toBe('<title>Habblaud</title>');
  });
});
