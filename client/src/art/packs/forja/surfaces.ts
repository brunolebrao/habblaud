// Pacote "Forja": pisos (tábuas, lajes de pedra, calçamento, terra batida), paredes de pedra e reboco com madeira e
// os temas das oficinas. Puro (PixelBuf), em blocos de mundo como ../../surfaces/floor.ts.
import { type FloorKind, type RoomTheme, type WallStyle } from '../../api';
import { mix, parseColor, shade, type RGBA } from '../../core/color';
import { PixelBuf } from '../../core/pixbuf';
import { CHUNK_PX, h3, type FloorOpts } from '../../surfaces/floor';

/** Bloco (cx, cy) do piso no estilo Forja; undefined = usa o piso original (grama, banheiro). */
export function forjaFloorChunk(kind: FloorKind, cx: number, cy: number, o: FloorOpts): PixelBuf | undefined {
  const b = new PixelBuf(CHUNK_PX, CHUNK_PX);
  const x0 = cx * CHUNK_PX;
  const y0 = cy * CHUNK_PX;
  switch (kind) {
    case 'carpet':
      planks(b, x0, y0, o.seed, o.tint ?? '#9a6b47');
      return b;
    case 'wood':
      planks(b, x0, y0, o.seed, '#7a5238');
      return b;
    case 'marble':
      // Oficinas e recepção: tábuas no tom da sala (pela semente da área).
      planks(b, x0, y0, o.seed, FLOOR_WOODS[((Math.floor(o.seed) % FLOOR_WOODS.length) + FLOOR_WOODS.length) % FLOOR_WOODS.length]);
      return b;
    case 'concrete':
      flagstones(b, x0, y0, o.seed, ['#8f8a80', '#97918a', '#8a857c', '#9c968c']);
      return b;
    case 'tile_check':
      slateCheck(b, x0, y0);
      return b;
    case 'sidewalk':
      cobbles(b, x0, y0, o.seed);
      return b;
    case 'street':
      dirt(b, x0, y0, o.seed);
      return b;
    default:
      return undefined;
  }
}

/** Tábuas largas (5 px) e compridas, com emendas desencontradas, cravos e veios, no tom pedido. */
function planks(b: PixelBuf, x0: number, y0: number, seed: number, tone: string): void {
  const tones = [tone, shade(tone, 0.035), shade(tone, -0.035), mix(tone, '#8a5a3b', 0.25)];
  const table: RGBA[][] = tones.map((t) => [t, shade(t, 0.05), shade(t, -0.16), shade(t, -0.05), shade(t, -0.22), shade(t, -0.3)].map(parseColor));
  for (let py = 0; py < CHUNK_PX; py++) {
    const wy = y0 + py;
    const row = Math.floor(wy / 5);
    const iy = wy - row * 5;
    const off = h3(row, 0, 1, seed) % 64;
    for (let px = 0; px < CHUNK_PX; px++) {
      const wx = x0 + px + off;
      const plank = Math.floor(wx / 64);
      const ix = wx - plank * 64;
      const ph = h3(row, plank, 2, seed);
      const t = table[ph % table.length];
      let k = 0;
      if (ix === 0) k = 4;
      else if (iy === 4) k = 2;
      else if (iy === 0) k = 1;
      else if ((ix === 3 || ix === 60) && iy === 2) k = 5;
      else if (iy === 1 + ((ph >>> 5) % 3) && (ix + (ph >>> 8)) % 19 < 6) k = 3;
      b.put(px, py, t[k]);
    }
  }
}

/** Lajes de pedra de 16x16 em fileiras desencontradas, com argamassa escura e aresta clara. */
function flagstones(b: PixelBuf, x0: number, y0: number, seed: number, tones: readonly string[]): void {
  const table: RGBA[][] = tones.map((t) => [t, shade(t, 0.06), shade(t, -0.07), shade(t, -0.04)].map(parseColor));
  const mortar = parseColor('#5f5a52');
  for (let py = 0; py < CHUNK_PX; py++) {
    for (let px = 0; px < CHUNK_PX; px++) {
      const wx = x0 + px;
      const wy = y0 + py;
      const row = wy >> 4;
      const sx = wx + (row & 1 ? 8 : 0);
      const ix = sx & 15;
      const iy = wy & 15;
      if (ix === 15 || iy === 15) {
        b.put(px, py, mortar);
        continue;
      }
      const t = table[h3(sx >> 4, row, 3, seed) % table.length];
      let k = 0;
      if (ix === 0 || iy === 0) k = 1;
      else if (ix === 14 || iy === 14) k = 2;
      else if (h3(wx, wy, 4, seed) % 23 === 0) k = 3;
      b.put(px, py, t[k]);
    }
  }
}

