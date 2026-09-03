import { describe, expect, it } from 'vitest';
import { decodeFrames, encodeFrame, PROTOCOL_VERSION, type BrokerMessage } from '../../src/broker/protocol';

describe('broker protocol frames', () => {
    it('round-trips a hello message', () => {
        const hello: BrokerMessage = { type: 'hello', version: PROTOCOL_VERSION };
        const decoded = decodeFrames(encodeFrame(hello));

        expect(decoded.messages).toEqual([hello]);
    });

    it('reassembles a request split across chunks', () => {
        const message: BrokerMessage = { type: 'req', id: 7, method: 'list', params: {} };
        const frame = encodeFrame(message);
        const mid = Math.ceil(frame.length / 2);

        const first = decodeFrames(frame.subarray(0, mid));
        const second = decodeFrames(frame.subarray(mid), first.rest);

        expect(first.messages).toEqual([]);
        expect(second.messages).toEqual([message]);
    });

    it('correlates multiple requests in one buffer', () => {
        const a: BrokerMessage = { type: 'req', id: 1, method: 'list', params: {} };
        const b: BrokerMessage = { type: 'req', id: 2, method: 'close', params: { identity: 'x' } };
        const buffer = Buffer.concat([encodeFrame(a), encodeFrame(b)]);

        expect(decodeFrames(buffer).messages).toEqual([a, b]);
    });
});
