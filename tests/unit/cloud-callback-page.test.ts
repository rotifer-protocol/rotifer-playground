import { describe, expect, it } from "vitest";
import { startOAuthCallbackServer } from "../../src/cloud/auth.js";

/**
 * Pages as a browser gets them from the real callback port. Each test ends the
 * login with a code so that no server or timer is left behind.
 */
async function pageFor(query: string): Promise<{ status: number; type: string | null; body: string }> {
  const { port, waitForCallback } = await startOAuthCallbackServer(0);
  const res = await fetch(`http://127.0.0.1:${port}/callback${query}`);
  const body = await res.text();
  if (!new URLSearchParams(query).get("code")) await fetch(`http://127.0.0.1:${port}/callback?code=finish`);
  await waitForCallback;
  return { status: res.status, type: res.headers.get("content-type"), body };
}

const CANCELED = "?error=access_denied&error_code=access_denied&error_description=The+user+denied+the+request";
const FAILED = "?error=server_error&error_code=unexpected_failure&error_description=Error+getting+user+email";

const STATES = [
  ["success", "?code=stand-in-code", "Authorization complete", "Return to your terminal"],
  ["canceled", CANCELED, "Login canceled", "To try again"],
  ["failed", FAILED, "Login failed", "To try again"],
  ["incomplete", "", "Login didn't finish", "To try again"],
] as const;

const TITLES = STATES.map(([, , title]) => title);

describe("the login callback pages", () => {
  it.each(STATES)("%s shows only its own message", async (_name, query, title, text) => {
    const { status, type, body } = await pageFor(query);
    expect(status).toBe(200);
    expect(type).toContain("text/html");
    expect(body).toContain(`<h1>${title}</h1>`);
    expect(body).toContain(text);
    for (const other of TITLES.filter((t) => t !== title)) expect(body).not.toContain(other);
  });

  it("treats a code as success even if an error is also present", async () => {
    expect((await pageFor(`?code=stand-in-code&error=server_error`)).body).toContain("Authorization complete");
  });

  it("treats an empty error as an incomplete login", async () => {
    expect((await pageFor("?error=")).body).toContain("Login didn't finish");
  });

  describe("never writes the URL into the page", () => {
    const MARK = "zzmarkzz";
    const payload = `<script>alert(1)</script>"'${MARK}`;
    const encoded = encodeURIComponent(payload);

    it.each([
      ["error", `?error=${encoded}`],
      ["error_description", `?error=server_error&error_description=${encoded}`],
      ["error_description while canceled", `?error=access_denied&error_description=${encoded}`],
      ["error_code", `?error=server_error&error_code=${encoded}`],
      ["state", `?state=${encoded}`],
      ["code", `?code=${encoded}`],
      ["an unknown parameter", `?${MARK}=${encoded}`],
    ])("from %s", async (_label, query) => {
      const { body } = await pageFor(query);
      expect(body).not.toContain(MARK);
      expect(body).not.toContain("alert(1)");
    });
  });

  describe.each(STATES)("%s", (_name, query) => {
    it("loads nothing else", async () => {
      const { body } = await pageFor(query);
      expect(body).not.toMatch(/https?:/i);
      expect(body).not.toMatch(/\burl\(|@import|<script|<img|<iframe|\bsrc=/i);
      expect(body.match(/\bhref="[^"]*"/g)).toEqual(['href="data:,"']);
    });

    it("carries the logo and follows the system theme", async () => {
      const { body } = await pageFor(query);
      expect(body).toMatch(/<svg [^>]*class="logo"/);
      expect(body).toContain("@media (prefers-color-scheme: light)");
      expect(body).toContain('name="viewport"');
    });
  });
});
