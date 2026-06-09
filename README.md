# ⎈ GitHub Governance Hub

An enterprise-grade repository intelligence and policy compliance dashboard built on **React** and **Vite**.

The GitHub Governance Hub is a centralized platform engineering and security compliance tool designed to audit, monitor, and enforce engineering standards across large scales of repositories. It identifies configuration drift, security alerts, and pipeline health in real time via the GitHub API.

---

## 📖 In-Depth Guides

- 🛠️ **System Architecture & Calculations**: Read the complete [Workflow & Architecture Specification](file:///Users/kumam/Downloads/github_governance/workflow.md) (including flowcharts, sequence diagrams, and mathematical scoring metrics).

---

## 💡 What it Does

Managing compliance and security across hundreds of repositories can lead to configuration drift (e.g., branch protections getting disabled, security alerts being ignored, or manual pipeline runs inflating build counts).

**GitHub Governance Hub** connects to your GitHub account or organization and aggregates critical telemetry across six core views:
1. **Audit Security Controls**: Instant checks on branch protection configurations, reviews, signatures, and CODEOWNERS.
2. **Assess Repository Health**: Computes a single weighted grade (0–100%) reflecting compliance, build stability, and security warnings.
3. **Track Pipelines**: Monitors recent GitHub Actions workflows and flags recurring build failures.
4. **Centralize Vulnerabilities**: Aggregates Dependabot, Secret Scanning, and Code Scanning alerts in a unified, filterable finder.
5. **Detect Stale Work**: Highlights aged Pull Requests that require reviewer attention.

---

## ✨ Features

### 🔍 1. Flexible Repository Discovery
Supports five discovery scopes to query exactly the repositories you want to audit:
* **All Accessible Repositories**: Queries every repository accessible to the authenticated Personal Access Token.
* **GitHub Topic filter**: Audits repositories tagged with a specific topic (e.g., `production` or `platform-engineering`).
* **Team Slug selection**: Targets repositories associated with a specific GitHub Team.
* **Name Prefix matches**: Targets repos starting with a prefix (e.g. `microservice-` or `demo-`).
* **Manual List**: Input exact comma-separated repository names to query a custom list.

### 🛡️ 2. Automated Policy Compliance Audit
Audits 6 structural rules critical to supply-chain security:
- **Branch Protection**: Ensures the default branch has branch protection settings enabled.
- **Required Pull Request Reviews**: Verifies pull requests require approving reviews before merging.
- **Signed Commits**: Confirms signature verification is turned on for incoming commits.
- **CODEOWNERS configuration**: Verifies a valid `CODEOWNERS` file is declared in the root, `.github/`, or `docs/` folder to prevent unauthorized merges.
- **Strict Status Checks**: Assures branches must be up-to-date with testing suites before merging.
- **No Auto-Merge**: Recommends keeping auto-merge disabled to ensure human oversight.

### 📊 3. Composite Health Scoring
A dynamic scoring model evaluates each repository:
$$\text{Health Score} = (\text{Compliance} \times 0.4) + (\text{Pipeline Success Rate} \times 0.3) + (30 - \text{Alert Penalty})$$
* **Compliance Posture (40%)**: Percentage of compliance controls set up correctly.
* **Pipeline Build Stability (30%)**: Success rate of the last 10 workflow runs.
* **Zero Critical Alerts Guarantee (30%)**: Starts at 30 points, deducting **15 points** for each unresolved critical Dependabot or Secret Scanning alert (capped at 30-point deduction).

### 🖥️ 4. Premium Responsive Light UI
* **Frosted-Glass Navigation**: Navigation bar using backdrop blur effects.
* **Interactive KPI Cards**: Animated dashboard cards that scale and highlight on hover.
* **Responsive Layouts**: Flexible grids that reflow automatically to fit desktops, iPads, and mobile screen sizes.
* **Scrollable Data Tables**: Responsive table wrappers that scroll horizontally on small viewports instead of breaking layouts.
* **Clean Light Aesthetics**: Modern colors with clear indicator status lights (🔴/🟡/🟢) replacing cluttered visual badges.

---

## 🚀 Getting Started

### 📋 Prerequisites
* **Node.js** (v18.x or newer)
* **GitHub Personal Access Token (PAT)**: Requires read-only access for `contents`, `metadata`, `actions`, `security events`, `administration`, and `pull requests`.

### 💻 Installation

1. Clone or navigate into the project directory:
   ```bash
   cd github_governance
   ```

2. Install the package dependencies:
   ```bash
   npm install
   ```

3. Spin up the Vite development server:
   ```bash
   npm run dev
   ```

4. Open [http://localhost:5173](http://localhost:5173) in your browser.

---

## 🛠️ Codebase Structure

```
github_governance/
├── src/
│   ├── App.jsx         # Dashboard components, logic, and state views
│   ├── App.css         # Styling utilities and responsive classes
│   ├── index.css       # Global light-theme resets and scrollbar overrides
│   └── main.jsx        # React DOM render root entrypoint
├── index.html          # Main HTML entrypoint (loads Google Fonts)
├── vite.config.js      # Dev server settings & CORS Proxy configuration (/ghapi)
├── workflow.md         # In-depth architectural sequence & workflow charts
└── README.md           # This project guide
```

---

## 🔒 Security & Privacy Notice
All Personal Access Tokens (PATs) enterable in this application are stored **exclusively** in the browser's `sessionStorage`. They are never uploaded or saved to any database and are automatically wiped clean when the browser tab is closed.
