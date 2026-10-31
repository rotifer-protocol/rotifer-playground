// Compare two runner outputs step by step. Prints one line per step and a
// summary; exits 1 if any step differs. Nothing is excused here: a
// difference is reported as a difference.
//
//   node compare.mjs napi.json cloud.json

import { readFileSync } from "node:fs";

//   node compare.mjs napi.json cloud.json [scenario.json]
const [a, b] = process.argv.slice(2, 4).map((p) => JSON.parse(readFileSync(p, "utf8")));
const scenario = JSON.parse(readFileSync(new URL(`./${process.argv[4] ?? "scenario.json"}`, import.meta.url), "utf8"));
const notes = Object.fromEntries(scenario.steps.map((s) => [s.id, `${s.op}${s.as ? " as " + s.as : ""}${s.note ? " — " + s.note : ""}`]));

function canon(v) {
  if (Array.isArray(v)) return v.map(canon);
  if (v && typeof v === "object") return Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]));
  return v;
}

function brief(r) {
  const exp = r.expired && r.expired.length ? ` expired×${r.expired.length}` : "";
  if ("error" in r) return `error ${r.error}${exp}`;
  const v = r.ok;
  if (Array.isArray(v)) return `ok [${v.map((e) => e.key).join(", ")}]${exp}`;
  if (v && typeof v === "object" && "key" in v) return `ok entry ${v.key}${exp}`;
  return `ok ${JSON.stringify(v)}${exp}`;
}

let diffs = 0;
const byId = new Map(b.results.map((r) => [r.id, r.result]));
for (const { id, result } of a.results) {
  const other = byId.get(id);
  const same = other !== undefined && JSON.stringify(canon(result)) === JSON.stringify(canon(other));
  if (!same) diffs++;
  console.log(`${same ? "same" : "DIFF"} ${id} ${notes[id] ?? ""}`);
  if (!same) {
    console.log(`     ${a.binding}: ${JSON.stringify(canon(result)).slice(0, 600)}`);
    console.log(`     ${b.binding}: ${JSON.stringify(canon(other)).slice(0, 600)}`);
  } else {
    console.log(`     both: ${brief(result)}`);
  }
}
console.log(`\n${a.results.length - diffs}/${a.results.length} steps identical, ${diffs} differ`);
process.exit(diffs === 0 ? 0 : 1);
