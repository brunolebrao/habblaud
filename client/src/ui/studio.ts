// Estúdio (botão do quadro na barra do topo; opcional, HABBLAUD_STUDIO=1): imagens geradas pelo Codex, organizadas em
// projetos (Funkos, D&D, miniaturas, cenários…). O início mostra os projetos (capa, descrição, quantas imagens e
// quantos pedidos esperando você); dentro de um projeto ficam os pedidos dos agentes esperando aprovação (título e
// prompt editáveis), o formulário para gerar e a galeria só dele. O guia de estilo do projeto vai junto em todo prompt.
// O painel reabre no último projeto. Dados de GET /api/studio (server/studio/studio.ts); as imagens, de
// /api/studio/file/<projeto>/<data>/<nome>. Gerar, aprovar, descartar e mexer nos projetos mandam o cabeçalho do painel.
import { tr } from "../../../shared/i18n";
import { access } from "../net/access";
import type { UiComponent, UiContext } from "./context";
import { copyText, h, iconButton, setHidden, setText } from "./dom";
import { relativeTime } from "./format";
import { ICONS } from "./icons";

export const STUDIO_URL = "/api/studio";
const POLL_IDLE_MS = 30_000;
const POLL_BUSY_MS = 4_000;
const PROJECT_KEY = "habblaud.studio.project";
const PANEL_HEADERS = {
  "Content-Type": "application/json",
  "X-Habblaud-Studio": "panel",
};

export interface StudioJobView {
  id: string;
  project: string;
  title: string;
  prompt: string;
  status: "pending" | "queued" | "sent" | "done" | "failed";
  at: number;
  requestedBy?: string;
  file?: string;
  error?: string;
}

export interface StudioItemView {
  file: string;
  project: string;
  date: string;
  title?: string;
  prompt?: string;
  model?: string;
  at: number;
}

export interface StudioProjectView {
  slug: string;
  name: string;
  description?: string;
  style?: string;
  count: number;
  cover?: string;
  pending: number;
  updatedAt: number;
}

export interface StudioState {
  available: boolean;
  projects: StudioProjectView[];
  jobs: StudioJobView[];
  items: StudioItemView[];
}

const FILE_RE = /^[a-z0-9][a-z0-9-]{0,39}\/\d{4}-\d{2}-\d{2}\/[\w.-]{1,120}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const STATUSES = ["pending", "queued", "sent", "done", "failed"];

const rec = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};
const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
const file = (v: unknown) => {
  const f = str(v);
  return f && FILE_RE.test(f) ? f : undefined;
};

/** Confere a resposta de GET /api/studio (o que não bate fica de fora). */
export function parseStudio(raw: unknown): StudioState {
  const o = rec(raw);
  const list = (v: unknown) => (Array.isArray(v) ? v : []);
  const jobs = list(o.jobs).flatMap((j): StudioJobView[] => {
    const x = rec(j);
    if (typeof x.id !== "string" || !STATUSES.includes(x.status as string))
      return [];
    return [
      {
        id: x.id,
        project: str(x.project) ?? "",
        title: str(x.title) ?? "",
        prompt: str(x.prompt) ?? "",
        status: x.status as StudioJobView["status"],
        at: Number(x.at) || 0,
        requestedBy: str(x.requestedBy),
        file: file(x.file),
        error: str(x.error),
      },
    ];
  });
  const items = list(o.items).flatMap((i): StudioItemView[] => {
    const x = rec(i);
    const f = file(x.file);
    if (!f) return [];
    return [
      {
        file: f,
        project: str(x.project) ?? f.split("/")[0]!,
        date: str(x.date) ?? f.split("/")[1]!,
        title: str(x.title),
        prompt: str(x.prompt),
        model: str(x.model),
        at: Number(x.at) || 0,
      },
    ];
  });
  const projects = list(o.projects).flatMap((p): StudioProjectView[] => {
    const x = rec(p);
    const slug = str(x.slug);
    if (!slug || !SLUG_RE.test(slug)) return [];
    return [
      {
        slug,
        name: str(x.name) ?? slug,
        description: str(x.description),
        style: str(x.style),
        count: Number(x.count) || 0,
        cover: file(x.cover),
        pending: Number(x.pending) || 0,
        updatedAt: Number(x.updatedAt) || 0,
      },
    ];
  });
  return { available: o.available === true, projects, jobs, items };
}

