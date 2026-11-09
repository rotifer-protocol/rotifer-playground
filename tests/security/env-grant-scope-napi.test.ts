import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryLoadBinding, type NativeBinding } from "../../src/utils/binding.js";
import { executeAlgebra, executeGene, requireCredentialConsent } from "../../src/utils/env-grant-consent.js";
import { DEFAULT_SANDBOX_CONSTRAINTS_JSON } from "../../src/utils/sandbox-defaults.js";

/**
 * The credential limit has to survive the JS → Rust call (#508). Everything
 * else about it is tested on one side of that call: the TS tests use a stand-in
 * binding, and the Rust tests hand the scope straight to the inner functions.
 * Here the CLI's own wrappers call the real addon, so an export that loses the
 * scope fails.
 *
 * The genes fetch `.invalid` hosts (RFC 2606, never resolve). A request that
 * was let through ends as a network failure (-5, or -4 if the resolver is
 * slow); one refused by the limit ends as -2 before any network call.
 *
 * Needs the addon built from this checkout: CI builds it for the Test jobs and
 * fails here without it. An addon older than #508 ignores the scope and fails.
 */

const GRANTED_HOST = "rotifer-permission-test.invalid";
const OTHER_HOST = "rotifer-permission-other.invalid";
const KEY = "T508_NAPI_KEY";
const VALUE = "t508-placeholder-value";
const NETWORK_FAILURES = [-5, -4];
const REFUSED = -2;

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
function fetchGene(envelope: string): Buffer {
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

/** A gene that sends the credential to `target`. */
function bearerGene(target: string): Buffer {
  return fetchGene(
    JSON.stringify({ method: "GET", url: `https://${target}/`, headers: { Authorization: `Bearer \${env:${KEY}}` } }),
  );
}

/** Declares the credential for `credentialHost` only. `otherHost` is a dependency too, so only the grant keeps the key from it. */
function phenotype(credentialHost: string, otherHost: string) {
  return {
    domain: "test.credentials",
    inputSchema: { type: "object" },
    outputSchema: { type: "object" },
    version: "0.1.0",
    fidelity: "Hybrid",
    externalDependencies: [
      { apiType: "rest", semanticTag: "credential-test", domains: [credentialHost], credentials: [KEY] },
      { apiType: "rest", semanticTag: "other-dependency", domains: [otherHost] },
    ],
    network: { allowedDomains: [credentialHost, otherHost], maxTimeoutMs: 5000 },
  };
}

function guestCode(message: string | null): number {
  const match = /error code: (-?\d+)/.exec(message ?? "");
  if (!match) throw new Error(`no guest error code in: ${message}`);
  return Number(match[1]);
}

const loaded = tryLoadBinding() as (NativeBinding & { constructor: new (dir: string) => NativeBinding }) | null;

describe.skipIf(!loaded && !process.env.CI)("the credential limit across the JS → Rust call", () => {
  let root: string;
  let binding: NativeBinding;

  function externalGene(geneName: string, phenotypeValue: unknown): string {
    const dir = join(root, geneName);
    mkdirSync(dir);
    writeFileSync(join(dir, "phenotype.json"), JSON.stringify(phenotypeValue));
    writeFileSync(join(dir, ".cloud-manifest.json"), JSON.stringify({ installed_at: "2026-01-01" }));
    return dir;
  }

  beforeEach(() => {
    if (!loaded) throw new Error("no rotifer native addon: build crates/rotifer-napi from this checkout");
    root = mkdtempSync(join(tmpdir(), "rotifer-scope-napi-"));
    binding = new loaded.constructor(root);
    vi.stubEnv(KEY, VALUE);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("a credential granted for one host does not go to another host the gene can reach", async () => {
    const declared = phenotype(GRANTED_HOST, OTHER_HOST);
    const dir = externalGene("gene", declared);
    await requireCredentialConsent([{ name: "gene", dir }], { allowCredentials: `${KEY}@${GRANTED_HOST}` });

    const run = (target: string) =>
      executeGene(binding, dir, bearerGene(target), "{}", JSON.stringify(declared), DEFAULT_SANDBOX_CONSTRAINTS_JSON);

    expect(NETWORK_FAILURES, "the granted host must be let through").toContain(guestCode(run(GRANTED_HOST).errorMessage));
    const elsewhere = run(OTHER_HOST);
    expect(guestCode(elsewhere.errorMessage), "the host it was not granted for must be refused").toBe(REFUSED);
    expect(JSON.stringify(elsewhere)).not.toContain(VALUE);
  }, 30_000);

  it("in a composition, gene B cannot use the grant gene A holds", async () => {
    const a = phenotype(GRANTED_HOST, OTHER_HOST);
    const b = phenotype(OTHER_HOST, GRANTED_HOST);
    const dirA = externalGene("a", a);
    const dirB = externalGene("b", b);
    await requireCredentialConsent(
      [{ name: "a", dir: dirA }, { name: "b", dir: dirB }],
      { allowCredentials: `${KEY}@${GRANTED_HOST},${KEY}@${OTHER_HOST}` },
    );

    const idA = new Array<number>(32).fill(10);
    const idB = new Array<number>(32).fill(11);
    const key = (id: number[]) => Buffer.from(id).toString("hex");
    // Both send the key to the host only A was granted it for.
    const entries = JSON.stringify({
      [key(idA)]: { wasm: [...bearerGene(GRANTED_HOST)], phenotype: a },
      [key(idB)]: { wasm: [...bearerGene(GRANTED_HOST)], phenotype: b },
    });
    const genes = { [key(idA)]: { dir: dirA, phenotype: a }, [key(idB)]: { dir: dirB, phenotype: b } };
    const run = (id: number[]) =>
      executeAlgebra(binding, genes, JSON.stringify({ Seq: [{ Gene: id }] }), entries, "{}", DEFAULT_SANDBOX_CONSTRAINTS_JSON);

    expect(NETWORK_FAILURES, "gene A holds this grant").toContain(guestCode(run(idA).errorMessage));
    const borrower = run(idB);
    expect(guestCode(borrower.errorMessage), "gene B does not").toBe(REFUSED);
    expect(JSON.stringify(borrower)).not.toContain(VALUE);
  }, 30_000);
});
