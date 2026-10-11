import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { CloseCode, encode, type ServerMessage } from '@collabpad/protocol';
import { decodeClientMessage } from '@collabpad/protocol/validate';
import type { RelayConfig } from './config';
import { TokenBucket } from './rate-limit';
import { Room, type Peer } from './room';
import { Store } from './store';

export interface Relay {
  readonly app: FastifyInstance;
  readonly store: Store;
  /** Rooms with at least one connection (others are reloaded from the store on demand). */
  readonly rooms: ReadonlyMap<string, Room>;
}

const titleSchema = {
  type: 'object',
  properties: { title: { type: 'string', minLength: 1, maxLength: 200 } },
} as const;

export async function buildRelay(config: RelayConfig): Promise<Relay> {
  const app = Fastify({ logger: { level: config.logLevel } });
  const store = new Store(config.dbPath);
  const rooms = new Map<string, Room>();

  const roomFor = (docId: string): Room => {
    let room = rooms.get(docId);
    if (!room) {
      room = new Room(docId, store, { replicaLeaseMs: config.replicaLeaseMs });
      rooms.set(docId, room);
    }
    return room;
  };

  await app.register(cors, { origin: config.corsOrigin });
  await app.register(websocket, { options: { maxPayload: config.maxMessageBytes } });
  app.addHook('onClose', () => store.close());

  // ---------- REST ----------

  app.get('/healthz', () => ({ ok: true }));

  app.post<{ Body: { title?: string } | undefined }>(
    '/api/docs',
    { schema: { body: { ...titleSchema, nullable: true } } },
    async (req, reply) => reply.code(201).send(store.createDoc(req.body?.title)),
  );

  app.get<{ Params: { id: string } }>('/api/docs/:id', (req, reply) => {
    const meta = store.getDoc(req.params.id);
    return meta ?? reply.code(404).send({ error: 'not found' });
  });

  app.patch<{ Params: { id: string }; Body: { title: string } }>(
    '/api/docs/:id',
    { schema: { body: { ...titleSchema, required: ['title'] } } },
    (req, reply) =>
      store.renameDoc(req.params.id, req.body.title)
        ? store.getDoc(req.params.id)
        : reply.code(404).send({ error: 'not found' }),
  );

  app.get<{ Params: { id: string } }>('/api/docs/:id/stats', (req, reply) => {
    if (!store.getDoc(req.params.id)) return reply.code(404).send({ error: 'not found' });
    return roomFor(req.params.id).stats();
  });

  // ---------- WebSocket ----------

  app.get<{ Querystring: { doc?: string } }>('/ws', { websocket: true }, (socket, req) => {
    const docId = req.query.doc ?? '';
    if (!store.getDoc(docId)) {
      socket.close(CloseCode.UnknownDoc, 'unknown document');
      return;
    }
    const room = roomFor(docId);
    const bucket = new TokenBucket(config.rateLimit.perSecond, config.rateLimit.burst);
    let peer: Peer | null = null;

    const send = (msg: ServerMessage): void => {
      if (socket.readyState === socket.OPEN) socket.send(room.bytes.countSent(encode(msg)));
    };
    const reject = (
      code: 'bad-message' | 'not-hello' | 'rate-limited',
      message: string,
      closeCode: number,
    ) => {
      send({ kind: 'error', code, message });
      socket.close(closeCode, message);
    };

    socket.on('message', (raw, isBinary) => {
      if (isBinary)
        return reject('bad-message', 'binary frames are not supported', CloseCode.PolicyViolation);
      if (!bucket.take()) return reject('rate-limited', 'too many messages', CloseCode.RateLimited);

      const decoded = decodeClientMessage(room.bytes.countReceived(raw.toString()));
      if (!decoded.ok) return reject('bad-message', decoded.error, CloseCode.PolicyViolation);
      const msg = decoded.msg;

      if (!peer) {
        if (msg.kind !== 'hello')
          return reject('not-hello', 'first message must be hello', CloseCode.PolicyViolation);
        peer = { replica: msg.replica, send, close: (code, reason) => socket.close(code, reason) };
        room.join(peer, msg.vv);
        return;
      }
      switch (msg.kind) {
        case 'hello':
          return reject('bad-message', 'duplicate hello', CloseCode.PolicyViolation);
        case 'sync':
          return room.sync(peer, msg.vv);
        case 'ops':
          return room.receiveOps(peer, msg.ops);
        case 'presence':
          return room.setPresence(peer, msg.presence);
      }
    });

    socket.on('close', () => {
      if (peer) room.leave(peer);
      if (room.size === 0 && rooms.get(docId) === room) rooms.delete(docId);
    });
  });

  return { app, store, rooms };
}
