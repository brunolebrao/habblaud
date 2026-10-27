// Pacote "Forja" (medieval): móveis no lugar dos do escritório, com o mesmo tamanho de folha, âncora e regiões (rects)
// dos originais em ../../furniture/office.ts, para o mundo posicionar e animar igual. Coordenadas = footprint.
import { ramp, shade, type Ramp } from '../../core/color';
import type { PixelBuf } from '../../core/pixbuf';
import { floorSheet, rectAt, type BufFurniture, type BufSprite } from '../../core/sprite';
import { ACCENTS, contact, frontFace, mug, pick, rngOf, topFace, underRect, woodGrain } from '../../furniture/kit';

type Box = { x: number; y: number; w: number; h: number };

const IRON = ramp('#4b4d55', 0.07);
const BRASS = ramp('#c99a45', 0.07);
const DARK_WOOD = ramp('#5a3b26', 0.06);
/** Cores de filamento (rolos, peças impressas). */
const FILAMENT = ['#e2604f', '#3f7fd8', '#f2c14e', '#4cae6a', '#8d66cf', '#ec8a3c', '#e8e2d4', '#36b0b0'] as const;

interface BenchMats {
  top: Ramp;
  edge: Ramp;
  legs: Ramp;
}

function benchMats(variant: string | undefined): BenchMats {
  switch (variant) {
    case 'white':
      return { top: ramp('#c49a6c', 0.06), edge: ramp('#9a7350', 0.06), legs: ramp('#7d5a3c', 0.06) };
    case 'dark':
      return { top: ramp('#6e4c36', 0.065), edge: ramp('#4d3424', 0.06), legs: ramp('#3f2b1e', 0.06) };
    default:
      return { top: ramp('#9a6a44', 0.06), edge: ramp('#6e4a30', 0.06), legs: DARK_WOOD };
  }
}

function benchShadow(b: PixelBuf): void {
  underRect(b, 3, 8, 26, 7, 'rgba(30,22,16,0.22)');
  contact(b, -1, 13, 34, 4, 0.22);
}

/** Bancada de tábuas sobre cavaletes (comum à frente e ao verso). */
function bench(s: BufSprite, m: BenchMats, seed: number, back: boolean): void {
  const b = s.buf;
  if (back) {
    frontFace(b, 1, 8, 30, 6, m.legs);
    b.hline(1, 30, 8, m.legs.dk);
    b.hline(2, 29, 11, m.legs.lt);
  }
  for (const x of [1, 28]) {
    b.rect(x, 8, 3, 8, m.legs.base);
    b.vline(x, 8, 15, m.legs.lt);
    b.vline(x + 2, 8, 15, m.legs.dk);
    b.hline(x, x + 2, 15, m.legs.dd);
  }
  if (!back) {
    b.hline(4, 27, 12, m.legs.dk);
    b.hline(4, 27, 13, m.legs.dd);
  }
  topFace(b, 0, -6, 32, 12, m.top);
  woodGrain(b, 1, -5, 30, 10, m.top, seed);
  // Tábuas do tampo e cravos.
  for (const y of [-3, 0, 3]) b.hline(0, 31, y, m.top.base);
  for (const x of [2, 29]) for (const y of [-5, -2, 1, 4]) b.set(x, y, m.top.dd);
  b.hline(0, 31, 6, m.edge.base);
  b.hline(0, 31, 7, m.edge.dk);
  b.set(0, 6, m.edge.lt);
}

/** Rolo de filamento de frente (disco): aro escuro, fio colorido, miolo claro. */
function spool(b: PixelBuf, cx: number, cy: number, r: number, color: string): void {
  b.ellipse(cx, cy, r, r, '#2f2a28');
  b.ellipse(cx, cy, r - 0.7, r - 0.7, color);
  b.set(cx - 1, cy - Math.max(1, Math.floor(r) - 1), shade(color, 0.18));
  b.rect(cx, cy, 1, 1, '#e8e2d4');
  b.set(cx + 1, cy, '#b9b2a4');
}

