// Endereços nas respostas e nas saídas dos agentes: viram link (só http/https, abre em outra aba, sem o Habblaud como
// origem) com um botão de copiar ao lado. Pull requests do GitHub e merge requests do GitLab ganham um selo ("PR #12",
// "MR !7"). A parte pura (achar e classificar os endereços) é testada em ui/links.test.ts; a montagem usa só
// createElement/textContent.
import { copyText, h, iconButton } from './dom';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

export type TextPart = { type: 'text'; text: string } | { type: 'url'; url: string };

const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
/** Pontuação que costuma fechar a frase, não o endereço. */
const TRAILING = /[.,;:!?'"»”’]+$/;

/** Só endereços http(s) válidos (nada de javascript:, data:...). */
export function safeUrl(href: string): string | undefined {
  try {
    const u = new URL(href);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined;
  } catch {
    return undefined;
  }
}

/** Corta a pontuação do fim e um ")" que não abriu dentro do endereço ("(veja https://x.com/a)"). */
function trimUrl(raw: string): string {
  let url = raw.replace(TRAILING, '');
  while (url.endsWith(')') && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1).replace(TRAILING, '');
  return url;
}

/** Separa o texto em trechos e endereços. Puro. */
export function splitUrls(text: string): TextPart[] {
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    const url = trimUrl(m[0]);
    if (!safeUrl(url) || url.length < 'https://x.y'.length) continue;
    const at = m.index ?? 0;
    if (at > last) out.push({ type: 'text', text: text.slice(last, at) });
    out.push({ type: 'url', url });
    last = at + url.length;
  }
  if (last < text.length) out.push({ type: 'text', text: text.slice(last) });
  return out;
}

/** Selo de PR (GitHub) ou MR (GitLab); undefined para os outros endereços. Puro. */
export function reviewLabel(url: string): string | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  const pr = /^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/|$)/.exec(u.pathname);
  if (pr && /(^|\.)github\.com$/.test(u.hostname)) return `PR #${pr[1]}`;
  const mr = /\/-\/merge_requests\/(\d+)(?:\/|$)/.exec(u.pathname);
  if (mr) return `MR !${mr[1]}`;
  return undefined;
}

/** Endereço curto para caber numa linha: domínio e o fim do caminho ("github.com/…/pull/12"). Puro. */
export function shortUrl(url: string): string {
  try {
    const u = new URL(url);
    const parts = u.pathname.split('/').filter(Boolean);
    const tail = parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : parts.join('/');
    return tail ? `${u.hostname}/${tail}` : u.hostname;
  } catch {
    return url;
  }
}

/**
 * Link (outra aba, sem referrer) + botão de copiar o endereço. `text` = o texto do link (padrão: o endereço); PR/MR
 * ganham o selo na frente, e com `text` vazio ('') o próprio selo é o link.
 */
export function linkNode(url: string, text?: string): HTMLElement {
  const label = reviewLabel(url);
  const badgeOnly = !!label && text === '';
  const a = h('a', {
    class: badgeOnly ? 'ui-link__a ui-link__badge' : 'ui-link__a',
    text: badgeOnly ? label : text || url,
    title: url,
    attrs: { href: url, target: '_blank', rel: 'noopener noreferrer' },
  });
  const copy = iconButton(
    ICONS.copy,
    tr('Copiar o endereço'),
    (ev) => {
      ev.stopPropagation();
      void copyText(url).then((ok) => {
        copy.classList.toggle('is-copied', ok);
        setTimeout(() => copy.classList.remove('is-copied'), 1200);
      });
    },
    'ui-icon-btn--sm ui-link__copy',
  );
  copy.setAttribute('data-chrome', '');
  const badge = label && !badgeOnly ? h('span', { class: 'ui-link__badge', text: label, attrs: { 'data-chrome': '' } }) : null;
  return h('span', { class: `ui-link${label ? ' ui-link--review' : ''}` }, ...(badge ? [badge] : []), a, copy);
}

/** Acrescenta o texto com os endereços já como links. */
export function appendLinked(parent: Node, text: string): void {
  for (const p of splitUrls(text)) parent.appendChild(p.type === 'url' ? linkNode(p.url) : document.createTextNode(p.text));
}
