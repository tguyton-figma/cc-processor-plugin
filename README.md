# cc-processor

A Figma plugin for authoring, validating, and publishing **Code Connect** templates at
scale. It walks a set of components through a linear, dependency-ordered pipeline —
from Figma platform setup, to scoping components, to generating a machine-readable
contract for each, to producing a Code Connect template file (either by hand or via an
optional AI transform), validating it against a live rule engine, and publishing the
result into Figma Variables.

The plugin is **backend-agnostic**: the core workflow runs entirely inside Figma. An
optional backend can be configured to enable AI template generation and a
server-relayed Variables publish, but nothing is hardcoded to a specific service — see
[docs/backend-integration.md](docs/backend-integration.md).

---

## What it does

Code Connect links a Figma component to its real code component, so a designer
inspecting a component in Dev Mode sees the exact code snippet a developer would use.
Authoring those links by hand across a large library is tedious and error-prone.
cc-processor turns it into a repeatable pipeline with validation at every step.

### The 7-stage pipeline

| # | Stage | What it does |
|---|-------|--------------|
| 1 | **Environment** | Set and validate the core Figma connection: target file key + a REST API token. Everything downstream builds on this. |
| 2 | **Components** | Choose exactly which component sets are in scope for this run. |
| 3 | **Contracts** | For each scoped set, extract its property surface (variants, booleans, text, instance swaps, defaults) into a versioned, machine-readable contract. |
| 4 | **Transform** *(optional)* | Send a contract to a configured backend and stream back a Code Connect template. Skipped when no backend is connected. |
| 5 | **Templates** | The finished Code Connect template lands here — from stage 4, or pasted in by hand. An in-panel editor with live validation signals. |
| 6 | **Validate** | Run the template through the built-in rule engine (structural + semantic checks) and surface findings. |
| 7 | **Publish** | Templates that pass are written into Figma Variables — the durable, team-shared, machine-readable home for the output. |

Re-running any stage automatically invalidates the downstream stages for that
component, so saved state never drifts out of sync with its inputs.

---

## Installing the plugin in Figma

This repo ships the built plugin artifacts (`code.js`, `ui.html`) alongside the source,
so you can load it directly:

1. In **Figma Desktop**, open **Menu → Plugins → Development → Import plugin from
   manifest…**
2. Select this repository's `manifest.json`.
3. The plugin appears under **Plugins → Development → cc-processor**. Run **Open
   cc-processor** to launch it.

The plugin works in both **Design** and **Dev Mode**.

> If you change any source under `code.ts` / `src/`, rebuild before reloading — see
> [Building](#building-from-source).

---

## Configuring

All configuration lives in the plugin's **Environment** view (stage 1). Credentials are
stored securely and never travel to other collaborators.

| Setting | Required | What it is | Stored as |
|---------|----------|------------|-----------|
| **File key** | Yes | The key of the Figma file this run targets (paste the file URL and it collapses to the key). | document pluginData |
| **REST API PLANT** | Yes | A Figma personal access token used for REST reads and the Dev Mode Variables publish. Validated against `api.figma.com`. | document pluginData (value never re-sent to the UI) |
| **CLI PLANT** | Optional | A token used to publish a downloaded template package via the Figma CLI (`figma connect publish`). A PLANT works for `publish`/`unpublish`; other CLI commands need a PAT — see below. | document pluginData |
| **Backend** | Optional | The origin + OAuth surface of a backend that provides the AI transform (stage 4) and/or server-relayed publish. See below. | document pluginData (non-secret) + clientStorage (per-user tokens) |

### Code Connect CLI tokens

A downloaded package is published with the Figma Code Connect CLI, which reads its
token from `FIGMA_ACCESS_TOKEN`. The `figma connect` commands don't accept the two
token types interchangeably:

- **PLANT** (project-scoped) works for `figma connect publish` and
  `figma connect unpublish`.
- Other commands (`figma connect preview`, `create`, `parse`) reject a PLANT with
  `403: Invalid Token Type` and require a **PAT** (personal access token) with Code
  Connect write scope.

If a command fails with `403: Invalid Token Type`, re-export `FIGMA_ACCESS_TOKEN`
with a PAT and re-run. Keep the CLI current with
`npm install @figma/code-connect@latest` (the downloaded package's own README
repeats this for whoever publishes it).

### Optional backend

Stage 4 (AI transform) and the server-relayed publish path are opt-in. To enable them,
configure a backend in **Environment → Backend → Advanced** (base URL, and route/slug
overrides if needed) and connect over OAuth.

Two things are required for a backend to work:

1. Its origin **must** be listed in `manifest.json` → `networkAccess.allowedDomains`
   (Figma reads this at publish time; there is no runtime API to add a domain).
2. It must implement the integration contract in
   [docs/backend-integration.md](docs/backend-integration.md).

The manifest ships with a reference backend origin already allowlisted. To point the
plugin at your own backend, add your origin to `allowedDomains`, rebuild, and set it as
the backend base URL.

---

## Building from source

Requires **Node.js** (18+) and npm.

```bash
npm install          # install dependencies
npm run build        # bundle code.js (main thread) + inline ui.html (UI)
```

- `npm run build` — full build: bundles `code.ts` → `code.js` and inlines the UI
  bundle into `ui.html`. Run this after any change under `code.ts` or `src/`.
- `npm run build:ui` — rebuild only the inlined `ui.html` (after `src/ui/**` changes).
- `npm run typecheck` — type-check without emitting.
- `npm test` — run the validation-engine test suite.

`code.js` and `ui.html` are generated artifacts committed to the repo so the plugin can
be imported without a build step. Never hand-edit them — edit `code.ts` / `src/**` and
rebuild.

---

## Project layout

```
manifest.json          Figma plugin manifest (entry points, network allowlist)
code.ts                Main-thread orchestrator (source) → bundles to code.js
ui.html                Plugin UI (generated; UI source lives in src/ui/**)
src/
  pipeline/            Pure, dependency-free pipeline core (stages, state, cascade)
  run/                 Main-thread run-state manager (persist + invalidation cascade)
  engine/              Code Connect validation engine (parse, rules, structural checks)
  variables/           The published-output store — sole owner of the Figma Variables API
  workspace/           Per-component working artifacts (contracts, drafts, findings)
  transformer/         Backend profile: connection + feature routes (see profile.ts)
  editor/              CodeMirror editor wrapper
  ui/                  UI layer (pipeline shell, backend client, icons, packaging)
tests/                 Validation-engine unit tests + Code Connect fixtures
docs/                  Architecture + backend-integration documentation
.figma/make/           Local dev harness (dev server, UI build, browser mock)
```

See [docs/architecture.md](docs/architecture.md) for how the pieces fit together.

---

## Testing

```bash
npm test
```

The suite exercises the validation engine — the parser, the rule registry, structural
and semantic checks, contract building, and template packaging — against a library of
Code Connect fixtures in `tests/fixtures/`.
