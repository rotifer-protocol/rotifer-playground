/**
 * The database connection checks the server's certificate and host name
 * whenever the database is not on this machine. These tests cover what the
 * function hands the driver; tls-check.sh connects to a real server.
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1";
import { databaseTls, issuerUser } from "./store.ts";
import { SUPABASE_ROOT_CA_2021, SUPABASE_ROOT_CA_2025, SUPABASE_ROOT_CAS } from "./supabase-root-ca.ts";

const POOLER = "postgres://por_issuer.abcdefghijklmnopqrst:pw@aws-1-us-west-1.pooler.supabase.com:6543/postgres";
const DIRECT = "postgresql://por_issuer:pw@db.abcdefghijklmnopqrst.supabase.co:5432/postgres";

Deno.test("sslmode=require is refused for a database that is not local: it encrypts but checks nothing", () => {
  for (const url of [`${POOLER}?sslmode=require`, `${DIRECT}?sslmode=require`, `${DIRECT}?sslmode=verify-full&sslmode=require`]) {
    assertThrows(() => issuerUser(url), Error, "verify-full", url);
  }
  assertEquals(issuerUser(`${POOLER}?sslmode=verify-full`), "por_issuer.abcdefghijklmnopqrst");
});

Deno.test("verify-full without a root CA is refused, so a missing CA cannot fall back to the runtime's own trust store", () => {
  for (const cas of [[], [""], ["not a certificate"]]) {
    assertThrows(() => databaseTls(`${POOLER}?sslmode=verify-full`, cas), Error, "root CA", JSON.stringify(cas));
  }
});

// The real driver and node:crypto run in a child Deno with no node_modules
// directory: the repository's package.json otherwise makes Deno look for npm
// packages and Node types in a node_modules that CI never installs.
// tls-check.sh runs the driver the same way.
async function child<T>(source: string, args: string[]): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    const script = `${dir}/child.ts`;
    await Deno.writeTextFile(script, source);
    const { code, stdout, stderr } = await new Deno.Command(Deno.execPath(), {
      args: ["run", "--allow-read", "--allow-env", "--no-lock", "--node-modules-dir=none", script, ...args],
      cwd: dir,
    }).output();
    const dec = new TextDecoder();
    assertEquals(code, 0, dec.decode(stderr));
    return JSON.parse(dec.decode(stdout)) as T;
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const here = (file: string) => new URL(file, import.meta.url).href;

const DRIVER_OPTIONS = `
import postgres from "npm:postgres@3.4.7";
const { databaseTls } = await import(Deno.args[0]);
const { SUPABASE_ROOT_CAS } = await import(Deno.args[1]);
const out = [];
for (const url of Deno.args.slice(2)) {
  const sql = postgres(url, { max: 1, ...databaseTls(url, SUPABASE_ROOT_CAS) });
  out.push({ url, ssl: sql.options.ssl });
  await sql.end();
}
console.log(JSON.stringify(out));
`;

Deno.test("the driver receives the root CAs with rejectUnauthorized true, whatever sslmode the URL says", async () => {
  const urls = [`${POOLER}?sslmode=verify-full`, `${DIRECT}?sslmode=verify-full`];
  const seen = await child<{ url: string; ssl: { ca?: unknown; rejectUnauthorized?: unknown } }[]>(
    DRIVER_OPTIONS,
    [here("./store.ts"), here("./supabase-root-ca.ts"), ...urls],
  );
  assertEquals(seen.map((s) => s.url), urls);
  for (const { url, ssl } of seen) {
    assertEquals(ssl.rejectUnauthorized, true, url);
    assertEquals(ssl.ca, [...SUPABASE_ROOT_CAS], url);
  }
});

Deno.test("a local database is left to its connection string, as before", () => {
  for (const host of ["localhost:54322", "127.0.0.1:54322", "[::1]:5432", "db:5432"]) {
    assertEquals(databaseTls(`postgresql://por_issuer:pw@${host}/postgres`, []), {}, host);
  }
});

Deno.test("index.ts gives the driver databaseTls with the built-in root CAs", async () => {
  const code = await Deno.readTextFile(new URL("./index.ts", import.meta.url));
  assert(/postgres\(dbUrl, \{[^}]*\.\.\.tls[^}]*\}\)/.test(code), "the driver options must include the TLS options");
  assert(/const tls = databaseTls\(dbUrl, SUPABASE_ROOT_CAS\)/.test(code), "the TLS options come from the built-in CAs");
});

const EXPECTED = [
  "80:70:25:AD:50:D4:ED:21:9D:2C:9C:7D:29:9C:00:4F:82:4E:B0:0C:F7:F6:5A:FE:F6:07:D0:7B:72:E6:CA:FA",
  "5F:9B:77:95:1A:7A:A1:30:3F:9B:58:EE:A9:BF:A8:9E:35:8C:FD:C1:5F:97:86:FF:10:D4:93:0A:72:2C:9A:E2",
];

type CertFacts = { fingerprint256: string; ca: boolean; subject: string; validTo: string };
const CERT_FACTS = `
import { X509Certificate } from "node:crypto";
const pems = JSON.parse(await Deno.readTextFile(Deno.args[0]));
console.log(JSON.stringify(pems.map((pem) => {
  const c = new X509Certificate(pem);
  return { fingerprint256: c.fingerprint256, ca: c.ca, subject: c.subject, validTo: c.validTo };
})));
`;
let factsOf: Promise<CertFacts[]> | undefined;
async function certFacts(pems: readonly string[]): Promise<CertFacts[]> {
  const file = await Deno.makeTempFile({ suffix: ".json" });
  try {
    await Deno.writeTextFile(file, JSON.stringify(pems));
    return await child<CertFacts[]>(CERT_FACTS, [file]);
  } finally {
    await Deno.remove(file);
  }
}
const builtInFacts = () => (factsOf ??= certFacts([SUPABASE_ROOT_CA_2021, SUPABASE_ROOT_CA_2025]));

Deno.test("the built-in root CAs are the two published Supabase roots, by SHA-256 fingerprint", async () => {
  assertEquals((await certFacts(SUPABASE_ROOT_CAS)).map((c) => c.fingerprint256), EXPECTED);
  for (const cert of await builtInFacts()) {
    assert(cert.ca, "a CA certificate");
    assertEquals(cert.subject.split("\n").find((l) => l.startsWith("CN=")), "CN=Supabase Root 2021 CA");
  }
});

const SIXTY_DAYS = 60 * 24 * 3600 * 1000;
for (const [i, name, expires] of [[0, "2021", "2031-04-26"], [1, "2025", "2035-09-01"]] as const) {
  Deno.test(`the ${name} root CA (expires ${expires}) is more than 60 days from expiry: replace it before this fails`, async () => {
    const cert = (await builtInFacts())[i];
    assertEquals(new Date(cert.validTo).toISOString().slice(0, 10), expires);
    const left = new Date(cert.validTo).getTime() - Date.now();
    assert(left > SIXTY_DAYS, `the ${name} root CA expires ${cert.validTo}: under 60 days left, add its replacement before it lapses`);
  });
}
