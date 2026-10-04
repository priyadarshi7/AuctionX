import net from 'node:net';

// A minimal client for ClamAV's clamd daemon, speaking its INSTREAM protocol
// over TCP: send "zINSTREAM\0", then the file as length-prefixed chunks
// (4-byte big-endian length + bytes), then a zero-length chunk. clamd answers
// "stream: OK", "stream: <Signature> FOUND" or "... ERROR", NUL-terminated.
//
// Raw `net` rather than a library: the protocol is ten lines and a dependency
// for it would be the larger risk.

const CHUNK_BYTES = 64 * 1024;
const SCAN_TIMEOUT_MS = 15_000;

export type ClamavVerdict = { clean: true } | { clean: false; signature: string };

export class ClamavUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClamavUnavailableError';
  }
}

export function scanWithClamav(bytes: Buffer, host: string, port: number): Promise<ClamavVerdict> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let reply = '';
    let settled = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      fn();
    };

    socket.setTimeout(SCAN_TIMEOUT_MS, () =>
      finish(() => reject(new ClamavUnavailableError('ClamAV scan timed out'))),
    );
    socket.on('error', (err) =>
      finish(() => reject(new ClamavUnavailableError(`ClamAV unreachable: ${err.message}`))),
    );
    socket.on('data', (data) => {
      reply += data.toString('utf8');
    });
    socket.on('end', () =>
      finish(() => {
        const text = reply.replace(/\0/g, '').trim();
        if (text.endsWith('OK')) return resolve({ clean: true });
        const found = /^stream:\s*(.+)\s+FOUND$/.exec(text);
        if (found) return resolve({ clean: false, signature: found[1]! });
        reject(new ClamavUnavailableError(`Unexpected ClamAV reply: ${text.slice(0, 120)}`));
      }),
    );

    socket.on('connect', () => {
      socket.write('zINSTREAM\0');
      for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
        const chunk = bytes.subarray(offset, offset + CHUNK_BYTES);
        const length = Buffer.alloc(4);
        length.writeUInt32BE(chunk.length);
        socket.write(length);
        socket.write(chunk);
      }
      socket.write(Buffer.alloc(4)); // zero-length chunk ends the stream
    });
  });
}