/** Xadrez de ardósia e pedra clara (copa). */
function slateCheck(b: PixelBuf, x0: number, y0: number): void {
  const light = [parseColor('#b8b0a2'), parseColor('#c4bcae'), parseColor('#9a9284')];
  const dark = [parseColor('#5d6066'), parseColor('#6a6d74'), parseColor('#4a4c52')];
  for (let py = 0; py < CHUNK_PX; py++) {
    for (let px = 0; px < CHUNK_PX; px++) {
      const wx = x0 + px;
      const wy = y0 + py;
      const t = ((wx >> 3) + (wy >> 3)) & 1 ? dark : light;
      const ix = wx & 7;
      const iy = wy & 7;
      b.put(px, py, t[ix === 7 || iy === 7 ? 2 : ix === 0 || iy === 0 ? 1 : 0]);
    }
  }
}

/** Calçamento de pedras redondas (6x5) com juntas de terra. */
function cobbles(b: PixelBuf, x0: number, y0: number, seed: number): void {
  const tones = ['#8d877c', '#9a9388', '#827c72', '#a19a8e'].map((t) => [t, shade(t, 0.08), shade(t, -0.1)].map(parseColor));
  const joint = parseColor('#5e5244');
  for (let py = 0; py < CHUNK_PX; py++) {
    for (let px = 0; px < CHUNK_PX; px++) {
      const wx = x0 + px;
      const wy = y0 + py;
      const row = Math.floor(wy / 5);
      const iy = wy - row * 5;
      const sx = wx + (row & 1 ? 3 : 0);
      const ix = sx % 6;
      const corner = (ix === 0 || ix === 5) && (iy === 0 || iy === 4);
      if (ix === 5 || iy === 4 || corner) {
        b.put(px, py, joint);
        continue;
      }
      const t = tones[h3(Math.floor(sx / 6), row, 5, seed) % tones.length];
      b.put(px, py, t[iy === 0 || ix === 0 ? 1 : iy === 3 ? 2 : 0]);
    }
  }
}

/** Terra batida com pedrisco (estrada). */
function dirt(b: PixelBuf, x0: number, y0: number, seed: number): void {
  const tones = [parseColor('#8b6f4e'), parseColor('#836848'), parseColor('#937655'), parseColor('#6f5840'), parseColor('#a38a68')];
  for (let py = 0; py < CHUNK_PX; py++) {
    for (let px = 0; px < CHUNK_PX; px++) {
      const wx = x0 + px;
      const wy = y0 + py;
      const n = h3(wx >> 2, wy >> 2, 6, seed) % 3;
      const sp = h3(wx, wy, 7, seed) % 37;
      b.put(px, py, sp === 0 ? tones[3] : sp === 1 ? tones[4] : tones[n]);
    }
  }
}

// ------------------------------------------------------------------ paredes e temas

const PLASTER: WallStyle = { base: '#e6d9bf', trim: '#5a3b26', pattern: 'wood_panel' };
const STONE: WallStyle = { base: '#9a9184', trim: '#4f453b', pattern: 'brick' };
const DARK_STONE: WallStyle = { base: '#857d72', trim: '#3f362e', pattern: 'brick' };

/** Parede no estilo Forja: pedra por fora, reboco com lambri de madeira ou pedra por dentro (vidro e azulejo ficam). */
export function forjaWall(style: WallStyle): WallStyle {
  if (style.pattern === 'glass' || style.pattern === 'tiles') return style;
  if (style.exterior) return { ...DARK_STONE, exterior: true };
  if (style.pattern === 'brick' || style.pattern === 'marble') return { ...STONE };
  return { ...PLASTER };
}

/** Tons de tábua das oficinas (pela semente da sala). */
const FLOOR_WOODS = ['#9a6b47', '#8a5f3f', '#a5764d', '#7d5a40', '#94643f', '#8f6a4a', '#6f4f38', '#9c6f4c', '#86603f', '#7a563a'] as const;
const ROOM_WALLS: readonly WallStyle[] = [PLASTER, STONE, PLASTER, { base: '#ddd0b4', trim: '#6e4a30', pattern: 'wood_panel' }, STONE];

/**
 * Tema da oficina: tapeçaria na cor da sala (escurecida, como tecido tingido) e paredes medievais; a cor de destaque
 * (lista lateral, gaveta) e a mesa/cadeira seguem o original.
 */
export function forjaRoomTheme(base: RoomTheme, seed: number): RoomTheme {
  const i = ((Math.floor(seed) % FLOOR_WOODS.length) + FLOOR_WOODS.length) % FLOOR_WOODS.length;
  const cloth = mix(base.accent, '#4a2e1e', 0.45);
  return { ...base, carpet: cloth, carpet2: shade(cloth, -0.06), wall: { ...ROOM_WALLS[i % ROOM_WALLS.length] } };
}
