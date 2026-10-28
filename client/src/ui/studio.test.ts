import { describe, expect, it } from 'vitest';
import { fileUrl, parseStudio, projectsOf } from './studio';

describe('parseStudio', () => {
  it('confere a resposta e descarta caminhos estranhos', () => {
    const s = parseStudio({
      available: true,
      jobs: [{ id: 'j', project: 'p', prompt: 'x', status: 'sent', at: 1 }, { id: 'k', status: 'hack' }],
      items: [
        { file: 'lebre-hq/2026-10-28/a.png', project: 'lebre-hq', date: '2026-10-28', prompt: 'lebre', at: 2 },
        { file: '../x.png' },
      ],
    });
    expect(s.available).toBe(true);
    expect(s.jobs.map((j) => j.id)).toEqual(['j']);
    expect(s.items.map((i) => i.file)).toEqual(['lebre-hq/2026-10-28/a.png']);
    expect(projectsOf([...s.items, { ...s.items[0]!, file: 'x/2026-10-27/b.png', project: 'x' }])).toEqual(['lebre-hq', 'x']);
  });

  it('endereço da imagem', () => {
    expect(fileUrl('lebre-hq/2026-10-28/134502-a.png')).toBe('/api/studio/file/lebre-hq/2026-10-28/134502-a.png');
  });
});
