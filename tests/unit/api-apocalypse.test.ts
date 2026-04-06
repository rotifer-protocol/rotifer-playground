import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { join } from "node:path";

const EXPERIMENT_DIR = join(__dirname, "../../examples/api-apocalypse");

describe("API Apocalypse experiment", () => {
  describe("file structure", () => {
    const requiredFiles = [
      "mock-server.ts",
      "run.ts",
      "baseline-agent.ts",
      "rotifer-agent.ts",
      "demo.ts",
    ];

    for (const file of requiredFiles) {
      it(`${file} exists`, () => {
        expect(existsSync(join(EXPERIMENT_DIR, file))).toBe(true);
      });
    }
  });

  describe("mock server endpoints (in-process)", () => {
    let server: Server;
    const PORT = 19876;
    let serverStartTime: number;

    function currentTemp(): number {
      return 23.5 + (Math.random() - 0.5) * 0.6;
    }

    beforeAll(
      () =>
        new Promise<void>((resolve) => {
          serverStartTime = Date.now();
          server = createServer((req: IncomingMessage, res: ServerResponse) => {
            const url = req.url ?? "/";
            if (url === "/source-a") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ temperature: currentTemp(), city: "Beijing", unit: "celsius" }));
            } else if (url === "/source-b") {
              res.writeHead(200, { "Content-Type": "application/xml" });
              res.end(`<weather><city>Beijing</city><temperature>${currentTemp()}</temperature></weather>`);
            } else if (url === "/source-c") {
              res.writeHead(200, { "Content-Type": "text/csv" });
              res.end(`city,temperature,unit\nBeijing,${currentTemp()},celsius`);
            } else if (url === "/status") {
              res.writeHead(200, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ elapsedMs: Date.now() - serverStartTime, currentPhase: "normal" }));
            } else {
              res.writeHead(404);
              res.end("Not Found");
            }
          });
          server.listen(PORT, resolve);
        })
    );

    afterAll(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        })
    );

    it("source-a returns JSON with temperature", async () => {
      const res = await fetch(`http://localhost:${PORT}/source-a`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.city).toBe("Beijing");
      expect(data.temperature).toBeTypeOf("number");
      expect(data.unit).toBe("celsius");
    });

    it("source-b returns XML with temperature", async () => {
      const res = await fetch(`http://localhost:${PORT}/source-b`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("<weather>");
      expect(text).toContain("Beijing");
    });

    it("source-c returns CSV with temperature", async () => {
      const res = await fetch(`http://localhost:${PORT}/source-c`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain("city,temperature,unit");
      expect(text).toContain("Beijing");
    });

    it("status endpoint returns phase info", async () => {
      const res = await fetch(`http://localhost:${PORT}/status`);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.currentPhase).toBe("normal");
      expect(data.elapsedMs).toBeTypeOf("number");
    });

    it("unknown path returns 404", async () => {
      const res = await fetch(`http://localhost:${PORT}/nonexistent`);
      expect(res.status).toBe(404);
    });
  });

  describe("DomainFailoverEngine integration with mock sources", () => {
    it("can failover between sources when one returns error", async () => {
      const { DomainFailoverEngine } = await import("../../src/runtime/domain-failover.js");

      const engine = new DomainFailoverEngine();

      engine.registerGene("source-a", "weather", async () => ({
        success: false,
        error: "rate limited",
        engine: "test",
        durationMs: 1,
      }));

      engine.registerGene("source-b", "weather", async () => ({
        success: true,
        output: { temp: 23.5, city: "Beijing" },
        engine: "test",
        durationMs: 5,
      }));

      engine.initialize();

      const result = await engine.executeDomain("weather", {});
      expect(result.status).toBe("success");
      expect(result.geneUsed).toBe("source-b");
      expect(result.switchedFrom).toBe("source-a");
    });
  });
});
