# CodeAtlas

A codebase scanner that generates a documentation wiki for any application, plus a small web UI (and a CI-friendly CLI) for triggering scans and browsing the results.

## What it does

1. You submit an application (a local path or a git repo URL) through the web form or the CLI, along with high-level info: purpose, owner/team, environment, tech stack, notes, and optionally a "deep scan" toggle.
2. CodeAtlas walks the target codebase directory-by-directory (splitting oversized directories into subdirectories automatically, and treating each sub-package of a monorepo as its own independent scan):
   - maps the folder structure and detects the tech stack / entry points
   - extracts functions, classes, and imports per file — a real parser (the TypeScript compiler API) for JS/TS/JSX/TSX, regex heuristics for everything else
   - detects data models/schemas (SQL `CREATE TABLE`, Prisma, Mongoose, Django models, TypeORM entities) and builds data dictionaries
   - detects HTTP routes across Express, Flask, FastAPI, Go (Gin/Echo/net-http), Rails, Spring, and Laravel, with a heuristic step-by-step trace for each one where the handler body can be located
   - flags likely security/quality issues (hardcoded secrets, SQL injection risk, eval/Function usage, unresolved TODOs, possible dead code) — string-literal and comment content is masked out first so a finding's own description text can't trigger itself
   - checks dependencies against `npm audit`'s live registry data when available, falling back to a small built-in advisory list otherwise
   - only reprocesses files that actually changed since the last scan (content-hash cache), and diffs each scan's issues/routes/models against the previous one
   - flags high-entropy string literals (possible tokens/keys not caught by keyword matching) alongside the keyword-based secret check, using a shared tokenizer so neither is fooled by quote characters nested inside a regex literal or a template string
