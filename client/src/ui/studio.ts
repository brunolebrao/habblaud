// Estúdio (botão do quadro na barra do topo; opcional, HABBLAUD_STUDIO=1): pede imagens ao Codex e mostra a galeria
// de ~/estudio/<projeto>/<data>/. O pedido é um projeto e um prompt (um agente do Claude pode escrever o prompt e
// mandar para POST /api/studio); a imagem leva de 1 a 3 minutos e aparece na galeria com o prompt e o modelo.
// Dados de GET /api/studio (server/studio/studio.ts); as imagens, de /api/studio/file/<projeto>/<data>/<nome>.
import { tr } from '../../../shared/i18n';
import { access } from '../net/access';
import type { UiComponent, UiContext } from './context';
import { copyText, h, iconButton, setHidden, setText } from './dom';
import { relativeTime } from './format';
import { ICONS } from './icons';

export const STUDIO_URL = '/api/studio';
const POLL_IDLE_MS = 30_000;
const POLL_BUSY_MS = 4_000;
const PROJECT_KEY = 'habblaud.studio.project';

export interface StudioJobView {
  id: string;
  project: string;
  prompt: string;
  status: 'queued' | 'sent' | 'done' | 'failed';
  at: number;
  file?: string;
  error?: string;
}

export interface StudioItemView {
  file: string;
  project: string;
  date: string;
  prompt?: string;
  model?: string;
  at: number;
}

export interface StudioState {
  available: boolean;
  jobs: StudioJobView[];
  items: StudioItemView[];
}

const FILE_RE = /^[a-z0-9][a-z0-9-]{0,39}\/\d{4}-\d{2}-\d{2}\/[\w.-]{1,120}$/;

/** Confere a resposta de GET /api/studio (o que não bate fica de fora). */
export function parseStudio(raw: unknown): StudioState {
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const jobs = (Array.isArray(o.jobs) ? o.jobs : []).flatMap((j): StudioJobView[] => {
    const x = j && typeof j === 'object' ? (j as Record<string, unknown>) : {};
    const status = x.status;
    if (typeof x.id !== 'string' || !['queued', 'sent', 'done', 'failed'].includes(status as string)) return [];
    const file = str(x.file);
    return [{ id: x.id, project: str(x.project) ?? '', prompt: str(x.prompt) ?? '', status: status as StudioJobView['status'], at: Number(x.at) || 0, file: file && FILE_RE.test(file) ? file : undefined, error: str(x.error) }];
  });
  const items = (Array.isArray(o.items) ? o.items : []).flatMap((i): StudioItemView[] => {
    const x = i && typeof i === 'object' ? (i as Record<string, unknown>) : {};
    const file = str(x.file);
    if (!file || !FILE_RE.test(file)) return [];
    return [{ file, project: str(x.project) ?? file.split('/')[0]!, date: str(x.date) ?? file.split('/')[1]!, prompt: str(x.prompt), model: str(x.model), at: Number(x.at) || 0 }];
  });
  return { available: o.available === true, jobs, items };
}

function readProject(): string {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? '';
  } catch {
    return '';
  }
}

export function fileUrl(file: string): string {
  return `${STUDIO_URL}/file/${file.split('/').map(encodeURIComponent).join('/')}`;
}

/** Projetos da galeria, do usado mais recentemente para o mais antigo. */
export function projectsOf(items: readonly StudioItemView[]): string[] {
  return [...new Set(items.map((i) => i.project))];
}

