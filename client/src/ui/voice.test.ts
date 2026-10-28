import { describe, expect, it } from 'vitest';
import type { AgentInfo, OfficeSnapshot, TerminalEntry } from '../../../shared/types';
import { lastAnswer, speakableText, voiceChanges, waitingSpeech } from './voice';

describe('speakableText', () => {
  it('tira código, endereços e marcações', () => {
    const md = '## Pronto\n\nCorrigi o **login** em `auth.ts`:\n\n```ts\nconst x = 1;\n```\n\n- Veja https://github.com/a/b/pull/3\n- [Docs](https://x.dev)';
    expect(speakableText(md)).toBe('Pronto Corrigi o login em auth.ts: Veja Docs');
  });

  it('corta numa frase', () => {
    const t = speakableText(`${'Primeira frase longa aqui. '.repeat(10)}Fim`, 100);
    expect(t.endsWith('.')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(100);
  });
});

describe('lastAnswer', () => {
  const e = (kind: 'user' | 'assistant', text: string, id = text): TerminalEntry => ({ kind, id, at: 0, text });

  it('a resposta mais recente depois do último pedido', () => {
    expect(lastAnswer([e('user', 'oi'), e('assistant', 'um'), e('assistant', 'dois')])).toBe('dois');
    expect(lastAnswer([e('assistant', 'velha'), e('user', 'nova pergunta')])).toBeUndefined();
  });
});

describe('waitingSpeech', () => {
  it('lê a pergunta com as opções', () => {
    const a = {
      name: 'Ana',
      waitingFor: 'responder uma pergunta',
      recent: [{ id: '1', kind: 'ask', icon: '', text: '', at: 0, questions: [{ index: 0, question: 'Qual banco?', options: [{ index: 0, label: 'Postgres' }, { index: 1, label: 'SQLite' }] }] }],
    } as unknown as AgentInfo;
    expect(waitingSpeech(a)).toBe('Ana pergunta: Qual banco? Opções: Postgres, SQLite.');
  });

  it('sem pergunta: o motivo', () => {
    expect(waitingSpeech({ name: 'Bia', waitingFor: 'aprovar uma permissão', recent: [] })).toBe('Bia precisa de você: aprovar uma permissão.');
  });
});

describe('voiceChanges', () => {
  const snap = (agents: Array<Partial<AgentInfo>>) => ({ agents }) as unknown as OfficeSnapshot;

  it('terminou (trabalhando → parado) e passou a esperar; subagentes e novatos ficam de fora', () => {
    const prev = new Map([
      ['a', 'working'],
      ['b', 'working'],
      ['c', 'working'],
      ['d', 'idle'],
    ]);
    const out = voiceChanges(
      prev,
      snap([
        { id: 'a', kind: 'main', status: 'idle' },
        { id: 'b', kind: 'main', status: 'waiting' },
        { id: 'c', kind: 'sub', status: 'idle' },
        { id: 'd', kind: 'main', status: 'idle' },
        { id: 'e', kind: 'main', status: 'waiting' },
      ]),
    );
    expect(out.map((c) => [c.kind, c.agent.id])).toEqual([
      ['done', 'a'],
      ['waiting', 'b'],
    ]);
  });
});
