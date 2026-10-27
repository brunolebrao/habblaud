// Marca própria (opcional): <HABBLAUD_BRAND_DIR>/brand.json troca o nome "Habblaud" e o logo onde eles aparecem como
// marca (barra do topo, aba, placa da recepção, login do celular, PWA). Sem o arquivo, tudo fica como no Habblaud. Os
// textos de ajuda, que falam do software, continuam dizendo Habblaud. Nada daqui vai para o Habblaud World. Node puro.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { BrandInfo } from '../shared/types';
import { tr } from '../shared/i18n';

export const BRAND_FILE = 'brand.json';
/** Prefixo das imagens da marca (servidas da pasta da marca; ver brandFile). */
export const BRAND_PATH = '/brand/';
const NAME_MAX = 24;
/** Só o nome de um arquivo de imagem na pasta da marca: nada de caminho. */
const IMAGE = /^[A-Za-z0-9][\w.@-]{0,63}\.(png|webp|jpe?g|gif)$/i;
const COLOR = /^#[0-9a-f]{6}$/i;
/** Pacotes de arte conhecidos (client/src/art/packs). */
const ART_PACKS = ['forja'] as const;

/** Valida o conteúdo do brand.json; campo inválido fica de fora, nome inválido = sem marca. */
export function parseBrand(raw: unknown): { brand?: BrandInfo; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { warnings: [tr('brand.json precisa ser um objeto JSON')] };
  const r = raw as Record<string, unknown>;
  const name = typeof r.name === 'string' ? r.name.trim().replace(/\s+/g, ' ') : '';
  // O nome entra no HTML e no JSON do manifest como texto: nada que precise de escape.
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f<>"&\\]/.test(name)) {
    return { warnings: [tr('brand.json: "name" precisa ter de 1 a {0} caracteres, sem < > " & nem barra invertida', [NAME_MAX])] };
  }
  const brand: BrandInfo = { name };
  for (const key of ['logo', 'sign'] as const) {
    const v = r[key];
    if (v === undefined) continue;
    if (typeof v === 'string' && IMAGE.test(v)) brand[key] = v;
    else warnings.push(tr('brand.json: "{0}" precisa ser só o nome de uma imagem da pasta (png, webp, jpg ou gif)', [key]));
  }
  if (r.accent !== undefined) {
    if (typeof r.accent === 'string' && COLOR.test(r.accent)) brand.accent = r.accent.toLowerCase();
    else warnings.push(tr('brand.json: "accent" precisa ser uma cor como #7cc8ff'));
  }
  if (r.art !== undefined) {
    if ((ART_PACKS as readonly unknown[]).includes(r.art)) brand.art = r.art as BrandInfo['art'];
    else warnings.push(tr('brand.json: "art" precisa ser um destes: {0}', [ART_PACKS.join(', ')]));
  }
  return { brand, warnings };
}

/** Lê <dir>/brand.json (sem o arquivo: sem marca e sem aviso). */
export function loadBrand(dir: string): { brand?: BrandInfo; warnings: string[] } {
  let text: string;
  try {
    text = readFileSync(join(dir, BRAND_FILE), 'utf8');
  } catch {
    return { warnings: [] };
  }
  try {
    return parseBrand(JSON.parse(text));
  } catch {
    return { warnings: [tr('brand.json não é um JSON válido')] };
  }
}

/** Arquivo pedido em /brand/<nome>: só imagens soltas na pasta da marca (undefined = 404). */
export function brandFile(dir: string, pathname: string): string | undefined {
  if (!pathname.startsWith(BRAND_PATH)) return undefined;
  let name: string;
  try {
    name = decodeURIComponent(pathname.slice(BRAND_PATH.length));
  } catch {
    return undefined;
  }
  if (!IMAGE.test(name)) return undefined;
  const file = join(dir, name);
  try {
    return statSync(file).isFile() ? file : undefined;
  } catch {
    return undefined;
  }
}

/** Troca "Habblaud" pelo nome da marca no texto do index.html e do manifest (o resto do arquivo fica igual). */
export function brandText(text: string, name: string): string {
  return text.replace(/Habblaud(?! World)/g, name);
}
