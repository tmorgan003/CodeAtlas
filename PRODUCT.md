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

The name "CodeAtlas" is fixed. Brand hue: navy blue — committed as the product's brand color going forward (the exact token value/tints are a design-implementation decision made in code/DESIGN.md, not fixed here). No other voice or brand assets are committed yet — open for future design work.

Implemented: the accent role is navy (hue ~221°) in `public/styles.css`, split into two tokens since one hex can't satisfy both roles' contrast needs at once — `--accent-text` (links, focus rings, the "Atlas" wordmark; `#152547` light / `#5c83d6` dark) and `--accent-surface` (button fills, checkbox tick; `#152547` light / `#3762be` dark). Both meet 4.5:1+ in light mode; dark mode clears 4.5:1 on `--accent-surface` (5.75:1 white-on-it) and 4.5:1+ on `--accent-text` (4.70:1 vs. panel) — the pre-existing single-token dark-mode gap (was 4.17:1) is resolved.

## Evidence on Hand

None. No existing testimonials, case studies, customer names, or benchmark data — future work must not fabricate any.

## Product Principles

- Trust comes from provenance: every doc and finding traces back to a real parse or pattern match on the actual code, not an LLM guessing from a prompt. Deep mode enriches verified facts; it never replaces them.
- Treat all generated content as a fast first pass, not a certified audit — the product's own generated wiki carries this disclaimer, and the design should not oversell confidence in findings.
- Incremental and diffable by default: caching and change-log diffing mean the product should always answer "what changed since last time," not just "what's true now."
- Serve two very different sessions well: a platform-team operator configuring/triaging across many apps, and any engineer dropping in to read one app's wiki to get oriented fast.
