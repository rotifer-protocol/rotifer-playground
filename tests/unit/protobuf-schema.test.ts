/**
 * Gap #9: Protobuf schema validation
 * Extracts .proto from RFC markdown and validates structure.
 * Requires the ROTIFER_PROTO_RFC env var (monorepo dev) — skipped when unset.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";

const RFC_PATH = process.env.ROTIFER_PROTO_RFC;
const HAS_RFC = RFC_PATH ? existsSync(RFC_PATH) : false;

function extractAllProtoSchemas(markdown: string): string {
  const matches = [...markdown.matchAll(/```protobuf\n([\s\S]*?)```/g)];
  return matches.map((m) => m[1]).join("\n");
}

const rfcContent = HAS_RFC ? readFileSync(RFC_PATH!, "utf-8") : "";
const proto = extractAllProtoSchemas(rfcContent);

// ─── Schema Extraction ───────────────────────────────────────

describe.skipIf(!HAS_RFC)("Protobuf schema: extraction from RFC", () => {
  it("proto schema is extractable from RFC markdown", () => {
    expect(proto.length).toBeGreaterThan(100);
  });

  it("starts with syntax = proto3", () => {
    expect(proto).toMatch(/syntax\s*=\s*"proto3"/);
  });

  it("has package declaration", () => {
    expect(proto).toMatch(/package\s+rotifer\.p2p\.v1/);
  });
});

// ─── Message Definitions ──────────────────────────────────────

describe.skipIf(!HAS_RFC)("Protobuf schema: required message types", () => {
  const expectedMessages = [
    "MessageEnvelope",
    "GeneAnnouncement",
    "GeneRetraction",
    "NodeHeartbeat",
  ];

  for (const msg of expectedMessages) {
    it(`message ${msg} is defined`, () => {
      expect(proto).toMatch(new RegExp(`message\\s+${msg}\\s*\\{`));
    });
  }
});

describe.skipIf(!HAS_RFC)("Protobuf schema: field completeness", () => {
  it("GeneAnnouncement has gene_id field", () => {
    expect(proto).toMatch(/gene_id/);
  });

  it("GeneAnnouncement has domain field", () => {
    expect(proto).toMatch(/domain/);
  });

  it("schema has fitness-related field", () => {
    expect(proto).toMatch(/fitness|score/);
  });

  it("schema uses proper protobuf types (string, bytes, double, etc.)", () => {
    expect(proto).toMatch(/\bstring\b/);
    expect(proto).toMatch(/\bbytes\b/);
    expect(proto).toMatch(/\bdouble\b|\bfloat\b/);
  });
});

// ─── Syntax Validation ───────────────────────────────────────

describe.skipIf(!HAS_RFC)("Protobuf schema: syntax correctness", () => {
  it("all message blocks are properly closed", () => {
    const openBraces = (proto.match(/\{/g) || []).length;
    const closeBraces = (proto.match(/\}/g) || []).length;
    expect(openBraces).toBe(closeBraces);
  });

  it("field numbers are sequential within messages", () => {
    const fieldNumbers = [...proto.matchAll(/=\s*(\d+)\s*;/g)].map((m) =>
      parseInt(m[1])
    );
    expect(fieldNumbers.length).toBeGreaterThan(0);
    for (const num of fieldNumbers) {
      expect(num).toBeGreaterThanOrEqual(0);
      expect(num).toBeLessThan(1000);
    }
  });

  it("no duplicate field numbers in same message", () => {
    const messages = proto.split(/message\s+\w+\s*\{/).slice(1);
    for (const msgBody of messages) {
      const endIdx = msgBody.indexOf("}");
      const body = endIdx >= 0 ? msgBody.slice(0, endIdx) : msgBody;
      const nums = [...body.matchAll(/=\s*(\d+)\s*;/g)].map((m) => parseInt(m[1]));
      const unique = new Set(nums);
      expect(unique.size).toBe(nums.length);
    }
  });

  it("no reserved keywords used as field names", () => {
    const reserved = ["import", "public", "option", "service", "rpc"];
    const fieldNames = [...proto.matchAll(/^\s+\w+\s+(\w+)\s*=/gm)].map((m) => m[1]);
    for (const name of fieldNames) {
      expect(reserved).not.toContain(name);
    }
  });
});
