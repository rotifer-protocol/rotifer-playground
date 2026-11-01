// A recorded Rotifer Cloud for the PR gate: answers the registry calls the
// e2e suites make from registry.json, in the shape the real PostgREST API
// answers them (recorded 2026-11-01). Run as a child process so suites that
// call the CLI with execSync can use it. Prints "listening <port>".
//
// Anything not recorded here gets 501 and is listed at GET /__unrecorded,
// which tests/e2e/recorded-cloud.ts checks is empty: a new call the CLI makes
// must be recorded, not silently answered.
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const data = JSON.parse(readFileSync(new URL("./registry.json", import.meta.url), "utf-8"));
const unrecorded = [];

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" }).end(JSON.stringify(body));
}

/** PostgREST `col=eq.value` filters, `order=col.asc|desc`, `limit=n`. */
function selectGenes(params) {
  let rows = data.genes;
  for (const [key, value] of params) {
    if (value.startsWith("eq.")) {
      const want = value.slice(3);
      rows = rows.filter((r) => String(r[key]) === want);
    }
  }
  const order = params.get("order");
  if (order) {
    const [col, dir] = order.split(".");
    rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (dir === "desc" ? -1 : 1));
  }
  const limit = Number(params.get("limit"));
  return limit > 0 ? rows.slice(0, limit) : rows;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const route = `${req.method} ${url.pathname}`;
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString("utf-8");

  if (route === "GET /__unrecorded") return json(res, 200, unrecorded);

  // The real API refuses a request without the publishable key, with this message.
  if (!req.headers.apikey) {
    return json(res, 401, {
      message: "No API key found in request",
      hint: "No `apikey` request header or url param was found.",
    });
  }

  if (route === "GET /rest/v1/genes") return json(res, 200, selectGenes(url.searchParams));

  if (route === "POST /rest/v1/rpc/get_reputation_leaderboard") {
    const limit = Number(JSON.parse(body || "{}").p_limit) || 20;
    return json(res, 200, data.reputation_leaderboard.slice(0, limit));
  }

  unrecorded.push(`${route}${url.search}`);
  return json(res, 501, { message: `not recorded in tests/fixtures/cloud: ${route}` });
});

server.listen(0, "127.0.0.1", () => console.log(`listening ${server.address().port}`));
