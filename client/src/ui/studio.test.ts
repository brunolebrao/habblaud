import { describe, expect, it } from 'vitest';
import { fileUrl, parseStudio, pendingTotal } from './studio';

describe('parseStudio', () => {
  it('confere a resposta e descarta o que não bate', () => {
    const s = parseStudio({
      available: true,
      projects: [{ slug: 'funkos', name: 'Funkos', style: 'vinil', count: 3, cover: 'funkos/2026-10-28/a.png', pending: 2 }, { slug: '../x' }],
      jobs: [{ id: 'j', project: 'funkos', title: 'Mago', prompt: 'x', status: 'pending', requestedBy: 'Simone', at: 1 }, { id: 'k', status: 'hack' }],
      items: [{ file: 'funkos/2026-10-28/a.png', title: 'Mago', at: 2 }, { file: '../x.png' }],
    });
    expect(s.projects.map((p) => [p.slug, p.pending, p.cover])).toEqual([['funkos', 2, 'funkos/2026-10-28/a.png']]);
    expect(s.jobs).toMatchObject([{ id: 'j', status: 'pending', title: 'Mago', requestedBy: 'Simone' }]);
    expect(s.items.map((i) => [i.file, i.title])).toEqual([['funkos/2026-10-28/a.png', 'Mago']]);
    expect(pendingTotal(s.projects)).toBe(2);
  });

  it('endereço da imagem', () => {
    expect(fileUrl('lebre-hq/2026-10-28/134502-a.png')).toBe('/api/studio/file/lebre-hq/2026-10-28/134502-a.png');
  });
});
