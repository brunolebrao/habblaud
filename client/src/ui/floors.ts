// Seletor de andares (barra do topo): um botão por computador (este e os de HABBLAUD_PEERS, server/peers/), com quem
// espera você em cada um. Some quando há só este computador. Trocar de andar remonta o prédio (world/index.ts).
import type { FloorSummary } from '../net/store';
import type { UiComponent, UiContext } from './context';
import { h, setHidden } from './dom';
import { tr } from '../../../shared/i18n';

export class FloorSwitcher implements UiComponent {
  readonly el: HTMLElement;
  private key = '';

  constructor(private readonly ctx: UiContext) {
    this.el = h('div', { class: 'ui-floors', role: 'tablist', hidden: true, attrs: { 'aria-label': tr('Andares (computadores)') } });
  }

  render(): void {
    const { store } = this.ctx;
    const floors = store.floors();
    setHidden(this.el, !floors.length);
    const key = JSON.stringify([store.floor ?? '', floors]);
    if (key === this.key) return;
    this.key = key;
    this.el.replaceChildren(...floors.map((f) => this.button(f, (f.id ?? undefined) === store.floor)));
  }

  private button(f: FloorSummary, current: boolean): HTMLElement {
    const state = f.state === 'online' ? '' : f.state === 'connecting' ? tr('conectando…') : tr('fora do ar');
    const parts = [f.name];
    if (state) parts.push(state);
    if (f.error && f.state !== 'online') parts.push(f.error);
    if (f.working) parts.push(f.working === 1 ? tr('1 trabalhando') : tr('{0} trabalhando', [f.working]));
    if (f.waiting) parts.push(f.waiting === 1 ? tr('1 precisa de você') : tr('{0} precisam de você', [f.waiting]));
    const badge = f.waiting ? h('span', { class: 'ui-floor__badge', text: String(f.waiting), attrs: { 'aria-hidden': 'true' } }) : null;
    return h(
      'button',
      {
        class: `ui-floor is-${f.state}${current ? ' is-current' : ''}`,
        type: 'button',
        role: 'tab',
        title: parts.join(' · '),
        attrs: { 'aria-selected': String(current), 'aria-label': parts.join(', ') },
        on: { click: () => this.ctx.store.setFloor(f.id) },
      },
      h('span', { class: 'ui-floor__dot', attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'ui-floor__name', text: f.name }),
      ...(badge ? [badge] : []),
    );
  }
}
