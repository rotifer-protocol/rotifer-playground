import { describe, it, expect } from "vitest";
import { SCAN_RULES } from "../../src/scanner/rules.js";

function matchesRule(ruleId: string, line: string): boolean {
  const rule = SCAN_RULES.find((r) => r.id === ruleId);
  if (!rule) throw new Error(`Unknown rule: ${ruleId}`);
  return rule.patterns.some((p) => p.test(line));
}

describe("S-01: Dynamic code execution", () => {
  it("detects eval()", () => {
    expect(matchesRule("S-01", 'eval("alert(1)")'));
    expect(matchesRule("S-01", "const r = eval(code);")).toBe(true);
  });

  it("detects Function()", () => {
    expect(matchesRule("S-01", 'new Function("return 1")'));
    expect(matchesRule("S-01", 'Function("return 1")')).toBe(true);
  });

  it("pattern matches even in comments (comment skipping is in scanFile)", () => {
    expect(matchesRule("S-01", "// eval() is dangerous")).toBe(true);
  });

  it("does not match evaluate or evalName", () => {
    expect(matchesRule("S-01", "const evaluate = true;")).toBe(false);
    expect(matchesRule("S-01", "this.evaluate()")).toBe(false);
  });
});

describe("S-02: System command execution", () => {
  it("detects require('child_process')", () => {
    expect(matchesRule("S-02", "const cp = require('child_process');")).toBe(true);
  });

  it("detects import from 'child_process'", () => {
    expect(matchesRule("S-02", "import { exec } from 'child_process';")).toBe(true);
  });

  it("detects execSync", () => {
    expect(matchesRule("S-02", 'execSync("ls -la");')).toBe(true);
  });

  it("detects spawn", () => {
    expect(matchesRule("S-02", 'spawn("node", ["app.js"]);')).toBe(true);
  });

  /**
   * The call-site patterns used to be bare `\bexec\s*\(` and friends, which
   * also matched `regex.exec(` — the standard way to iterate a global regex in
   * JavaScript. On this repo's own gene corpus that produced a CRITICAL finding
   * on 6 of the 7 genes it flagged, blocking `rotifer publish` for genes whose
   * only offence was calling a regex. `grammar-checker` was one of them.
   *
   * The narrowing is safe because it does not touch the load-bearing half:
   * system commands are unreachable in JS without child_process, and both
   * import forms remain CRITICAL. A member call like `cp.exec(...)` can only
   * get `cp` from a binding those two patterns already catch — the cases below
   * assert exactly that, so the fix cannot be mistaken for switching S-02 off.
   */
  it("does not fire on regex.exec(), the false positive that blocked publishing", () => {
    expect(matchesRule("S-02", "while ((match = regex.exec(text)) !== null) {")).toBe(false);
  });

  it("does not fire on other member calls named exec/spawn", () => {
    expect(matchesRule("S-02", "const m = pattern.exec(input);")).toBe(false);
    expect(matchesRule("S-02", "const w = pool.spawn(job);")).toBe(false);
    expect(matchesRule("S-02", "db.execSync(query);")).toBe(false);
  });

  it("still fires on a bare call from a destructured child_process import", () => {
    expect(matchesRule("S-02", 'exec("rm -rf /");')).toBe(true);
    expect(matchesRule("S-02", 'spawnSync("sh", ["-c", cmd]);')).toBe(true);
  });

  it("still fires on a member call once the import that supplies it is present", () => {
    // The realistic shape of the threat the narrowing could have let through.
    // Line 1 alone is enough — which is the point.
    const source = [
      "const cp = require('child_process');",
      "cp.exec(userInput);",
    ].join("\n");
    expect(matchesRule("S-02", source)).toBe(true);
  });
});

describe("S-03: Code obfuscation", () => {
  it("detects eval(atob(...))", () => {
    expect(matchesRule("S-03", 'eval(atob("dGVzdA=="));')).toBe(true);
  });

  it("detects atob + eval on same line", () => {
    expect(matchesRule("S-03", 'const code = atob(encoded); eval(code);')).toBe(true);
  });

  it("does not flag atob alone", () => {
    expect(matchesRule("S-03", 'const decoded = atob("dGVzdA==");')).toBe(false);
  });
});

describe("S-04: Suspicious external communication", () => {
  it("detects fetch()", () => {
    expect(matchesRule("S-04", 'const res = await fetch("https://api.example.com");')).toBe(true);
  });

  it("detects http.request", () => {
    expect(matchesRule("S-04", "http.request(options, callback);")).toBe(true);
  });

  it("detects axios", () => {
    expect(matchesRule("S-04", 'axios.get("/api/data");')).toBe(true);
    expect(matchesRule("S-04", 'const res = axios("/url");')).toBe(true);
  });

  it("detects XMLHttpRequest", () => {
    expect(matchesRule("S-04", "const xhr = new XMLHttpRequest();")).toBe(true);
  });
});

describe("S-05: Environment variable access", () => {
  it("detects process.env", () => {
    expect(matchesRule("S-05", "const key = process.env.API_KEY;")).toBe(true);
  });

  it("detects Deno.env", () => {
    expect(matchesRule("S-05", "Deno.env.get('SECRET');")).toBe(true);
  });

  it("detects import.meta.env", () => {
    expect(matchesRule("S-05", "const url = import.meta.env.VITE_API;")).toBe(true);
  });
});

describe("S-06: Persistent outbound connection", () => {
  it("detects WebSocket", () => {
    expect(matchesRule("S-06", 'const ws = new WebSocket("wss://evil.com");')).toBe(true);
  });

  it("detects net.Socket", () => {
    expect(matchesRule("S-06", "const sock = new net.Socket();")).toBe(true);
  });

  it("detects net.createConnection", () => {
    expect(matchesRule("S-06", "net.createConnection(8080, 'evil.com');")).toBe(true);
  });
});

describe("S-07: File system operations", () => {
  it("detects fs.readFileSync", () => {
    expect(matchesRule("S-07", 'const data = fs.readFileSync("/etc/passwd");')).toBe(true);
  });

  it("detects fs.writeFile", () => {
    expect(matchesRule("S-07", 'fs.writeFile("/tmp/out", data, cb);')).toBe(true);
  });

  it("detects fs.unlink", () => {
    expect(matchesRule("S-07", 'fs.unlink("/tmp/file", cb);')).toBe(true);
  });

  it("detects bare readFileSync import usage", () => {
    expect(matchesRule("S-07", 'const content = readFileSync("file.txt", "utf-8");')).toBe(true);
  });
});
