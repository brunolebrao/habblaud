// Rotas das mensagens pelo escritório. A trava (recurso ligado + Host local) já foi conferida em http/app.ts; o
// guard (http/guard.ts) já exigiu JSON e Origin local nos POST (contra CSRF).
//
//   POST /api/messages          (página)  {agentId, text, attachments?}: 201 OutboxMessage (queued) | 400 | 404 | 409 | 429
//   POST /api/messages/attachments (página) {name, type?, data (base64)}: 201 {id, name, size} (um por arquivo, antes da
//                                         mensagem; gravados ao mandar, e a mensagem leva os caminhos: spawn/attachments.ts)
//   GET  /api/messages/:id      (página)  situação da mensagem: 200 OutboxMessage | 404
//   POST /api/mod/inbox         (plugin)  {session, account?}: 200 {messages: InboxMessage[]} (e marca a presença)
//   POST /api/mod/inbox/ack     (plugin)  {session, results: [{id, ok, error?}]}: 200 {ok: true}
//   POST /api/codex/bridge/poll (auxiliar do Codex no host, npm run codex:bridge)
//                                         {}: 200 {messages: [{id, account, codexHome, thread, text}]} (marca a presença)
//   POST /api/codex/bridge/ack  (auxiliar) {results: [{id, ok, error?}]}: 200 {ok: true}
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, readJson, sendJson } from '../http/app';
import { InvalidRequest, MAX_OPEN, type MessageRegistry } from './registry';
import { ATTACHMENT_BODY_MAX, parseAttachment, promptWithAttachments, type Attachment, type AttachmentStore } from '../spawn/attachments';
import { tr } from '../../shared/i18n';

const ITEM = /^\/api\/messages\/([^/]+)$/;

function methodNotAllowed(res: ServerResponse, allow: string): void {
  res.setHeader('Allow', allow);
  sendJson(res, 405, { error: tr('método não permitido') });
}

function fail(res: ServerResponse, err: unknown): void {
  if (res.headersSent) return void res.destroy();
  if (err instanceof HttpError) sendJson(res, err.status, { error: err.message });
  else if (err instanceof InvalidRequest) sendJson(res, 400, { error: err.message });
  else sendJson(res, 500, { error: tr('erro interno') });
}

/** Anexos das mensagens: o depósito (o mesmo do Novo agente) e quem grava, devolvendo os caminhos como a sessão os vê. */
export interface MessageFiles {
  store: AttachmentStore;
  write: (id: string, files: readonly Attachment[]) => string[];
}

export function createMessageRoutes(
  registry: MessageRegistry,
  files?: MessageFiles,
  newId: () => string = randomUUID,
): (req: IncomingMessage, res: ServerResponse, path: string) => void {
  const send = async (req: IncomingMessage, res: ServerResponse) => {
    let body = await readJson(req);
    const ids = body && typeof body === 'object' ? (body as { attachments?: unknown }).attachments : undefined;
    if (ids !== undefined && !(Array.isArray(ids) && !ids.length)) {
      if (!files) return sendJson(res, 400, { error: tr('anexos desligados') });
      const taken = files.store.take(ids);
      if ('error' in taken) return sendJson(res, 400, { error: taken.error });
      let paths: string[];
      try {
        paths = files.write(newId(), taken);
      } catch (err) {
        return sendJson(res, 500, { error: tr('não deu para gravar os anexos ({0})', [(err as Error).message]) });
      } finally {
        files.store.release(taken.reduce((n, f) => n + f.data.length, 0));
      }
      const b = body as { text?: unknown };
      body = { ...b, text: promptWithAttachments(typeof b.text === 'string' ? b.text : '', paths), attachments: undefined };
    }
    const r = registry.send(body);
    if ('message' in r) return sendJson(res, 201, r.message);
    switch (r.error) {
      case 'not-found':
        return sendJson(res, 404, { error: tr('agente desconhecido: ele já saiu do escritório?') });
      case 'unavailable':
        return sendJson(res, 409, { error: r.reason });
      case 'too-many':
        return sendJson(res, 429, { error: tr('já há {0} mensagens esperando a entrega para este agente: espere a sessão buscar', [MAX_OPEN]) });
    }
  };

  const inbox = async (req: IncomingMessage, res: ServerResponse) => {
    sendJson(res, 200, { messages: registry.inbox(await readJson(req)) });
  };

  const ack = async (req: IncomingMessage, res: ServerResponse) => {
    registry.ack(await readJson(req));
    sendJson(res, 200, { ok: true });
  };

  const codexPoll = async (req: IncomingMessage, res: ServerResponse) => {
    sendJson(res, 200, { messages: registry.codexPoll(await readJson(req)) });
  };

  const codexAck = async (req: IncomingMessage, res: ServerResponse) => {
    registry.codexAck(await readJson(req));
    sendJson(res, 200, { ok: true });
  };

  const post = (req: IncomingMessage, res: ServerResponse, handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>) => {
    if ((req.method ?? 'GET') !== 'POST') return methodNotAllowed(res, 'POST');
    handler(req, res).catch((err) => fail(res, err));
  };

  const upload = async (req: IncomingMessage, res: ServerResponse) => {
    if (!files) return sendJson(res, 403, { error: tr('anexos desligados') });
    const a = parseAttachment(await readJson(req, ATTACHMENT_BODY_MAX));
    if ('error' in a) return sendJson(res, 400, { error: a.error });
    const r = files.store.put(a);
    if ('error' in r) return sendJson(res, 429, { error: r.error });
    sendJson(res, 201, { id: r.id, name: a.name, size: a.data.length });
  };

  return (req, res, path) => {
    if (path === '/api/messages') return post(req, res, send);
    if (path === '/api/messages/attachments') return post(req, res, upload);
    if (path === '/api/mod/inbox') return post(req, res, inbox);
    if (path === '/api/mod/inbox/ack') return post(req, res, ack);
    if (path === '/api/codex/bridge/poll') return post(req, res, codexPoll);
    if (path === '/api/codex/bridge/ack') return post(req, res, codexAck);
    const m = ITEM.exec(path);
    if (!m) return sendJson(res, 404, { error: tr('rota desconhecida') });
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') return methodNotAllowed(res, 'GET');
    let id: string;
    try {
      id = decodeURIComponent(m[1]);
    } catch {
      return sendJson(res, 400, { error: tr('id inválido') });
    }
    const msg = registry.get(id);
    if (msg) sendJson(res, 200, msg);
    else sendJson(res, 404, { error: tr('mensagem desconhecida: ela já foi resolvida há mais de 10 min ou o Habblaud reiniciou') });
  };
}
