import type { ClientMessage, ServerMessage } from './messages';

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

/** Server frames come from our own relay, so they are parsed without re-validation. */
export const decodeServerMessage = (data: string): ServerMessage =>
  JSON.parse(data) as ServerMessage;
