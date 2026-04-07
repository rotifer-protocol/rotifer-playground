import { Command } from "commander";
import { randomBytes, createHash } from "node:crypto";
import * as display from "../utils/display.js";
import { loadCredentials, refreshTokenIfNeeded } from "../cloud/auth.js";
import { loadCloudConfig } from "../cloud/client.js";

function generateApiKey(): { key: string; prefix: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const key = `rk_${raw}`;
  const prefix = key.slice(0, 8);
  const hash = createHash("sha256").update(key).digest("hex");
  return { key, prefix, hash };
}

async function supabaseRequest(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ data: unknown; status: number }> {
  await refreshTokenIfNeeded();
  const creds = loadCredentials();
  if (!creds) {
    display.error("Not logged in. Run 'rotifer login' first.");
    process.exit(1);
  }

  const config = loadCloudConfig();
  const url = `${config.endpoint.replace(/\/+$/, "")}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    apikey: config.anonKey,
    Authorization: `Bearer ${creds.access_token}`,
  };

  const res = await fetch(url, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (res.status === 204) {
    return { data: null, status: res.status };
  }

  const text = await res.text();
  const data = text.trim().length === 0 ? null : JSON.parse(text);
  return { data, status: res.status };
}

// ─── api-key create ───────────────────────────────────────────

const createCommand = new Command("create")
  .description("Create a new Evolution API key")
  .requiredOption("--name <name>", "Human-readable name for this key")
  .option("--scopes <scopes>", "Comma-separated scopes (default: read)", "read")
  .option("--expires <days>", "Expire after N days (default: never)")
  .option("--rate-limit <n>", "Max requests per minute (default: 30)", "30")
  .action(async (options: {
    name: string;
    scopes: string;
    expires?: string;
    rateLimit: string;
  }) => {
    display.header("Create API Key");

    const creds = loadCredentials();
    if (!creds) {
      display.error("Not logged in. Run 'rotifer login' first.");
      process.exit(1);
    }

    const { key, prefix, hash } = generateApiKey();

    const scopes = options.scopes.split(",").map((s) => s.trim());
    const validScopes = ["read", "execute", "agent:write"];
    for (const s of scopes) {
      if (!validScopes.includes(s)) {
        display.error(`Invalid scope: '${s}'. Valid: ${validScopes.join(", ")}`);
        process.exit(1);
      }
    }

    const rateLimitPerMin = parseInt(options.rateLimit, 10);
    if (isNaN(rateLimitPerMin) || rateLimitPerMin < 1 || rateLimitPerMin > 1000) {
      display.error("Rate limit must be between 1 and 1000.");
      process.exit(1);
    }

    let expiresAt: string | null = null;
    if (options.expires) {
      const days = parseInt(options.expires, 10);
      if (isNaN(days) || days < 1) {
        display.error("Expiry must be a positive number of days.");
        process.exit(1);
      }
      expiresAt = new Date(Date.now() + days * 86400000).toISOString();
    }

    const body: Record<string, unknown> = {
      owner_id: creds.user.id,
      key_hash: hash,
      key_prefix: prefix,
      name: options.name,
      scopes,
      rate_limit_per_min: rateLimitPerMin,
    };
    if (expiresAt) body.expires_at = expiresAt;

    const s = display.spinner("Creating API key...");
    try {
      const { status } = await supabaseRequest(
        "POST",
        "/rest/v1/api_keys",
        body,
      );

      s.stop();

      if (status >= 400) {
        display.error(`Failed to create API key (HTTP ${status})`);
        process.exit(1);
      }

      console.log();
      display.success("API key created successfully");
      console.log();
      display.keyValue("Key", key);
      display.keyValue("Name", options.name);
      display.keyValue("Prefix", prefix);
      display.keyValue("Scopes", scopes.join(", "));
      display.keyValue("Rate Limit", `${rateLimitPerMin}/min`);
      if (expiresAt) display.keyValue("Expires", expiresAt);
      console.log();
      display.warn(
        "Save this key now — it will not be shown again."
      );
      display.hint(
        "Use it with: curl -H 'X-API-Key: <key>' https://api.rotifer.dev/v1/genes"
      );
    } catch (err: any) {
      s.stop();
      display.error(err.message || "Failed to create API key");
      process.exit(1);
    }
  });

// ─── api-key list ─────────────────────────────────────────────

const listKeysCommand = new Command("list")
  .description("List your API keys")
  .action(async () => {
    display.header("Your API Keys");

    const s = display.spinner("Fetching keys...");
    try {
      const { data, status } = await supabaseRequest(
        "GET",
        "/rest/v1/api_keys?select=id,key_prefix,name,scopes,rate_limit_per_min,expires_at,revoked_at,last_used_at,total_requests,created_at&order=created_at.desc",
      );

      s.stop();

      if (status >= 400 || !Array.isArray(data)) {
        display.error("Failed to fetch API keys");
        process.exit(1);
      }

      if (data.length === 0) {
        display.info("No API keys found.");
        display.hint("Create one with: rotifer api-key create --name 'My Key'");
        return;
      }

      const rows = data.map((k: any) => ({
        prefix: k.key_prefix + "…",
        name: k.name,
        scopes: (k.scopes || []).join(", "),
        rate: k.rate_limit_per_min,
        status: k.revoked_at ? "revoked" : k.expires_at && new Date(k.expires_at) < new Date() ? "expired" : "active",
        last_used: k.last_used_at ? new Date(k.last_used_at).toLocaleDateString() : "never",
        requests: k.total_requests,
      }));

      display.table(rows, [
        { key: "prefix", label: "Prefix" },
        { key: "name", label: "Name" },
        { key: "scopes", label: "Scopes" },
        { key: "rate", label: "Rate/min", align: "right" },
        { key: "status", label: "Status" },
        { key: "last_used", label: "Last Used" },
        { key: "requests", label: "Requests", align: "right" },
      ]);
    } catch (err: any) {
      s.stop();
      display.error(err.message || "Failed to list keys");
      process.exit(1);
    }
  });

// ─── api-key revoke ───────────────────────────────────────────

const revokeCommand = new Command("revoke")
  .description("Revoke an API key by prefix")
  .requiredOption("--prefix <prefix>", "Key prefix (first 8 chars, e.g. rk_a1b2)")
  .action(async (options: { prefix: string }) => {
    display.header("Revoke API Key");

    const s = display.spinner("Looking up key...");
    try {
      const { data: lookupData, status: lookupStatus } = await supabaseRequest(
        "GET",
        `/rest/v1/api_keys?key_prefix=eq.${encodeURIComponent(options.prefix)}&select=id,name,key_prefix,revoked_at`,
      );

      if (lookupStatus >= 400 || !Array.isArray(lookupData) || lookupData.length === 0) {
        s.stop();
        display.error(`No key found with prefix '${options.prefix}'`);
        process.exit(1);
      }

      const key = lookupData[0] as any;
      if (key.revoked_at) {
        s.stop();
        display.info(`Key '${key.name}' (${key.key_prefix}…) is already revoked.`);
        return;
      }

      s.update("Revoking key...");
      const { status: patchStatus } = await supabaseRequest(
        "PATCH",
        `/rest/v1/api_keys?id=eq.${key.id}`,
        { revoked_at: new Date().toISOString() },
      );

      s.stop();

      if (patchStatus >= 400) {
        display.error("Failed to revoke key");
        process.exit(1);
      }

      display.success(`Key '${key.name}' (${key.key_prefix}…) has been revoked.`);
      display.hint("The key will be rejected within 5 minutes (KV cache TTL).");
    } catch (err: any) {
      s.stop();
      display.error(err.message || "Failed to revoke key");
      process.exit(1);
    }
  });

// ─── Parent command ───────────────────────────────────────────

export const apiKeyCommand = new Command("api-key")
  .description("Manage Evolution API keys");

apiKeyCommand.addCommand(createCommand);
apiKeyCommand.addCommand(listKeysCommand);
apiKeyCommand.addCommand(revokeCommand);
