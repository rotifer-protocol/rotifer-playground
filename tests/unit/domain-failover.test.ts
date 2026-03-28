import { describe, it, expect, vi } from "vitest";
import {
  DomainFailoverEngine,
  type GeneExecutionResult,
} from "../../src/runtime/domain-failover.js";

function okResult(output: unknown = "ok"): GeneExecutionResult {
  return { success: true, output, engine: "test", durationMs: 1 };
}

function failResult(error = "boom"): GeneExecutionResult {
  return { success: false, error, engine: "test", durationMs: 1 };
}

describe("DomainFailoverEngine", () => {
  describe("registration & initialization", () => {
    it("registers genes and tracks domains", () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("a", "weather", vi.fn());
      engine.registerGene("b", "weather", vi.fn());
      engine.registerGene("c", "search", vi.fn());

      expect(engine.getDomains()).toEqual(["weather", "search"]);
      expect(engine.getPoolSize("weather")).toBe(2);
      expect(engine.getPoolSize("search")).toBe(1);
    });

    it("initialize sets first registered gene as active", () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("alpha", "d", vi.fn());
      engine.registerGene("beta", "d", vi.fn());
      engine.initialize();

      expect(engine.getActiveGene("d")).toBe("alpha");
    });

    it("getPoolSize returns 0 for unknown domain", () => {
      const engine = new DomainFailoverEngine();
      expect(engine.getPoolSize("nonexistent")).toBe(0);
    });
  });

  describe("executeDomain — happy path", () => {
    it("returns success when active gene succeeds", async () => {
      const engine = new DomainFailoverEngine();
      const executor = vi.fn().mockResolvedValue(okResult("sunny"));
      engine.registerGene("weather-v1", "weather", executor);
      engine.initialize();

      const result = await engine.executeDomain("weather", { city: "Beijing" });

      expect(result.status).toBe("success");
      expect(result.geneUsed).toBe("weather-v1");
      expect(result.output).toBe("sunny");
      expect(result.switchedFrom).toBeUndefined();
      expect(result.attempts).toBe(1);
    });
  });

  describe("executeDomain — failover", () => {
    it("switches to backup gene when active fails", async () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("v1", "weather", vi.fn().mockResolvedValue(failResult()));
      engine.registerGene("v2", "weather", vi.fn().mockResolvedValue(okResult("rainy")));
      engine.initialize();

      const result = await engine.executeDomain("weather", {});

      expect(result.status).toBe("success");
      expect(result.geneUsed).toBe("v2");
      expect(result.switchedFrom).toBe("v1");
      expect(result.attempts).toBe(2);
    });

    it("returns all_failed when every gene fails", async () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("a", "d", vi.fn().mockResolvedValue(failResult()));
      engine.registerGene("b", "d", vi.fn().mockResolvedValue(failResult()));
      engine.registerGene("c", "d", vi.fn().mockResolvedValue(failResult()));
      engine.initialize();

      const result = await engine.executeDomain("d", {});

      expect(result.status).toBe("all_failed");
      expect(result.attempts).toBe(3);
      expect(result.geneUsed).toBeUndefined();
    });

    it("returns all_failed for empty domain", async () => {
      const engine = new DomainFailoverEngine();
      const result = await engine.executeDomain("nonexistent", {});

      expect(result.status).toBe("all_failed");
      expect(result.attempts).toBe(0);
    });
  });

  describe("fitness scoring", () => {
    it("rewards successful genes (fitness increases)", async () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("g", "d", vi.fn().mockResolvedValue(okResult()));
      engine.initialize();

      await engine.executeDomain("d", {});
      await engine.executeDomain("d", {});

      const state = engine.exportFitnessState();
      expect(state["g"].fitness).toBeCloseTo(0.6); // 0.5 + 0.05 + 0.05
      expect(state["g"].successes).toBe(2);
      expect(state["g"].failures).toBe(0);
    });

    it("penalizes failed genes (fitness decreases)", async () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("g", "d", vi.fn().mockResolvedValue(failResult()));
      engine.initialize();

      await engine.executeDomain("d", {});

      const state = engine.exportFitnessState();
      expect(state["g"].fitness).toBeCloseTo(0.35); // 0.5 - 0.15
      expect(state["g"].failures).toBe(1);
    });

    it("fitness is clamped to [0, 1]", async () => {
      const engine = new DomainFailoverEngine();
      const alwaysFail = vi.fn().mockResolvedValue(failResult());
      engine.registerGene("g", "d", alwaysFail);
      engine.initialize();

      for (let i = 0; i < 10; i++) await engine.executeDomain("d", {});

      const state = engine.exportFitnessState();
      expect(state["g"].fitness).toBe(0);
    });

    it("after failover, higher-fitness gene becomes active", async () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("weak", "d", vi.fn().mockResolvedValue(failResult()));
      engine.registerGene("strong", "d", vi.fn().mockResolvedValue(okResult()));
      engine.initialize();

      expect(engine.getActiveGene("d")).toBe("weak");

      await engine.executeDomain("d", {});

      expect(engine.getActiveGene("d")).toBe("strong");
    });
  });

  describe("fitness state persistence", () => {
    it("export → import preserves fitness and counters", async () => {
      const engine1 = new DomainFailoverEngine();
      engine1.registerGene("a", "d", vi.fn().mockResolvedValue(okResult()));
      engine1.registerGene("b", "d", vi.fn().mockResolvedValue(failResult()));
      engine1.initialize();

      await engine1.executeDomain("d", {});

      const exported = engine1.exportFitnessState();

      const engine2 = new DomainFailoverEngine();
      engine2.registerGene("a", "d", vi.fn().mockResolvedValue(okResult()));
      engine2.registerGene("b", "d", vi.fn().mockResolvedValue(okResult()));
      engine2.initialize();
      engine2.loadFitnessState(exported);

      expect(engine2.getActiveGene("d")).toBe("a");

      const state = engine2.exportFitnessState();
      expect(state["a"].fitness).toBeCloseTo(0.55);
      expect(state["a"].successes).toBe(1);
    });

    it("loadFitnessState promotes highest-fitness gene to active", () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("low", "d", vi.fn());
      engine.registerGene("high", "d", vi.fn());
      engine.initialize();

      engine.loadFitnessState({
        low: { fitness: 0.2, successes: 1, failures: 5 },
        high: { fitness: 0.9, successes: 8, failures: 0 },
      });

      expect(engine.getActiveGene("d")).toBe("high");
    });
  });

  describe("executeAll", () => {
    it("executes all domains in parallel", async () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("w1", "weather", vi.fn().mockResolvedValue(okResult("sunny")));
      engine.registerGene("s1", "search", vi.fn().mockResolvedValue(okResult("results")));
      engine.initialize();

      const results = await engine.executeAll({});

      expect(results).toHaveLength(2);
      expect(results.every((r) => r.status === "success")).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles gene that throws an exception", async () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("crasher", "d", vi.fn().mockRejectedValue(new Error("crash")));
      engine.initialize();

      await expect(engine.executeDomain("d", {})).rejects.toThrow("crash");
    });

    it("three genes: first fails, second fails, third succeeds", async () => {
      const engine = new DomainFailoverEngine();
      engine.registerGene("a", "d", vi.fn().mockResolvedValue(failResult()));
      engine.registerGene("b", "d", vi.fn().mockResolvedValue(failResult()));
      engine.registerGene("c", "d", vi.fn().mockResolvedValue(okResult("finally")));
      engine.initialize();

      const result = await engine.executeDomain("d", {});
      expect(result.status).toBe("success");
      expect(result.geneUsed).toBe("c");
      expect(result.switchedFrom).toBe("a");
      expect(result.attempts).toBe(3);
    });
  });
});
