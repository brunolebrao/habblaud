// Marca própria (server/brand.ts, OfficeSnapshot.meta.brand): nome, logo, placa e cor no lugar dos do Habblaud. Chega
// com o snapshot; quem mostra a marca lê brandName() e se inscreve em onBrand() para trocar quando ela chegar.
import type { BrandInfo } from '../../../shared/types';

export const DEFAULT_NAME = 'Habblaud';

let current: BrandInfo | undefined;
const listeners = new Set<(b: BrandInfo | undefined) => void>();

export function brand(): BrandInfo | undefined {
  return current;
}

/** Nome da marca (ou "Habblaud"). */
export function brandName(): string {
  return current?.name ?? DEFAULT_NAME;
}

/** URL de uma imagem da pasta da marca. */
export function brandUrl(file: string): string {
  return `/brand/${encodeURIComponent(file)}`;
}

/** Chamado a cada snapshot: só avisa quando algo mudou. */
export function setBrand(next: BrandInfo | undefined): void {
  if (JSON.stringify(next) === JSON.stringify(current)) return;
  current = next ? { ...next } : undefined;
  applyAccent(current?.accent);
  // Pacote de arte (brand.json "art"): a interface ganha a paleta dele (styles.css, .ui-root[data-art]).
  for (const root of document.querySelectorAll<HTMLElement>('.ui-root')) {
    if (current?.art) root.dataset.art = current.art;
    else delete root.dataset.art;
  }
  for (const fn of listeners) fn(current);
}

/** Recebe a marca agora e a cada mudança; devolve o cancelamento. */
export function onBrand(fn: (b: BrandInfo | undefined) => void): () => void {
  listeners.add(fn);
  fn(current);
  return () => listeners.delete(fn);
}

/** `#rrggbb` → a cor de destaque da interface e a versão suave (mesma transparência do tema), no .ui-root. */
function applyAccent(accent: string | undefined): void {
  const m = accent && /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(accent);
  for (const root of document.querySelectorAll<HTMLElement>('.ui-root')) {
    if (!m) {
      root.style.removeProperty('--ui-accent');
      root.style.removeProperty('--ui-accent-soft');
      continue;
    }
    const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16));
    root.style.setProperty('--ui-accent', m[0]);
    root.style.setProperty('--ui-accent-soft', `rgba(${r}, ${g}, ${b}, 0.13)`);
  }
}