export function fileUrl(f: string): string {
  return `${STUDIO_URL}/file/${f.split("/").map(encodeURIComponent).join("/")}`;
}

/** Pedidos esperando você em todos os projetos (o selo do botão). */
export function pendingTotal(projects: readonly StudioProjectView[]): number {
  return projects.reduce((n, p) => n + p.pending, 0);
}

function remembered(): string {
  try {
    return localStorage.getItem(PROJECT_KEY) ?? "";
  } catch {
    return "";
  }
}

function remember(slug: string): void {
  try {
    if (slug) localStorage.setItem(PROJECT_KEY, slug);
    else localStorage.removeItem(PROJECT_KEY);
  } catch {
    // Sem localStorage: o painel só não reabre no projeto.
  }
}

async function call(url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    headers: { Accept: "application/json", ...PANEL_HEADERS },
    ...init,
  });
  const j = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(j.error ?? tr("erro {0}", [res.status]));
  return j;
}

const input = (attrs: Record<string, string>, value = "") => {
  const el = h("input", {
    class: "ui-rename__input",
    type: "text",
    attrs,
  }) as HTMLInputElement;
  el.value = value;
  return el;
};
const area = (attrs: Record<string, string>, value = "") => {
  const el = h("textarea", {
    class: "ui-rename__input ui-studio__prompt",
    attrs: { rows: "4", ...attrs },
  }) as HTMLTextAreaElement;
  el.value = value;
  return el;
};

export class Studio implements UiComponent {
  readonly button: HTMLButtonElement;
  readonly el: HTMLElement;
  private badge: HTMLElement;
  private title: HTMLElement;
  private back: HTMLButtonElement;
  private status: HTMLElement;
  private body: HTMLElement;
  private state: StudioState = {
    available: false,
    projects: [],
    jobs: [],
    items: [],
  };
  /** Projeto aberto ('' = início). */
  private project = remembered();
  private enabled = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private busy = false;
  /** Rascunhos (formulários abertos não são refeitos a cada atualização). */
  private editing = false;
  private lastKey = "";

  constructor(private ctx: UiContext) {
    this.badge = h("span", { class: "ui-studio-badge", hidden: true });
    this.button = iconButton(
      ICONS.studio,
      tr("Estúdio: imagens geradas pelo Codex"),
      () => this.toggle(),
      "ui-btn-studio",
    );
    this.button.append(this.badge);
    this.button.setAttribute("aria-haspopup", "dialog");
    setHidden(this.button, true);
    this.title = h("h2", { text: tr("Estúdio") });
    this.back = h("button", {
      class: "ui-btn ui-btn--sm",
      type: "button",
      text: tr("‹ Projetos"),
      on: { click: () => this.go("") },
    }) as HTMLButtonElement;
    this.status = h("p", {
      class: "ui-studio__status",
      attrs: { role: "status" },
    });
    this.body = h("div", { class: "ui-studio__body" });
    this.el = h(
      "div",
      {
        class: "ui-popover ui-studio",
        role: "dialog",
        tabIndex: -1,
        attrs: {
          "aria-label": tr("Estúdio"),
          id: "ui-studio",
          popover: "auto",
        },
      },
      h(
        "div",
        { class: "ui-popover__head" },
        this.back,
        this.title,
        iconButton(
          ICONS.close,
          tr("Fechar"),
          () => this.hide(),
          "ui-icon-btn--sm",
        ),
      ),
      this.status,
      this.body,
    );
    this.el.addEventListener("toggle", () => this.schedule());
  }

  private get open(): boolean {
    try {
      return this.el.matches(":popover-open");
    } catch {
      return this.el.classList.contains("is-open");
    }
  }

