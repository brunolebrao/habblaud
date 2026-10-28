// Leitura em voz alta (opcional, nas Configurações › Avisos): quando um agente principal termina, o escritório lê o
// começo da resposta dele; quando ele precisa de você, lê o motivo e a pergunta (com as opções). Usa a voz do
// sistema (speechSynthesis) no idioma da interface; nada sai do navegador. Não lê código: blocos e trechos de código,
// endereços e marcações do markdown ficam de fora. Junto com o ditado do composer (Whisper local), dá para conversar
// com o agente só pela voz.
import type { AgentInfo, OfficeSnapshot, TerminalEntry } from '../../../shared/types';
import { getLocale, tr } from '../../../shared/i18n';
import type { UiComponent, UiContext } from './context';
import { parseInit, terminalUrl } from './terminal';

/** Caracteres lidos de uma resposta (o começo costuma ser o resumo). */
export const SPEAK_MAX = 420;
/** Falas na fila: com mais, as antigas saem (vale a mais recente). */
const QUEUE_MAX = 3;
const FETCH_TIMEOUT_MS = 6_000;

const LANG_TAGS: Record<string, string> = { pt: 'pt-BR', en: 'en-US', es: 'es-ES', fr: 'fr-FR' };

/** Texto falável de uma resposta em markdown: sem código, endereços e marcações; cortado numa frase. */
export function speakableText(md: string, max = SPEAK_MAX): string {
  let t = md
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    // Trecho curto (nome de arquivo, de função) fica; código mais longo sai.
    .replace(/`([^`\n]*)`/g, (_m, code: string) => (code.length <= 24 ? code : ' '))
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/^\s*\|.*\|\s*$/gm, ' ')
    .replace(/[*_~#|>]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  t = t.slice(0, max);
  const end = Math.max(t.lastIndexOf('. '), t.lastIndexOf('! '), t.lastIndexOf('? '), t.lastIndexOf(': '));
  return end > max / 3 ? t.slice(0, end + 1) : `${t.slice(0, t.lastIndexOf(' ') > 0 ? t.lastIndexOf(' ') : max)}…`;
}

/** Última resposta do agente numa conversa (a mais recente com texto). */
export function lastAnswer(entries: readonly TerminalEntry[]): string | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.kind === 'user') return undefined;
    if (e.kind === 'assistant' && e.text.trim()) return e.text;
  }
  return undefined;
}

/** O que dizer quando um agente passa a precisar de você. */
export function waitingSpeech(a: Pick<AgentInfo, 'name' | 'waitingFor' | 'recent'>): string {
  const ask = [...a.recent].reverse().find((r) => r.kind === 'ask' && r.questions?.length);
  const q = ask?.questions?.[0];
  if (q) {
    const opts = q.options.map((o) => o.label).join(', ');
    return tr('{0} pergunta: {1}', [a.name, speakableText(q.question)]) + (opts ? ` ${tr('Opções: {0}.', [opts])}` : '');
  }
  return tr('{0} precisa de você: {1}.', [a.name, a.waitingFor ?? tr('responder no terminal')]);
}

type Change = { kind: 'done' | 'waiting'; agent: AgentInfo };

/** Agentes principais que terminaram (trabalhando → parado) ou passaram a esperar você entre dois snapshots. */
export function voiceChanges(prev: ReadonlyMap<string, string>, snap: OfficeSnapshot): Change[] {
  const out: Change[] = [];
  for (const a of snap.agents) {
    if (a.kind !== 'main') continue;
    const before = prev.get(a.id);
    if (before === undefined || before === a.status) continue;
    if (a.status === 'waiting') out.push({ kind: 'waiting', agent: a });
    else if (before === 'working' && a.status === 'idle') out.push({ kind: 'done', agent: a });
  }
  return out;
}

/** Última resposta pelo stream do terminal (evento `init`); undefined se não vier a tempo. */
function fetchLastAnswer(agentId: string): Promise<string | undefined> {
  return new Promise((ok) => {
    let es: EventSource;
    try {
      es = new EventSource(terminalUrl(agentId));
    } catch {
      return ok(undefined);
    }
    const done = (text: string | undefined) => {
      clearTimeout(timer);
      es.close();
      ok(text);
    };
    const timer = setTimeout(() => done(undefined), FETCH_TIMEOUT_MS);
    es.addEventListener('init', (ev) => done(lastAnswer(parseInit((ev as MessageEvent).data)?.entries ?? [])));
    es.addEventListener('error', () => {
      if (es.readyState === EventSource.CLOSED) done(undefined);
    });
  });
}

export class VoiceReader implements UiComponent {
  private prev = new Map<string, string>();
  private lastSnap: OfficeSnapshot | null = null;
  private pending = 0;

  constructor(private ctx: UiContext) {}

  static get supported(): boolean {
    return typeof speechSynthesis !== 'undefined' && typeof SpeechSynthesisUtterance !== 'undefined';
  }

  render(): void {
    // Ao vivo, mesmo durante o timelapse.
    const snap = this.ctx.store.liveSnapshot;
    if (!snap || snap === this.lastSnap) return;
    this.lastSnap = snap;
    const changes = this.prev.size ? voiceChanges(this.prev, snap) : [];
    this.prev = new Map(snap.agents.map((a) => [a.id, a.status]));
    if (!this.ctx.prefs.readAloud || !VoiceReader.supported) return;
    for (const c of changes) void this.announce(c);
  }

  private async announce(c: Change): Promise<void> {
    if (c.kind === 'waiting') return this.say(waitingSpeech(c.agent));
    const text = await fetchLastAnswer(c.agent.id);
    if (!text) return this.say(tr('{0} terminou.', [c.agent.name]));
    this.say(`${c.agent.name}: ${speakableText(text)}`);
  }

  /** Fala (na fila do sistema); com fila longa, descarta as antigas. */
  say(text: string): void {
    if (!VoiceReader.supported || !text.trim()) return;
    if (this.pending >= QUEUE_MAX) {
      speechSynthesis.cancel();
      this.pending = 0;
    }
    const u = new SpeechSynthesisUtterance(text);
    const lang = LANG_TAGS[getLocale()] ?? 'pt-BR';
    u.lang = lang;
    const voice = speechSynthesis.getVoices().find((v) => v.lang.replace('_', '-') === lang) ?? speechSynthesis.getVoices().find((v) => v.lang.startsWith(lang.slice(0, 2)));
    if (voice) u.voice = voice;
    this.pending++;
    u.onend = u.onerror = () => {
      this.pending = Math.max(0, this.pending - 1);
    };
    speechSynthesis.speak(u);
  }
}
