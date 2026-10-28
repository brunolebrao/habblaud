import { describe, expect, it } from 'vitest';
import { floorOf, hostOf, namespaceOffice, splitHost, withHost } from '../../shared/hosts';
import type { AgentInfo, OfficeSnapshot } from '../../shared/types';
import { NameStore } from '../model/names';
import { Office } from '../model/office';
import { Hub } from '../http/sse';
import { parsePeers } from './config';
import { PeerSet, prefixIds } from './index';

function agent(id: string, roomId: string, extra: Partial<AgentInfo> = {}): AgentInfo {
  return {
    id,
    kind: 'main',
    roomId,
    name: 'Ana',
    look: 'f',
    role: 'Agente principal',
    sessionId: 's1',
    account: '.claude',
    status: 'working',
    recent: [],
    tasks: [],
    startedAt: 0,
    lastEventAt: 0,
    statusSince: 0,
    stats: { tokensIn: 0, tokensOut: 0, subagents: 0 },
    seed: 1,
    ...extra,
  } as AgentInfo;
}

function remoteSnapshot(): OfficeSnapshot {
  return {
    rev: 7,
    serverTime: 0,
    rooms: [{ id: '/Users/b/app', name: 'app', path: '/Users/b/app', slot: 0, seed: 1, createdAt: 0 }],
    agents: [agent('.claude:42', '/Users/b/app', { permission: { id: 'p-1', tool: 'Bash', title: 'Bash(ls)', text: 'x', icon: 'x', createdAt: 0, expiresAt: 0 } })],
    accounts: [{ id: '.claude', short: 'B', name: 'Bruno', color: '#fff', configDir: '/x', sessions: 1, usageStatus: 'disabled' }],
    meta: { demo: false, sources: [], startedAt: 0, version: '1' },
  };
}

const CA = '-----BEGIN CERTIFICATE-----\nx\n-----END CERTIFICATE-----';
const PEERS = { self: 'Mac Studio', peers: [{ id: 'mac2', name: 'MacBook', url: 'https://192.168.0.176:4748', user: 'central', password: 'x', ca: CA }] };

describe('ids de outros computadores (shared/hosts.ts)', () => {
  it('prefixa e separa', () => {
    const id = withHost('mac2', '.claude:42');
    expect(id).toBe('@mac2:.claude:42');
    expect(splitHost(id)).toEqual({ host: 'mac2', id: '.claude:42' });
    expect(hostOf(id)).toBe('mac2');
    expect(splitHost('.claude:42')).toEqual({ id: '.claude:42' });
    expect(hostOf('/Users/b/app')).toBeUndefined();
  });

  it('prefixa salas, agentes, contas e o pedido de permissão; floorOf separa os andares', () => {
    const ns = namespaceOffice(remoteSnapshot(), 'mac2');
    expect(ns.rooms[0]).toMatchObject({ id: '@mac2:/Users/b/app', host: 'mac2', path: '/Users/b/app' });
    expect(ns.agents[0]).toMatchObject({ id: '@mac2:.claude:42', roomId: '@mac2:/Users/b/app', account: '@mac2:.claude', host: 'mac2' });
    expect(ns.agents[0].permission?.id).toBe('@mac2:p-1');
    expect(ns.accounts[0]).toMatchObject({ id: '@mac2:.claude', host: 'mac2' });
    const all = { rooms: [...ns.rooms], agents: [agent('.claude:1', '/Users/a/x'), ...ns.agents], accounts: [] };
    expect(floorOf(all, undefined).agents.map((a) => a.id)).toEqual(['.claude:1']);
    expect(floorOf(all, 'mac2').agents.map((a) => a.id)).toEqual(['@mac2:.claude:42']);
  });
});

describe('peers.json', () => {
  it('aceita os válidos e avisa dos inválidos', () => {
    const r = parsePeers({
      self: 'Mac Studio',
      peers: [
        PEERS.peers[0],
        { id: 'Mac 3', url: 'https://x', user: 'a', password: 'b' },
        { id: 'mac2', url: 'https://y', user: 'a', password: 'b' },
        { id: 'win', url: 'ftp://x', user: 'a', password: 'b' },
        { id: 'pc', url: 'https://10.0.0.2:4748/qualquer', user: 'a', ca: CA },
        { id: 'sem-ca', url: 'https://10.0.0.3:4748', user: 'a', password: 'b' },
      ],
    });
    expect(r.file.self).toBe('Mac Studio');
    expect(r.file.peers).toHaveLength(1);
    expect(r.file.peers[0]).toMatchObject({ id: 'mac2', name: 'MacBook', url: 'https://192.168.0.176:4748' });
    expect(r.warnings).toHaveLength(5);
    expect(parsePeers([]).warnings).toHaveLength(1);
  });
});

describe('PeerSet', () => {
  it('junta os andares de lá ao snapshot daqui, com os andares em meta.hosts', () => {
    const set = new PeerSet(parsePeers(PEERS).file);
    const link = set.links[0];
    link.snapshot = remoteSnapshot();
    link.state = 'online';
    const local = { ...remoteSnapshot(), rev: 3, rooms: [], agents: [agent('.claude:1', '/Users/a/x')], accounts: [] };
    const merged = set.merge(local);
    expect(merged.agents.map((a) => a.id)).toEqual(['.claude:1', '@mac2:.claude:42']);
    expect(merged.meta.hosts).toEqual([
      { name: 'Mac Studio', state: 'online' },
      { id: 'mac2', name: 'MacBook', state: 'online' },
    ]);
    expect(merged.rev).toBeGreaterThanOrEqual(local.rev);
  });

  it('computador fora do ar: o andar aparece, sem ninguém', () => {
    const set = new PeerSet(parsePeers(PEERS).file);
    set.links[0].state = 'offline';
    const merged = set.merge({ ...remoteSnapshot(), agents: [], rooms: [], accounts: [] });
    expect(merged.agents).toEqual([]);
    expect(merged.meta.hosts?.[1]).toMatchObject({ id: 'mac2', state: 'offline' });
  });

  it('sem outros computadores, o snapshot passa igual', () => {
    const set = new PeerSet({ peers: [] });
    const snap = remoteSnapshot();
    expect(set.merge(snap)).toBe(snap);
  });

  it('prefixa os ids das respostas de lá em qualquer profundidade', () => {
    expect(prefixIds({ id: 'm-1', agentId: '.claude:42', status: 'queued', nested: [{ roomId: '/x', name: 'y' }] }, 'mac2')).toEqual({
      id: '@mac2:m-1',
      agentId: '@mac2:.claude:42',
      status: 'queued',
      nested: [{ roomId: '@mac2:/x', name: 'y' }],
    });
  });

  it('o Hub manda os andares de lá só para a página: current() (estatísticas, mod, Habblaud World) fica só com este computador', () => {
    const office = new Office({ names: new NameStore(null), version: '9.9.9', startedAt: Date.now(), accounts: () => [], sources: () => [], accountName: () => undefined });
    const set = new PeerSet(parsePeers(PEERS).file);
    set.links[0].snapshot = remoteSnapshot();
    set.links[0].state = 'online';
    const hub = new Hub(office, { throttleMs: 10, peers: set });
    expect(hub.current().agents.some((a) => a.host)).toBe(false);
    expect(hub.current().meta.hosts).toBeUndefined();
    expect(hub.merged().agents.map((a) => a.id)).toContain('@mac2:.claude:42');
    expect(office.list().some((a) => a.id.startsWith('@'))).toBe(false);
  });
});
