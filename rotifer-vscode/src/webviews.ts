import type { CloudGene, GeneReputation, GeneStats, GeneVersionEntry, LeaderboardEntry, DeveloperReputation } from "./cloud-client";

const baseStyle = `
  body { font-family: var(--vscode-font-family); padding: 20px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  h2 { font-size: 1.15em; margin-top: 24px; color: var(--vscode-descriptionForeground); }
  .score { font-size: 2.4em; font-weight: bold; color: #2563eb; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 0.85em; }
  .native { background: #059669; color: white; }
  .hybrid { background: #2563eb; color: white; }
  .wrapped { background: #9333ea; color: white; }
  table { border-collapse: collapse; margin-top: 12px; width: 100%; max-width: 600px; }
  td, th { padding: 6px 14px; text-align: left; border-bottom: 1px solid var(--vscode-panel-border); }
  .bar-bg { background: #333; border-radius: 4px; height: 18px; width: 200px; }
  .bar-fill { background: #2563eb; height: 100%; border-radius: 4px; }
  .version-chain { border-left: 2px solid #2563eb; padding-left: 16px; margin: 12px 0; }
  .version-entry { margin: 8px 0; }
  .version-label { font-weight: bold; }
  .version-date { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .version-changelog { margin-top: 2px; font-style: italic; }
  .stat-bar { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
  .stat-label { width: 100px; }
  .stat-fill { height: 18px; border-radius: 4px; }
  .rank-row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-bottom: 1px solid var(--vscode-panel-border); }
  .rank-num { font-size: 1.3em; font-weight: bold; width: 36px; text-align: center; }
  .rank-gold { color: #fbbf24; }
  .rank-silver { color: #9ca3af; }
  .rank-bronze { color: #d97706; }
  .muted { color: var(--vscode-descriptionForeground); }
`;

function html(title: string, body: string): string {
  return `<!DOCTYPE html><html><head><style>${baseStyle}</style></head><body>${body}</body></html>`;
}

export function renderGeneDetails(gene: CloudGene): string {
  return html(`Gene: ${gene.name}`, `
    <h1>${gene.name}</h1>
    <span class="badge ${(gene.fidelity || "wrapped").toLowerCase()}">${gene.fidelity || "Wrapped"}</span>
    <p>${gene.description || ""}</p>
    <table>
      <tr><th>Domain</th><td>${gene.domain}</td></tr>
      <tr><th>Version</th><td>${gene.version}</td></tr>
      <tr><th>Creator</th><td>${gene.owner || "unknown"}</td></tr>
      <tr><th>Downloads</th><td>${gene.downloads ?? 0}</td></tr>
      <tr><th>Reputation</th><td>${gene.reputation_score != null ? gene.reputation_score.toFixed(4) : "N/A"}</td></tr>
      <tr><th>WASM Size</th><td>${gene.wasm_size ? (gene.wasm_size / 1024).toFixed(1) + " KB" : "—"}</td></tr>
      <tr><th>Created</th><td>${gene.created_at}</td></tr>
    </table>
  `);
}

export function renderReputationPanel(name: string, rep: GeneReputation): string {
  const bar = (label: string, val: number) =>
    `<tr><td>${label}</td><td><div class="bar-bg">
       <div class="bar-fill" style="width:${Math.min(val * 100, 100)}%"></div>
     </div></td><td>${(val * 100).toFixed(1)}%</td></tr>`;

  return html(`Reputation: ${name}`, `
    <h1>Reputation: ${name}</h1>
    <div class="score">${(rep.score * 100).toFixed(1)}</div>
    <p class="muted">Epoch ${rep.epoch} · ${new Date(rep.computedAt).toLocaleDateString()}</p>
    <table>
      ${bar("Arena", rep.arenaScore)}
      ${bar("Usage", rep.usageScore)}
      ${bar("Stability", rep.stabilityScore)}
    </table>
  `);
}

export function renderGeneStats(geneName: string, stats: GeneStats): string {
  const max = Math.max(stats.total, 1);
  const periods = [
    { label: "Last 7 days", value: stats.last_7d, color: "#3b82f6" },
    { label: "Last 30 days", value: stats.last_30d, color: "#8b5cf6" },
    { label: "Last 90 days", value: stats.last_90d, color: "#06b6d4" },
    { label: "All time", value: stats.total, color: "#2563eb" },
  ];

  const bars = periods.map((p) => `
    <div class="stat-bar">
      <span class="stat-label">${p.label}</span>
      <div class="bar-bg" style="flex:1">
        <div class="stat-fill" style="width:${(p.value / max) * 100}%;background:${p.color}"></div>
      </div>
      <strong>${p.value}</strong>
    </div>
  `).join("");

  return html(`Stats: ${geneName}`, `
    <h1>Download Statistics: ${geneName}</h1>
    <div style="margin-top:16px">${bars}</div>
  `);
}