3. It writes the results to a `/wiki` folder at the root of the *scanned* application (not inside CodeAtlas), following the structure: `Home.md`, `Architecture.md`, `Components/`, `Data-Dictionary/`, `Process-Flows/`, `Data-Model.md`, `Issues.md`, `Change-Log.md`, `Setup.md`, `Progress.md`.
   - attributes each file to an owner: a matching CODEOWNERS rule first (`.github/CODEOWNERS`, `CODEOWNERS`, or `docs/CODEOWNERS`), falling back to the most frequent git committer for that file (capped per scan so a repo with no CODEOWNERS file doesn't turn into hundreds of `git log` spawns)
5. The web UI shows scan status (Not Started / Scanning / Queued / Done / Failed) live — Server-Sent Events stream real progress messages while a scan runs, rather than waiting on a poll — and lets you browse the generated wiki, plus several interactive views that go beyond the static markdown:
   - **Issues** — mark a finding acknowledged/false-positive/fixed, assign it to a person or team, and (if a tracker is configured for the app) push it straight to GitHub Issues or Jira; dismissed findings drop out of the active count and CLI severity gating on every future scan until reopened. File paths and long summaries are truncated inline with the full text one click away, so a heavily-flagged app's Issues table doesn't force horizontal scrolling.
   - **Data Dictionary** — edit a field's description inline; your text takes priority over deep-scan prose and auto-detected placeholders, and survives rescans
   - **Env Vars** — same inline-edit-and-persist pattern as the Data Dictionary, applied to the env var names the scanner found referenced in code (Setup tab); values are never shown, only what each one is for
   - **Dependency Graph** — a hand-rolled SVG view of the resolved file import graph, click a node to highlight its edges; export the current view as a standalone SVG or PNG for docs/tickets
   - **History** — stats for every past scan, plus a line chart of issue/route counts over time and a picker to diff any two past scans against each other (not just the latest against the one before it)
   - **Search** — live full-text search across the generated wiki
   - **Export** — bundle one app's wiki into a portable static HTML site, or push it to the repo's companion Wiki repo (`<repo>.wiki.git` — GitHub and GitLab both use this convention) via your own git credentials

   The app list can be filtered by environment, owner, or a free-text search over name/tags — every app can carry free-form tags set at submission time, and clicking the Name/Environment/Status column headers sorts the table. Environment is free text with autocomplete against values already in use (not locked to a fixed set); Owner/Team is validated against a small saved registry (add/remove entries from "Manage Owners" on the form panel) so the same team doesn't end up spelled three different ways across apps. Apps can be registered a dozen at a time via "Bulk Import" (one path/repo per line, or CSV rows with environment/owner/tags), and retired via "Archive" — hidden from the default list and every portfolio rollup below without deleting its scan history, reversible at any time.

   An app can also be put on an auto-rescan schedule (hourly/daily/weekly, off by default), given a webhook URL (Slack-compatible payload) that fires when a scheduled or manual rescan turns up new Critical/High severity issues, and separately opted into a weekly digest — a periodic "N new, M resolved" rollup to that same webhook regardless of whether a scan happened to run in the window. Rescans go through a small concurrency-capped queue (2 at a time); anything beyond that shows as "Queued" instead of "Scanning" until a slot frees up, with a queue banner on the dashboard while anything is active or waiting. The Deep Scan checkbox shows a rough pre-scan cost estimate (file count/size — a proxy for the enrichment prompt's size, not an exact token count) before you commit to it.

   The CLI exits non-zero when active (non-dismissed) issues at/above a configurable severity are found — for gating a pipeline; that same threshold is also settable per app from the UI (detail panel, "CI Gate Severity"), with a live "Would PASS/FAIL CI" readout against the latest scan.

   Above the app list, a **Portfolio Overview** dashboard aggregates across every non-archived app: total apps, active issues by severity, environment breakdown, and which apps haven't been scanned in >14 days (or never). From there: **View All Issues** opens every open/acknowledged issue across every app in one filterable, severity-sorted table; **View Tech Stack** groups apps by shared framework/dependency (combining the free-text Tech Stack field with whatever the scanner auto-detected) — useful for planning a shared version upgrade; **Compare Two Apps** shows two apps side by side (stats, severity breakdown, tech stack) with differing rows highlighted, for spotting drift between similar services; and **Export Portfolio Static Site** bundles every app's wiki into one combined static site with a summary index page, instead of exporting each app separately.

**Scan modes:**
- **Static** (default) — pattern-based only, no network calls except an optional `git clone` and `npm audit`. Fast, free, repeatable.
- **Deep** (opt-in) — after the static pass, shells out to your local `claude` CLI once to turn the verified static facts (routes, models, tech stack) into plain-language prose for the purpose paragraph, an architecture narrative, and data-dictionary field descriptions. It's told not to invent facts beyond what static analysis found. Slower, uses your Claude usage, and silently falls back to static-only output if the CLI call fails or times out.

Treat all generated prose and issue findings as a fast first pass, not a certified audit — see a scanned app's own `wiki/Home.md` for the disclaimer it stamps on generated docs.

## Running locally

```
npm install
npm start
```

Then open http://localhost:4173 (override with `PORT=xxxx npm start`).

### CLI / CI usage

```
node cli.js <path-or-repo-url> [--fail-on=Critical|High|Medium|Low] [--deep] [--json]
```

Runs a scan headlessly (no server, no JSON data store) and exits `1` if any issue at/above `--fail-on` (default `Critical`) was found — for gating a pipeline. `--json` prints a machine-readable summary instead of progress text. Also available as `npm run scan -- <path>`.

## Project layout

- `server.js` — Express entry point, serves the frontend, mounts the API, starts the scheduler
- `cli.js` — headless CLI entry point for CI/scripted use
- `src/scanRunner.js` — shared "run a scan for this stored app" glue (used by both the API route and the scheduler)
- `src/scheduler.js` — in-process poller for opt-in auto-rescans
- `src/routes/apps.js` — REST API: CRUD for scanned-app entries, scan trigger + live progress stream, wiki/history/export viewers, plus every portfolio-wide route (dashboard, cross-app issues, tech stack, compare, scan queue, portfolio export)
- `src/routes/browse.js` — server-side folder browser for the path picker, plus the Deep Scan cost-estimate endpoint
- `src/routes/owners.js` — CRUD for the saved Owner/Team registry
- `src/store/db.js` — JSON-file-backed store (`data/apps.json`) for submitted app metadata
- `src/store/owners.js` — JSON-file-backed store (`data/owners.json`) for the saved Owner/Team registry apps are validated against
- `src/scanner/` — the scan engine:
  - `structure.js` — tech stack, entry points, directory tree, monorepo sub-package detection
  - `components.js` — AST-based (TS compiler API) JS/TS extraction, regex fallback for other languages
  - `dataLayer.js` — schema/model detection (SQL, Prisma, Mongoose, Django, TypeORM)
  - `processFlows.js` — route detection + heuristic step traces across 7 frameworks
  - `issues.js` / `mask.js` / `npmAudit.js` — security/quality findings (keyword + entropy-based secrets, injection risk, dead code), shared string/comment/regex-literal tokenizer, live dependency audit
  - `graph.js` — resolved import graph (shared resolution logic with dead-code detection)
  - `cache.js` — incremental rescan cache (content-hash keyed)
  - `history.js` — scan snapshots + diffing for Change-Log.md and the History-tab scan-vs-scan diff picker
  - `triage.js` — persisted issue triage state (acknowledged/false-positive/fixed), assignee, and external-tracker link
  - `dictionaryOverrides.js` — persisted human-edited data-dictionary field descriptions
  - `envVarOverrides.js` — persisted human-edited env var descriptions (Setup tab)
  - `trackerLink.js` — pushes a single issue to GitHub Issues or Jira via their REST APIs
  - `digest.js` — opt-in weekly summary rollup, independent of the on-completion webhook
  - `scanQueue.js` — in-process concurrency-capped scan queue (2 at a time); anything beyond that sits as "Queued"
  - `exportPortfolio.js` — combined static-site export across every app, reusing `exportSite.js` per app plus a summary index page
  - `wikiSearch.js` — live full-text search over a scanned app's wiki files
  - `ownership.js` — CODEOWNERS parsing + git-blame fallback for per-file ownership
  - `progressBus.js` — in-memory pub/sub feeding the live scan-progress SSE stream
  - `notify.js` — webhook notification when a scan surfaces new Critical/High issues
  - `exportSite.js` / `exportGithubWiki.js` / `markdownToHtml.js` — static-site export and Wiki-repo push
  - `deepMode.js` — optional LLM-assisted enrichment pass
  - `wikiWriter.js` — assembles every wiki page
  - `index.js` — orchestrator (`runScan`)
- `public/` — plain HTML/CSS/JS frontend (no build step)

## API

### Apps

- `GET /api/apps` — list all submitted apps (excludes archived; `?includeArchived=true` to include them)
- `POST /api/apps` — add an app `{ name, pathOrRepo, purpose, owner, environment, techStack, notes, tags, scanMode, scheduleMinutes, notifyWebhookUrl, failOnSeverity, digestEnabled, trackerType, trackerBaseUrl, trackerProjectOrRepo, trackerEmail, trackerToken }` (`scanMode: "deep"` to opt into LLM-assisted enrichment; `scheduleMinutes` in `{0, 60, 1440, 10080}` for off/hourly/daily/weekly auto-rescan; `owner` must match an entry in the saved Owners list if non-blank; `failOnSeverity` in `{Critical, High, Medium, Low}`, defaults `Critical`)
- `POST /api/apps/bulk` — register several apps at once `{ text }`, one per line — either a bare path/repo, or a CSV row `name,pathOrRepo,environment,owner,tags`; returns `{ created, errors }` so a partially-bad paste doesn't silently drop apps
- `PATCH /api/apps/:id` — update any of the above fields (including `archived: true|false`) on an existing app
- `GET /api/apps/:id` — get one app (works for archived apps too — only the list endpoint filters them out)
- `DELETE /api/apps/:id` — remove an app entry
- `POST /api/apps/:id/scan` — trigger a scan; goes through the scan queue (2 concurrent max) so status becomes `"Scanning"` immediately or `"Queued"` if all slots are busy
- `GET /api/apps/:id/scan-stream` — Server-Sent Events stream of live progress messages while a scan is running

### Portfolio-wide

- `GET /api/apps/dashboard` — rollup across all non-archived apps: issue counts by severity, apps by status/environment, apps not scanned in >14 days
- `GET /api/apps/issues` — every issue across every non-archived app, each tagged with `appId`/`appName`, merged with triage state
- `GET /api/apps/tech-stack` — apps grouped by shared framework/dependency (free-text `techStack` field + scanner-detected frameworks/ecosystems)
- `GET /api/apps/compare?a=<id>&b=<id>` — side-by-side summary (stats, severity breakdown, tech stack) for two apps
- `GET /api/apps/scan-queue` — current scan concurrency: `{ active, maxConcurrent, queued: [{ id, name, position }] }`
- `POST /api/apps/export/portfolio-static-site` — bundle every non-archived app's wiki into one combined static site (each under its own slug subfolder) plus a summary `index.html`, under `data/portfolio-export/`

### Per-app resources

- `GET /api/apps/:id/wiki-file?path=Home.md` — read a file out of the scanned app's generated wiki
- `GET /api/apps/:id/history` — compact stats for every past scan of this app, newest first
- `GET /api/apps/:id/history/diff?from=<scannedAt>&to=<scannedAt>` — diff any two of this app's past scans (new/resolved issues, new/removed routes, added/removed models) — not just the latest against the one before it
- `GET /api/apps/:id/issues` — latest scan's issues merged with triage state (state, note, assignee, external tracker link)
- `POST /api/apps/:id/issues/triage` — set triage state `{ fingerprint, state: "open"|"acknowledged"|"false_positive"|"fixed", note? }`
- `POST /api/apps/:id/issues/assign` — set or clear an issue's assignee `{ fingerprint, assignee }`, independent of triage state
- `POST /api/apps/:id/issues/push-to-tracker` — push a single issue to the app's configured tracker `{ fingerprint }`; requires `trackerType` to be `"github"` or `"jira"` on the app
- `GET /api/apps/:id/models` — latest scan's data models/fields merged with description overrides
- `POST /api/apps/:id/models/override` — set a field description override `{ modelName, fieldName, description }` (empty description clears it)
- `GET /api/apps/:id/env-vars` — env vars the scanner found referenced in code, merged with description overrides
- `POST /api/apps/:id/env-vars/override` — set an env var description `{ name, description }` (empty description clears it)
- `GET /api/apps/:id/graph` — resolved import graph `{ nodes, edges }`
- `GET /api/apps/:id/wiki-search?q=term` — full-text search across the generated wiki
- `POST /api/apps/:id/export/static-site` — bundle the wiki into a portable static HTML site under `<appRoot>/wiki-static-site/`
- `POST /api/apps/:id/export/github-wiki` — push the wiki to `<repo>.wiki.git` (`{ dryRun: true }` to commit locally without pushing); only valid for apps submitted as a repo URL

### Owners

- `GET /api/owners` — list the saved Owner/Team registry
- `POST /api/owners` — add an owner `{ name }` (de-duplicated, case-insensitive)
- `DELETE /api/owners/:name` — remove an owner

### Browse

- `GET /api/browse?path=` — server-side directory listing for the path picker (drives only when `path` is omitted)
- `GET /api/browse/estimate?path=` — rough Deep Scan cost estimate for a local path: source file count/size and an approximate enrichment-prompt token count and call duration (not available for a repo URL until it's cloned)

## Known limitations

- JS/TS/JSX/TSX use a real parser; every other language (Python, Go, Ruby, Java, PHP, ...) still uses regex heuristics — unusual formatting can be missed there.
- Process-flow traces are deepest for Express, Go, Java, and PHP (branches, error handling, DB calls, status codes, via brace-matching); Python (Flask/FastAPI) and Ruby (Rails) traces are shallow (method/path/handler only) since their handlers aren't brace-delimited or live in a separately-referenced controller file.
- `npm audit` needs network access to the npm registry; other ecosystems (pip, go, etc.) have no live vulnerability check and aren't covered by the small built-in advisory list either.
- Dead-code detection resolves real relative-import paths (including `index.js`/`__init__.py` fallback) but only understands JS/TS `import`/`require` and Python `import` — it doesn't see references from HTML `<script>` tags, a `package.json` `bin`/`scripts` entry, or other non-import consumption, so a file only reached that way can be misflagged.
- Deep scan mode requires the `claude` CLI installed and authenticated on the machine running the scan; it makes one enrichment call per scan and times out after 90s, falling back to static-only output on any failure.
- Monorepo sub-package detection looks for a manifest directly inside a top-level directory, or one level under `packages/`, `apps/`, `services/`, `libs/`, or `modules/` — other layouts won't be recognized as a monorepo.
- Triage state, data-dictionary overrides, and the dependency graph are all keyed by an app's id; a repo scanned once through the web UI and once through the CLI gets two separate ids (a real UUID vs. a hash of the path/URL), so triage/overrides set on one side won't show up on the other.
- The entropy-based secret check only looks at single/double-quoted string literals (not template literals, since interpolation makes "random-looking" unreliable) and is Medium severity by design — it has a real false-positive rate on legitimate hashes/IDs, so treat it as a hint to investigate, not a confirmed finding.
- The directory walk skips a fixed list of generated/vendored folder names (`node_modules`, `dist`, `build`, `coverage`, `data`, `graphify-out`, ...) by name only, at any depth — a scanned app with its own legitimately-named `data/` folder (or any other name on the list) has that content skipped entirely, including by the secret scanner. This trades a small amount of real coverage for not flooding results with a tool's own generated output (this app's own `data/` directory, or a `graphify-out/` from the graphify skill, are the common case).
- The dependency graph view lays nodes out in a simple circle, not a force-directed layout — legible for the tens of files a typical scan produces, but a very large repo's graph will look cluttered.
- Wiki search does a live, unindexed read of every `.md` file on each query — fine for a generated wiki's normal size, but there's no caching if you're hammering it.
- Long-running subprocess calls (`npm audit`, the `claude` CLI, `git clone`) run asynchronously so the server stays responsive to other requests during a scan — but the bulk file-read/parse loop itself is still synchronous, so a very large repo's scan can briefly block other requests during that phase. Not an issue at the file counts this scanner is meant for.
- The scheduler is a `setInterval` poll inside the same Node process as the server — it stops when the server stops, and its per-app "auto-rescan" clock is anchored to `scannedAt`, not wall-clock time-of-day (so "daily" means "24h since the last scan finished," not "every day at a fixed time").
- Webhook notifications use a `{ text }` JSON payload (works directly as a Slack incoming webhook); other chat tools may need a different shape. There's no email/SMTP notification path — no mail server is available in this environment to build or test one against honestly.
- GitHub Wiki push flattens nested pages into `Dir-File.md` names and rewrites internal links to match, but it fully overwrites the wiki repo's tracked files on every push (except `.git`) — anything added directly in the GitHub wiki UI outside of a CodeAtlas export will be lost on the next push.
- CODEOWNERS wildcard matching (`*`, `**`, anchored `/`, directory `/` suffix) is a pragmatic approximation of the GitHub spec, not a byte-for-byte reimplementation — it's been checked against the common cases (unanchored, anchored, directory, later-rule-wins precedence) but edge cases in obscure pattern combinations may differ from GitHub's own resolution.
- The GitHub/Jira tracker integration stores the API token/PAT in `data/apps.json` as plain text (same as the webhook URL) — this is a local single-user tool, not a secrets manager; don't point it at a token with more access than you're comfortable having sit in a JSON file on disk.
- The scan queue's concurrency cap (2 at a time) is hardcoded, not configurable per deployment.
- Owner/Team validation is a small local saved list (`data/owners.json`), not a real directory/SSO integration — it only prevents free-text drift within this one CodeAtlas instance.
- Tech stack sharing and the env var descriptions tool both read frameworks/ecosystems/env-vars off the *latest scan snapshot* — an app scanned before this data started being persisted needs one rescan before it shows up in either.
- Cross-app views (dashboard, All Issues, Tech Stack, Compare, portfolio export) all exclude archived apps and read from each app's most recent snapshot independently — there's no cross-app consistency check if apps were scanned at very different times.