/** Impressora 3D de moldura (vista de frente) com a peça na mesa. Devolve o painel (tela) da base. */
function printerFront(b: PixelBuf, fil: string): Box {
  // Postes e travessa de ferro.
  for (const x of [7, 23]) {
    b.rect(x, -19, 2, 11, IRON.base);
    b.vline(x, -19, -9, IRON.lt);
  }
  b.rect(7, -19, 18, 2, IRON.base);
  b.hline(7, 24, -19, IRON.lt);
  b.vline(24, -19, -9, IRON.dk);
  // Guias do carro e cabeçote de latão com o bico quente.
  b.hline(9, 22, -16, '#b9bcc4');
  b.hline(9, 22, -15, '#7d808a');
  b.rect(13, -17, 5, 4, BRASS.base);
  b.hline(13, 17, -17, BRASS.hi);
  b.vline(17, -17, -14, BRASS.dk);
  b.set(15, -13, '#3a2a20');
  b.set(15, -12, '#ff9a3c');
  // Peça subindo na mesa aquecida.
  b.rect(13, -11, 5, 1, shade(fil, 0.12));
  b.rect(13, -10, 5, 1, fil);
  b.rect(9, -9, 14, 1, '#d6d0c2');
  b.hline(9, 22, -8, '#a59f92');
  // Base com o painel e o botão.
  frontFace(b, 7, -7, 18, 6, IRON);
  b.hline(7, 24, -7, IRON.lt);
  const screen = { x: 9, y: -6, w: 9, h: 4 };
  b.rect(screen.x - 1, screen.y - 1, screen.w + 2, screen.h + 2, '#2a2c32');
  b.rect(screen.x, screen.y, screen.w, screen.h, '#22324f');
  b.rect(20, -5, 2, 2, BRASS.lt);
  b.set(20, -5, BRASS.hi);
  for (const x of [8, 23]) b.set(x, -3, BRASS.base);
  return screen;
}

/** Bancada com impressora 3D, rolo de filamento e uma miudeza por semente (caneca, vela, peças, ferramentas). */
export function desk(variant: string | undefined, seed: number): BufFurniture {
  const s = floorSheet(2, 1, 20);
  const b = s.buf;
  const r = rngOf(seed, 11);
  const fil = pick(r, FILAMENT);
  bench(s, benchMats(variant), seed, false);
  // Rolo à direita e o fio até o cabeçote.
  spool(b, 28, -7, 3.5, fil);
  b.line(26, -9, 18, -16, shade(fil, -0.1));
  const screen = printerFront(b, fil);
  switch (seed % 4) {
    case 1: {
      // Vela.
      b.rect(2, -5, 2, 4, '#efe6cf');
      b.set(2, -5, '#fff8e6');
      b.set(2, -7, '#ffd36b');
      b.set(3, -6, '#ff9a3c');
      b.set(2, -6, '#ffe9a8');
      b.hline(1, 4, -1, '#8a8378');
      break;
    }
    case 2: {
      // Peças prontas.
      b.rect(1, -3, 2, 3, pick(r, ACCENTS));
      b.rect(4, -2, 2, 2, pick(r, ACCENTS));
      b.rect(2, 1, 3, 2, pick(r, ACCENTS));
      break;
    }
    case 3: {
      // Martelo e lima.
      b.hline(1, 5, -2, '#8a5a3b');
      b.rect(5, -3, 2, 3, IRON.lt);
      b.line(1, 2, 5, 0, '#9aa0aa');
      break;
    }
    default:
      mug(b, 2, -2, '#8a5a3b');
  }
  b.outline();
  benchShadow(b);
  s.rects = { screen: rectAt(s, screen.x, screen.y, screen.w, screen.h) };
  return { base: s };
}

/** A mesma bancada vista do outro lado: o verso da impressora, com o rolo pendurado atrás. */
export function deskBack(variant: string | undefined, seed: number): BufFurniture {
  const s = floorSheet(2, 1, 12);
  const b = s.buf;
  const r = rngOf(seed, 12);
  const fil = pick(r, FILAMENT);
  bench(s, benchMats(variant), seed, true);
  for (const x of [8, 22]) {
    b.rect(x, -11, 2, 9, IRON.dk);
    b.vline(x, -11, -3, IRON.base);
  }
  b.rect(8, -11, 16, 2, IRON.base);
  b.hline(8, 23, -11, IRON.lt);
  frontFace(b, 8, -4, 16, 4, IRON);
  b.hline(8, 23, -4, IRON.dk);
  spool(b, 16, -6, 3.5, fil);
  if (seed % 2) mug(b, 2, 0, '#8a5a3b');
  else {
    b.rect(26, -2, 4, 3, '#e9dcb8');
    b.hline(26, 29, -2, '#f6ecd0');
    b.vline(29, -2, 0, '#c9b88f');
  }
  b.outline();
  benchShadow(b);
  return { base: s };
}

// ------------------------------------------------------------------ assentos

const CUSHION: Readonly<Record<string, string>> = {
  black: '#5b4a3e',
  blue: '#3f5f93',
  red: '#a8413b',
  green: '#4a7a46',
  gray: '#8a7f70',
};

function cushionRamp(variant: string | undefined): Ramp {
  return ramp(CUSHION[variant ?? 'black'] ?? CUSHION.black, 0.07);
}

