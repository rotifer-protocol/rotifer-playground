// A second real node for tests/por-e2e/run.ts: connects to the node under
// test, trusts the local issuer, and prints what its heartbeats proved.
// Heartbeats go out when a peer subscribes and then every five minutes.
import { createRequire } from "node:module";

const [addon, bootstrap, peer, iss, jwksUrl, timeoutS] = process.argv.slice(2);
const { P2PNode } = createRequire(import.meta.url)(addon);

const node = new P2PNode("127.0.0.1", 0, [bootstrap], false, [{ iss, jwksUrl }]);
node.start();

const deadline = Date.now() + Number(timeoutS) * 1000;
let last = null;
while (Date.now() < deadline) {
  last = node.peerAttestation(peer) ?? last;
  if (last?.status === "valid") break;
  await new Promise((res) => setTimeout(res, 1000));
}
node.stop();
process.stdout.write(`${JSON.stringify(last ?? { status: "no heartbeat" })}\n`);
process.exit(0);
