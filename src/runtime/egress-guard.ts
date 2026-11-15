/**
 * Egress guard: while the CLI runs a gene's source under Node, the gene's
 * global `fetch` (and `WebSocket` / `EventSource`) answer to the gene's own
 * `network` declaration.
 *
 * Spec, Phenotype `NetworkConfig`: a Hybrid or Wrapped gene that makes HTTP
 * requests SHOULD declare NetworkConfig so the sandbox can enforce a domain
 * whitelist, timeouts and rate limits; a gene that declares none is treated
 * as having no network access. `ctx.gatewayFetch` always applied that; a gene
 * calling the global `fetch` used to bypass it.
 *
 * How:
 * - `withGeneEgress(egress, fn)` runs `fn` (importing the gene, calling
 *   `express` or `display`) inside an AsyncLocalStorage context naming the
 *   gene, and waits for what it returns to settle. On entry the first window
 *   puts guards in `globalThis.fetch` / `WebSocket` / `EventSource`; when the
 *   last window closes the original property descriptors go back, so the
 *   globals are the very objects they were.
 * - A gene that never settles: if Node's event loop empties while a call is
 *   still waiting on the gene, nothing is left that could ever settle it, and
 *   Node would exit there with code 0. The call fails instead with
 *   `GeneNeverSettledError`, so the command reports it and exits non-zero.
 *   Its window stays open: the gene's code could still run (a timer that does
 *   not keep the process alive), and it is still held to its declaration.
 * - The fetch guard reads the context. No gene in it: the call is the CLI's
 *   own (an invocation report or heartbeat in flight), and goes straight to
 *   the original fetch. A gene with no `network`: refused. Otherwise: the
 *   gene's gateway — the same one behind `ctx.gatewayFetch`, so one allow-list,
 *   one timeout, one rate limit, one count.
 * - WebSockets and EventSources from a gene are refused: the gateway carries
 *   HTTP requests only.
 *
 * What this is not: a sandbox. A gene under Node runs with the host's full
 * privileges. This does not reach `node:http` / `node:https` / `node:http2` /
 * `node:net` / `node:tls` / `node:dgram`, a child process (`curl`), a worker
 * thread's own globals, DNS lookups, callbacks that run outside the gene's
 * async context (a `process.on("exit")` listener), or a timer that fires
 * after the gene has returned and the globals are restored. Isolation is the
 * WASM sandbox's job, where the only way out is `rotifer.net.fetch`.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  NetworkGateway,
  NetworkGatewayError,
  type GatewayFetchOptions,
  type GatewayRawResponse,
  type GatewayResponse,
  type GatewayTestOptions,
  type NetworkConfig,
} from "./network-gateway.js";
import { setReplacedFetch } from "./host-fetch.js";

/** One gene's network rights while the CLI runs it. */
export interface GeneEgress {
  readonly geneName: string;
  /** Present when the phenotype declares `network`. */
  readonly gateway?: NetworkGateway;
  /** `ctx.gatewayFetch`, on the same gateway. Present when the phenotype declares `network`. */
  readonly gatewayFetch?: (url: string, options?: GatewayFetchOptions) => Promise<GatewayResponse>;
}

/**
 * The network rights a phenotype declares: a gateway when it has a `network`
 * block (any fidelity — the spec names Hybrid and Wrapped), none otherwise.
 * `testOptions` is the gateway's binding-internal test hook; the CLI never
 * passes it.
 */
export function geneEgress(
  geneName: string,
  phenotype: { network?: unknown } | null | undefined,
  testOptions?: GatewayTestOptions,
): GeneEgress {
  const network = phenotype?.network;
  if (!network || typeof network !== "object") return { geneName };
  const gateway = new NetworkGateway(network as Partial<NetworkConfig>, testOptions);
  return { geneName, gateway, gatewayFetch: (url, options) => gateway.fetch(url, options) };
}

const running = new AsyncLocalStorage<GeneEgress>();

const GUARDED_GLOBALS = ["fetch", "WebSocket", "EventSource"] as const;
let openWindows = 0;
let saved: Map<string, PropertyDescriptor | undefined> | null = null;

/** Run `fn` as the gene `egress` names: its global fetch answers to its declaration. */
export function withGeneEgress<T>(egress: GeneEgress, fn: () => T | Promise<T>): Promise<T> {
  install();
  let call: Promise<T>;
  try {
    call = Promise.resolve(running.run(egress, fn));
  } catch (err) {
    uninstall();
    return Promise.reject(err);
  }
  // The window closes when the gene is done, and not before, however long that takes.
  call.then(uninstall, uninstall);
  return untilSettled(call, egress.geneName);
}

/**
 * A call into a gene that was still waiting when Node's event loop emptied:
 * nothing was left that could settle it.
 */
export class GeneNeverSettledError extends Error {
  constructor(geneName: string) {
    super(
      `Gene '${geneName}' never finished: it was still waiting on a Promise when nothing else was left to run, ` +
        `so nothing could ever settle it`,
    );
    this.name = "GeneNeverSettledError";
  }
}

/** One entry per call still waiting on a gene: what to do if it never settles. */
const waiting = new Set<() => void>();
let isWatching = false;

