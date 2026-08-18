# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Primary users are engineers on a platform/DevOps team who run one shared instance of CodeAtlas for their whole engineering org. Through it, other engineers across the org browse generated documentation, triage flagged issues, and gate CI pipelines against scan results. The submitting/administering user (adding an app, configuring scan mode, schedules, webhooks) and the browsing user (reading the wiki, searching, viewing the dependency graph) are both engineers, but the former is closer to a platform-team operator and the latter can be any engineer trying to understand an unfamiliar codebase.

## Product Purpose

CodeAtlas statically scans a codebase (local path or git repo URL) and generates a structured documentation wiki — architecture, components, data dictionary, process flows, data model, security/quality issues, change log, setup — without requiring the scanned app's own team to write or maintain that documentation by hand. Success looks like an engineer unfamiliar with a service being able to get oriented from the generated wiki alone, and a platform team being able to gate CI on newly introduced Critical/High issues.

## Positioning

CodeAtlas earns its documentation from real static analysis rather than asking an LLM to summarize a repo from scratch: a real parser (TypeScript compiler API) for JS/TS, multi-framework route tracing (Express, Flask, FastAPI, Go, Rails, Spring, Laravel) with step-by-step handler traces, schema/model detection across four ORM/DB conventions, and CODEOWNERS/git-blame-based ownership attribution. An optional "deep scan" mode layers an LLM enrichment pass on top of those verified facts (explicitly instructed not to invent beyond them) rather than replacing the static pass. Incremental content-hash caching and per-scan diffing mean rescans are fast and changes are tracked over time, not just a fresh snapshot each run.

## Operating Context

- Run as one shared instance a platform/DevOps team operates for its engineering org (not a personal single-user tool) — the durable deployment model is expected to grow toward multi-tenancy/auth (multiple teams or orgs, logged-in users with permissions) rather than staying a single trusted-network instance indefinitely. This is a forward-looking constraint, not yet built: today's implementation is a single JSON-file store (`data/apps.json`) with no auth or org boundaries.
- Two entry points into the same scan engine: the web UI (persistent app records, live SSE progress, history, scheduling, webhooks) and a headless CLI (`cli.js`) for CI gating, which exits non-zero on issues at/above a configured severity.
- A scan writes its wiki to a `/wiki` folder inside the *scanned* application's own directory, not inside CodeAtlas — CodeAtlas is a generator/viewer, not the system of record for the docs it produces.
- Two scan modes: Static (default, no network calls except optional `git clone`/`npm audit`) and Deep (opt-in, shells out to a local `claude` CLI once per scan, falls back silently to static-only on failure/timeout).
- Auto-rescan scheduling (off/hourly/daily/weekly) and Slack-compatible webhook notification on new Critical/High issues are both opt-in per app.
- Triage state (acknowledged/false-positive/fixed) and data-dictionary field overrides persist across rescans and are keyed by an app's id, so the same repo scanned via the web UI vs. the CLI is currently tracked as two separate apps.

## Capabilities and Constraints

- JS/TS/JSX/TSX gets real AST-based extraction; every other supported language (Python, Go, Ruby, Java, PHP, ...) uses regex heuristics.
- Process-flow traces are deep (branches, error handling, DB calls, status codes) for Express, Go, Java, PHP; shallow (method/path/handler only) for Flask/FastAPI and Rails.
- Live dependency vulnerability checking only covers npm (via `npm audit`); other ecosystems fall back to a small built-in advisory list.
- Dead-code detection only follows JS/TS `import`/`require` and Python `import` — references from `<script>` tags or `package.json` `bin`/`scripts` entries aren't seen.
- Dependency graph view uses a simple circular layout, not force-directed — legible at typical scan sizes, cluttered on very large repos.
- No email/SMTP notification path exists or is planned to be built/tested in this environment; webhook notifications are the supported channel.
- Deployment/auth model is an explicitly open, forward-looking gap: today single-instance/no-auth, intended to grow toward multi-tenant/auth. Treat this as undecided product surface, not a confirmed spec, until scoped.

## Brand Commitments

The name "CodeAtlas" is fixed. Brand color palette — committed as the product's brand colors going forward: `#264653`, `#2a9d8f`, `#e9c46a`, `#f4a261`, `#e76f51` (dark teal → teal → yellow → orange → red-orange). This replaces the earlier single-hue navy commitment. No other voice or brand assets are committed yet — open for future design work.

Implemented in `public/styles.css`: each of the five brand hues owns exactly one semantic role, mapped along the palette's own dark-teal→red-orange ramp so it reinforces the severity/status ramp the product already relies on rather than being decorative — dark teal is the primary accent (`--accent-text` / `--accent-surface`: links, buttons, focus rings, the wordmark), teal is `--ok` (Done status, passing CI gate), yellow is `--warn` (Scanning status, Medium severity), orange is `--sev-high` (High severity, Production environment — the existing "elevated stakes" role), and red-orange is `--err` (Critical severity, Failed status). `--info` (Low severity, Staging environment, calm status notes) has no brand hex of its own; it's a derived cyan-teal sitting between the accent and Ok hues, staying inside the palette's family rather than reusing the old blue.

Saturation was deliberately capped (~42–50%, vs. the raw brand hexes' own 37–87%) and contrast headroom brought closer to the 4.5:1 AA floor rather than pushed for extra vividness — a quieter pass after the initial migration read as too saturated for an Operate-mode tool used all day. Light-mode text/icon values: `--accent-text` `#38728a`, `--accent-surface` `#3e7e98`, `--ok` `#28776d`, `--warn` `#82692b`, `--sev-high` `#955e32`, `--err` `#ac5039`, `--info` `#2b7582`. Dark-mode: `--accent-text` `#4790ae`, `--accent-surface` `#3e7e98` (same value in both themes now — one consistent button color rather than a saturation bump for dark mode), `--ok` `#329589`, `--warn` `#a48537`, `--sev-high` `#bf7840`, `--err` `#c8705b`, `--info` `#3794a4`. Every text/badge-background pair is still verified ≥4.5:1 (WCAG AA) via scripted contrast checks against its actual panel/canvas/bg background in both themes. Stat tiles that tint by status (dashboard) dropped their colored border in the same pass — a colored border plus a tinted background plus a colored number was three simultaneous signals for one fact; the tinted background and colored value carry it alone now. Neutral chrome (`--bg`, `--panel`, `--inset`, `--border`, `--text`, `--muted`, `--badge-neutral-bg`, `--chip-bg`) remains untouched.

## Evidence on Hand

None. No existing testimonials, case studies, customer names, or benchmark data — future work must not fabricate any.

## Product Principles

- Trust comes from provenance: every doc and finding traces back to a real parse or pattern match on the actual code, not an LLM guessing from a prompt. Deep mode enriches verified facts; it never replaces them.
- Treat all generated content as a fast first pass, not a certified audit — the product's own generated wiki carries this disclaimer, and the design should not oversell confidence in findings.
- Incremental and diffable by default: caching and change-log diffing mean the product should always answer "what changed since last time," not just "what's true now."
- Serve two very different sessions well: a platform-team operator configuring/triaging across many apps, and any engineer dropping in to read one app's wiki to get oriented fast.
