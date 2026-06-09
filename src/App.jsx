import { useState, useEffect, useCallback, useRef } from "react";

// ─────────────────────────────────────────────────────────────────────────────
// AUTH ABSTRACTION LAYER
// Swap PAT → GitHub App by replacing this provider object only.
// All API calls go through `githubFetch` — never call GitHub directly.
// ─────────────────────────────────────────────────────────────────────────────
const AuthProvider = {
  type: "PAT", // "PAT" | "GITHUB_APP" | "OAUTH"
  getToken: () => sessionStorage.getItem("gh_token"),
  setToken: (t) => sessionStorage.setItem("gh_token", t),
  clearToken: () => sessionStorage.removeItem("gh_token"),
  isConfigured: () => !!sessionStorage.getItem("gh_token"),
};

// API_BASE: Vite proxy rewrites /ghapi/* → https://api.github.com/*
// For production: replace "/ghapi" with your Azure Function base URL.
const API_BASE = "/ghapi";

async function githubFetch(path, opts = {}) {
  const token = AuthProvider.getToken();
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw Object.assign(new Error(err.message || `GitHub API ${res.status}`), { status: res.status, response: err });
  }
  return res.json();
}

// Paginate all pages of a GitHub list endpoint
async function githubPaginate(path, params = {}) {
  const qs = new URLSearchParams({ per_page: 100, ...params }).toString();
  let results = [], page = 1;
  while (true) {
    const data = await githubFetch(`${path}?${qs}&page=${page}`);
    if (!Array.isArray(data) || data.length === 0) break;
    results = results.concat(data);
    if (data.length < 100) break;
    page++;
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMIT TRACKER
// ─────────────────────────────────────────────────────────────────────────────
async function getRateLimit() {
  const data = await githubFetch("/rate_limit");
  return data.rate;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA FETCHERS — all isolated, replace individually when moving to GitHub App
// ─────────────────────────────────────────────────────────────────────────────
async function fetchRepos(org, discoveryMode, discoveryValue) {
  let repos = [];
  if (discoveryMode === "all") {
    try { repos = await githubPaginate(`/orgs/${org}/repos`); }
    catch { repos = await githubPaginate(`/user/repos`, { affiliation: "owner,collaborator,organization_member" }); }
  } else if (discoveryMode === "topic") {
    const data = await githubFetch(`/search/repositories?q=user:${org}+topic:${discoveryValue}&per_page=100`);
    repos = data.items || [];
  } else if (discoveryMode === "team") {
    repos = await githubPaginate(`/orgs/${org}/teams/${discoveryValue}/repos`);
  } else if (discoveryMode === "prefix") {
    let all;
    try { all = await githubPaginate(`/orgs/${org}/repos`); }
    catch { all = await githubPaginate(`/user/repos`, { affiliation: "owner,collaborator,organization_member" }); }
    repos = all.filter(r => r.name.startsWith(discoveryValue));
  } else if (discoveryMode === "manual") {
    const names = discoveryValue.split(",").map(s => s.trim()).filter(Boolean);
    repos = await Promise.all(names.map(n => githubFetch(`/repos/${org}/${n}`)));
  }
  return repos;
}

async function fetchBranchProtection(org, repo, branch) {
  try {
    const data = await githubFetch(`/repos/${org}/${repo}/branches/${branch}/protection`);
    return data;
  } catch (e) {
    return null;
  }
}

async function fetchWorkflowRuns(org, repo) {
  try {
    const data = await githubFetch(`/repos/${org}/${repo}/actions/runs?per_page=10`);
    return data.workflow_runs || [];
  } catch { return []; }
}

async function fetchDependabotAlerts(org, repo) {
  try {
    return await githubPaginate(`/repos/${org}/${repo}/dependabot/alerts`, { state: "open" });
  } catch { return []; }
}

async function fetchSecretScanningAlerts(org, repo) {
  try {
    return await githubPaginate(`/repos/${org}/${repo}/secret-scanning/alerts`, { state: "open" });
  } catch { return []; }
}

async function fetchCodeScanningAlerts(org, repo) {
  try {
    return await githubPaginate(`/repos/${org}/${repo}/code-scanning/alerts`, { state: "open" });
  } catch { return []; }
}

async function fetchPullRequests(org, repo) {
  try {
    return await githubPaginate(`/repos/${org}/${repo}/pulls`, { state: "all" });
  } catch { return []; }
}

async function fetchCodeOwners(org, repo) {
  for (const path of ["CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"]) {
    try {
      await githubFetch(`/repos/${org}/${repo}/contents/${path}`);
      return true;
    } catch {}
  }
  return false;
}

// Aggregate full repo health data
async function enrichRepo(org, repoData) {
  const name = repoData.name;
  const [protection, runs, dependabot, secrets, codeScanning, prs, hasCodeowners] = await Promise.allSettled([
    fetchBranchProtection(org, name, repoData.default_branch || "main"),
    fetchWorkflowRuns(org, name),
    fetchDependabotAlerts(org, name),
    fetchSecretScanningAlerts(org, name),
    fetchCodeScanningAlerts(org, name),
    fetchPullRequests(org, name),
    fetchCodeOwners(org, name),
  ]);

  const bp = protection.value;
  const workflows = runs.value || [];
  const depAlerts = dependabot.value || [];
  const secretAlerts = secrets.value || [];
  const codeAlerts = codeScanning.value || [];
  const prList = prs.value || [];
  const codeowners = hasCodeowners.value || false;

  const recentRuns = workflows.slice(0, 10);
  const failedRuns = recentRuns.filter(r => r.conclusion === "failure");
  const successRate = recentRuns.length ? Math.round(((recentRuns.length - failedRuns.length) / recentRuns.length) * 100) : null;
  const manualRuns = recentRuns.filter(r => r.event === "workflow_dispatch");
  const lastRun = recentRuns[0];

  // Compliance scoring (6 controls, equal weight)
  const controls = {
    branchProtection: !!bp,
    requiredReviews: !!bp?.required_pull_request_reviews?.required_approving_review_count,
    signedCommits: !!bp?.required_signatures?.enabled,
    codeOwners: codeowners,
    statusChecks: !!bp?.required_status_checks?.strict,
    autoMergeDisabled: !repoData.allow_auto_merge,
  };
  const complianceScore = Math.round((Object.values(controls).filter(Boolean).length / 6) * 100);

  // Health score: compliance 40% + pipeline success 30% + zero critical alerts 30%
  const criticals = [...depAlerts, ...secretAlerts].filter(a =>
    (a.security_advisory?.severity || a.severity || "").toLowerCase() === "critical"
  ).length;
  const alertPenalty = Math.min(criticals * 15, 30);
  const pipelineScore = successRate ?? 70;
  const health = Math.max(0, Math.round(complianceScore * 0.4 + pipelineScore * 0.3 + (30 - alertPenalty)));

  return {
    ...repoData,
    _enriched: {
      controls,
      complianceScore,
      health,
      workflows: recentRuns,
      failedRuns,
      manualRuns,
      successRate,
      lastRun,
      depAlerts,
      secretAlerts,
      codeAlerts,
      allAlerts: [...depAlerts.map(a => ({ ...a, _source: "dependabot" })), ...secretAlerts.map(a => ({ ...a, _source: "secret" })), ...codeAlerts.map(a => ({ ...a, _source: "code-scan" }))],
      prs: prList,
      codeowners,
    }
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────────────────────
const T = {
  bg0: "#f8fafc",       // deepest bg (slate 50)
  bg1: "#ffffff",       // surface (white)
  bg2: "#ffffff",       // card (white)
  bg3: "#f1f5f9",       // elevated / hover surface (slate 100)
  border: "#e2e8f0",    // border color (slate 200)
  borderHover: "#cbd5e1", // border hover color (slate 300)
  text0: "#0f172a",     // headings / title (slate 900)
  text1: "#334155",     // normal body text (slate 700)
  text2: "#64748b",     // secondary / muted text (slate 500)
  blue: "#2563eb",      // primary blue (blue 600)
  blueDim: "#eff6ff",   // soft blue tint (blue 50)
  green: "#16a34a",     // success green (green 600)
  greenDim: "#f0fdf4",  // soft green tint (green 50)
  amber: "#d97706",     // warning amber (amber 600)
  amberDim: "#fef3c7",  // soft amber tint (amber 50)
  red: "#dc2626",       // error red (red 600)
  redDim: "#fef2f2",    // soft red tint (red 50)
  purple: "#7c3aed",    // purple (purple 600)
  purpleDim: "#f5f3ff", // soft purple tint (purple 50)
  orange: "#ea580c",    // orange (orange 600)
  orangeDim: "#fff7ed", // soft orange tint (orange 50)
  cyan: "#0891b2",      // info cyan (cyan 600)
  cyanDim: "#ecfeff",   // soft cyan tint (cyan 50)
};

const healthColor = v => v >= 85 ? T.green : v >= 65 ? T.amber : T.red;
const healthDim = v => v >= 85 ? T.greenDim : v >= 65 ? T.amberDim : T.redDim;
const sevColor = { critical: T.red, high: T.orange, medium: T.amber, low: T.blue, warning: T.amber };
const sevDim = { critical: T.redDim, high: T.orangeDim, medium: T.amberDim, low: T.blueDim, warning: T.amberDim };

// ─────────────────────────────────────────────────────────────────────────────
// SHARED UI PRIMITIVES
// ─────────────────────────────────────────────────────────────────────────────
function Pill({ label, color, bg, size = "sm" }) {
  const pad = size === "xs" ? "2px 6px" : "4px 10px";
  const fs = size === "xs" ? 10 : 11;
  return (
    <span style={{ 
      background: bg || T.bg3, 
      color: color || T.text1, 
      padding: pad, 
      borderRadius: 6, 
      fontSize: fs, 
      fontWeight: 700, 
      letterSpacing: "0.04em", 
      textTransform: "uppercase", 
      whiteSpace: "nowrap",
      border: `1px solid ${bg ? "transparent" : T.border}`,
      boxShadow: "0 1px 2px rgba(0,0,0,0.02)"
    }}>
      {label}
    </span>
  );
}

function HealthBar({ value, height = 6 }) {
  return (
    <div style={{ background: "#e2e8f0", borderRadius: 99, height, width: "100%", overflow: "hidden" }}>
      <div style={{ width: `${Math.max(0, Math.min(100, value))}%`, height: "100%", background: healthColor(value), borderRadius: 99, transition: "width 0.6s cubic-bezier(.4,0,.2,1)" }} />
    </div>
  );
}

function KpiCard({ label, value, sub, accent, icon, onClick }) {
  return (
    <div onClick={onClick} 
      style={{ 
        background: T.bg2, 
        border: `1px solid ${T.border}`, 
        borderRadius: 14, 
        padding: "20px 22px", 
        display: "flex", 
        flexDirection: "column", 
        gap: 10, 
        cursor: onClick ? "pointer" : "default", 
        transition: "all 0.25s cubic-bezier(0.4, 0, 0.2, 1)", 
        position: "relative", 
        overflow: "hidden",
        boxShadow: "0 4px 6px -1px rgba(15, 23, 42, 0.03), 0 2px 4px -2px rgba(15, 23, 42, 0.03)"
      }}
      onMouseEnter={e => {
        e.currentTarget.style.transform = "translateY(-2px)";
        e.currentTarget.style.boxShadow = "0 12px 20px -8px rgba(15, 23, 42, 0.08), 0 4px 6px -4px rgba(15, 23, 42, 0.08)";
        e.currentTarget.style.borderColor = accent || T.blue;
      }}
      onMouseLeave={e => {
        e.currentTarget.style.transform = "translateY(0)";
        e.currentTarget.style.boxShadow = "0 4px 6px -1px rgba(15, 23, 42, 0.03), 0 2px 4px -2px rgba(15, 23, 42, 0.03)";
        e.currentTarget.style.borderColor = T.border;
      }}>
      <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 3, background: accent || T.blue, opacity: 0.8 }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <span style={{ color: T.text2, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</span>
        <span style={{ fontSize: 18, filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.05))" }}>{icon}</span>
      </div>
      <div style={{ color: T.text0, fontSize: 32, fontWeight: 800, lineHeight: 1, letterSpacing: "-0.03em" }}>{value}</div>
      {sub && <div style={{ color: T.text2, fontSize: 12, fontWeight: 500 }}>{sub}</div>}
    </div>
  );
}

function SectionHeader({ title, count, action }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <span style={{ color: T.text0, fontSize: 15, fontWeight: 750, letterSpacing: "-0.01em" }}>{title}</span>
        {count !== undefined && <span style={{ background: T.bg3, color: T.text1, padding: "2px 8px", borderRadius: 99, fontSize: 11, fontWeight: 700 }}>{count}</span>}
      </div>
      {action}
    </div>
  );
}

function FilterBar({ filters, active, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4, padding: "4px", background: "#f1f5f9", border: `1px solid ${T.border}`, borderRadius: 10, width: "fit-content", boxShadow: "0 1px 2px rgba(0,0,0,0.01)" }}>
      {filters.map(f => (
        <button key={f.value} onClick={() => onChange(f.value)}
          style={{ background: active === f.value ? T.bg1 : "transparent", border: active === f.value ? "1px solid rgba(0,0,0,0.05)" : "1px solid transparent", color: active === f.value ? T.blue : T.text2, borderRadius: 7, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)", boxShadow: active === f.value ? "0 2px 4px rgba(0,0,0,0.04)" : "none" }}>
          {f.label}
        </button>
      ))}
    </div>
  );
}

function EmptyState({ icon, title, sub }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "48px 24px", color: T.text2, gap: 10, background: T.bg1, border: `1px solid ${T.border}`, borderRadius: 14 }}>
      <div style={{ fontSize: 36, filter: "drop-shadow(0 4px 6px rgba(0,0,0,0.05))" }}>{icon}</div>
      <div style={{ color: T.text0, fontSize: 15, fontWeight: 700 }}>{title}</div>
      {sub && <div style={{ fontSize: 13, color: T.text2, textAlign: "center", maxWidth: 300 }}>{sub}</div>}
    </div>
  );
}

function Spinner({ size = 20 }) {
  return (
    <div style={{ width: size, height: size, border: `2.5px solid ${T.border}`, borderTop: `2.5px solid ${T.blue}`, borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
  );
}

function StatusDot({ status }) {
  const c = { success: T.green, failure: T.red, in_progress: T.blue, cancelled: T.text2, skipped: T.text2, queued: T.amber }[status] || T.text2;
  return <span style={{ display: "inline-block", width: 9, height: 9, borderRadius: "50%", background: c, boxShadow: status === "in_progress" ? `0 0 8px ${c}` : "none", flexShrink: 0 }} />;
}

function Table({ cols, rows, empty }) {
  if (!rows.length) return empty || <EmptyState icon="📭" title="No data" />;
  return (
    <div style={{ width: "100%", overflowX: "auto", borderRadius: 14, border: `1px solid ${T.border}`, boxShadow: "0 4px 6px -1px rgba(15, 23, 42, 0.02), 0 2px 4px -2px rgba(15, 23, 42, 0.02)" }}>
      <div style={{ minWidth: 800 }}>
        <div style={{ display: "grid", gridTemplateColumns: cols.map(c => c.width || "1fr").join(" "), background: T.bg3, padding: "12px 18px", gap: 12, borderBottom: `1px solid ${T.border}` }}>
          {cols.map(c => <div key={c.key} style={{ color: T.text2, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>{c.label}</div>)}
        </div>
        {rows.map((row, i) => (
          <div key={i} 
            style={{ 
              display: "grid", 
              gridTemplateColumns: cols.map(c => c.width || "1fr").join(" "), 
              padding: "14px 18px", 
              gap: 12, 
              borderTop: i > 0 ? `1px solid ${T.border}` : "none", 
              background: i % 2 === 0 ? T.bg1 : "#fafbfc", 
              alignItems: "center",
              transition: "background-color 0.15s"
            }}
            onMouseEnter={e => e.currentTarget.style.backgroundColor = "#f8fafc"}
            onMouseLeave={e => e.currentTarget.style.backgroundColor = i % 2 === 0 ? T.bg1 : "#fafbfc"}>
            {cols.map(c => <div key={c.key}>{c.render ? c.render(row) : <span style={{ color: T.text1, fontSize: 13, fontWeight: 500 }}>{row[c.key]}</span>}</div>)}
          </div>
        ))}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// ONBOARDING / SETTINGS MODAL
// ─────────────────────────────────────────────────────────────────────────────
function OnboardingScreen({ onComplete }) {
  const [step, setStep] = useState(0);
  const [config, setConfig] = useState({
    org: "", token: "", discoveryMode: "topic", discoveryValue: "", productName: "GitHub Governance Hub",
  });
  const [validating, setValidating] = useState(false);
  const [error, setError] = useState("");
  const [orgData, setOrgData] = useState(null);

  const update = (k, v) => setConfig(c => ({ ...c, [k]: v }));

  async function validateAndNext() {
    setError(""); setValidating(true);
    try {
      AuthProvider.setToken(config.token);
      const rl = await getRateLimit();
      let orgData;
      try { orgData = await githubFetch(`/orgs/${config.org}`); }
      catch { orgData = await githubFetch(`/users/${config.org}`); }
      setOrgData({ ...orgData, rateLimit: rl });
      setStep(1);
    } catch (e) {
      setError(e.message || "Invalid token or org");
      AuthProvider.clearToken();
    }
    setValidating(false);
  }

  async function finish() {
    const cfg = { org: config.org, discoveryMode: config.discoveryMode, discoveryValue: config.discoveryValue, productName: config.productName, configuredAt: new Date().toISOString() };
    sessionStorage.setItem("gh_config", JSON.stringify(cfg));
    onComplete(cfg);
  }

  const discoverModes = [
    { value: "all", label: "All Accessible Repos", desc: "Every repo accessible to this PAT — owner, collaborator, and org member", placeholder: null },
    { value: "topic", label: "GitHub Topic", desc: "Repos tagged with a specific topic (e.g. platform-eng)", placeholder: "e.g. platform-eng" },
    { value: "team", label: "Team Slug", desc: "All repos accessible to a GitHub team", placeholder: "e.g. cloud-platform" },
    { value: "prefix", label: "Name Prefix", desc: "Repos whose name starts with a prefix", placeholder: "e.g. aks- or finops-" },
    { value: "manual", label: "Manual List", desc: "Comma-separated list of exact repo names", placeholder: "repo-a, repo-b, repo-c" },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#f8fafc", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, fontFamily: "inherit" }}>
      <style>{`@keyframes spin { to { transform: rotate(360deg); } } * { box-sizing: border-box; }`}</style>
      <div style={{ width: 520, maxWidth: "100%", background: "#ffffff", border: `1px solid ${T.border}`, borderRadius: 20, overflow: "hidden", boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.05), 0 8px 10px -6px rgba(0, 0, 0, 0.05)" }}>
        {/* Header */}
        <div style={{ background: "linear-gradient(135deg, #eff6ff 0%, #f8fafc 100%)", padding: "28px 32px", borderBottom: `1px solid ${T.border}`, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 38, height: 38, background: "linear-gradient(135deg, #2563eb, #7c3aed)", borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, color: "#fff", fontWeight: "bold", boxShadow: "0 4px 6px -1px rgba(37, 99, 235, 0.2)" }}>⎈</div>
            <div>
              <div style={{ color: T.text0, fontWeight: 800, fontSize: 18, letterSpacing: "-0.02em" }}>GitHub Governance Hub</div>
              <div style={{ color: T.text2, fontSize: 12, fontWeight: 500 }}>Enterprise Repository Intelligence</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 4 }}>
            {["Connect", "Discover"].map((s, i) => (
              <div key={s} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 22, height: 22, borderRadius: "50%", background: step >= i ? T.blue : T.bg3, border: `1px solid ${step >= i ? T.blue : T.border}`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: step >= i ? "#fff" : T.text2 }}>{i + 1}</div>
                <span style={{ color: step === i ? T.text0 : T.text2, fontSize: 12, fontWeight: 700 }}>{s}</span>
                {i < 1 && <span style={{ color: T.text2, fontSize: 12, margin: "0 4px" }}>→</span>}
              </div>
            ))}
          </div>
        </div>

        <div style={{ padding: 32 }}>
          {step === 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div>
                <label style={{ color: T.text1, fontSize: 11, fontWeight: 700, display: "block", marginBottom: 6, letterSpacing: "0.05em" }}>GITHUB ORGANISATION / USERNAME</label>
                <input value={config.org} onChange={e => update("org", e.target.value)}
                  placeholder="your-github-username-or-org"
                  style={{ width: "100%", background: "#ffffff", border: `1px solid ${T.border}`, borderRadius: 8, color: T.text0, padding: "10px 14px", fontSize: 14, outline: "none", transition: "all 0.2s" }} />
              </div>
              <div>
                <label style={{ color: T.text1, fontSize: 11, fontWeight: 700, display: "block", marginBottom: 6, letterSpacing: "0.05em" }}>
                  FINE-GRAINED PAT
                  <span style={{ color: T.text2, fontWeight: 400, marginLeft: 8, textTransform: "none", fontSize: 11 }}>sessionStorage only</span>
                </label>
                <input type="password" value={config.token} onChange={e => update("token", e.target.value)}
                  placeholder="github_pat_..."
                  style={{ width: "100%", background: "#ffffff", border: `1px solid ${T.border}`, borderRadius: 8, color: T.text0, padding: "10px 14px", fontSize: 14, outline: "none", fontFamily: "monospace", transition: "all 0.2s" }} />
                <div style={{ marginTop: 10, background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 14px" }}>
                  <div style={{ color: T.text2, fontSize: 10, fontWeight: 700, marginBottom: 8, letterSpacing: "0.05em" }}>REQUIRED PAT PERMISSIONS (READ-ONLY)</div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                    {["Contents", "Metadata", "Actions", "Security events", "Administration", "Pull requests", "Dependabot alerts", "Secret scanning alerts"].map(p => (
                      <Pill key={p} label={p} color={T.text1} bg={T.bg1} size="xs" />
                    ))}
                  </div>
                </div>
              </div>
              <div style={{ background: "#eff6ff", border: "1px solid #bfdbfe", borderRadius: 8, padding: "10px 14px" }}>
                <div style={{ color: T.blue, fontSize: 11, fontWeight: 700, marginBottom: 4 }}>ℹ BROWSER MODE — CORS PROXY ACTIVE</div>
                <div style={{ color: T.text1, fontSize: 11, lineHeight: 1.4 }}>API calls route through corsproxy.io for browser compatibility. For production, replace with an Azure Function backend.</div>
              </div>
              {error && <div style={{ background: `${T.redDim}`, border: `1px solid ${T.red}33`, borderRadius: 8, padding: "10px 14px", color: T.red, fontSize: 13, fontWeight: 500 }}>⚠ {error}</div>}
              <button onClick={validateAndNext} disabled={!config.org || !config.token || validating}
                style={{ background: validating || !config.org || !config.token ? T.bg3 : "linear-gradient(135deg, #2563eb, #4f46e5)", border: "none", borderRadius: 9, color: validating || !config.org || !config.token ? T.text2 : "#fff", padding: "12px 0", fontSize: 14, fontWeight: 700, cursor: validating || !config.org || !config.token ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "all 0.2s", boxShadow: !config.org || !config.token ? "none" : "0 4px 10px rgba(37,99,235,0.15)" }}>
                {validating ? <><Spinner size={16} /> Validating…</> : "Connect to GitHub →"}
              </button>
            </div>
          )}

          {step === 1 && orgData && (
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              <div style={{ background: `${T.greenDim}`, border: `1px solid ${T.green}22`, borderRadius: 10, padding: "12px 16px", display: "flex", alignItems: "center", gap: 12 }}>
                <img src={orgData.avatar_url} alt="" style={{ width: 38, height: 38, borderRadius: 8 }} />
                <div>
                  <div style={{ color: T.green, fontWeight: 750, fontSize: 13 }}>Connected — {orgData.name || config.org}</div>
                  <div style={{ color: T.text2, fontSize: 12, fontWeight: 500 }}>{orgData.public_repos + (orgData.total_private_repos || 0)} total repos · {orgData.rateLimit.remaining}/{orgData.rateLimit.limit} API calls remaining</div>
                </div>
              </div>

              <div>
                <label style={{ color: T.text1, fontSize: 11, fontWeight: 700, display: "block", marginBottom: 10, letterSpacing: "0.05em" }}>REPOSITORY DISCOVERY METHOD</label>
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {discoverModes.map(m => (
                    <label key={m.value} style={{ display: "flex", gap: 12, background: config.discoveryMode === m.value ? `${T.blueDim}` : "#ffffff", border: `1px solid ${config.discoveryMode === m.value ? T.blue : T.border}`, borderRadius: 10, padding: "12px 14px", cursor: "pointer", alignItems: "flex-start", transition: "all 0.2s" }}>
                      <input type="radio" name="disc" value={m.value} checked={config.discoveryMode === m.value} onChange={() => update("discoveryMode", m.value)} style={{ marginTop: 3, accentColor: T.blue }} />
                      <div>
                        <div style={{ color: config.discoveryMode === m.value ? T.blue : T.text0, fontSize: 13, fontWeight: 700 }}>{m.label}</div>
                        <div style={{ color: T.text2, fontSize: 12, marginTop: 2, fontWeight: 500 }}>{m.desc}</div>
                      </div>
                    </label>
                  ))}
                </div>
              </div>

              {config.discoveryMode !== "all" && (
                <div>
                  <label style={{ color: T.text1, fontSize: 11, fontWeight: 700, display: "block", marginBottom: 6, letterSpacing: "0.05em" }}>
                    {discoverModes.find(m => m.value === config.discoveryMode)?.label.toUpperCase()}
                  </label>
                  <input value={config.discoveryValue} onChange={e => update("discoveryValue", e.target.value)}
                    placeholder={discoverModes.find(m => m.value === config.discoveryMode)?.placeholder}
                    style={{ width: "100%", background: "#ffffff", border: `1px solid ${T.border}`, borderRadius: 8, color: T.text0, padding: "10px 14px", fontSize: 14, outline: "none", transition: "all 0.2s" }} />
                </div>
              )}

              <div style={{ display: "flex", gap: 10 }}>
                <button onClick={() => setStep(0)} style={{ flex: 1, background: "#ffffff", border: `1px solid ${T.border}`, borderRadius: 9, color: T.text1, padding: "11px 0", fontSize: 14, fontWeight: 700, cursor: "pointer", transition: "all 0.2s" }}>← Back</button>
                <button onClick={finish} disabled={config.discoveryMode !== "all" && !config.discoveryValue}
                  style={{ flex: 2, background: (config.discoveryMode !== "all" && !config.discoveryValue) ? T.bg3 : "linear-gradient(135deg, #2563eb, #4f46e5)", border: "none", borderRadius: 9, color: (config.discoveryMode !== "all" && !config.discoveryValue) ? T.text2 : "#fff", padding: "12px 0", fontSize: 14, fontWeight: 700, cursor: (config.discoveryMode !== "all" && !config.discoveryValue) ? "not-allowed" : "pointer", transition: "all 0.2s", boxShadow: (config.discoveryMode !== "all" && !config.discoveryValue) ? "none" : "0 4px 10px rgba(37,99,235,0.15)" }}>
                  Load Dashboard →
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// VIEWS
// ─────────────────────────────────────────────────────────────────────────────

function ExecutiveView({ repos, rateLimit }) {
  if (!repos.length) return <EmptyState icon="📊" title="Loading data…" sub="Fetching repository metrics" />;

  const avg = v => Math.round(repos.reduce((a, r) => a + (r._enriched?.[v] ?? 0), 0) / repos.length);
  const avgHealth = avg("health");
  const avgCompliance = avg("complianceScore");
  const totalAlerts = repos.reduce((a, r) => a + (r._enriched?.allAlerts?.length || 0), 0);
  const critAlerts = repos.reduce((a, r) => a + (r._enriched?.allAlerts?.filter(al => (al.security_advisory?.severity || al.severity || "").toLowerCase() === "critical").length || 0), 0);
  const failedPipelines = repos.filter(r => r._enriched?.failedRuns?.length > 0).length;
  const manualRuns = repos.reduce((a, r) => a + (r._enriched?.manualRuns?.length || 0), 0);
  const fullyCompliant = repos.filter(r => r._enriched?.complianceScore === 100).length;

  const bands = [
    { label: "Healthy (≥85%)", v: repos.filter(r => (r._enriched?.health || 0) >= 85).length, c: T.green },
    { label: "At Risk (65–84%)", v: repos.filter(r => { const h = r._enriched?.health || 0; return h >= 65 && h < 85; }).length, c: T.amber },
    { label: "Critical (<65%)", v: repos.filter(r => (r._enriched?.health || 0) < 65).length, c: T.red },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 24, animation: "slideUp 0.3s ease-out" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 16 }}>
        <KpiCard label="Repositories Monitored" value={repos.length} icon="🗂️" sub="Across configured discovery scope" accent={T.blue} />
        <KpiCard label="Avg Repository Health" value={`${avgHealth}%`} accent={healthColor(avgHealth)} icon="💚" sub="Composite compliance + pipeline + alerts" />
        <KpiCard label="Critical Alerts" value={critAlerts} accent={critAlerts > 0 ? T.red : T.green} icon="🚨" sub={`${totalAlerts} total open alerts`} />
        <KpiCard label="Repos with Pipeline Failures" value={failedPipelines} accent={failedPipelines > 0 ? T.orange : T.green} icon="⛔" sub={`of ${repos.length} repos`} />
        <KpiCard label="Governance Compliant" value={`${fullyCompliant}/${repos.length}`} accent={T.green} icon="🛡️" sub="100% compliance policy score" />
        <KpiCard label="Manual Pipeline Runs" value={manualRuns} accent={T.purple} icon="🖱️" sub="Target: zero — automate all triggers" />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(360px, 1fr))", gap: 20 }}>
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22, boxShadow: "0 4px 6px -1px rgba(15, 23, 42, 0.02), 0 2px 4px -2px rgba(15, 23, 42, 0.02)" }}>
          <SectionHeader title="Health Distribution" />
          {bands.map(b => (
            <div key={b.label} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
                <span style={{ color: T.text1, fontSize: 13, fontWeight: 600 }}>{b.label}</span>
                <span style={{ color: b.c, fontWeight: 750, fontSize: 13 }}>{b.v} repos</span>
              </div>
              <HealthBar value={repos.length ? (b.v / repos.length) * 100 : 0} />
            </div>
          ))}
        </div>

        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22, boxShadow: "0 4px 6px -1px rgba(15, 23, 42, 0.02), 0 2px 4px -2px rgba(15, 23, 42, 0.02)" }}>
          <SectionHeader title="Worst Health Repos" />
          {[...repos].sort((a, b) => (a._enriched?.health || 0) - (b._enriched?.health || 0)).slice(0, 5).map(r => (
            <div key={r.name} style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1 }}>
                <div style={{ color: T.text0, fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{r.name}</div>
                <HealthBar value={r._enriched?.health || 0} height={5} />
              </div>
              <span style={{ color: healthColor(r._enriched?.health || 0), fontWeight: 800, fontSize: 14, minWidth: 42, textAlign: "right" }}>{r._enriched?.health || 0}%</span>
            </div>
          ))}
        </div>
      </div>

      {rateLimit && (
        <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 12, padding: "14px 20px", display: "flex", alignItems: "center", gap: 16, boxShadow: "0 2px 4px rgba(0,0,0,0.01)" }}>
          <div style={{ color: T.text2, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>API Rate Limit</div>
          <div style={{ flex: 1 }}><HealthBar value={(rateLimit.remaining / rateLimit.limit) * 100} height={5} /></div>
          <span style={{ color: rateLimit.remaining < 500 ? T.red : T.green, fontWeight: 800, fontSize: 13 }}>{rateLimit.remaining}/{rateLimit.limit}</span>
          <span style={{ color: T.text2, fontSize: 12, fontWeight: 500 }}>Resets {new Date(rateLimit.reset * 1000).toLocaleTimeString()}</span>
        </div>
      )}
    </div>
  );
}

function RepositoriesView({ repos }) {
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState("health");
  const sorted = [...repos]
    .filter(r => r.name.toLowerCase().includes(search.toLowerCase()))
    .sort((a, b) => {
      if (sort === "health") return (b._enriched?.health || 0) - (a._enriched?.health || 0);
      if (sort === "alerts") return (b._enriched?.allAlerts?.length || 0) - (a._enriched?.allAlerts?.length || 0);
      if (sort === "name") return a.name.localeCompare(b.name);
      return 0;
    });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, animation: "slideUp 0.3s ease-out" }}>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Filter repositories by name…"
          style={{ background: "#ffffff", border: `1px solid ${T.border}`, borderRadius: 9, color: T.text0, padding: "10px 16px", fontSize: 13, flex: 1, minWidth: 260, outline: "none", transition: "all 0.2s" }} />
        <select value={sort} onChange={e => setSort(e.target.value)}
          style={{ background: "#ffffff", border: `1px solid ${T.border}`, borderRadius: 9, color: T.text0, padding: "10px 14px", fontSize: 13, outline: "none", cursor: "pointer", transition: "all 0.2s" }}>
          <option value="health">Sort by Health</option>
          <option value="alerts">Sort by Alerts Count</option>
          <option value="name">Sort by Name A-Z</option>
        </select>
      </div>
      <Table
        cols={[
          { key: "name", label: "Repository", width: "2fr", render: r => (
            <div style={{ padding: "2px 0" }}>
              <div style={{ color: T.text0, fontSize: 13, fontWeight: 700 }}>{r.name}</div>
              <div style={{ color: T.text2, fontSize: 11, marginTop: 4, fontWeight: 500 }}>{r.description || <em>No description</em>}</div>
            </div>
          )},
          { key: "lang", label: "Language", width: "110px", render: r => r.language ? <Pill label={r.language} bg={T.bg3} color={T.text1} /> : <span style={{ color: T.text2, fontSize: 13 }}>—</span> },
          { key: "health", label: "Health", width: "130px", render: r => (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, width: "100%", paddingRight: 12 }}>
              <span style={{ color: healthColor(r._enriched?.health || 0), fontWeight: 800, fontSize: 13 }}>{r._enriched?.health || 0}%</span>
              <HealthBar value={r._enriched?.health || 0} height={4} />
            </div>
          )},
          { key: "compliance", label: "Compliance", width: "110px", render: r => (
            <span style={{ color: healthColor(r._enriched?.complianceScore || 0), fontWeight: 800, fontSize: 13 }}>{r._enriched?.complianceScore || 0}%</span>
          )},
          { key: "alerts", label: "Alerts", width: "90px", render: r => {
            const count = r._enriched?.allAlerts?.length || 0;
            return <span style={{ color: count > 0 ? T.orange : T.green, fontWeight: 800, fontSize: 13 }}>{count}</span>;
          }},
          { key: "pipeline", label: "Last Pipeline", width: "130px", render: r => {
            const run = r._enriched?.lastRun;
            if (!run) return <span style={{ color: T.text2, fontSize: 12, fontWeight: 500 }}>No runs</span>;
            return (
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <StatusDot status={run.conclusion || run.status} />
                <span style={{ color: T.text1, fontSize: 12, fontWeight: 600, textTransform: "capitalize" }}>{run.conclusion || run.status}</span>
              </div>
            );
          }},
          { key: "visibility", label: "Visibility", width: "100px", render: r => <Pill label={r.visibility} color={r.visibility === "internal" ? T.cyan : T.text1} bg={r.visibility === "internal" ? T.cyanDim : T.bg3} size="xs" /> },
          { key: "branch", label: "Branch", width: "100px", render: r => <span style={{ color: T.text2, fontSize: 12, fontFamily: "monospace", fontWeight: 500 }}>{r.default_branch}</span> },
        ]}
        rows={sorted}
      />
    </div>
  );
}

