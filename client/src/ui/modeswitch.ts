// Troca do modo de permissão a qualquer hora, no painel do agente (agente principal do Claude Code). Sessão aberta
// aqui no terminal interativo: o Habblaud aperta Shift+Tab até o rodapé mostrar o modo (server/pty/mode.ts). Noutro
// terminal não dá para apertar teclas: o modo fica agendado e vale na próxima aprovação deste agente (o cartão de
// permissão aprova já passando para ele, como os botões de modo do cartão).
import { isDemoId } from '../../../shared/timeline';
import type { AgentInfo, PermissionModeChoice } from '../../../shared/types';
import { access } from '../net/access';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { providerOf } from './provider';
import { postPty } from './ptyapi';
import { tr } from '../../../shared/i18n';

export const MODE_LABELS: Array<[PermissionModeChoice, string]> = [
  ['default', tr('Manual')],
  ['acceptEdits', tr('Aceitar edições')],
  ['plan', tr('Plano')],
  ['auto', tr('Auto')],
];

/** Modo agendado por agente (vale até a próxima aprovação ou até a sessão já estar nele). */
const scheduled = new Map<string, PermissionModeChoice>();
/** Modo confirmado no rodapé pela última troca (sessão nova ainda sem conversa não diz o modo). */
const confirmed = new Map<string, string>();

export function scheduledMode(agentId: string): PermissionModeChoice | undefined {
  return scheduled.get(agentId);
}

export function clearScheduledMode(agentId: string): void {
  scheduled.delete(agentId);
}

export function modeLabel(mode: string): string {
  return MODE_LABELS.find(([m]) => m === mode)?.[1] ?? mode;
}

/** Troca o modo de uma sessão aberta aqui no terminal interativo; devolve o modo em que ela ficou. */
export async function setAgentMode(agentId: string, mode: PermissionModeChoice): Promise<string | undefined> {
  return (await postPty<{ mode: string }>(`/api/agents/${encodeURIComponent(agentId)}/mode`, { mode }))?.mode;
}

export class ModeSwitch {
  readonly el: HTMLElement;
  private btns: Array<[PermissionModeChoice, HTMLButtonElement]>;
  private note: HTMLElement;
  private agent: AgentInfo | null = null;
  private busy = false;

  constructor(private ctx: UiContext) {
    this.btns = MODE_LABELS.map(([mode, label]) => [mode, h('button', { class: 'ui-btn ui-btn--sm ui-mode__btn', type: 'button', text: label, on: { click: () => void this.pick(mode) } })]);
    this.note = h('p', { class: 'ui-mode__note', attrs: { role: 'status' } });
    this.el = h('div', { class: 'ui-mode', hidden: true }, h('span', { class: 'ui-mode__label', text: tr('Modo') }), h('div', { class: 'ui-mode__btns', attrs: { role: 'group', 'aria-label': tr('Modo de permissão') } }, ...this.btns.map(([, b]) => b)), this.note);
  }

  private interactive(id: string): boolean {
    return !!this.ctx.terminals?.interactive(id);
  }

  render(a: AgentInfo | null, live: boolean): void {
    if (a?.id !== this.agent?.id) setText(this.note, '');
    this.agent = a;
    const show = !!a && live && a.kind === 'main' && providerOf(a) === 'claude' && !isDemoId(a.id) && !this.ctx.store.replaying && (this.interactive(a.id) || access().permissions);
    setHidden(this.el, !show);
    if (!show || !a) return;
    // A sessão chegou ao modo agendado (pelo terminal ou por uma aprovação): nada mais a fazer.
    if (scheduled.get(a.id) === a.permissionMode) scheduled.delete(a.id);
    const next = scheduled.get(a.id);
    const current = a.permissionMode ?? confirmed.get(a.id);
    for (const [mode, b] of this.btns) {
      b.classList.toggle('is-on', current === mode);
      b.classList.toggle('is-next', next === mode);
      b.setAttribute('aria-pressed', String(current === mode));
      b.disabled = this.busy;
    }
  }

  private async pick(mode: PermissionModeChoice): Promise<void> {
    const a = this.agent;
    if (!a || this.busy) return;
    if (this.interactive(a.id)) {
      this.busy = true;
      setText(this.note, tr('Trocando o modo no terminal…'));
      this.ctx.invalidate();
      try {
        const now = await setAgentMode(a.id, mode);
        scheduled.delete(a.id);
        confirmed.set(a.id, now ?? mode);
        setText(this.note, tr('Modo: {0}.', [modeLabel(now ?? mode)]));
      } catch (err) {
        setText(this.note, err instanceof Error ? err.message : String(err));
      } finally {
        this.busy = false;
        this.ctx.invalidate();
      }
      return;
    }
    if (mode === a.permissionMode || scheduled.get(a.id) === mode) {
      scheduled.delete(a.id);
      setText(this.note, '');
    } else {
      scheduled.set(a.id, mode);
      setText(this.note, tr('A sessão roda em outro terminal: passa para {0} na próxima aprovação dela aqui.', [modeLabel(mode)]));
    }
    this.ctx.invalidate();
  }
}
