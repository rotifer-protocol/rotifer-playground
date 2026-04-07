import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execSync, spawn } from "node:child_process";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_HOME = join(tmpdir(), `rotifer-api-key-test-${Date.now()}`);
const CLI = join(__dirname, "..", "..", "dist", "index.js");

type CapturedRequest = {
  method: string;
  url: string;
  body: string;
};

let baseUrl = "";
let requests: CapturedRequest[] = [];
let listResponse: unknown[] = [];
let revokeLookupResponse: unknown[] = [];
let postStatus = 201;
let postBody = "";

async function run(args: string): Promise<{ stdout: string; exitCode: number }> {
  const argList = args.match(/(?:[^\s"]+|"[^"]*")+/g)?.map((arg) => arg.replace(/^"|"$/g, "")) ?? [];

  return new Promise((resolve) => {
    const child = spawn("node", [CLI, ...argList], {
      env: {
        ...process.env,
        FORCE_COLOR: "0",
        HOME: TEST_HOME,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      resolve({ stdout, exitCode: 1 });
    }, 15000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });
    child.stderr.on("data", (chunk) => {
      stdout += chunk.toString("utf-8");
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ stdout, exitCode: code ?? 1 });
    });
  });
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

function respondJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

describe("api-key CLI commands", () => {
  let server: ReturnType<typeof createServer>;

  beforeAll(async () => {
    mkdirSync(join(TEST_HOME, ".rotifer"), { recursive: true });

    server = createServer(async (req, res) => {
      const body = await readBody(req);
      requests.push({
        method: req.method || "GET",
        url: req.url || "/",
        body,
      });

      if (!req.url?.startsWith("/rest/v1/api_keys")) {
        respondJson(res, 404, { error: "not found" });
        return;
      }

      if (req.method === "POST") {
        res.statusCode = postStatus;
        if (postBody) {
          res.setHeader("Content-Type", "application/json");
          res.end(postBody);
        } else {
          res.end();
        }
        return;
      }

      if (req.method === "GET") {
        const payload = req.url.includes("select=id,name,key_prefix,revoked_at")
          ? revokeLookupResponse
          : listResponse;
        respondJson(res, 200, payload);
        return;
      }

      if (req.method === "PATCH") {
        res.statusCode = 204;
        res.end();
        return;
      }

      respondJson(res, 405, { error: "method_not_allowed" });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address() as { port: number };
        baseUrl = `http://127.0.0.1:${addr.port}`;
        resolve();
      });
    });

    writeFileSync(
      join(TEST_HOME, ".rotifer", "cloud.json"),
      JSON.stringify(
        {
          endpoint: baseUrl,
          anonKey: "test-anon-key",
        },
        null,
        2
      ) + "\n"
    );

    writeFileSync(
      join(TEST_HOME, ".rotifer", "credentials.json"),
      JSON.stringify(
        {
          access_token: "test-access-token",
          refresh_token: "test-refresh-token",
          expires_at: Date.now() + 3600_000,
          provider: "github",
          user: {
            id: "58a7c9cf-94ce-4ce7-bb25-e6380b2aab6c",
            username: "testdev",
            avatar_url: null,
            provider_id: "github-user-1",
          },
        },
        null,
        2
      ) + "\n"
    );
  });

  afterAll(() => {
    server.close();
    if (existsSync(TEST_HOME)) {
      rmSync(TEST_HOME, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    requests = [];
    listResponse = [];
    revokeLookupResponse = [];
    postStatus = 201;
    postBody = "";
  });

  it("api-key help shows subcommands", async () => {
    const result = await run("api-key --help");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Manage Evolution API keys");
    expect(result.stdout).toContain("create");
    expect(result.stdout).toContain("list");
    expect(result.stdout).toContain("revoke");
  });

  it("api-key create succeeds when PostgREST returns 201 with empty body", async () => {
    const result = await run("api-key create --name \"test-key\"");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("API key created successfully");
    expect(result.stdout).toContain("Save this key now");

    const post = requests.find((req) => req.method === "POST");
    expect(post).toBeDefined();

    const payload = JSON.parse(post!.body);
    expect(payload.name).toBe("test-key");
    expect(payload.owner_id).toBe("58a7c9cf-94ce-4ce7-bb25-e6380b2aab6c");
    expect(payload.scopes).toEqual(["read"]);
    expect(payload.rate_limit_per_min).toBe(30);
    expect(payload.key_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("api-key create rejects invalid scopes", async () => {
    const result = await run("api-key create --name \"bad-key\" --scopes nope");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("Invalid scope");
  });

  it("api-key list shows empty state when no keys exist", async () => {
    const result = await run("api-key list");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("No API keys found.");
  });

  it("api-key revoke reports missing prefix when key does not exist", async () => {
    const result = await run("api-key revoke --prefix rk_missing");
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toContain("No key found with prefix 'rk_missing'");
  });
});