export class Studio implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  private project: HTMLInputElement;
  private projects: HTMLDataListElement;
  private prompt: HTMLTextAreaElement;
  private submitBtn: HTMLButtonElement;
  private status: HTMLElement;
  private jobsEl: HTMLElement;
  private grid: HTMLElement;
  private empty: HTMLElement;
  private state: StudioState = { available: false, jobs: [], items: [] };
  private enabled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private sending = false;

  constructor(private ctx: UiContext) {
    this.button = iconButton(ICONS.studio, tr('Estúdio: imagens geradas pelo Codex'), () => this.toggle(), 'ui-btn-studio');
    this.button.setAttribute('aria-haspopup', 'dialog');
    setHidden(this.button, true);
    this.project = h('input', { class: 'ui-rename__input', type: 'text', attrs: { list: 'ui-studio-projects', maxlength: '40', placeholder: tr('projeto (ex.: lebre-hq)'), 'aria-label': tr('Projeto') } }) as HTMLInputElement;
    this.project.value = readProject();
    this.projects = h('datalist', { attrs: { id: 'ui-studio-projects' } }) as HTMLDataListElement;
    this.prompt = h('textarea', { class: 'ui-rename__input ui-studio__prompt', attrs: { rows: '4', maxlength: '4000', placeholder: tr('Descreva a imagem: assunto, estilo, cores, enquadramento…'), 'aria-label': tr('Prompt da imagem') } }) as HTMLTextAreaElement;
    this.submitBtn = h('button', { class: 'ui-btn ui-btn--primary', type: 'submit', text: tr('Gerar imagem') }) as HTMLButtonElement;
    this.status = h('p', { class: 'ui-studio__status', attrs: { role: 'status' } });
    const form = h('form', { class: 'ui-studio__form' }, this.project, this.projects, this.prompt, h('div', { class: 'ui-studio__actions' }, this.submitBtn, this.status));
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      void this.submit();
    });
    this.jobsEl = h('ul', { class: 'ui-studio__jobs' });
    this.grid = h('div', { class: 'ui-studio__grid' });
    this.empty = h('p', { class: 'ui-studio__empty', text: tr('Nenhuma imagem ainda. As geradas ficam em ~/estudio/<projeto>/<data>/.') });
    this.el = h(
      'div',
      { class: 'ui-popover ui-studio', role: 'dialog', tabIndex: -1, attrs: { 'aria-label': tr('Estúdio'), id: 'ui-studio', popover: 'auto' } },
      h('div', { class: 'ui-popover__head' }, h('h2', { text: tr('Estúdio') }), iconButton(ICONS.close, tr('Fechar'), () => this.hide(), 'ui-icon-btn--sm')),
      form,
      this.jobsEl,
      this.empty,
      this.grid,
    );
    this.el.addEventListener('toggle', () => this.schedule());
  }

  private get open(): boolean {
    try {
      return this.el.matches(':popover-open');
    } catch {
      return this.el.classList.contains('is-open');
    }
  }

  render(): void {
    const on = !!access().studio && !this.ctx.store.mock;
    if (on === this.enabled) return;
    this.enabled = on;
    setHidden(this.button, !on);
    if (!on) this.hide();
  }

  private toggle(): void {
    if (this.open) return this.hide();
    const r = this.button.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === 'function') this.el.showPopover();
    else this.el.classList.add('is-open');
    void this.refresh();
  }

  private hide(): void {
    if (typeof this.el.hidePopover === 'function' && this.open) this.el.hidePopover();
    this.el.classList.remove('is-open');
  }

  /** Enquanto aberto: atualiza rápido com imagem sendo gerada, devagar sem. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.open) return;
    const busy = this.state.jobs.some((j) => j.status === 'queued' || j.status === 'sent');
    this.timer = setTimeout(() => void this.refresh(), busy ? POLL_BUSY_MS : POLL_IDLE_MS);
  }

  private async refresh(): Promise<void> {
    try {
      const res = await fetch(STUDIO_URL, { headers: { Accept: 'application/json' } });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? tr('erro {0}', [res.status]));
      this.state = parseStudio(j);
      this.renderPanel();
    } catch (err) {
      setText(this.status, err instanceof Error ? err.message : String(err));
    }
    this.schedule();
  }

  private async submit(): Promise<void> {
    if (this.sending) return;
    const project = this.project.value.trim();
    const prompt = this.prompt.value.trim();
    if (!project || !prompt) {
      setText(this.status, tr('Escolha o projeto e escreva o prompt.'));
      return;
    }
    this.sending = true;
    this.submitBtn.disabled = true;
    setText(this.status, tr('Enviando…'));
    try {
      const res = await fetch(STUDIO_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ project, prompt }) });
      const j = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) throw new Error(j.error ?? tr('erro {0}', [res.status]));
      try {
        localStorage.setItem(PROJECT_KEY, project);
      } catch {
        // Sem localStorage: o projeto só não fica lembrado.
      }
      this.prompt.value = '';
      setText(this.status, tr('Gerando: leva de 1 a 3 minutos.'));
      await this.refresh();
    } catch (err) {
      setText(this.status, err instanceof Error ? err.message : String(err));
    } finally {
      this.sending = false;
      this.submitBtn.disabled = false;
    }
  }

  private renderPanel(): void {
    const s = this.state;
    if (!s.available) setText(this.status, tr('Sem o Codex agora: o auxiliar do computador (npm run codex:bridge) parou ou o Codex não está instalado.'));
    this.submitBtn.disabled = !s.available || this.sending;
    this.projects.replaceChildren(...projectsOf(s.items).map((p) => h('option', { attrs: { value: p } })));
    const now = Date.now();
    const jobs = s.jobs.filter((j) => j.status !== 'done');
    this.jobsEl.replaceChildren(
      ...jobs.map((j) =>
        h(
          'li',
          { class: `ui-studio__job is-${j.status}` },
          h('span', { class: 'ui-studio__job-state', text: j.status === 'failed' ? tr('Falhou') : j.status === 'sent' ? tr('Gerando…') : tr('Na fila') }),
          h('span', { class: 'ui-studio__job-text', text: `${j.project}: ${j.prompt}` }),
          ...(j.error ? [h('span', { class: 'ui-studio__job-error', text: j.error })] : []),
          h('span', { class: 'ui-studio__job-at', text: relativeTime(j.at, now) }),
        ),
      ),
    );
    setHidden(this.empty, s.items.length > 0);
    this.grid.replaceChildren(...s.items.map((i) => this.card(i)));
  }

  private card(i: StudioItemView): HTMLElement {
    const url = fileUrl(i.file);
    const img = h('img', { attrs: { src: url, alt: i.prompt?.slice(0, 120) ?? i.file, loading: 'lazy' } });
    const link = h('a', { class: 'ui-studio__thumb', attrs: { href: url, target: '_blank', rel: 'noopener noreferrer', title: i.prompt ?? i.file } }, img);
    const copy = iconButton(ICONS.copy, tr('Copiar o prompt'), () => void copyText(i.prompt ?? ''), 'ui-icon-btn--sm');
    setHidden(copy, !i.prompt);
    return h(
      'figure',
      { class: 'ui-studio__item' },
      link,
      h('figcaption', {}, h('span', { class: 'ui-studio__meta', text: `${i.project} · ${i.date}${i.model ? ` · ${i.model}` : ''}` }), copy),
    );
  }
}
