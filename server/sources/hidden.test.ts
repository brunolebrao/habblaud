import { describe, expect, it } from 'vitest';
import { isHiddenPath, parseHiddenDirs } from './hidden';

describe('pastas escondidas (HABBLAUD_IGNORE_DIRS)', () => {
  it('expande ~ e $HOME, tira a barra final, ignora vazias, relativas e repetidas', () => {
    expect(parseHiddenDirs(' ~/.claude-mem/ , $HOME/tmp,, relativa, /opt/x, ~/.claude-mem', '/Users/eu')).toEqual([
      '/Users/eu/.claude-mem',
      '/Users/eu/tmp',
      '/opt/x',
    ]);
    expect(parseHiddenDirs(undefined, '/Users/eu')).toEqual([]);
    expect(parseHiddenDirs('  ', '/Users/eu')).toEqual([]);
  });

  it('esconde a pasta e as subpastas, mas não pastas com o mesmo começo de nome', () => {
    const dirs = ['/Users/eu/.claude-mem'];
    expect(isHiddenPath('/Users/eu/.claude-mem', dirs)).toBe(true);
    expect(isHiddenPath('/Users/eu/.claude-mem/', dirs)).toBe(true);
    expect(isHiddenPath('/Users/eu/.claude-mem/observer-sessions/21', dirs)).toBe(true);
    expect(isHiddenPath('/Users/eu/.claude-mem-outro', dirs)).toBe(false);
    expect(isHiddenPath('/Users/eu/projetos/app', dirs)).toBe(false);
    expect(isHiddenPath(undefined, dirs)).toBe(false);
    expect(isHiddenPath('/Users/eu/.claude-mem', [])).toBe(false);
  });
});
