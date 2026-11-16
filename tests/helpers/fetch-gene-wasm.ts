/**
 * A hand-assembled WASM gene that makes one `rotifer.net.fetch` call and
 * returns a negative result as its error code — for tests that need a real
 * sandboxed request without compiling a gene.
 */

const DATA = 1024;
const OUT = 16384;
const OUT_CAP = 65536;

function uleb(n: number): number[] {
  const out: number[] = [];
  do {
    const low = n & 0x7f;
    n >>>= 7;
    out.push(n ? low | 0x80 : low);
  } while (n);
  return out;
}

function i32Const(n: number): number[] {
  const out: number[] = [0x41];
  for (;;) {
    const low = n & 0x7f;
    n >>= 7;
    const done = (n === 0 && !(low & 0x40)) || (n === -1 && low & 0x40);
    out.push(done ? low : low | 0x80);
    if (done) return out;
  }
}

const name = (s: string) => [...uleb(s.length), ...Buffer.from(s)];
const vec = (items: number[][]) => [...uleb(items.length), ...items.flat()];
const section = (id: number, body: number[]) => [id, ...uleb(body.length), ...body];

/** `express(i32, i32) -> i32` that sends `envelope` to rotifer.net.fetch and returns a negative result as its error code. */
export function fetchGene(envelope: string): Buffer {
  const I32 = 0x7f;
  const body = [
    ...[1, 1, I32], // one extra i32 local: index 2
    ...i32Const(DATA),
    ...i32Const(envelope.length),
    ...i32Const(OUT),
    ...i32Const(OUT_CAP),
    ...[0x10, 0], // call fetch
    ...[0x21, 2, 0x20, 2], // local.set 2, local.get 2
    ...i32Const(0),
    0x48, // i32.lt_s
    ...[0x04, 0x40], // if
    ...[0x20, 2, 0x0f], // local.get 2, return
    0x0b, // end if
    ...i32Const(OUT),
    0x0b,
  ];
  return Buffer.from([
    ...[0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00],
    ...section(1, vec([[0x60, 4, I32, I32, I32, I32, 1, I32], [0x60, 2, I32, I32, 1, I32]])),
    ...section(2, vec([[...name("rotifer.net"), ...name("fetch"), 0x00, 0]])),
    ...section(3, vec([[1]])),
    ...section(5, vec([[0x01, 4, 16]])),
    ...section(7, vec([[...name("express"), 0x00, 1], [...name("memory"), 0x02, 0]])),
    ...section(10, vec([[...uleb(body.length), ...body]])),
    ...section(11, vec([[0x00, ...i32Const(DATA), 0x0b, ...name(envelope)]])),
  ]);
}

/** A gene that sends the environment variable `envName` as a bearer token to `https://<target>/`. */
export function bearerGene(envName: string, target: string): Buffer {
  return fetchGene(
    JSON.stringify({ method: "GET", url: `https://${target}/`, headers: { Authorization: `Bearer \${env:${envName}}` } }),
  );
}