const CHAIR_WOOD = ramp('#7a5034', 0.07);

/** Cadeira de madeira vista por trás: assento com almofada (base) e encosto de travessas (front). */
export function chair(variant: string | undefined): BufFurniture {
  const c = cushionRamp(variant);
  const w = CHAIR_WOOD;
  const base = floorSheet(1, 1, 6);
  const b = base.buf;
  for (const x of [3, 11]) {
    b.rect(x, 9, 2, 6, w.dk);
    b.vline(x, 9, 14, w.base);
  }
  b.hline(5, 10, 12, w.dd);
  b.rect(2, 5, 12, 4, w.base);
  b.hline(2, 13, 5, w.lt);
  b.hline(2, 13, 8, w.dk);
  b.hline(2, 13, 9, w.dd);
  b.rect(3, 3, 10, 3, c.lt);
  b.hline(4, 11, 3, c.hi);
  b.outline();
  contact(b, 1, 13, 14, 3, 0.22);
  const front = floorSheet(1, 1, 6);
  const f = front.buf;
  for (const x of [4, 11]) {
    f.rect(x, 6, 1, 8, w.base);
    f.set(x, 6, w.lt);
  }
  f.rect(4, 6, 8, 2, w.base);
  f.hline(4, 11, 6, w.lt);
  f.hline(5, 10, 10, w.dk);
  f.hline(5, 10, 11, w.dd);
  f.outline();
  return { base, front };
}

/** Cadeira de madeira de frente: espaldar alto de travessas, almofada e pés. */
export function chairFront(variant: string | undefined): BufFurniture {
  const c = cushionRamp(variant);
  const w = CHAIR_WOOD;
  const s = floorSheet(1, 1, 10);
  const b = s.buf;
  for (const x of [2, 12]) {
    b.rect(x, 9, 2, 6, w.dk);
    b.vline(x, 9, 14, w.base);
  }
  for (const x of [3, 11]) {
    b.rect(x, -7, 2, 12, w.base);
    b.vline(x, -7, 4, w.lt);
  }
  b.rect(3, -7, 10, 3, w.base);
  b.hline(4, 11, -8, w.lt);
  b.hline(3, 12, -7, w.hi);
  b.hline(3, 12, -5, w.dk);
  for (const x of [6, 9]) b.vline(x, -4, 3, w.dk);
  b.rect(2, 5, 12, 4, c.lt);
  b.hline(3, 12, 5, c.hi);
  b.hline(2, 13, 8, c.dk);
  b.rect(2, 9, 12, 1, w.dk);
  b.outline();
  contact(b, 1, 13, 14, 3, 0.22);
  return { base: s };
}

// ------------------------------------------------------------------ estante, tocha e barril

/** Prateleira de madeira escura com rolos de filamento, frascos e pergaminhos. */
export function spoolShelf(seed: number): BufFurniture {
  const s = floorSheet(2, 1, 22);
  const b = s.buf;
  const w = DARK_WOOD;
  const r = rngOf(seed, 21);
  topFace(b, 0, -21, 32, 3, w);
  b.rect(0, -18, 32, 34, w.dk);
  b.rect(2, -17, 28, 31, shade(w.dd, -0.15));
  b.vline(0, -18, 15, w.lt);
  b.vline(1, -18, 15, w.base);
  b.vline(30, -18, 15, w.base);
  b.vline(31, -18, 15, w.dd);
  const shelves = [-8, 3, 15];
  for (const y of shelves) {
    b.hline(1, 30, y, w.lt);
    b.hline(1, 30, y + 1, w.dk);
  }
  b.hline(0, 31, 15, w.dd);
  for (const shelf of shelves) {
    const bottom = shelf - 1;
    let x = 3;
    while (x < 27) {
      const k = r();
      if (k < 0.16) {
        // Frasco de vidro com líquido.
        const liquid = pick(r, ['#5ec2a8', '#d86b9b', '#f2c14e', '#7c9be8']);
        b.rect(x, bottom - 4, 3, 5, 'rgba(200,225,235,0.55)');
        b.rect(x, bottom - 2, 3, 3, liquid);
        b.set(x + 1, bottom - 5, '#8a5a3b');
        b.set(x, bottom - 4, 'rgba(255,255,255,0.7)');
        x += 4;
      } else if (k < 0.26) {
        // Pergaminho enrolado.
        b.rect(x, bottom - 2, 5, 3, '#e9dcb8');
        b.vline(x, bottom - 2, bottom, '#c9b88f');
        b.vline(x + 4, bottom - 2, bottom, '#c9b88f');
        b.set(x + 2, bottom - 1, '#a8413b');
        x += 6;
      } else {
        spool(b, x + 3, bottom - 3, 3.4, pick(r, FILAMENT));
        x += 7;
      }
    }
  }
  b.outline();
  contact(b, -1, 13, 34, 4, 0.22);
  return { base: s };
}

