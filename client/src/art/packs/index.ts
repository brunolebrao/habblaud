// Pacotes de arte (brand.json "art"): um ArtModule que embrulha o original e troca só o que o pacote redesenha (móveis,
// pisos, paredes, temas das salas); o resto (personagens, telas, ícones) vem do original. Só local: o mundo daqui
// desenha com o pacote, a Visita e o Habblaud World não sabem dele.
import type { ArtModule, Doorway, FloorKind, FurnitureKind, FurnitureSprites, Sprite, WallStyle } from '../api';
import type { PixelBuf } from '../core/pixbuf';
import { trim, type BufFurniture, type BufSprite } from '../core/sprite';
import { normalizeFurniture } from '../furniture/index';
import { CHUNK_PX, type FloorOpts } from '../surfaces/floor';
import * as forja from './forja/furniture';
import { forjaFloorChunk, forjaRoomTheme, forjaWall } from './forja/surfaces';

export type ArtPack = 'forja';

function toCanvas(buf: PixelBuf): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, buf.w);
  c.height = Math.max(1, buf.h);
  const ctx = c.getContext('2d');
  if (ctx && buf.w > 0 && buf.h > 0) ctx.putImageData(new ImageData(buf.data, buf.w, buf.h), 0, 0);
  return c;
}

function toSprite(s: BufSprite): Sprite {
  return { canvas: toCanvas(s.buf), ax: s.ax, ay: s.ay, rects: s.rects };
}

/** Móvel do pacote Forja, recortado como os originais (undefined = o original). */
export function forjaFurniture(kind: FurnitureKind, variant: string | undefined, seed: number): BufFurniture | undefined {
  const f = buildForja(kind, variant, seed);
  return f && { base: trim(f.base), front: f.front ? trim(f.front) : undefined };
}

function buildForja(kind: FurnitureKind, variant: string | undefined, seed: number): BufFurniture | undefined {
  switch (kind) {
    case 'desk':
      return forja.desk(variant, seed);
    case 'desk_back':
      return forja.deskBack(variant, seed);
    case 'office_chair':
      return forja.chair(variant);
    case 'office_chair_front':
      return forja.chairFront(variant);
    case 'bookshelf':
      return forja.spoolShelf(seed);
    case 'floor_lamp':
      return forja.torch();
    case 'water_cooler':
      return forja.barrel();
    default:
      return undefined;
  }
}

/** O ArtModule do pacote, sobre o original. Caches próprios (os do original ficam para a Visita). */
export function artWithPack(base: ArtModule, pack: ArtPack | undefined): ArtModule {
  if (pack !== 'forja') return base;
  const furn = new Map<string, FurnitureSprites | null>();
  const floors = new Map<string, HTMLCanvasElement | null>();
  const limited = <T>(m: Map<string, T>, limit: number, key: string, make: () => T): T => {
    if (m.has(key)) return m.get(key) as T;
    if (m.size >= limit) m.clear();
    const v = make();
    m.set(key, v);
    return v;
  };
  const drawFloor = (ctx: CanvasRenderingContext2D, kind: FloorKind, x: number, y: number, w: number, h: number, opts: FloorOpts) => {
    const cx0 = Math.floor(x / CHUNK_PX);
    const cy0 = Math.floor(y / CHUNK_PX);
    const cx1 = Math.ceil((x + w) / CHUNK_PX);
    const cy1 = Math.ceil((y + h) / CHUNK_PX);
    for (let cy = cy0; cy < cy1; cy++) {
      for (let cx = cx0; cx < cx1; cx++) {
        const key = `${kind}|${opts.seed}|${opts.tint ?? ''}|${cx}|${cy}`;
        const chunk = limited(floors, 1500, key, () => {
          const buf = forjaFloorChunk(kind, cx, cy, opts);
          return buf ? toCanvas(buf) : null;
        });
        const px = cx * CHUNK_PX;
        const py = cy * CHUNK_PX;
        const sx = Math.max(0, x - px);
        const sy = Math.max(0, y - py);
        const ex = Math.min(CHUNK_PX, x + w - px);
        const ey = Math.min(CHUNK_PX, y + h - py);
        if (ex <= sx || ey <= sy) continue;
        if (chunk) ctx.drawImage(chunk, sx, sy, ex - sx, ey - sy, px + sx, py + sy, ex - sx, ey - sy);
        else base.drawFloor(ctx, kind, px + sx, py + sy, ex - sx, ey - sy, opts);
      }
    }
  };
  return {
    ...base,
    furnitureSprites(kind, variant, state, opts = {}) {
      const n = normalizeFurniture(kind, variant, state, opts.seed);
      const key = `${kind}|${n.variant ?? '-'}|${n.state}|${n.vseed}`;
      const own = limited(furn, 4000, key, () => {
        const f = forjaFurniture(kind, n.variant, n.vseed);
        return f ? { base: toSprite(f.base), front: f.front ? toSprite(f.front) : undefined } : null;
      });
      return own ?? base.furnitureSprites(kind, variant, state, opts);
    },
    drawFloor,
    drawWallFace: (ctx, x, y, w, style: WallStyle, opts?: { doorways?: Doorway[] }) => base.drawWallFace(ctx, x, y, w, forjaWall(style), opts),
    drawWallTop: (ctx, x, y, w, h, style) => base.drawWallTop(ctx, x, y, w, h, forjaWall(style)),
    drawSouthWall: (ctx, x, y, w, style, opts) => base.drawSouthWall(ctx, x, y, w, forjaWall(style), opts),
    roomTheme: (seed) => forjaRoomTheme(base.roomTheme(seed), seed),
  };
}
