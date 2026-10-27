import { describe, expect, it } from 'vitest';
import type { UiContext } from './context';
import { officeIsEmpty } from './overlays';

const ctxWith = (rooms: Array<{ fixed?: true }>, agents: unknown[] = []) =>
  ({ store: { connection: 'open', replaying: false, snapshot: { rooms, agents } } }) as unknown as UiContext;

describe('officeIsEmpty', () => {
  it('salas fixas (HABBLAUD_FIXED_ROOMS) sozinhas não tiram o aviso de escritório vazio', () => {
    expect(officeIsEmpty(ctxWith([]))).toBe(true);
    expect(officeIsEmpty(ctxWith([{ fixed: true }, { fixed: true }]))).toBe(true);
    expect(officeIsEmpty(ctxWith([{ fixed: true }, {}]))).toBe(false);
    expect(officeIsEmpty(ctxWith([{ fixed: true }], [{ id: 'a' }]))).toBe(false);
  });
});
