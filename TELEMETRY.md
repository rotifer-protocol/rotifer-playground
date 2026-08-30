# Telemetry

Rotifer sends two different signals to Rotifer Cloud, kept deliberately
separate — different purposes, different privacy guarantees, different
tables, different defaults. This page is the complete, field-by-field
description of both. If a field is not listed here, it is not collected.

## The two signals

**Anonymous usage heartbeat** — covered in full below. No identity, on by
default, answers "is anyone using this, from which channel". Off means off,
using the switches described further down.

**Gene invocation report** — only for signed-in users, off by default, and
governed by a separate set of rules documented directly in the source
(`src/cloud/invocation.ts` in this repository). It ties a Gene invocation to
your account, which is why it needs your explicit opt-in rather than running
by default like the heartbeat does. The two are never combined into one
table: the heartbeat's whole value is that it doesn't need your consent
first, and an anonymous row mixed into an accountable one would undermine
the accountable one.

The rest of this page is about the heartbeat.

## What the heartbeat collects

| Field | Example | Notes |
|---|---|---|
| `machine_id` | `b3a8f1c2-...` (UUIDv4) | Minted once on first run, stored in `~/.rotifer/telemetry.json`. Random — **never** derived from hardware, MAC address, disk serial, file paths, or your account. Deleting the file mints a new one on next use. |
| `day` | `2026-08-30` | The UTC calendar day, computed **server-side** — a client with a wrong clock cannot skew which day a report lands on. |
| `channel` | `cli`, `mcp:cursor`, `mcp:dsh` | Which entry point ran the Gene. The MCP server reports the host name it received during its own protocol handshake (`initialize`), folded to a fixed shape (lowercase, non-alphanumeric runs collapsed to `_`) so `Claude Code`, `claude-code`, and `CLAUDE CODE` all count as the same channel rather than splitting into three. |
| `client_version` | `0.22.1` | The version of whichever package sent the report (`@rotifer/playground` or `@rotifer/mcp-server`), taken from that package's own `package.json` at send time. |
| `invocation_count` | `7` | How many times a Gene ran that day, on that channel, from that machine. Not a full history — a running total for `(machine_id, day, channel)`, reset the next UTC day. |

## What it never collects

- **No code.** No file contents, file names, file paths, Gene source, or
  anything derived from what a Gene actually does.
- **No call data.** Not the input you passed, not the output a Gene
  returned, not which Gene by name — only that *some* Gene ran, and how many
  times.
- **No identity.** No account, no username, no email — not even for a
  signed-in user. If you are signed in, that identity only goes into the
  separate invocation report above (which you can turn off independently),
  never into this one.
- **No IP address.** Stripped at Rotifer Cloud's edge before storage.
- **No per-call event stream.** Reports are per-Gene-run counters, sent as
  they happen, aggregated server-side into one row per
  `(machine, day, channel)` — there is no timestamped log of individual
  calls to reconstruct a session from.

## Turning it off

Any of these works, and each one turns off **both** signals — the heartbeat
and the signed-in invocation report:

```bash
rotifer telemetry off      # stores the choice in ~/.rotifer/telemetry.json
```

```bash
export ROTIFER_TELEMETRY=0   # per-shell / per-CI override, either signal
export DO_NOT_TRACK=1        # the cross-tool standard — always honoured, highest priority
```

`rotifer telemetry status` shows the current state and what decided it.

Resolution order (first match wins): `DO_NOT_TRACK` > `ROTIFER_TELEMETRY` >
the stored choice > default on. The stored default is baked into the client
at build time and is never changed remotely — a compromised or malicious
server response cannot flip your local setting.

Off means off: when disabled, nothing is sent, no connection is opened to
report an "opted out" event, and no first-run notice is shown (there is
nothing to disclose about data that never leaves the machine).

## The first-run notice

The first time a report is actually about to be sent — never before, and
never if telemetry ends up off — you'll see a one-line notice:

- **CLI**: printed to stderr.
- **MCP server**: included once in a tool call's response content, since
  stderr is where CLI users look and exactly where most MCP hosts don't.

Seeing the notice is recorded in `~/.rotifer/telemetry.json`
(`first_run_notice_shown`), so it prints exactly once per machine, not once
per command.

## The aggregate is queryable — there is no dashboard for it (yet)

The raw heartbeat table — one row per machine, per day, per channel — is
not directly readable by anyone, not even the machine that wrote it. What's
queryable is an aggregate view grouped by day and channel with no
per-machine column at all (not filtered out for the public — structurally
absent from what's exposed). It answers "how many machines were active on
channel X on day Y" and "how many Gene calls did that add up to" — the
same numbers this project uses internally to decide where to invest
distribution effort.

To be precise about what "public" means here: there is no web page for
this yet, just an API anyone can call with the same public credential every
Rotifer client already ships with (the `anon` key in
`~/.rotifer/cloud.json`, or visible in this repo's own client source). If
you have it handy:

```bash
curl "https://cloud.rotifer.dev/rest/v1/usage_heartbeat_public?select=day,channel,active_machines,total_invocations&order=day.desc&limit=20" \
  -H "apikey: $ROTIFER_CLOUD_ANON_KEY" \
  -H "Authorization: Bearer $ROTIFER_CLOUD_ANON_KEY"
```

That's the whole surface: a REST endpoint returning the same rows this
project itself reads to decide where usage is coming from, nothing rendered
for it beyond what the JSON gives you.

## Reporting a concern

If something here doesn't match what you observe — a field not listed, a
value that looks more specific than it should — please open an issue.
Undisclosed collection is the one failure mode this design exists to rule
out, and a report that turns out to be right gets treated as a bug, not a
footnote in the next release.
