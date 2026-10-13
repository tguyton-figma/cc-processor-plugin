# Architecture

cc-processor is organized around a **linear 7-stage pipeline**. Each stage depends on
the one before it, and re-running a stage automatically invalidates everything
downstream of it. This document explains the state model, storage, module layout, and
the published-output schema.

## Mental model

The UI is a two-pane shell: a left **Nav** rail of the 7 stage icons (top → bottom,
showing rollup status) and a **Main** working pane that renders the selected stage.

The 7 stages, and whether each operates at the run level or per component:

| # | Stage | Scope | Summary |
|---|-------|-------|---------|
| 1 | Environment | run | Core Figma connection (file key + REST token) set and validated. |
| 2 | Components | run | Choose which component sets are in scope. |
| 3 | Contracts | per-component | Extract each set's property surface into a versioned contract. |
| 4 | Transform | per-component | *(Optional)* Turn a contract into a template via a backend. |
| 5 | Templates | per-component | The finished template file (from stage 4 or pasted by hand). |
| 6 | Validate | per-component | Run the template through the rule engine; surface findings. |
| 7 | Publish | per-component | Write passing templates into Figma Variables. |

## State model

State is kept in two tiers:

- **Run-level (one per file):** whether the platform is ready (stage 1), the scoped set
  of component references (stage 2, keyed by **component key** so it survives node
  move/rename), and config (tokens, optional backend profile).
- **Per-component record (stages 3–7):** a status per stage
  (`pending · active · done · failed · blocked · skipped`), pointers to that component's
  artifacts (contract → template → findings → published), and any last-error /
  block-reason for the UI to surface.

### Invalidation cascade

- Re-running stage N for a component resets its stages N+1..7 to `pending`.
- Re-validating stage 1 invalidates **all** components (everything builds on the
  platform).
- Removing a set from scope drops its record.
- `blocked` means an upstream stage isn't satisfied yet; `skipped` means the optional
  transform stage has no backend connected.

This cascade is the core guarantee: saved work can never be inconsistent with the inputs
that produced it.

## Storage

The plugin uses three Figma storage surfaces, each chosen deliberately:

| Data | Store | Why |
|------|-------|-----|
| **Published template files** (the deliverable) | **Figma Variables** | Durable, team-shared, travels with the file; a machine-readable public database readable by the panel, plugins, REST, and MCP. |
| Contracts, draft templates, findings | **root pluginData** (per component) | Intermediate working artifacts; kept off the Variables panel. |
| Run + per-component status | **root pluginData** (one JSON blob) | Cheap to read and render the whole Nav; travels with the file. |
| Backend profile (non-secret: base URL, routes) | **document pluginData** | A team standardizes on one backend; travels with the file. |
| Backend OAuth refresh token | **clientStorage** (per user) | User identity, not document data — must never travel to collaborators. |

### Published-output schema (Variables)

The published output is stored as **one flat collection per library, using variable
groups** (the `/` naming the Variables panel renders as folders):

- **One collection = one library**, single mode. It's tagged as ours via the
  collection's shared plugin data (kind + library id + schema version), so the
  collection contains nothing but template files and other tools can discover it.
- **One variable = one template file**, named `<component set>/<label>` (e.g.
  `Button/web`, `Card/ios`). The prefix is the group (component); the leaf is the label.
- **Groups are derived, never stored** — a group exists as long as it has at least one
  variable.
- **Identity lives inside the file.** The authoritative addressing (node id, component
  key, file URL) is in the Code Connect metadata comments inside the template itself, so
  variable names are free to be human-friendly display text; a rename is cosmetic.

**Atomicity:** Figma has no cross-variable transaction, so the atomic unit is a single
`setValueForMode`. Storing one whole file as one variable value means every save is
inherently atomic — a consumer reads a whole file or the previous whole file, never a
half-written one. This is why a file is never split across multiple variables.

## Module layout

The code is split so the pure logic has no Figma dependency and the Figma API has a
single owner per concern.

- **`src/pipeline/`** — the pure, dependency-free core: stage definitions, the state
  shape, the status enum, derived `blocked`, the invalidation cascade, rollup, and
  tolerant serialize/parse. No Figma API.
- **`src/run/`** — the main-thread run-state *manager*: reads/writes the run-state blob
  and performs the cascade side effects the pure core can't (e.g. clearing a dropped
  set's artifacts).
- **`src/engine/`** — the validation engine (see below).
- **`src/variables/`** — the **sole** owner of the `figma.variables.*` API. A typed
  store (`TemplateStore`) implementing the schema above: discover, ensure, list, read,
  write, remove. All Variables-API casts are quarantined behind this boundary.
- **`src/workspace/`** — per-component working artifacts (contract, draft, findings) in
  root pluginData, off the Variables panel.
- **`src/transformer/`** — the backend *profile*: a connector (origin + OAuth surface)
  plus feature routes (transform run, publish). Shared by both threads. A backend is
  configuration, not a hardcoded endpoint.
- **`src/editor/`** — a CodeMirror wrapper for the template editor.
- **`src/ui/`** — the UI layer: the pipeline shell, the backend OAuth client, the icon
  registry, and template packaging/download.
- **`code.ts`** — the main-thread orchestrator: owns the storage keys, wires the stage
  actions, and streams state to the UI over `postMessage`.

## The validation engine (`src/engine/`)

The engine grades Code Connect template files and is reused at stage 6 and live in the
Templates editor.

- **Registry-driven.** `rules.ts` is the single source of truth for rules; the rule id
  type is *derived* from it, so config, icons, and the config UI can't drift out of sync
  with the rules that exist.
- **Real AST parse.** `parse.ts` uses a JavaScript grammar (`@lezer/javascript`), so it
  is multi-example-aware and comment-safe rather than a fragile hand-rolled scanner.
- **Pure structural pass.** `structural.ts` walks a parsed template into flat findings;
  severity is layered on top from the user's config, so the same finding can be an
  error, a warning, or muted without changing the check.
- **Semantic checks** additionally verify facts that need the Figma document (the node
  exists, is a component, is published), run on the main thread and folded into the same
  signal stream.

## Design notes

- **The plugin is the orchestrator.** No external CLI owns the pipeline; the plugin
  drives every stage.
- **Backend-agnostic.** The transform and server-relayed publish features hang off a
  configurable backend profile; absent a backend, stage 4 is skipped and templates are
  pasted by hand at stage 5, which is the merge point for both paths.
- **Variables are output only.** Only the final stage writes the Variables API; stages
  3–6 work entirely in pluginData, so the Variables panel stays empty until output is
  deliberately materialized.