/** `call`, or a GeneNeverSettledError once the event loop has emptied while it waits. */
function untilSettled<T>(call: Promise<T>, geneName: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const giveUp = (): void => reject(new GeneNeverSettledError(geneName));
    waiting.add(giveUp);
    watchForEmptyLoop();
    call.then(
      (value) => {
        waiting.delete(giveUp);
        resolve(value);
      },
      (err: unknown) => {
        waiting.delete(giveUp);
        reject(err);
      },
    );
  });
}

/**
 * `beforeExit` fires when the loop empties. Each waiting call is failed once:
 * the set is emptied before any is failed. Node fires it again only if the
 * listener leaves the loop work to do — what the failed calls' callers do
 * next runs as microtasks, which do not count — so it queues an empty
 * macrotask: a command that goes on after a call fails (T1's next case) is
 * watched the same way when the loop empties again. A long-running process (a
 * server) never empties its loop, so this never fires there.
 */
function watchForEmptyLoop(): void {
  if (isWatching) return;
  isWatching = true;
  process.on("beforeExit", () => {
    const stuck = [...waiting];
    if (stuck.length === 0) return;
    waiting.clear();
    for (const giveUp of stuck) giveUp();
    setImmediate(() => {});
  });
}

/** The gene's network rights, read from the phenotype.json beside its source. None if there is none. */
export function geneEgressFromDir(geneDir: string, fallbackName: string): GeneEgress {
  let phenotype: { name?: unknown; network?: unknown } = {};
  try {
    phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
  } catch {
    // no readable phenotype: the gene declares nothing, so it reaches nothing
  }
  const name = typeof phenotype.name === "string" ? phenotype.name : fallbackName;
  return geneEgress(name, phenotype);
}

function install(): void {
  if (openWindows++ > 0) return;
  saved = new Map(GUARDED_GLOBALS.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  const original = globalThis.fetch;
  setReplacedFetch(original);
  defineGlobal("fetch", guardFetch(original));
  for (const name of ["WebSocket", "EventSource"] as const) {
    const Real = (globalThis as Record<string, unknown>)[name];
    if (typeof Real === "function") defineGlobal(name, guardConstructor(name, Real as new (...args: unknown[]) => object));
  }
}

function uninstall(): void {
  if (--openWindows > 0) return;
  for (const [name, descriptor] of saved ?? []) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
  saved = null;
  setReplacedFetch(null);
}

function defineGlobal(name: string, value: unknown): void {
  Object.defineProperty(globalThis, name, { value, writable: true, configurable: true, enumerable: false });
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function undeclared(gene: string, what: string, host: string): NetworkGatewayError {
  return new NetworkGatewayError(
    "DOMAIN_BLOCKED",
    `Gene '${gene}' declares no network access, so ${what} was refused. ` +
      `To allow it, declare the host in phenotype.json: "network": { "allowedDomains": ["${host}"] }`,
  );
}

function withHint(err: unknown): unknown {
  if (err instanceof NetworkGatewayError && err.code === "DOMAIN_BLOCKED" && err.message.startsWith("Domain ")) {
    return new NetworkGatewayError(
      err.code,
      `${err.message} — a gene reaches only the hosts in phenotype.json "network": { "allowedDomains": [...] }; add the host there to allow it`,
    );
  }
  return err;
}

/** Statuses a Response must have no body for. */
const NULL_BODY = new Set([101, 103, 204, 205, 304]);

function toResponse(raw: GatewayRawResponse): Response {
  const body = NULL_BODY.has(raw.status) ? null : raw.bytes;
  return new Response(body, { status: raw.status, statusText: raw.statusText, headers: raw.headers });
}

function guardFetch(original: typeof fetch): typeof fetch {
  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const egress = running.getStore();
    if (!egress) return original(input, init);

    const request = new Request(input, init);
    const host = hostOf(request.url);
    if (!egress.gateway) throw undeclared(egress.geneName, `fetch("${request.url}")`, host);

    let raw: GatewayRawResponse;
    try {
      raw = await egress.gateway.request(request.url, {
        method: request.method,
        headers: Object.fromEntries(request.headers),
        body: request.body ? new Uint8Array(await request.arrayBuffer()) : undefined,
        signal: request.signal,
      });
    } catch (err) {
      throw withHint(err);
    }
    // A cut-off body would surface as a JSON parse error in the gene; say what happened.
    if (raw.isTruncated) {
      throw new NetworkGatewayError(
        "RESPONSE_TOO_LARGE",
        `Response from ${host} is larger than the gene's network.maxResponseBytes`,
      );
    }
    return toResponse(raw);
  };
  return guarded as typeof fetch;
}

function guardConstructor(name: string, Real: new (...args: unknown[]) => object): unknown {
  return new Proxy(Real, {
    construct(target, args, newTarget) {
      const egress = running.getStore();
      if (egress) {
        throw new NetworkGatewayError(
          "DOMAIN_BLOCKED",
          `Gene '${egress.geneName}' opened a ${name} to ${hostOf(String(args[0]))}, which is refused: ` +
            `under the CLI a gene reaches the network only with HTTP requests (fetch or ctx.gatewayFetch) ` +
            `to the hosts in phenotype.json "network": { "allowedDomains": [...] }`,
        );
      }
      return Reflect.construct(target, args, newTarget);
    },
  });
}