  render(): void {
    const on = !!access().studio && !this.ctx.store.mock;
    if (on === this.enabled) return;
    this.enabled = on;
    setHidden(this.button, !on);
    if (on) void this.refresh();
    else this.hide();
  }

  private toggle(): void {
    if (this.open) return this.hide();
    const r = this.button.getBoundingClientRect();
    this.el.style.top = `${Math.round(r.bottom + 8)}px`;
    this.el.style.right = `${Math.max(8, Math.round(innerWidth - r.right - 4))}px`;
    if (typeof this.el.showPopover === "function") this.el.showPopover();
    else this.el.classList.add("is-open");
    this.editing = false;
    this.lastKey = "";
    void this.refresh();
  }

  private hide(): void {
    if (typeof this.el.hidePopover === "function" && this.open)
      this.el.hidePopover();
    this.el.classList.remove("is-open");
  }

  private go(slug: string): void {
    this.project = slug;
    remember(slug);
    this.editing = false;
    this.lastKey = "";
    setText(this.status, "");
    void this.refresh();
  }

  /** Aberto: rápido com imagem sendo gerada, devagar sem. Fechado: devagar, só para o selo. */
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.enabled) return;
    const working = this.state.jobs.some(
      (j) => j.status === "queued" || j.status === "sent",
    );
    this.timer = setTimeout(
      () => void this.refresh(),
      this.open && working ? POLL_BUSY_MS : POLL_IDLE_MS,
    );
  }

  private async refresh(): Promise<void> {
    try {
      const q = this.project
        ? `?project=${encodeURIComponent(this.project)}`
        : "";
      this.state = parseStudio(await call(`${STUDIO_URL}${q}`));
      // Projeto que sumiu (pasta apagada): volta ao início.
      if (
        this.project &&
        !this.state.projects.some((p) => p.slug === this.project)
      )
        this.go("");
      this.renderBadge();
      if (this.open) this.renderPanel();
    } catch (err) {
      if (this.open)
        setText(this.status, err instanceof Error ? err.message : String(err));
    }
    this.schedule();
  }

  private renderBadge(): void {
    const n = pendingTotal(this.state.projects);
    setText(this.badge, n > 9 ? "9+" : String(n));
    setHidden(this.badge, n === 0);
    this.button.title = n
      ? tr("Estúdio: {0} pedido(s) de imagem esperando você", [n])
      : tr("Estúdio: imagens geradas pelo Codex");
  }

  private async act(
    work: () => Promise<unknown>,
    done?: string,
  ): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    setText(this.status, tr("Enviando…"));
    try {
      await work();
      setText(this.status, done ?? "");
      this.editing = false;
      this.lastKey = "";
      await this.refresh();
    } catch (err) {
      setText(this.status, err instanceof Error ? err.message : String(err));
    } finally {
      this.busy = false;
    }
  }

  private renderPanel(): void {
    const s = this.state;
    const p = s.projects.find((x) => x.slug === this.project);
    setHidden(this.back, !p);
    setText(this.title, p ? p.name : tr("Estúdio"));
    if (!s.available && !this.status.textContent)
      setText(
        this.status,
        tr(
          "Sem o Codex agora: o auxiliar do computador (npm run codex:bridge) parou ou o Codex não está instalado.",
        ),
      );
    // Com um formulário sendo preenchido, não refaz a tela (só quando algo muda de verdade).
    const key = JSON.stringify([
      this.project,
      s.available,
      s.projects,
      s.jobs.map((j) => [j.id, j.status, j.error]),
      s.items.map((i) => i.file),
    ]);
    if (key === this.lastKey || this.editing) return;
    this.lastKey = key;
    this.body.replaceChildren(...(p ? this.projectView(p) : this.home()));
  }

  // ------------------------------------------------------------ início: os projetos

  private home(): HTMLElement[] {
    const cards = this.state.projects.map((p) =>
      h(
        "button",
        {
          class: "ui-studio__project",
          type: "button",
          on: { click: () => this.go(p.slug) },
        },
        h(
          "span",
          { class: "ui-studio__cover" },
          ...(p.cover
            ? [
                h("img", {
                  attrs: { src: fileUrl(p.cover), alt: "", loading: "lazy" },
                }),
              ]
            : [
                h("span", {
                  class: "ui-studio__cover-empty",
                  text: p.name.slice(0, 1).toUpperCase(),
                }),
              ]),
        ),
        h("span", { class: "ui-studio__project-name", text: p.name }),
        h("span", {
          class: "ui-studio__project-meta",
          text: tr("{0} imagem(ns)", [p.count]),
        }),
        ...(p.description
          ? [
              h("span", {
                class: "ui-studio__project-desc",
                text: p.description,
              }),
            ]
          : []),
        ...(p.pending
          ? [
              h("span", {
                class: "ui-studio__pending-chip",
                text: tr("{0} esperando você", [p.pending]),
              }),
            ]
          : []),
      ),
    );
    const add = h("button", {
      class: "ui-studio__project ui-studio__project--new",
      type: "button",
      text: tr("+ Novo projeto"),
    });
    const grid = h("div", { class: "ui-studio__projects" }, ...cards, add);
    const form = this.projectForm(undefined, () => {
      setHidden(form, true);
      setHidden(add, false);
      this.editing = false;
    });
    setHidden(form, true);
    add.addEventListener("click", () => {
      setHidden(form, false);
      setHidden(add, true);
      this.editing = true;
      form.querySelector("input")?.focus();
    });
    const empty = this.state.projects.length
      ? []
      : [
          h("p", {
            class: "ui-studio__empty",
            text: tr(
              "Crie um projeto para cada tema (Funkos, D&D, miniaturas, cenários…). Cada um tem a sua galeria e o seu guia de estilo.",
            ),
          }),
        ];
    return [...empty, grid, form];
  }

  /** Criar (sem `p`) ou editar um projeto. */
  private projectForm(
    p: StudioProjectView | undefined,
    cancel: () => void,
  ): HTMLElement {
    const name = input(
      {
        maxlength: "40",
        placeholder: tr("Nome (ex.: Funkos, D&D RPG, Miniaturas)"),
        "aria-label": tr("Nome do projeto"),
      },
      p?.name,
    );
    const description = input(
      {
        maxlength: "300",
        placeholder: tr("Descrição (opcional)"),
        "aria-label": tr("Descrição do projeto"),
      },
      p?.description,
    );
    const style = area(
      {
        maxlength: "1000",
        rows: "3",
        placeholder: tr(
          "Guia de estilo, somado a todo prompt deste projeto (ex.: Funko Pop, vinil, cabeça grande, fundo neutro, luz de estúdio)",
        ),
        "aria-label": tr("Guia de estilo"),
      },
      p?.style,
    );
    const form = h(
      "form",
      { class: "ui-studio__form" },
      name,
      description,
      style,
      h(
        "div",
        { class: "ui-studio__actions" },
        h("button", {
          class: "ui-btn ui-btn--primary",
          type: "submit",
          text: p ? tr("Salvar") : tr("Criar projeto"),
        }),
        h("button", {
          class: "ui-btn",
          type: "button",
          text: tr("Cancelar"),
          on: { click: cancel },
        }),
      ),
    );
    form.addEventListener("input", () => {
      this.editing = true;
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void this.act(
        async () => {
          const saved = rec(
            await call(`${STUDIO_URL}/projects`, {
              method: "POST",
              body: JSON.stringify({
                slug: p?.slug,
                name: name.value,
                description: description.value,
                style: style.value,
              }),
            }),
          );
          if (!p && typeof saved.slug === "string") {
            this.project = saved.slug;
            remember(saved.slug);
          }
        },
        p ? tr("Projeto salvo.") : tr("Projeto criado."),
      );
    });
    return form;
  }

  // ------------------------------------------------------------ dentro de um projeto

  private projectView(p: StudioProjectView): HTMLElement[] {
    const s = this.state;
    const info = h(
      "div",
      { class: "ui-studio__info" },
      ...(p.description
        ? [h("p", { class: "ui-studio__project-desc", text: p.description })]
        : []),
      h("p", {
        class: "ui-studio__style",
        text: p.style
          ? tr("Estilo: {0}", [p.style])
          : tr("Sem guia de estilo: os prompts vão como estão."),
      }),
    );
    const edit = h("button", {
      class: "ui-btn ui-btn--sm",
      type: "button",
      text: tr("Editar projeto"),
    });
    const editForm = this.projectForm(p, () => {
      setHidden(editForm, true);
      setHidden(info, false);
      setHidden(edit, false);
      this.editing = false;
    });
    setHidden(editForm, true);
    edit.addEventListener("click", () => {
      setHidden(editForm, false);
      setHidden(info, true);
      setHidden(edit, true);
      this.editing = true;
    });

    const pending = s.jobs.filter((j) => j.status === "pending");
    const pendingSec = pending.length
      ? [
          h("h3", {
            class: "ui-studio__h",
            text: tr("Esperando você ({0})", [pending.length]),
          }),
          ...pending.map((j) => this.pendingCard(j)),
        ]
      : [];

    const title = input({
      maxlength: "80",
      placeholder: tr("Título (ex.: Mago anão com martelo)"),
      "aria-label": tr("Título da imagem"),
    });
    const prompt = area({
      maxlength: "4000",
      placeholder: tr(
        "Descreva a imagem: assunto, pose, cores, enquadramento…",
      ),
      "aria-label": tr("Prompt da imagem"),
    });
    const go = h("button", {
      class: "ui-btn ui-btn--primary",
      type: "submit",
      text: tr("Gerar imagem"),
    }) as HTMLButtonElement;
    go.disabled = !s.available;
    const form = h(
      "form",
      { class: "ui-studio__form" },
      h("h3", { class: "ui-studio__h", text: tr("Nova imagem") }),
      title,
      prompt,
      h("div", { class: "ui-studio__actions" }, go),
    );
    form.addEventListener("input", () => {
      this.editing = !!(title.value || prompt.value);
    });
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (!prompt.value.trim())
        return void setText(this.status, tr("Escreva o prompt."));
      void this.act(
        () =>
          call(STUDIO_URL, {
            method: "POST",
            body: JSON.stringify({
              project: p.slug,
              title: title.value,
              prompt: prompt.value,
            }),
          }),
        tr("Gerando: leva de 1 a 3 minutos."),
      );
    });

    const now = Date.now();
    const running = s.jobs.filter(
      (j) =>
        j.status === "queued" || j.status === "sent" || j.status === "failed",
    );
    const jobs = h(
      "ul",
      { class: "ui-studio__jobs" },
      ...running.map((j) =>
        h(
          "li",
          { class: `ui-studio__job is-${j.status}` },
          h("span", {
            class: "ui-studio__job-state",
            text:
              j.status === "failed"
                ? tr("Falhou")
                : j.status === "sent"
                  ? tr("Gerando…")
                  : tr("Na fila"),
          }),
          h("span", { class: "ui-studio__job-text", text: j.title }),
          ...(j.error
            ? [h("span", { class: "ui-studio__job-error", text: j.error })]
            : []),
          h("span", {
            class: "ui-studio__job-at",
            text: relativeTime(j.at, now),
          }),
          ...(j.status === "failed"
            ? [
                h(
                  "span",
                  { class: "ui-studio__actions" },
                  h("button", {
                    class: "ui-btn ui-btn--sm",
                    type: "button",
                    text: tr("Tentar de novo"),
                    on: {
                      click: () =>
                        void this.act(() =>
                          call(
                            `${STUDIO_URL}/jobs/${encodeURIComponent(j.id)}/retry`,
                            { method: "POST", body: "{}" },
                          ),
                        ),
                    },
                  }),
                  h("button", {
                    class: "ui-btn ui-btn--sm",
                    type: "button",
                    text: tr("Descartar"),
                    on: {
                      click: () =>
                        void this.act(() =>
                          call(
                            `${STUDIO_URL}/jobs/${encodeURIComponent(j.id)}/discard`,
                            { method: "POST", body: "{}" },
                          ),
                        ),
                    },
                  }),
                ),
              ]
            : []),
        ),
      ),
    );
    const grid = h(
      "div",
      { class: "ui-studio__grid" },
      ...s.items.map((i) => this.card(i)),
    );
    const empty = s.items.length
      ? []
      : [
          h("p", {
            class: "ui-studio__empty",
            text: tr("Nenhuma imagem neste projeto ainda."),
          }),
        ];
    const hint = h("p", {
      class: "ui-studio__hint",
      text: tr(
        'Agentes pedem imagens com POST /api/studio {project: "{0}", title, prompt, requestedBy}; o pedido espera você aqui.',
        [p.slug],
      ),
    });
    return [
      info,
      edit,
      editForm,
      ...pendingSec,
      form,
      jobs,
      h("h3", { class: "ui-studio__h", text: tr("Galeria") }),
      ...empty,
      grid,
      hint,
    ];
  }

  private pendingCard(j: StudioJobView): HTMLElement {
    const title = input(
      { maxlength: "80", "aria-label": tr("Título da imagem") },
      j.title,
    );
    const prompt = area(
      { maxlength: "4000", "aria-label": tr("Prompt da imagem") },
      j.prompt,
    );
    const approve = h("button", {
      class: "ui-btn ui-btn--primary",
      type: "button",
      text: tr("Gerar"),
    }) as HTMLButtonElement;
    approve.disabled = !this.state.available;
    approve.addEventListener(
      "click",
      () =>
        void this.act(
          () =>
            call(`${STUDIO_URL}/jobs/${encodeURIComponent(j.id)}/approve`, {
              method: "POST",
              body: JSON.stringify({
                title: title.value,
                prompt: prompt.value,
              }),
            }),
          tr("Gerando: leva de 1 a 3 minutos."),
        ),
    );
    const discard = h("button", {
      class: "ui-btn",
      type: "button",
      text: tr("Descartar"),
    });
    discard.addEventListener(
      "click",
      () =>
        void this.act(
          () =>
            call(`${STUDIO_URL}/jobs/${encodeURIComponent(j.id)}/discard`, {
              method: "POST",
              body: "{}",
            }),
          tr("Pedido descartado."),
        ),
    );
    const card = h(
      "div",
      { class: "ui-studio__pending" },
      h("p", {
        class: "ui-studio__pending-who",
        text: tr("{0} pediu · {1}", [
          j.requestedBy ?? tr("um agente"),
          relativeTime(j.at, Date.now()),
        ]),
      }),
      title,
      prompt,
      h("div", { class: "ui-studio__actions" }, approve, discard),
    );
    card.addEventListener("input", () => {
      this.editing = true;
    });
    return card;
  }

  private card(i: StudioItemView): HTMLElement {
    const url = fileUrl(i.file);
    const label = i.title ?? i.prompt?.slice(0, 80) ?? i.file;
    const img = h("img", { attrs: { src: url, alt: label, loading: "lazy" } });
    const link = h(
      "a",
      {
        class: "ui-studio__thumb",
        attrs: {
          href: url,
          target: "_blank",
          rel: "noopener noreferrer",
          title: i.prompt ?? label,
        },
      },
      img,
    );
    const copy = iconButton(
      ICONS.copy,
      tr("Copiar o prompt"),
      () => void copyText(i.prompt ?? ""),
      "ui-icon-btn--sm",
    );
    setHidden(copy, !i.prompt);
    return h(
      "figure",
      { class: "ui-studio__item" },
      link,
      h(
        "figcaption",
        {},
        h("span", {
          class: "ui-studio__meta",
          text: label,
          attrs: { title: `${i.date}${i.model ? ` · ${i.model}` : ""}` },
        }),
        copy,
      ),
    );
  }
}
