// Pastas escondidas do escritório (HABBLAUD_IGNORE_DIRS): as sessões abertas nelas (ou em subpastas) não viram sala nem
// personagem e ficam fora do histórico, das entregas e das pastas do Novo agente. Serve para ferramentas que rodam o
// Claude Code ou o Codex por baixo dos panos (ex.: os observadores do claude-mem, em ~/.claude-mem). Node puro.
import { expandHome } from '../accounts/detect';

/** Caminho absoluto, `~` ou `$HOME`: relativo não vale (dependeria da pasta de onde o servidor foi iniciado). */
const ABSOLUTE = /^(\/|~(\/|$)|\$\{?HOME\b)/;

/** Pastas de HABBLAUD_IGNORE_DIRS (separadas por vírgula), absolutas e sem barra final; as relativas ficam de fora. */
export function parseHiddenDirs(raw: string | undefined, home: string): string[] {
  const out = new Set<string>();
  for (const part of (raw ?? '').split(',')) {
    const p = part.trim();
    if (p && ABSOLUTE.test(p)) out.add(expandHome(p, home));
  }
  return [...out];
}

/** O caminho é uma das pastas escondidas ou fica dentro de uma delas. */
export function isHiddenPath(path: string | undefined, dirs: readonly string[]): boolean {
  const p = path?.trim().replace(/\/+$/, '');
  if (!p) return false;
  return dirs.some((d) => p === d || p.startsWith(`${d}/`));
}
