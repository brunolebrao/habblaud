import { describe, expect, it } from 'vitest';
import { renderFurniture } from '../furniture/index';
import { floorChunk, CHUNK_PX } from '../surfaces/floor';
import { forjaFurniture } from './index';
import { forjaFloorChunk, forjaRoomTheme, forjaWall } from './forja/surfaces';
import { roomTheme } from '../theme';
import type { FurnitureKind } from '../api';

describe('pacote de arte Forja', () => {
  it('cada móvel trocado tem a mesma folha, âncora e regiões do original', () => {
    const kinds: FurnitureKind[] = ['desk', 'desk_back', 'office_chair', 'office_chair_front', 'bookshelf', 'floor_lamp', 'water_cooler'];
    for (const kind of kinds) {
      for (const seed of [0, 1, 2, 3]) {
        const orig = renderFurniture(kind, undefined, 0, seed);
        const mine = forjaFurniture(kind, undefined, seed)!;
        expect(mine, kind).toBeDefined();
        // Recortados ao desenho: o tamanho varia, mas os pés (âncora) ficam na mesma linha do chão.
        expect(mine.base.buf.h - mine.base.ay, kind).toBeLessThanOrEqual(orig.base.buf.h - orig.base.ay + 1);
        expect(Math.abs(mine.base.buf.w - orig.base.buf.w), kind).toBeLessThanOrEqual(6);
        expect(Object.keys(mine.base.rects ?? {}).sort(), kind).toEqual(Object.keys(orig.base.rects ?? {}).filter((k) => k !== 'screen2').sort());
        expect(!!mine.front, kind).toBe(!!orig.front);
        expect(mine.base.buf.countOpaque(), kind).toBeGreaterThan(40);
      }
    }
    expect(forjaFurniture('sofa', undefined, 0)).toBeUndefined();
  });

  it('pisos: blocos cheios do tamanho certo; grama fica com o original', () => {
    for (const kind of ['carpet', 'wood', 'concrete', 'marble', 'tile_check', 'sidewalk', 'street'] as const) {
      const b = forjaFloorChunk(kind, 1, 2, { seed: 7, tint: '#9a6b47' })!;
      expect([b.w, b.h]).toEqual([CHUNK_PX, CHUNK_PX]);
      expect(b.countOpaque()).toBe(CHUNK_PX * CHUNK_PX);
    }
    expect(forjaFloorChunk('grass', 0, 0, { seed: 1 })).toBeUndefined();
    expect(floorChunk('grass', 0, 0, { seed: 1 }).w).toBe(CHUNK_PX);
  });

  it('paredes e temas: vidro fica, o resto vira pedra ou reboco; a cor de destaque da sala não muda', () => {
    expect(forjaWall({ base: '#fff', pattern: 'glass' }).pattern).toBe('glass');
    expect(forjaWall({ base: '#fff', exterior: true }).exterior).toBe(true);
    expect(forjaWall({ base: '#fff', pattern: 'stripes' }).pattern).toBe('wood_panel');
    for (let seed = 0; seed < 12; seed++) {
      const t = forjaRoomTheme(roomTheme(seed), seed);
      expect(t.accent).toBe(roomTheme(seed).accent);
      expect(t.carpet).not.toBe(roomTheme(seed).carpet);
    }
  });
});
