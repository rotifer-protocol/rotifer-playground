/**
 * The fetch the CLI itself sends with.
 *
 * While a gene runs, the egress guard (egress-guard.ts) puts its own function
 * in `globalThis.fetch`. Code that must reach the network on the gene's
 * behalf — the network gateway — goes out through the fetch the guard
 * replaced, or it would be checked against the gene a second time. With no
 * guard installed this is simply the current global fetch, so a test that
 * stubs `globalThis.fetch` still sees its stub.
 */
let replaced: typeof fetch | null = null;

export function hostFetch(): typeof fetch {
  return replaced ?? globalThis.fetch;
}

/** Called by the egress guard only: the fetch it replaced, or null once it is restored. */
export function setReplacedFetch(fn: typeof fetch | null): void {
  replaced = fn;
}