function PipelinesView({ repos }) {
  const [statusFilter, setStatusFilter] = useState("all");
  const allRuns = repos.flatMap(r =>
    (r._enriched?.workflows || []).map(w => ({ ...w, _repo: r.name }))
  );
  const filtered = allRuns.filter(r => statusFilter === "all" || (statusFilter === "manual" ? r.event === "workflow_dispatch" : r.conclusion === statusFilter || r.status === statusFilter));

  const failedRepos = [...new Set(repos.filter(r => r._enriched?.failedRuns?.length > 0).map(r => r.name))];
  const manualCount = allRuns.filter(r => r.event === "workflow_dispatch").length;
  const successCount = allRuns.filter(r => r.conclusion === "success").length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, animation: "slideUp 0.3s ease-out" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <KpiCard label="Total Recent Runs" value={allRuns.length} icon="▶️" accent={T.blue} />
        <KpiCard label="Failed Repos" value={failedRepos.length} accent={failedRepos.length > 0 ? T.red : T.green} icon="⛔" />
        <KpiCard label="Manual Triggers" value={manualCount} accent={T.purple} icon="🖱️" sub="workflow_dispatch events" />
        <KpiCard label="Overall Success" value={allRuns.length ? `${Math.round((successCount / allRuns.length) * 100)}%` : "—"} accent={T.green} icon="✅" />
      </div>

      {failedRepos.length > 0 && (
        <div style={{ background: T.redDim, border: `1px solid ${T.red}22`, borderRadius: 12, padding: "14px 18px", boxShadow: "0 2px 4px rgba(220,38,38,0.02)" }}>
          <div style={{ color: T.red, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", marginBottom: 10 }}>⚠ Repos with Recurring Pipeline Failures</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {failedRepos.map(r => <Pill key={r} label={r} color={T.red} bg={T.redDim} />)}
          </div>
        </div>
      )}

      <FilterBar
        filters={[
          { value: "all", label: `All (${allRuns.length})` },
          { value: "failure", label: `Failed (${allRuns.filter(r => r.conclusion === "failure").length})` },
          { value: "manual", label: `Manual (${manualCount})` },
          { value: "in_progress", label: `Running (${allRuns.filter(r => r.status === "in_progress").length})` },
        ]}
        active={statusFilter}
        onChange={setStatusFilter}
      />

      <Table
        cols={[
          { key: "_repo", label: "Repository", width: "1.5fr", render: r => <span style={{ color: T.text0, fontWeight: 700, fontSize: 13 }}>{r._repo}</span> },
          { key: "name", label: "Workflow", width: "2fr", render: r => <span style={{ color: T.text1, fontSize: 13, fontWeight: 500 }}>{r.name}</span> },
          { key: "status", label: "Status", width: "120px", render: r => (
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              <StatusDot status={r.conclusion || r.status} />
              <span style={{ color: T.text1, fontSize: 12, fontWeight: 600, textTransform: "capitalize" }}>{r.conclusion || r.status}</span>
            </div>
          )},
          { key: "event", label: "Trigger", width: "120px", render: r => <Pill label={r.event} color={r.event === "workflow_dispatch" ? T.purple : T.text1} bg={r.event === "workflow_dispatch" ? T.purpleDim : T.bg3} size="xs" /> },
          { key: "head_branch", label: "Branch", width: "120px", render: r => <span style={{ color: T.text2, fontSize: 12, fontFamily: "monospace", fontWeight: 500 }}>{r.head_branch}</span> },
          { key: "created_at", label: "Started", width: "160px", render: r => <span style={{ color: T.text2, fontSize: 12, fontWeight: 500 }}>{new Date(r.created_at).toLocaleString()}</span> },
        ]}
        rows={filtered}
        empty={<EmptyState icon="⚙️" title="No pipeline runs" sub="No workflows match this filter" />}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY VIEW
// ─────────────────────────────────────────────────────────────────────────────
function SecurityView({ repos }) {
  const [sevFilter, setSevFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");

  const allAlerts = repos.flatMap(r =>
    (r._enriched?.allAlerts || []).map(a => ({ ...a, _repo: r.name }))
  );

  const getSeverity = a => (a.security_advisory?.severity || a.severity || a.rule?.severity || "unknown").toLowerCase();
  const getSource = a => a._source || "unknown";

  const filtered = allAlerts.filter(a =>
    (sevFilter === "all" || getSeverity(a) === sevFilter) &&
    (sourceFilter === "all" || getSource(a) === sourceFilter)
  );

  const sevCounts = ["critical", "high", "medium", "low"].reduce((acc, s) => ({ ...acc, [s]: allAlerts.filter(a => getSeverity(a) === s).length }), {});
  const sources = [...new Set(allAlerts.map(getSource))];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, animation: "slideUp 0.3s ease-out" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        {["critical", "high", "medium", "low"].map(s => (
          <KpiCard key={s} label={s.charAt(0).toUpperCase() + s.slice(1)} value={sevCounts[s] || 0} accent={sevColor[s]} icon={s === "critical" ? "🔴" : s === "high" ? "🟠" : s === "medium" ? "🟡" : "🔵"} />
        ))}
      </div>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <FilterBar
          filters={[{ value: "all", label: "All Severity" }, ...["critical", "high", "medium", "low"].map(s => ({ value: s, label: s.charAt(0).toUpperCase() + s.slice(1) }))]}
          active={sevFilter} onChange={setSevFilter}
        />
        <FilterBar
          filters={[{ value: "all", label: "All Sources" }, ...sources.map(s => ({ value: s, label: s }))]}
          active={sourceFilter} onChange={setSourceFilter}
        />
      </div>

      <Table
        cols={[
          { key: "_repo", label: "Repository", width: "1.5fr", render: r => <span style={{ color: T.text0, fontWeight: 700, fontSize: 13 }}>{r._repo}</span> },
          { key: "title", label: "Finding", width: "3fr", render: a => (
            <div style={{ padding: "2px 0" }}>
              <div style={{ color: T.text0, fontSize: 13, fontWeight: 700 }}>{a.security_advisory?.summary || a.secret_type_display_name || a.rule?.description || a.number}</div>
              <div style={{ color: T.text2, fontSize: 11, marginTop: 4, fontFamily: "monospace", fontWeight: 500 }}>{a.dependency?.package?.name || a.locations?.[0]?.details?.path || ""}</div>
            </div>
          )},
          { key: "severity", label: "Severity", width: "100px", render: a => {
            const s = getSeverity(a);
            return <Pill label={s} color={sevColor[s] || T.text1} bg={sevDim[s] || T.bg3} />;
          }},
          { key: "source", label: "Source", width: "120px", render: a => <Pill label={getSource(a)} color={T.cyan} bg={T.cyanDim} size="xs" /> },
          { key: "created_at", label: "Opened", width: "110px", render: a => <span style={{ color: T.text2, fontSize: 12, fontWeight: 500 }}>{new Date(a.created_at).toLocaleDateString()}</span> },
        ]}
        rows={filtered}
        empty={<EmptyState icon="🛡️" title="No alerts" sub="No security alerts match the current filter" />}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPLIANCE VIEW
// ─────────────────────────────────────────────────────────────────────────────
function ComplianceView({ repos }) {
  const controls = [
    { key: "branchProtection", label: "Branch Protection", icon: "🔒" },
    { key: "requiredReviews", label: "Required Reviews", icon: "👁" },
    { key: "signedCommits", label: "Signed Commits", icon: "✍️" },
    { key: "codeOwners", label: "CODEOWNERS", icon: "📋" },
    { key: "statusChecks", label: "Status Checks", icon: "✅" },
    { key: "autoMergeDisabled", label: "Auto-merge Off", icon: "🚫" },
  ];

  const fullyCompliant = repos.filter(r => r._enriched?.complianceScore === 100).length;
  const violations = repos.filter(r => (r._enriched?.complianceScore || 0) < 50).length;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, animation: "slideUp 0.3s ease-out" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 14 }}>
        <KpiCard label="Fully Compliant" value={fullyCompliant} accent={T.green} icon="🛡️" sub="100% policy score" />
        <KpiCard label="Policy Violations" value={violations} accent={violations > 0 ? T.red : T.green} icon="🚨" sub="Score below 50%" />
        <KpiCard label="Avg Compliance Score" value={`${repos.length ? Math.round(repos.reduce((a, r) => a + (r._enriched?.complianceScore || 0), 0) / repos.length) : 0}%`} icon="📊" accent={T.blue} />
      </div>

      <div style={{ width: "100%", overflowX: "auto", borderRadius: 14, border: `1px solid ${T.border}`, boxShadow: "0 4px 6px -1px rgba(15, 23, 42, 0.02)" }}>
        <div style={{ minWidth: 800 }}>
          <div style={{ display: "grid", gridTemplateColumns: `2fr repeat(${controls.length}, 1fr) 100px`, background: T.bg3, padding: "12px 18px", gap: 8, borderBottom: `1px solid ${T.border}` }}>
            <div style={{ color: T.text2, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase" }}>Repository</div>
            {controls.map(c => (
              <div key={c.key} title={c.label} style={{ color: T.text2, fontSize: 13, fontWeight: 700, textAlign: "center" }}>{c.icon}</div>
            ))}
            <div style={{ color: T.text2, fontSize: 11, fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", textAlign: "right", paddingRight: 10 }}>Score</div>
          </div>
          {repos.map((r, i) => (
            <div key={r.name} style={{ display: "grid", gridTemplateColumns: `2fr repeat(${controls.length}, 1fr) 100px`, padding: "14px 18px", gap: 8, borderTop: i > 0 ? `1px solid ${T.border}` : "none", background: i % 2 === 0 ? T.bg1 : "#fafbfc", alignItems: "center" }}>
              <div style={{ color: T.text0, fontSize: 13, fontWeight: 700 }}>{r.name}</div>
              {controls.map(c => (
                <div key={c.key} style={{ textAlign: "center", fontSize: 15 }}>
                  {r._enriched?.controls?.[c.key] ? "🟢" : "🔴"}
                </div>
              ))}
              <div style={{ display: "flex", flexDirection: "column", gap: 4, paddingRight: 10 }}>
                <span style={{ color: healthColor(r._enriched?.complianceScore || 0), fontWeight: 800, fontSize: 13, textAlign: "right" }}>{r._enriched?.complianceScore || 0}%</span>
                <HealthBar value={r._enriched?.complianceScore || 0} height={4} />
              </div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background: T.bg2, border: `1px solid ${T.border}`, borderRadius: 14, padding: 22, boxShadow: "0 4px 6px -1px rgba(15, 23, 42, 0.02)" }}>
        <SectionHeader title="Policy Coverage per Control" />
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 12 }}>
          {controls.map(c => {
            const pass = repos.filter(r => r._enriched?.controls?.[c.key]).length;
            const pct = repos.length ? Math.round((pass / repos.length) * 100) : 0;
            return (
              <div key={c.key} style={{ background: T.bg0, border: `1px solid ${T.border}`, borderRadius: 10, padding: "14px 16px" }}>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
                  <span style={{ color: T.text1, fontSize: 13, fontWeight: 600 }}>{c.icon} {c.label}</span>
                  <span style={{ color: healthColor(pct), fontWeight: 800, fontSize: 13 }}>{pct}%</span>
                </div>
                <HealthBar value={pct} height={4} />
                <div style={{ color: T.text2, fontSize: 11, marginTop: 6, fontWeight: 500 }}>{pass}/{repos.length} repos compliant</div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// PULL REQUESTS VIEW
// ─────────────────────────────────────────────────────────────────────────────
function PullRequestsView({ repos }) {
  const allPRs = repos.flatMap(r =>
    (r._enriched?.prs || []).map(p => ({ ...p, _repo: r.name }))
  );
  const open = allPRs.filter(p => p.state === "open");
  const avgAge = open.length
    ? Math.round(open.reduce((a, p) => a + (Date.now() - new Date(p.created_at)) / 86400000, 0) / open.length)
    : 0;
  const stalePRs = open.filter(p => (Date.now() - new Date(p.updated_at)) / 86400000 > 7);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 18, animation: "slideUp 0.3s ease-out" }}>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        <KpiCard label="Open PRs" value={open.length} accent={T.blue} icon="🔀" />
        <KpiCard label="Total PRs" value={allPRs.length} icon="📋" accent={T.text2} />
        <KpiCard label="Avg PR Age (open)" value={`${avgAge}d`} accent={avgAge > 7 ? T.amber : T.green} icon="⏱️" />
        <KpiCard label="Stale PRs (>7d)" value={stalePRs.length} accent={stalePRs.length > 0 ? T.orange : T.green} icon="🕰️" sub="No activity for 7+ days" />
      </div>
      <Table
        cols={[
          { key: "_repo", label: "Repository", width: "1.5fr", render: r => <span style={{ color: T.text0, fontWeight: 700, fontSize: 13 }}>{r._repo}</span> },
          { key: "title", label: "PR Title", width: "3fr", render: r => (
            <a href={r.html_url} target="_blank" rel="noreferrer" style={{ color: T.blue, fontSize: 13, fontWeight: 700, textDecoration: "none" }}>{r.title}</a>
          )},
          { key: "state", label: "State", width: "90px", render: r => <Pill label={r.state} color={r.state === "open" ? T.green : T.text1} bg={r.state === "open" ? T.greenDim : T.bg3} size="xs" /> },
          { key: "user", label: "Author", width: "120px", render: r => <span style={{ color: T.text1, fontSize: 12, fontWeight: 600 }}>{r.user?.login}</span> },
          { key: "created_at", label: "Opened", width: "110px", render: r => <span style={{ color: T.text2, fontSize: 12, fontWeight: 500 }}>{new Date(r.created_at).toLocaleDateString()}</span> },
          { key: "updated_at", label: "Last Activity", width: "120px", render: r => {
            const days = Math.floor((Date.now() - new Date(r.updated_at)) / 86400000);
            return <span style={{ color: days > 7 ? T.amber : T.text2, fontSize: 12, fontWeight: 600 }}>{days === 0 ? "Today" : `${days}d ago`}</span>;
          }},
        ]}
        rows={allPRs.slice(0, 50)}
        empty={<EmptyState icon="🔀" title="No pull requests" sub="No PRs found across monitored repos" />}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN APP SHELL
// ─────────────────────────────────────────────────────────────────────────────
const VIEWS = [
  { id: "executive", label: "Executive", icon: "📊" },
  { id: "repositories", label: "Repositories", icon: "🗂️" },
  { id: "pipelines", label: "Pipelines", icon: "⚙️" },
  { id: "security", label: "Security", icon: "🔒" },
  { id: "compliance", label: "Compliance", icon: "🛡️" },
  { id: "pull-requests", label: "Pull Requests", icon: "🔀" },
];

export default function App() {
  const [appState, setAppState] = useState("init"); // init | onboarding | loading | ready | error
  const [config, setConfig] = useState(null);
  const [repos, setRepos] = useState([]);
  const [enrichProgress, setEnrichProgress] = useState({ done: 0, total: 0 });
  const [rateLimit, setRateLimit] = useState(null);
  const [view, setView] = useState("executive");
  const [globalError, setGlobalError] = useState("");
  const loadRef = useRef(false);

  // Restore session on mount
  useEffect(() => {
    const saved = sessionStorage.getItem("gh_config");
    if (saved && AuthProvider.isConfigured()) {
      const cfg = JSON.parse(saved);
      setConfig(cfg);
      setAppState("loading");
    } else {
      setAppState("onboarding");
    }
  }, []);

  // Load data when config is set
  useEffect(() => {
    if (appState !== "loading" || !config || loadRef.current) return;
    loadRef.current = true;
    loadAll(config);
  }, [appState, config]);

  async function loadAll(cfg) {
    setGlobalError("");
    try {
      const rl = await getRateLimit();
      setRateLimit(rl);

      const rawRepos = await fetchRepos(cfg.org, cfg.discoveryMode, cfg.discoveryValue);
      setEnrichProgress({ done: 0, total: rawRepos.length });

      const enriched = [];
      for (const repo of rawRepos) {
        const result = await enrichRepo(cfg.org, repo);
        enriched.push(result);
        setRepos([...enriched]);
        setEnrichProgress({ done: enriched.length, total: rawRepos.length });
      }

      const finalRL = await getRateLimit();
      setRateLimit(finalRL);
      setAppState("ready");
    } catch (e) {
      setGlobalError(e.message);
      setAppState("error");
    }
    loadRef.current = false;
  }

  function handleOnboardComplete(cfg) {
    setConfig(cfg);
    setAppState("loading");
    loadRef.current = false;
  }

  function handleDisconnect() {
    AuthProvider.clearToken();
    sessionStorage.removeItem("gh_config");
    setRepos([]);
    setConfig(null);
    setAppState("onboarding");
    loadRef.current = false;
  }

  async function handleRefresh() {
    if (!config) return;
    setRepos([]);
    setAppState("loading");
    loadRef.current = false;
  }

  if (appState === "init") return null;
  if (appState === "onboarding") return <OnboardingScreen onComplete={handleOnboardComplete} />;

  const critAlerts = repos.reduce((a, r) => a + (r._enriched?.allAlerts?.filter(al => (al.security_advisory?.severity || al.severity || "").toLowerCase() === "critical").length || 0), 0);
  const failedPipelines = repos.filter(r => r._enriched?.failedRuns?.length > 0).length;
  const loadPct = enrichProgress.total ? Math.round((enrichProgress.done / enrichProgress.total) * 100) : 0;

  return (
    <div style={{ minHeight: "100vh", background: T.bg0, color: T.text0, fontFamily: "inherit" }}>
      <style>{`
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: ${T.bg0}; }
        ::-webkit-scrollbar-thumb { background: ${T.border}; border-radius: 3px; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:.4; } }
        input::placeholder { color: ${T.text2}; }
        input, select, button { font-family: inherit; }
        input:focus, select:focus {
          border-color: ${T.blue} !important;
          box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.15) !important;
          outline: none;
        }
      `}</style>

      {/* Top navigation */}
      <header style={{ 
        background: "rgba(255, 255, 255, 0.85)", 
        backdropFilter: "blur(12px)", 
        borderBottom: `1px solid ${T.border}`, 
        height: 56, 
        display: "flex", 
        alignItems: "center", 
        padding: "0 24px", 
        gap: 16, 
        position: "sticky", 
        top: 0, 
        zIndex: 100,
        boxShadow: "0 1px 3px rgba(0,0,0,0.02)"
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 220 }}>
          <div style={{ width: 32, height: 32, background: "linear-gradient(135deg, #2563eb, #7c3aed)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, color: "#fff", fontWeight: "bold", flexShrink: 0 }}>⎈</div>
          <div>
            <div style={{ color: T.text0, fontWeight: 800, fontSize: 14, letterSpacing: "-0.02em" }}>{config?.productName || "Governance Hub"}</div>
            <div style={{ color: T.text2, fontSize: 10.5, fontWeight: 600, marginTop: 1 }}>{config?.org} · {repos.length} repos</div>
          </div>
        </div>

        <nav style={{ display: "flex", gap: 4, flex: 1, overflowX: "auto", padding: "4px 0" }}>
          {VIEWS.map(v => (
            <button key={v.id} onClick={() => setView(v.id)}
              style={{ 
                background: view === v.id ? T.blueDim : "transparent", 
                border: "none",
                color: view === v.id ? T.blue : T.text2, 
                padding: "6px 14px", 
                borderRadius: 8, 
                fontSize: 13, 
                fontWeight: 700, 
                display: "flex", 
                alignItems: "center", 
                gap: 6, 
                cursor: "pointer", 
                transition: "all 0.2s cubic-bezier(0.4, 0, 0.2, 1)",
                whiteSpace: "nowrap"
              }}
              onMouseEnter={e => {
                if (view !== v.id) {
                  e.currentTarget.style.background = "#f1f5f9";
                  e.currentTarget.style.color = T.text0;
                }
              }}
              onMouseLeave={e => {
                if (view !== v.id) {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = T.text2;
                }
              }}>
              <span style={{ fontSize: 14 }}>{v.icon}</span>{v.label}
            </button>
          ))}
        </nav>

        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          {critAlerts > 0 && (
            <div style={{ background: T.redDim, border: `1px solid ${T.red}22`, borderRadius: 7, padding: "4px 10px", color: T.red, fontSize: 11, fontWeight: 700, cursor: "pointer", transition: "all 0.2s" }} 
              onClick={() => setView("security")}
              onMouseEnter={e => e.currentTarget.style.background = `${T.redDim}dd`}
              onMouseLeave={e => e.currentTarget.style.background = T.redDim}>
              🚨 {critAlerts} Critical
            </div>
          )}
          {failedPipelines > 0 && (
            <div style={{ background: T.orangeDim, border: `1px solid ${T.orange}22`, borderRadius: 7, padding: "4px 10px", color: T.orange, fontSize: 11, fontWeight: 700, cursor: "pointer", transition: "all 0.2s" }} 
              onClick={() => setView("pipelines")}
              onMouseEnter={e => e.currentTarget.style.background = `${T.orangeDim}dd`}
              onMouseLeave={e => e.currentTarget.style.background = T.orangeDim}>
              ⛔ {failedPipelines} Failed
            </div>
          )}
          {rateLimit && (
            <div style={{ color: rateLimit.remaining < 500 ? T.amber : T.text2, fontSize: 11, fontWeight: 600 }}>
              API {rateLimit.remaining}/{rateLimit.limit}
            </div>
          )}
          {appState === "ready" && (
            <button onClick={handleRefresh} style={{ background: "#ffffff", border: `1px solid ${T.border}`, borderRadius: 8, color: T.text1, padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", transition: "all 0.2s", boxShadow: "0 1px 2px rgba(0,0,0,0.02)" }}
              onMouseEnter={e => e.currentTarget.style.background = "#f8fafc"}
              onMouseLeave={e => e.currentTarget.style.background = "#ffffff"}>↻ Refresh</button>
          )}
          <button onClick={handleDisconnect} style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: 8, color: T.text2, padding: "6px 14px", fontSize: 12, fontWeight: 600, cursor: "pointer", transition: "all 0.2s" }}
            onMouseEnter={e => e.currentTarget.style.background = "#f1f5f9"}
            onMouseLeave={e => e.currentTarget.style.background = "transparent"}>Disconnect</button>
        </div>
      </header>

      {/* Loading bar */}
      {appState === "loading" && (
        <div style={{ background: "#ffffff", borderBottom: `1px solid ${T.border}`, padding: "14px 24px", animation: "fadeIn 0.2s ease" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 8 }}>
            <Spinner size={16} />
            <span style={{ color: T.text1, fontSize: 13, fontWeight: 600 }}>Fetching repository data… {enrichProgress.done}/{enrichProgress.total} repos enriched</span>
            <span style={{ color: T.text2, fontSize: 12, fontWeight: 700, marginLeft: "auto" }}>{loadPct}%</span>
          </div>
          <div style={{ background: "#e2e8f0", borderRadius: 99, height: 5, overflow: "hidden" }}>
            <div style={{ width: `${loadPct}%`, height: "100%", background: `linear-gradient(90deg, ${T.blue}, ${T.purple})`, borderRadius: 99, transition: "width 0.3s ease" }} />
          </div>
          {enrichProgress.done > 0 && (
            <div style={{ color: T.text2, fontSize: 12, marginTop: 8, fontWeight: 500 }}>Showing partial data — dashboard updates as each repo loads</div>
          )}
        </div>
      )}

      {/* Error state */}
      {appState === "error" && (
        <div style={{ margin: "24px", background: T.redDim, border: `1px solid ${T.red}22`, borderRadius: 12, padding: 20, display: "flex", alignItems: "center", gap: 16, animation: "slideUp 0.3s ease" }}>
          <span style={{ fontSize: 24 }}>⚠️</span>
          <div style={{ flex: 1 }}>
            <div style={{ color: T.red, fontWeight: 800 }}>Failed to load data</div>
            <div style={{ color: T.text1, fontSize: 13, marginTop: 4, fontWeight: 500 }}>{globalError}</div>
          </div>
          <button onClick={handleDisconnect} style={{ background: "#ffffff", border: `1px solid ${T.border}`, borderRadius: 8, color: T.text0, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>Reconfigure</button>
        </div>
      )}

      {/* Main content */}
      <main style={{ padding: "24px", maxWidth: 1400, margin: "0 auto", width: "100%" }}>
        {(appState === "ready" || (appState === "loading" && enrichProgress.done > 0)) && (
          <>
            {view === "executive" && <ExecutiveView repos={repos} rateLimit={rateLimit} />}
            {view === "repositories" && <RepositoriesView repos={repos} />}
            {view === "pipelines" && <PipelinesView repos={repos} />}
            {view === "security" && <SecurityView repos={repos} />}
            {view === "compliance" && <ComplianceView repos={repos} />}
            {view === "pull-requests" && <PullRequestsView repos={repos} />}
          </>
        )}
      </main>
    </div>
  );
}
