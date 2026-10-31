/**
 * Hand-encoded WASM genes that use agent memory through the host functions
 * `rotifer.readMemory` / `rotifer.writeMemory`,
 * for e2e tests of the WASM path. Same ABI as rotifer-napi's own test guest:
 *
 *   express(input_ptr, input_len) -> output_ptr   (NUL-terminated JSON)
 *   readMemory / writeMemory(req_ptr, req_len, out_ptr, out_cap) -> i32
 *
 * `express` makes the given calls in order, each with its own request and
 * response buffer, and returns the last call's response — the wire
 * MemoryEntry JSON (or `null`). Memory is zeroed, so a response is
 * NUL-terminated as long as it is shorter than its buffer.
 */

export type MemoryCall = { op: "read" | "write"; request: string };

const REQUEST_BASE = 4096;
const RESPONSE_BASE = 32768;
const SLOT = 8192;

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    let byte = n & 0x7f;
    n >>>= 7;
    if (n !== 0) byte |= 0x80;
    out.push(byte);
  } while (n !== 0);
  return out;
}

function sleb(n: number): number[] {
  const out: number[] = [];
  for (;;) {
    const byte = n & 0x7f;
    n >>= 7;
    const done = (n === 0 && (byte & 0x40) === 0) || (n === -1 && (byte & 0x40) !== 0);
    out.push(done ? byte : byte | 0x80);
    if (done) return out;
  }
}

const vec = (items: number[][]): number[] => [...uleb(items.length), ...items.flat()];
const name = (s: string): number[] => {
  const bytes = [...new TextEncoder().encode(s)];
  return [...uleb(bytes.length), ...bytes];
};
const section = (id: number, content: number[]): number[] => [id, ...uleb(content.length), ...content];

const I32 = 0x7f;
const IMPORT = { read: 0, write: 1 } as const;

export function memoryGeneWasm(calls: MemoryCall[]): Uint8Array {
  if (calls.length === 0 || calls.length > 3) throw new Error("1 to 3 calls");
  const requests = calls.map((c) => [...new TextEncoder().encode(c.request)]);
  for (const r of requests) if (r.length >= SLOT) throw new Error("request too long for its slot");

  const types = section(1, vec([
    [0x60, ...vec([[I32], [I32], [I32], [I32]]), ...vec([[I32]])], // (req, len, out, cap) -> i32
    [0x60, ...vec([[I32], [I32]]), ...vec([[I32]])], //                 express(ptr, len) -> ptr
  ]));
  const imports = section(2, vec([
    [...name("rotifer"), ...name("readMemory"), 0x00, ...uleb(0)],
    [...name("rotifer"), ...name("writeMemory"), 0x00, ...uleb(0)],
  ]));
  const functions = section(3, vec([uleb(1)]));
  const memory = section(5, vec([[0x00, ...uleb(1)]])); // one 64 KiB page
  const exports = section(7, vec([
    [...name("express"), 0x00, ...uleb(2)],
    [...name("memory"), 0x02, ...uleb(0)],
  ]));

  const body: number[] = [0x00]; // no locals
  calls.forEach((call, i) => {
    body.push(0x41, ...sleb(REQUEST_BASE + i * SLOT));
    body.push(0x41, ...sleb(requests[i].length));
    body.push(0x41, ...sleb(RESPONSE_BASE + i * SLOT));
    body.push(0x41, ...sleb(SLOT));
    body.push(0x10, ...uleb(IMPORT[call.op]));
    body.push(0x1a); // drop the byte count
  });
  body.push(0x41, ...sleb(RESPONSE_BASE + (calls.length - 1) * SLOT));
  body.push(0x0b);
  const code = section(10, vec([[...uleb(body.length), ...body]]));

  const data = section(11, vec(requests.map((bytes, i) => [0x00, 0x41, ...sleb(REQUEST_BASE + i * SLOT), 0x0b, ...uleb(bytes.length), ...bytes])));

  return new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00, ...types, ...imports, ...functions, ...memory, ...exports, ...code, ...data]);
}

/** A writeMemory request (wire shape; value is base64). */
export const writeRequest = (key: string, value: string, category = "PREFERENCE"): string =>
  JSON.stringify({ key, value: Buffer.from(value).toString("base64"), category });

export const readRequest = (key: string): string => JSON.stringify({ key });
