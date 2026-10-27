// Anexos esperando o envio (caixa de mensagem): a lista com miniatura, nome e tamanho, o seletor de arquivos e o envio
// um a um (POST /api/messages/attachments, JSON base64: o guard exige JSON em todo POST). O servidor grava os arquivos
// no computador e a mensagem leva os caminhos para o agente ler (server/spawn/attachments.ts).
import { h, iconButton } from './dom';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

export const MAX_FILES = 8;
export const MAX_FILE_BYTES = 15 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;
}

export function fileToBase64(file: Blob): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(new Error(tr('não deu para ler o arquivo')));
    r.readAsDataURL(file);
  });
}

interface PendingFile {
  file: File;
  url?: string;
  el: HTMLElement;
}

export class AttachTray {
  readonly list: HTMLElement;
  readonly input: HTMLInputElement;
  private files: PendingFile[] = [];

  constructor(
    private onChange: () => void,
    private onError: (text: string) => void,
  ) {
    this.list = h('ul', { class: 'ui-spawn__files ui-msg__files', attrs: { 'aria-label': tr('Anexos') } });
    this.input = h('input', { type: 'file', hidden: true, attrs: { multiple: true, 'aria-hidden': 'true', tabindex: '-1' } });
    this.input.addEventListener('change', () => {
      this.add([...(this.input.files ?? [])]);
      this.input.value = '';
    });
  }

  get count(): number {
    return this.files.length;
  }

  /** Abre o seletor de arquivos do sistema. */
  pick(): void {
    this.input.click();
  }

  add(list: File[]): void {
    for (const file of list) {
      if (this.files.length >= MAX_FILES) {
        this.onError(tr('No máximo {0} anexos por pedido.', [MAX_FILES]));
        break;
      }
      if (file.size > MAX_FILE_BYTES) {
        this.onError(tr('{0} passa de {1} MB.', [file.name, MAX_FILE_BYTES / 1024 / 1024]));
        continue;
      }
      if (!file.size) continue;
      const url = file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined;
      const item: PendingFile = { file, url, el: h('li', { class: 'ui-spawn__file' }) };
      const thumb = url
        ? h('img', { class: 'ui-spawn__thumb', attrs: { src: url, alt: '' } })
        : h('span', { class: 'ui-spawn__thumb ui-spawn__thumb--doc', attrs: { 'aria-hidden': 'true' }, text: (file.name.split('.').pop() ?? '').slice(0, 4).toUpperCase() || tr('ARQ') });
      const remove = iconButton(ICONS.close, tr('Tirar {0}', [file.name]), () => this.remove(item), 'ui-icon-btn--sm ui-spawn__file-x');
      item.el.append(thumb, h('span', { class: 'ui-spawn__file-name', text: file.name, attrs: { title: file.name } }), h('span', { class: 'ui-spawn__file-size', text: formatBytes(file.size) }), remove);
      this.files.push(item);
      this.list.append(item.el);
    }
    this.onChange();
  }

  clear(): void {
    if (!this.files.length) return;
    for (const f of this.files) if (f.url) URL.revokeObjectURL(f.url);
    this.files = [];
    this.list.replaceChildren();
    this.onChange();
  }

  /** Manda os arquivos ao servidor, um por vez; devolve os ids na ordem. Erro = lança com o motivo. */
  async upload(path: string, progress?: (i: number, n: number) => void): Promise<string[]> {
    const ids: string[] = [];
    for (const [i, f] of this.files.entries()) {
      progress?.(i + 1, this.files.length);
      let res: Response;
      try {
        res = await fetch(path, {
          method: 'POST',
          credentials: 'same-origin',
          cache: 'no-store',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: f.file.name, type: f.file.type, data: await fileToBase64(f.file) }),
        });
      } catch {
        throw new Error(tr('o Habblaud não respondeu'));
      }
      const body = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
      if (!res.ok || !body.id) throw new Error(body.error ?? tr('erro {0}', [res.status]));
      ids.push(body.id);
    }
    return ids;
  }

  private remove(item: PendingFile): void {
    if (item.url) URL.revokeObjectURL(item.url);
    item.el.remove();
    this.files = this.files.filter((f) => f !== item);
    this.onChange();
  }
}