export function renderVersionHistory(owner: string, name: string, versions: GeneVersionEntry[]): string {
  if (versions.length === 0) {
    return html(`Versions: ${owner}/${name}`, `
      <h1>Version History: ${owner}/${name}</h1>
      <p class="muted">No published versions found.</p>
    `);
  }

  const entries = versions.map((v, i) => {
    const isLatest = i === versions.length - 1;
    return `<div class="version-entry">
      <span class="version-label" style="${isLatest ? "color:#059669" : ""}">${v.version}</span>
      <span class="version-date">${new Date(v.created_at).toLocaleDateString()}</span>
      ${v.changelog ? `<div class="version-changelog">${v.changelog}</div>` : ""}
    </div>`;
  }).join("");

  return html(`Versions: ${owner}/${name}`, `
    <h1>Version History: ${owner}/${name}</h1>
    <p class="muted">${versions.length} version(s) · Latest: ${versions[versions.length - 1].version}</p>
    <div class="version-chain">${entries}</div>
  `);
}

export function renderLeaderboard(entries: LeaderboardEntry[]): string {
  const rows = entries.map((e, i) => {
    const rankClass = i === 0 ? "rank-gold" : i === 1 ? "rank-silver" : i === 2 ? "rank-bronze" : "";
    const medal = i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : `#${i + 1}`;
    return `<div class="rank-row">
      <span class="rank-num ${rankClass}">${medal}</span>
      <div style="flex:1">
        <strong>${e.username}</strong>
        <div class="muted">${e.genes_published} genes · ${e.total_downloads} downloads · ${e.arena_wins} wins</div>
      </div>
      <span class="score" style="font-size:1.2em">${(e.score * 100).toFixed(0)}</span>
    </div>`;
  }).join("");

  return html("Leaderboard", `
    <h1>Creator Leaderboard</h1>
    <p class="muted">${entries.length} creators</p>
    <div style="margin-top:16px">${rows}</div>
  `);
}

export function renderMyReputation(username: string, rep: DeveloperReputation): string {
  return html(`My Reputation`, `
    <h1>My Reputation: @${username}</h1>
    <div class="score">${(rep.score * 100).toFixed(1)}</div>
    <table>
      <tr><th>Genes Published</th><td>${rep.genes_published}</td></tr>
      <tr><th>Total Downloads</th><td>${rep.total_downloads}</td></tr>
      <tr><th>Arena Wins</th><td>${rep.arena_wins}</td></tr>
      <tr><th>Community Bonus</th><td>${rep.community_bonus.toFixed(2)}</td></tr>
    </table>
  `);
}

export function renderCompare(genes: CloudGene[]): string {
  const headers = genes.map((g) => `<th>${g.name}</th>`).join("");
  const rows = [
    ["Domain", ...genes.map((g) => g.domain)],
    ["Version", ...genes.map((g) => g.version)],
    ["Fidelity", ...genes.map((g) => g.fidelity)],
    ["Downloads", ...genes.map((g) => String(g.downloads))],
    ["Reputation", ...genes.map((g) => g.reputation_score != null ? g.reputation_score.toFixed(4) : "N/A")],
    ["WASM Size", ...genes.map((g) => g.wasm_size ? (g.wasm_size / 1024).toFixed(1) + " KB" : "—")],
  ].map((row) => `<tr><th>${row[0]}</th>${row.slice(1).map((v) => `<td>${v}</td>`).join("")}</tr>`).join("");

  const sorted = [...genes].sort((a, b) => (b.reputation_score || 0) - (a.reputation_score || 0));
  const best = sorted[0];

  return html("Gene Comparison", `
    <h1>Gene Comparison</h1>
    <table>
      <tr><th></th>${headers}</tr>
      ${rows}
    </table>
    ${best.reputation_score != null ? `<p style="margin-top:16px">Highest reputation: <strong>${best.name}</strong> (${best.reputation_score.toFixed(4)})</p>` : ""}
  `);
}
