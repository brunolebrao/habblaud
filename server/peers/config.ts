// Outros computadores que a central acompanha (peers.json; ver server/peers/index.ts). Cada um roda o próprio Habblaud
// com o acesso remoto ligado (npm run remote:setup) e é lido pela porta com login, como o celular. O arquivo tem as
// senhas desse login: fica fora do git, em ~/.habblaud/peers, com permissão 600. Node puro.
import { readFileSync } from 'node:fs';
import { HOST_ID } from '../../shared/hosts';
import { tr } from '../../shared/i18n';

export interface PeerConfig {
  /** Vai no prefixo dos ids ("@<id>:") e nas URLs: minúsculas, dígitos e hífen. */
  id: string;
  /** Nome do andar. */
  name: string;
  /** Endereço da porta remota do outro computador (https://192.168.0.10:4748). */
  url: string;
  user: string;
  password: string;
  /** CA do outro computador (PEM, de ~/.habblaud/remote-tls/ca.crt de lá): sem ela, a conexão HTTPS é recusada. */
  ca?: string;
}

export interface PeersFile {
  /** Nome do andar deste computador. */
  self?: string;
  peers: PeerConfig[];
}

const NAME_MAX = 24;

/** Valida o conteúdo do peers.json; computador inválido fica de fora, com aviso. */
export function parsePeers(raw: unknown): { file: PeersFile; warnings: string[] } {
  const warnings: string[] = [];
  const file: PeersFile = { peers: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { file, warnings: [tr('peers.json precisa ser um objeto JSON')] };
  const r = raw as Record<string, unknown>;
  const name = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ').slice(0, NAME_MAX) : '');
  if (name(r.self)) file.self = name(r.self);
  const list = Array.isArray(r.peers) ? r.peers : [];
  const seen = new Set<string>();
  for (const [i, item] of list.entries()) {
    const p = (item ?? {}) as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id.trim() : '';
    let url: URL | undefined;
    try {
      url = typeof p.url === 'string' ? new URL(p.url) : undefined;
    } catch {
      url = undefined;
    }
    const bad = (why: string) => warnings.push(tr('peers.json: computador {0} ignorado ({1})', [id || `#${i + 1}`, why]));
    if (!HOST_ID.test(id)) bad(tr('"id" precisa ter só minúsculas, dígitos e hífen'));
    else if (seen.has(id)) bad(tr('"id" repetido'));
    else if (!url || (url.protocol !== 'https:' && url.protocol !== 'http:')) bad(tr('"url" precisa ser um endereço http(s)'));
    else if (typeof p.user !== 'string' || !p.user || typeof p.password !== 'string' || !p.password) bad(tr('faltam "user" e "password"'));
    else {
      seen.add(id);
      file.peers.push({
        id,
        name: name(p.name) || id,
        url: url.origin,
        user: p.user,
        password: p.password,
        ca: typeof p.ca === 'string' && p.ca.includes('BEGIN CERTIFICATE') ? p.ca : undefined,
      });
    }
  }
  return { file, warnings };
}

/** Lê o peers.json (sem o arquivo: nenhum outro computador, sem aviso). */
export function loadPeers(path: string): { file: PeersFile; warnings: string[] } {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { file: { peers: [] }, warnings: [] };
  }
  try {
    return parsePeers(JSON.parse(text));
  } catch {
    return { file: { peers: [] }, warnings: [tr('peers.json não é um JSON válido')] };
  }
}
