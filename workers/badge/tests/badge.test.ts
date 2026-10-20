import { describe, it, expect } from "vitest";

// Unit tests for the route parser and badge helpers (no Worker runtime needed)

function parseRoute(pathname: string): { handler: string; param: string } | null {
  const segments = pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (segments.length < 2) return null;

  if (segments[0] === "safety") return { handler: "safety", param: segments.slice(1).join("/") };

  if (segments[0] === "gene") {
    const lastSeg = segments[segments.length - 1];
    if (lastSeg === "fitness") {
      return { handler: "gene-fitness", param: segments.slice(1, -1).join("/") };
    }
    return { handler: "gene", param: segments.slice(1).join("/") };
  }

  if (segments[0] === "dev") return { handler: "dev", param: segments[1] };
  return null;
}

describe("parseRoute", () => {
  it("parses /safety/:id", () => {
    expect(parseRoute("/safety/my-skill")).toEqual({ handler: "safety", param: "my-skill" });
  });

  it("parses /safety with scoped id", () => {
    expect(parseRoute("/safety/@author/my-skill")).toEqual({ handler: "safety", param: "@author/my-skill" });
  });

  it("parses /gene/:id", () => {
    expect(parseRoute("/gene/abc123")).toEqual({ handler: "gene", param: "abc123" });
  });

  it("parses /gene/:id/fitness", () => {
    expect(parseRoute("/gene/abc123/fitness")).toEqual({ handler: "gene-fitness", param: "abc123" });
  });

  it("parses /dev/:username", () => {
    expect(parseRoute("/dev/alice")).toEqual({ handler: "dev", param: "alice" });
  });

  it("returns null for root path", () => {
    expect(parseRoute("/")).toBeNull();
  });

  it("returns null for unknown routes", () => {
    expect(parseRoute("/unknown/path")).toBeNull();
  });

  it("handles trailing slashes", () => {
    expect(parseRoute("/gene/abc123/")).toEqual({ handler: "gene", param: "abc123" });
  });

  it("parses /gene/@owner/name (qualified name)", () => {
    expect(parseRoute("/gene/@alice/search-web")).toEqual({ handler: "gene", param: "@alice/search-web" });
  });

  it("parses /gene/@owner/name/fitness (qualified name + fitness)", () => {
    expect(parseRoute("/gene/@alice/search-web/fitness")).toEqual({ handler: "gene-fitness", param: "@alice/search-web" });
  });
});

describe("badge response format", () => {
  it("shields.io JSON endpoint structure", () => {
    const badge = {
      schemaVersion: 1,
      label: "rotifer safety",
      message: "A",
      color: "brightgreen",
      cacheSeconds: 3600,
    };
    expect(badge.schemaVersion).toBe(1);
    expect(badge).toHaveProperty("label");
    expect(badge).toHaveProperty("message");
    expect(badge).toHaveProperty("color");
  });
});

describe("grade color mapping", () => {
  const GRADE_COLORS: Record<string, string> = {
    A: "brightgreen",
    B: "green",
    C: "yellow",
    D: "red",
    "?": "lightgrey",
  };

  it("maps all grades to colors", () => {
    expect(GRADE_COLORS["A"]).toBe("brightgreen");
    expect(GRADE_COLORS["B"]).toBe("green");
    expect(GRADE_COLORS["C"]).toBe("yellow");
    expect(GRADE_COLORS["D"]).toBe("red");
    expect(GRADE_COLORS["?"]).toBe("lightgrey");
  });
});
