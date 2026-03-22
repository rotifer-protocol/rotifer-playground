import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execSync } from "node:child_process";

const ENDPOINT = process.env.SUPABASE_URL;
const ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!ENDPOINT || !ANON_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY environment variables.");
  process.exit(1);
}

const creds = JSON.parse(readFileSync(join(homedir(), ".rotifer", "credentials.json"), "utf-8"));
const ACCESS_TOKEN = creds.access_token;
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const GENES_DIR = join(__dirname, "..", "genes");

const NATIVE_GENES = [
  "readability-analyzer",
  "grammar-checker",
  "citation-manager",
  "design-tokens",
  "seo-optimizer",
];

function updateGene(name) {
  const geneDir = join(GENES_DIR, name);
  const phenotype = JSON.parse(readFileSync(join(geneDir, "phenotype.json"), "utf-8"));
  const readme = readFileSync(join(geneDir, "SKILL.md"), "utf-8");

  const body = JSON.stringify({
    fidelity: "Native",
    version: "0.2.0",
    description: phenotype.description,
    phenotype,
    readme,
  });

  const tmpFile = `/tmp/rotifer-republish-${name}.json`;
  writeFileSync(tmpFile, body);

  try {
    const result = execSync(
      `curl -s -X PATCH "${ENDPOINT}/rest/v1/genes?name=eq.${name}" ` +
      `-H "Content-Type: application/json" ` +
      `-H "apikey: ${ANON_KEY}" ` +
      `-H "Authorization: Bearer ${ACCESS_TOKEN}" ` +
      `-H "Prefer: return=representation" ` +
      `-d @${tmpFile}`,
      { encoding: "utf-8", timeout: 15000 }
    );

    const data = JSON.parse(result);
    if (Array.isArray(data) && data.length > 0) {
      console.log(`  OK   ${name} → v${data[0].version} fidelity=${data[0].fidelity}`);
      return true;
    } else if (data.message) {
      console.error(`  FAIL ${name}: ${data.message}`);
      return false;
    } else {
      console.error(`  WARN ${name}: no rows matched`);
      return false;
    }
  } catch (err) {
    console.error(`  FAIL ${name}: ${err.message}`);
    return false;
  }
}

console.log("Republishing 5 Native Genes to Cloud Registry...\n");

let success = 0;
for (const name of NATIVE_GENES) {
  const ok = updateGene(name);
  if (ok) success++;
}

console.log(`\nDone: ${success}/${NATIVE_GENES.length} genes updated.`);
