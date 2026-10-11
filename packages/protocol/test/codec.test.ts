import { Doc } from '@collabpad/crdt';
import { describe, expect, it } from 'vitest';
import { ByteCounter, decodeClientMessage, decodeServerMessage, encode } from '../src';

describe('protocol codec', () => {
  it('round-trips real ops', () => {
    const doc = new Doc('a');
    const ops = [...doc.insertAt(0, 'hé'), ...doc.deleteRange(0, 1)];
    const decoded = decodeClientMessage(encode({ kind: 'ops', ops }));
    expect(decoded).toEqual({ ok: true, msg: { kind: 'ops', ops } });
  });

  it.each([
    ['not json', '{'],
    ['unknown kind', '{"kind":"nope"}'],
    ['empty ops', '{"kind":"ops","ops":[]}'],
    [
      'multi-char insert',
      JSON.stringify({
        kind: 'ops',
        ops: [
          {
            type: 'ins',
            id: { replica: 'a', seq: 1 },
            ts: { lamport: 1, replica: 'a' },
            origin: null,
            char: 'ab',
          },
        ],
      }),
    ],
    [
      'stamp/id mismatch',
      JSON.stringify({
        kind: 'ops',
        ops: [
          {
            type: 'del',
            id: { replica: 'a', seq: 1 },
            ts: { lamport: 1, replica: 'b' },
            target: { replica: 'a', seq: 1 },
          },
        ],
      }),
    ],
    ['negative vv', '{"kind":"sync","vv":{"a":-1}}'],
    [
      'bad color',
      '{"kind":"presence","presence":{"name":"x","color":"red","anchor":null,"head":null}}',
    ],
  ])('rejects %s', (_, frame) => {
    expect(decodeClientMessage(frame).ok).toBe(false);
  });

  it('counts UTF-8 bytes', () => {
    const c = new ByteCounter();
    expect(c.countSent('é')).toBe('é');
    c.countReceived('abc');
    expect(c).toMatchObject({ sent: 2, received: 3, messagesSent: 1, messagesReceived: 1 });
    expect(decodeServerMessage('{"kind":"ack","vv":{}}')).toEqual({ kind: 'ack', vv: {} });
  });
});
