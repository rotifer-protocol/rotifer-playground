/**
 * The database connection checks the server's certificate and host name
 * whenever the database is not on this machine. These tests cover what the
 * function hands the driver; tls-check.sh connects to a real server.
 */

import { X509Certificate } from "node:crypto";
import postgres from "npm:postgres@3.4.7";
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

Deno.test("the driver receives the root CAs with rejectUnauthorized true, whatever sslmode the URL says", async () => {
  for (const url of [`${POOLER}?sslmode=verify-full`, `${DIRECT}?sslmode=verify-full`]) {
    const sql = postgres(url, { max: 1, ...databaseTls(url, SUPABASE_ROOT_CAS) });
    try {
      const ssl = sql.options.ssl as { ca?: unknown; rejectUnauthorized?: unknown };
      assertEquals(ssl.rejectUnauthorized, true, url);
      assertEquals(ssl.ca, [...SUPABASE_ROOT_CAS], url);
    } finally {
      await sql.end();
    }
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

Deno.test("the built-in root CAs are the two published Supabase roots, by SHA-256 fingerprint", () => {
  assertEquals(SUPABASE_ROOT_CAS.map((pem) => new X509Certificate(pem).fingerprint256), EXPECTED);
  for (const pem of SUPABASE_ROOT_CAS) {
    const cert = new X509Certificate(pem);
    assert(cert.ca, "a CA certificate");
    assertEquals(cert.subject.split("\n").find((l) => l.startsWith("CN=")), "CN=Supabase Root 2021 CA");
  }
});

const SIXTY_DAYS = 60 * 24 * 3600 * 1000;
for (const [name, pem, expires] of [["2021", SUPABASE_ROOT_CA_2021, "2031-04-26"], ["2025", SUPABASE_ROOT_CA_2025, "2035-09-01"]]) {
  Deno.test(`the ${name} root CA (expires ${expires}) is more than 60 days from expiry: replace it before this fails`, () => {
    const cert = new X509Certificate(pem);
    assertEquals(new Date(cert.validTo).toISOString().slice(0, 10), expires);
    const left = new Date(cert.validTo).getTime() - Date.now();
    assert(left > SIXTY_DAYS, `the ${name} root CA expires ${cert.validTo}: under 60 days left, add its replacement before it lapses`);
  });
}
