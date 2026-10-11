import { clientMessageSchema, type ClientMessage, type ServerMessage } from './messages';

const encoder = new TextEncoder();

/** Running byte totals for the wire, reported in the stats endpoint and the debug panel. */
export class ByteCounter {
  sent = 0;
  received = 0;
  messagesSent = 0;
  messagesReceived = 0;

  countSent(data: string): string {
    this.sent += byteLength(data);
    this.messagesSent++;
    return data;
  }

  countReceived(data: string): string {
    this.received += byteLength(data);
    this.messagesReceived++;
    return data;
  }
}

export const byteLength = (data: string): number => encoder.encode(data).length;

export const encode = (msg: ClientMessage | ServerMessage): string => JSON.stringify(msg);

export type Decoded<T> = { ok: true; msg: T } | { ok: false; error: string };

/** Parse and validate an untrusted client frame. */
export function decodeClientMessage(data: string): Decoded<ClientMessage> {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return { ok: false, error: 'invalid JSON' };
  }
  const parsed = clientMessageSchema.safeParse(json);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'invalid' };
  return { ok: true, msg: parsed.data as ClientMessage };
}

/** Server frames come from our own relay, so they are parsed without re-validation. */
export const decodeServerMessage = (data: string): ServerMessage =>
  JSON.parse(data) as ServerMessage;
