import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { localUrl } from "./local-only.ts";

Deno.test("localUrl: the fallback is used when the variable is unset", () => {
  assertEquals(localUrl("X", undefined, "http://127.0.0.1:54321"), "http://127.0.0.1:54321");
});

Deno.test("localUrl: loopback hosts are accepted", () => {
  for (const u of ["http://127.0.0.1:54321", "http://localhost:54321", "http://[::1]:54321", "postgresql://postgres:postgres@127.0.0.1:54322/postgres"]) {
    assertEquals(localUrl("X", u, "unused"), u);
  }
});

Deno.test("localUrl: a hosted project is refused, naming the variable and host only", () => {
  const e = assertThrows(() => localUrl("SUPABASE_URL", "https://abcd.supabase.co", "unused"));
  assertEquals((e as Error).message.includes("SUPABASE_URL"), true);
  assertEquals((e as Error).message.includes("abcd.supabase.co"), true);
});

Deno.test("localUrl: the password of a refused URL is not echoed", () => {
  const e = assertThrows(() => localUrl("DB_URL", "postgresql://postgres:hunter2@db.abcd.supabase.co:5432/postgres", "unused"));
  assertEquals((e as Error).message.includes("hunter2"), false);
});

Deno.test("localUrl: something that is not a URL is refused", () => {
  assertThrows(() => localUrl("DB_URL", "not a url", "unused"));
});
