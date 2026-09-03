export const PROTOCOL_VERSION = 1;

export type BrokerMessage =
    | { type: 'hello'; version: number }
    | { type: 'hello-ok'; version: number }
    | { type: 'hello-mismatch'; version: number }
    | { type: 'req'; id: number; method: string; params: unknown }
    | { type: 'res'; id: number; result?: unknown; error?: { code: string; message: string } }
    | { type: 'event'; id?: number; name: string; payload: unknown };

export function encodeFrame(message: BrokerMessage): Buffer {
    const payload = Buffer.from(JSON.stringify(message), 'utf8');
    const header = Buffer.alloc(4);
    header.writeUInt32BE(payload.length, 0);
    return Buffer.concat([header, payload]);
}

export function decodeFrames(chunk: Buffer, rest: Buffer = Buffer.alloc(0)): { messages: BrokerMessage[]; rest: Buffer } {
    let buffer = Buffer.concat([rest, chunk]);
    const messages: BrokerMessage[] = [];

    while (buffer.length >= 4) {
        const length = buffer.readUInt32BE(0);
        if (buffer.length < 4 + length) {
            break;
        }
        const payload = buffer.subarray(4, 4 + length);
        buffer = buffer.subarray(4 + length);
        messages.push(JSON.parse(payload.toString('utf8')) as BrokerMessage);
    }

    return { messages, rest: buffer };
}

export function attachFrameReader(
    readable: NodeJS.ReadableStream,
    onMessage: (message: BrokerMessage) => void,
): void {
    let rest = Buffer.alloc(0);
    readable.on('data', (chunk: Buffer | string) => {
        const decoded = decodeFrames(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), rest);
        rest = Buffer.from(decoded.rest);
        for (const message of decoded.messages) {
            onMessage(message);
        }
    });
}