/** Tocha num suporte de ferro (no lugar da luminária); a região `glow` é a da chama. */
export function torch(): BufFurniture {
  const s = floorSheet(1, 1, 26);
  const b = s.buf;
  b.ellipse(8, 14, 4, 1.5, IRON.dd);
  b.hline(5, 10, 13, IRON.base);
  b.vline(8, -14, 13, IRON.dk);
  b.vline(7, -14, 13, IRON.lt);
  // Braseiro.
  b.rect(4, -16, 8, 3, IRON.base);
  b.hline(4, 11, -16, IRON.lt);
  b.hline(5, 10, -13, IRON.dk);
  // Chama em camadas.
  const flame: [number, number, number, string][] = [
    [-17, 3, 10, '#d9481f'],
    [-18, 3, 10, '#e8552b'],
    [-19, 4, 10, '#f07a2c'],
    [-20, 4, 9, '#ff9a3c'],
    [-21, 5, 9, '#ffb43c'],
    [-22, 6, 8, '#ffd36b'],
    [-23, 7, 8, '#ffe9a8'],
  ];
  for (const [y, x0, x1, c] of flame) b.hline(x0, x1, y, c);
  b.hline(6, 8, -19, '#ffd36b');
  b.hline(6, 8, -18, '#fff1c2');
  b.set(7, -17, '#fff8e0');
  b.outline();
  contact(b, 3, 13, 10, 3, 0.22);
  s.rects = { glow: rectAt(s, 4, -22, 8, 6) };
  return { base: s };
}

/** Barril com aros de ferro e torneira de latão (no lugar do bebedouro): bojudo, aduelas curvas, tampa oval. */
export function barrel(): BufFurniture {
  const s = floorSheet(1, 1, 20);
  const b = s.buf;
  const w = ramp('#a3582a', 0.07);
  const hoop = { hi: '#eef0fa', lt: '#b4b8cc', dk: '#5c6078', line: '#1c2030' };
  // Silhueta: 18 px no meio, 14 px nas pontas (y = -11 a 13).
  const edge = (y: number): [number, number] => {
    const t = (y - 1) / 12;
    const inset = Math.round(2 * t * t);
    return [-1 + inset, 16 - inset];
  };
  for (let y = -11; y <= 13; y++) {
    const [l, r] = edge(y);
    b.hline(l, r, y, w.base);
    b.set(l, y, w.lt);
    b.set(l + 1, y, w.hi);
    b.set(r - 1, y, w.dk);
    b.set(r, y, shade(w.base, -0.3));
    // Aduelas: as juntas seguem o bojo.
    for (const f of [0.22, 0.42, 0.62, 0.82]) b.set(Math.round(l + f * (r - l)), y, shade(w.base, -0.22));
    b.set(Math.round(l + 0.32 * (r - l)), y, shade(w.base, 0.06));
  }
  // Aros: curvos (vistos de cima), mais baixos no meio.
  for (const y0 of [-6, 8]) {
    for (let x = -1; x <= 16; x++) {
      const [l, r] = edge(y0);
      if (x < l || x > r) continue;
      const d = (x - 7.5) / 8.5;
      const y = y0 + Math.round(1.6 * (1 - d * d));
      b.set(x, y - 1, hoop.line);
      b.set(x, y, x < 3 || x > 12 ? hoop.lt : hoop.hi);
      b.set(x, y + 1, hoop.dk);
      b.set(x, y + 2, hoop.line);
    }
  }
  // Tampa oval com tábuas.
  const lid = ramp('#b8682f', 0.06);
  const lidRows: [number, number, number][] = [
    [-15, 3, 12],
    [-14, 1, 14],
    [-13, 0, 15],
    [-12, 0, 15],
    [-11, 1, 14],
    [-10, 3, 12],
  ];
  for (const [y, l, r] of lidRows) {
    b.hline(l, r, y, shade(w.base, -0.32));
    if (y > -15 && y < -10) b.hline(l + 1, r - 1, y, lid.base);
  }
  b.hline(3, 12, -14, lid.lt);
  b.hline(1, 14, -12, shade(lid.base, -0.12));
  b.hline(4, 9, -13, lid.hi);
  // Torneira de latão.
  b.rect(7, 2, 2, 2, BRASS.base);
  b.set(7, 2, BRASS.hi);
  b.set(8, 4, BRASS.dk);
  b.set(8, 5, '#7cc0e8');
  b.outline();
  contact(b, 0, 13, 16, 4, 0.24);
  return { base: s };
}
