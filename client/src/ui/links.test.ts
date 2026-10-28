import { describe, expect, it } from 'vitest';
import { reviewLabel, safeUrl, shortUrl, splitUrls } from './links';

describe('links', () => {
  it('acha endereços no texto e deixa a pontuação de fora', () => {
    expect(splitUrls('PR aberto: https://github.com/a/b/pull/12. Veja (https://x.com/doc) e https://y.dev/a_(b)!')).toEqual([
      { type: 'text', text: 'PR aberto: ' },
      { type: 'url', url: 'https://github.com/a/b/pull/12' },
      { type: 'text', text: '. Veja (' },
      { type: 'url', url: 'https://x.com/doc' },
      { type: 'text', text: ') e ' },
      { type: 'url', url: 'https://y.dev/a_(b)' },
      { type: 'text', text: '!' },
    ]);
    expect(splitUrls('sem link aqui')).toEqual([{ type: 'text', text: 'sem link aqui' }]);
  });

  it('só http e https', () => {
    expect(safeUrl('javascript:alert(1)')).toBeUndefined();
    expect(safeUrl('data:text/html,x')).toBeUndefined();
    expect(safeUrl('https://ok.com/x')).toBe('https://ok.com/x');
    expect(splitUrls('ftp://x.com/a')).toEqual([{ type: 'text', text: 'ftp://x.com/a' }]);
  });

  it('selo de PR (GitHub) e MR (GitLab)', () => {
    expect(reviewLabel('https://github.com/dono/repo/pull/42')).toBe('PR #42');
    expect(reviewLabel('https://github.com/dono/repo/pull/42/files')).toBe('PR #42');
    expect(reviewLabel('https://gitlab.com/grupo/sub/proj/-/merge_requests/7')).toBe('MR !7');
    expect(reviewLabel('https://gitlab.empresa.com.br/g/p/-/merge_requests/3/diffs')).toBe('MR !3');
    expect(reviewLabel('https://github.com/dono/repo/issues/42')).toBeUndefined();
    expect(reviewLabel('https://evil.com/dono/repo/pull/1')).toBeUndefined();
  });

  it('endereço curto', () => {
    expect(shortUrl('https://github.com/dono/repo/actions/runs/123')).toBe('github.com/…/runs/123');
    expect(shortUrl('https://x.com/')).toBe('x.com');
  });
});
