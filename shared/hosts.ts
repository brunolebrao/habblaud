// Outros computadores (HABBLAUD_PEERS, server/peers/): a central junta o escritório de cada um ao seu, como um andar.
// Os ids de lá (agentes, salas, contas, pedidos) chegam aqui prefixados com "@<computador>:", para não colidirem com os
// daqui (todo computador tem a conta ".claude", pids e pastas se repetem). Os ids deste computador não mudam. Puro.
import type { AccountInfo, AgentInfo, OfficeSnapshot, RoomInfo } from './types';

/** Id de um computador: minúsculas, dígitos e hífen (vai no prefixo dos ids e na URL). */
export const HOST_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;

const PREFIXED = /^@([a-z0-9][a-z0-9-]{0,23}):(.*)$/s;

/** Prefixa um id de outro computador. */
export function withHost(host: string, id: string): string {
  return `@${host}:${id}`;
}

/** Separa o computador do id ("@mac2:.claude:123" → {host: "mac2", id: ".claude:123"}); id daqui = sem `host`. */
export function splitHost(id: string): { host?: string; id: string } {
  const m = PREFIXED.exec(id);
  return m ? { host: m[1], id: m[2] } : { id };
}

/** Computador de um id (undefined = este). */
export function hostOf(id: string): string | undefined {
  return PREFIXED.exec(id)?.[1];
}

/** O escritório de outro computador com os ids prefixados (salas, agentes e contas; terminais interativos ficam lá). */
export function namespaceOffice(snap: Pick<OfficeSnapshot, 'rooms' | 'agents' | 'accounts'>, host: string): { rooms: RoomInfo[]; agents: AgentInfo[]; accounts: AccountInfo[] } {
  const p = (id: string) => withHost(host, id);
  return {
    rooms: snap.rooms.map((r) => ({ ...r, id: p(r.id), host, effect: r.effect && { ...r.effect, agentId: r.effect.agentId && p(r.effect.agentId) } })),
    agents: snap.agents.map((a) => namespaceAgent(a, host)),
    accounts: snap.accounts.map((acc) => ({ ...acc, id: p(acc.id), host })),
  };
}

export function namespaceAgent(a: AgentInfo, host: string): AgentInfo {
  const p = (id: string) => withHost(host, id);
  return {
    ...a,
    id: p(a.id),
    roomId: p(a.roomId),
    account: p(a.account),
    host,
    parentId: a.parentId && p(a.parentId),
    permission: a.permission && { ...a.permission, id: p(a.permission.id) },
  };
}

/** Só o andar escolhido (undefined = este computador): salas, agentes e contas dele. */
export function floorOf<T extends Pick<OfficeSnapshot, 'rooms' | 'agents' | 'accounts'>>(snap: T, host: string | undefined): T {
  const on = (x: { host?: string }) => (x.host ?? undefined) === host;
  return { ...snap, rooms: snap.rooms.filter(on), agents: snap.agents.filter(on), accounts: snap.accounts.filter(on) };
}
