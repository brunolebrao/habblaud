// Avisos no celular (Web Push): cadastra ESTE aparelho no servidor (/api/push/*) pelo service worker (public/sw.js).
// No iPhone/iPad só funciona com o escritório adicionado à Tela de Início e aberto por lá (o Safari comum não tem push).
import { tr } from '../../../shared/i18n';

export type PushState = 'unsupported' | 'ios-home' | 'denied' | 'off' | 'on';

const SW_URL = '/sw.js';

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function pushSupported(): boolean {
  return typeof navigator !== 'undefined' && 'serviceWorker' in navigator && typeof window !== 'undefined' && 'PushManager' in window && typeof Notification !== 'undefined';
}

/** Chave pública (base64url) no formato que o pushManager pede. */
export function keyBytes(b64u: string): Uint8Array<ArrayBuffer> {
  const b64 = b64u.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64u.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Registra o service worker (sem esperar): o toque num aviso precisa dele mesmo com a opção já ligada. */
export function registerPushWorker(): void {
  if (!pushSupported()) return;
  navigator.serviceWorker.register(SW_URL).catch(() => {
    // sem service worker, a opção mostra "indisponível"
  });
}

async function registration(): Promise<ServiceWorkerRegistration | undefined> {
  if (!pushSupported()) return undefined;
  return (await navigator.serviceWorker.getRegistration('/')) ?? (await navigator.serviceWorker.register(SW_URL));
}

export async function pushState(): Promise<PushState> {
  if (!pushSupported()) return isIos() ? 'ios-home' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const sub = await (await registration())?.pushManager.getSubscription();
    return sub ? 'on' : 'off';
  } catch {
    return 'off';
  }
}

async function post(path: string, body: unknown): Promise<void> {
  const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify(body) });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error || `HTTP ${res.status}`);
  }
}

/** Liga neste aparelho (pede a permissão: chame a partir de um toque) e manda um aviso de teste. */
export async function enablePush(): Promise<void> {
  const reg = await registration();
  if (!reg) throw new Error(tr('Este navegador não oferece avisos no celular.'));
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error(tr('Notificações bloqueadas pelo navegador.'));
  const res = await fetch('/api/push', { credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(tr('Avisos no celular desligados no servidor.'));
  const { key } = (await res.json()) as { key: string };
  const sub =
    (await reg.pushManager.getSubscription()) ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) }));
  await post('/api/push/subscribe', { subscription: sub.toJSON() });
  await post('/api/push/test', { endpoint: sub.endpoint });
}

export async function disablePush(): Promise<void> {
  const sub = await (await registration())?.pushManager.getSubscription();
  if (!sub) return;
  await post('/api/push/unsubscribe', { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}
