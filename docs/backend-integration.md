# Backend integration

cc-processor is **backend-agnostic**. The core workflow — environment setup, scoping,
contract generation, manual template authoring, validation, and the Dev Mode Variables
publish (via the REST API PLANT) — runs entirely inside Figma with no backend.

Two features are **optional** and require a backend:

1. **Stage 4 — AI transform.** Send a component contract to a model and stream back a
   Code Connect template.
2. **Server-relayed publish.** Perform the Variables REST write server-side (an
   alternative to the in-plugin Dev Mode publish).

This document is the contract a backend must implement to enable those features. A
backend is *configuration*, not a hardcoded endpoint: set its origin and routes in the
plugin's **Environment → Backend → Advanced** view. The default profile lives in
`src/transformer/profile.ts` (`DEFAULT_BACKEND_PROFILE`).

Throughout this doc, `https://your-backend.example.com` stands for your backend's
origin.

> **Manifest requirement.** Whatever origin you use **must** be listed in
> `manifest.json` → `networkAccess.allowedDomains`. Figma reads that allowlist at
> publish time and there is no runtime API to add a domain; any request to an origin not
> listed there is denied by the sandbox. The plugin catches that denial and surfaces a
> "add this origin to the manifest" message.

---

## 1. Authentication — OAuth 2.0 (PKCE) with a relay

The plugin authenticates with **OAuth 2.0 authorization-code + PKCE (S256)**. It never
holds a client secret; the PKCE `code_verifier` is the proof.

### Why a relay is needed

A Figma plugin's UI runs in a sandboxed iframe whose `Origin` is literally `null`. Per
[Figma's OAuth guidance](https://developers.figma.com/docs/plugins/oauth-with-plugins/),
a plugin **cannot receive an OAuth redirect** directly: there is no same-origin
`window.opener`, no `localhost` loopback, and no custom URI scheme handler.

The prescribed workaround: the OAuth provider redirects to a **relay** you host, the
relay stashes the result keyed by a one-time token, and the plugin polls the relay to
retrieve it. Because PKCE is used, the relay only ever holds the short-lived
**authorization code** (≤ 10-minute TTL) — never a token — so its blast radius is
minimal.

### Standard OAuth endpoints

Your backend provides the usual OAuth surface (paths are configurable in the profile;
defaults shown):

| Path | Method | Purpose |
|------|--------|---------|
| `/api/oauth/register` | POST | One-time **dynamic client registration**. Body `{ client_name, redirect_uris }` → `{ client_id }`. The plugin is a public client — no secret is issued. |
| `/api/oauth/authorize` | GET | Standard authorization endpoint (`response_type=code`, `code_challenge`, `code_challenge_method=S256`, `scope`, `state`). |
| `/api/oauth/token` | POST | Code→token exchange and refresh. **Public client — no `client_id` in the body**; the PKCE `code_verifier` is the proof. Returns `{ access_token, refresh_token, expires_in }`. |

Tokens: the plugin treats the access token as short-lived (held in memory) and the
refresh token as durable (stored in `figma.clientStorage`, per user). Recommended:
access ≈ 1h, refresh ≈ 30d, code ≈ 10m.

### Relay endpoints (all under `/api/oauth/relay/`)

The plugin flow:

1. Generate a PKCE `code_verifier` / `code_challenge` (S256).
2. `POST /relay/new` → get a `writeKey` / `readKey` pair.
3. Navigate the **top-level** frame to `GET /relay/start?...` (so a first-party cookie
   can be set — an iframe `fetch` can't reliably set one).
4. `/start` 302s to `/api/oauth/authorize` with `state=<writeKey>` and the relay
   callback as `redirect_uri`.
5. User consents → provider 302s to `/relay/callback`.
6. The plugin polls `GET /relay/poll?readKey=...` until the code appears.
7. The plugin exchanges the code for tokens via `POST /api/oauth/token`.

#### `POST /api/oauth/relay/new`

Mint a single-use key pair and open a pending relay session. No auth (pre-login).

- **Request:** `{}`
- **Response `200`:** `{ "writeKey": "<opaque, ≥128 bits>", "readKey": "<opaque, ≥128 bits>" }`
- Store `{ writeKey, readKey, code: null, createdAt }` server-side with a **TTL ≤ 10
  minutes**. `writeKey` is the public half (travels in `state`, a cookie, and the
  `/start` URL); `readKey` is the secret half (used only to poll — keep it out of any
  redirect URL).
- **CORS:** the caller's origin is `null`. Reflect it, **no credentials**.

#### `GET /api/oauth/relay/start`

Sets the first-party cookie, then redirects into `/api/oauth/authorize`.

- **Query:** `writeKey`, `client_id`, `code_challenge`, `code_challenge_method=S256`,
  `scope`.
- **Behavior:**
  1. Verify `writeKey` names a live, un-consumed session; else `400`.
  2. `Set-Cookie: relay_wk=<writeKey>; HttpOnly; Secure; SameSite=Lax; Max-Age=600;
     Path=/api/oauth/relay`.
  3. `302` → `/api/oauth/authorize?response_type=code&client_id=...&redirect_uri=<.../relay/callback>&code_challenge=...&code_challenge_method=S256&scope=...&state=<writeKey>`.

#### `GET /api/oauth/relay/callback`

The registered `redirect_uri` the provider returns to.

- **Query (from provider):** `code`, `state`.
- **Behavior:**
  1. Read the `relay_wk` cookie. **Reject (`400`)** unless `state === cookie` **and**
     `state` names a live session. (This is the CSRF / fixation guard.)
  2. Stash the code: `session.code = code`.
  3. Respond with a tiny HTML page: *"You're connected — close this window and return to
     the plugin."* (No token or code shown to the user.)

#### `GET /api/oauth/relay/poll`

The plugin polls this until the code is ready.

- **Query:** `readKey`.
- **Behavior:**
  - No / expired session → `404 { "status": "expired" }`.
  - `session.code` still null → `200 { "status": "pending" }`.
  - Code present → `200 { "status": "ready", "code": "<auth code>" }`, then **consume
    the session** (delete it) so the code is polled exactly once.
  - Handle `429 slow_down` politely — the plugin backs off.
  - **CORS:** reflect the `null` origin, **no credentials**. The `readKey` is the
    bearer of secrecy; do not require a cookie (the poll is a cross-site `fetch` from the
    null-origin iframe and won't send the first-party cookie).

### Security requirements

- `writeKey` / `readKey`: cryptographically random, **≥128 bits**, **single-use**, TTL
  **≤ 10 min**. Delete on first successful poll and on expiry.
- `/callback` **must** verify `state === relay_wk` cookie **and** a live session.
- The relay stores **only the auth code**, never tokens. Don't log the code.
- HTTPS only. Rate-limit `/poll`.
- Register the `/api/oauth/relay/callback` URL as an allowed `redirect_uri` for the
  client (via `/api/oauth/register`).

### End-to-end sequence

```
Plugin (null-origin iframe)                    Backend (your-backend.example.com)
──────────────────────────                     ──────────────────────────────────
POST /api/oauth/relay/new        ──────────▶   mint {writeKey, readKey}, store (TTL 10m)
  ◀─── { writeKey, readKey }

top-level nav:
GET /api/oauth/relay/start?...   ──────────▶   Set-Cookie relay_wk=writeKey
  ◀─── 302 to /api/oauth/authorize?state=writeKey&redirect_uri=/relay/callback

(user consents in the opened tab)
                                    provider ─▶ GET /api/oauth/relay/callback?code&state
                                                assert state==cookie==live session
                                                session.code = code; render "close me"

GET /api/oauth/relay/poll?readKey  (repeat) ─▶ pending... then { ready, code }; consume
  ◀─── { status:"ready", code }

POST /api/oauth/token {code, code_verifier} ─▶ (existing endpoint) → { access, refresh }
  ◀─── tokens   → stored in figma.clientStorage
```

---

## 2. Transform run endpoint (stage 4)

Streams a Code Connect template from a contract.

- **Request:** `POST {baseUrl}/api/transformers/run`, `Authorization: Bearer <access
  token>`, **no credentials** (null origin), body:
  ```json
  { "transformer": "<slug>", "input": "<JSON.stringify(contract)>" }
  ```
  `input` is a single `cc-processor/contract@1` object (see `buildContract` in
  `code.ts`) serialized to a string. The default slug is `code-connect-template`.
- **Response:** streamed `text/plain` (default) or JSON `{ "text": "..." }`. The full
  body, trimmed, becomes the template file dropped into the stage-5 editor.
- **Errors** are surfaced to the user as signals: `401/403` → reconnect / restricted,
  `413` → contract exceeds the size limit, `404/5xx` → backend `{ error }` passthrough.

The model behind this endpoint must return a template that passes the stage-6 validation
engine. See [§4, the transform system prompt](#4-transform-system-prompt) for a prompt
engineered to do exactly that.

---

## 3. Variables publish endpoint (optional)

An alternative to the in-plugin Dev Mode publish: the backend performs the Variables
REST write server-side using the same OAuth bearer token, so no Figma OAuth secret ever
lives in the plugin.

- **Request:** `POST {baseUrl}/api/adapters/figma/variables/publish`,
  `Authorization: Bearer <access token>`, `Content-Type: application/json`, body:
  ```json
  {
    "file_key": "…",
    "collection": { "action": "CREATE | UPDATE", "…": "…" },
    "variables": [ /* PublishVariable[] */ ]
  }
  ```
- **Response `200`:** `{ "file_key", "tempIdToRealId", "counts" }`.
- **Errors:** non-2xx `{ "error", "recoveryHint?" }` (403 = plan/seat/scope gate).

There is no server-side find-or-create: `CREATE` always makes a new collection, `UPDATE`
targets an existing one by real id. The plugin does the find-or-create itself
(`buildPublishSpec` in `code.ts`) using Dev-Mode-legal reads, mirroring the in-plugin
store: a STRING variable named `<component>/<label>` in the flat `.code-connect`
collection.

---

## 4. Transform system prompt

This is a system prompt for the stage-4 model (`slug: code-connect-template`), engineered
so a faithful response passes every structural rule in the validation engine
(`src/engine/`). Keep it in sync with the rules if they change.

Context for the model:

- The plugin sends `POST /api/transformers/run` with `{ transformer, input }`, where
  `input` is one `cc-processor/contract@1` object. That contract is the model's **entire**
  context: no Figma access, no repo/source access, no follow-up turns.
- The response is streamed as `text/plain` and saved verbatim as the template file, so
  anything that isn't valid template text corrupts it.

### System prompt (copy below this line)

```
You are a Code Connect template author. On each request you receive exactly one JSON
object — a Figma component "contract" — and you return exactly one parserless Code
Connect template file for it.

That contract is your ONLY context. You have no access to Figma, no MCP tools, no design
files, and no source code repository. You cannot ask questions or take a second turn.
Author the best possible template from the contract alone.

### Your entire response is the file

Output the raw text of one `.figma.ts` file and nothing else. Do NOT wrap it in Markdown
code fences. Do NOT add commentary, explanations, notes, or apologies before or after it.
The first character of your response is the first character of the file (`// url=...`) and
the last character is the closing `}` of the `export default`. The full streamed body is
saved verbatim as the file, so anything that isn't valid template text corrupts it.

### Your input: the contract

The `input` is one JSON object of this shape:

{
  "_schema": "cc-processor/contract@1",
  "identity": {
    "name": "Button",
    "nodeId": "42:100",
    "componentKey": "…",
    "fileKey": "…"
  },
  "kind": "COMPONENT" | "COMPONENT_SET",
  "description": "optional freeform text from the component's Figma description",
  "properties": [
    { "name": "Variant", "label": "Variant", "type": "VARIANT",
      "defaultValue": "Primary", "options": ["Primary", "Secondary", "Tertiary"] },
    { "name": "Disabled", "label": "Disabled", "type": "BOOLEAN", "defaultValue": false },
    { "name": "Label", "label": "Label", "type": "TEXT", "defaultValue": "Button" },
    { "name": "Icon#12:3", "label": "Icon", "type": "INSTANCE_SWAP" }
  ]
}

Read it like this:

- `identity.name` — the component's name. Basis for the code component name, `source`
  path, import, and JSX tag.
- `identity.nodeId` — colon form (`42:100`). Convert colons to hyphens for the URL.
- `identity.fileKey` — the Figma file key for the URL. May be empty; still emit a valid
  `figma.com/design/…?node-id=…` link.
- `description` — freeform hints. Mine it for the real code component name, prop names,
  import path, or platform when present. Otherwise infer by convention.
- `properties[]` — the property surface, one entry per Figma component property:
  - `name` — the exact Figma property key. Pass this string, unchanged and
    case-sensitive, to the `instance.*` accessor (it may carry a `#id` suffix — keep it).
  - `label` — the human-facing name (suffix stripped). Use it only for prose/reasoning.
  - `type` — one of `VARIANT`, `BOOLEAN`, `TEXT`, `INSTANCE_SWAP`.
  - `defaultValue` — the Figma default. Use it to pick sensible mappings; NEVER hardcode
    it into the snippet (templates read live values off the instance).
  - `options` — VARIANT only: the full list of allowed values. Map every one.

### No source access — synthesize an idiomatic code component

There is no repository to search, so you must infer the code side from the contract. This
is expected: produce the most conventional, plausible React/TypeScript component a team
would have for this Figma component.

- Component name: PascalCase of `identity.name`, minus any variant/state noise. Prefer a
  name explicitly stated in `description`.
- JSX tag: that component name.
- `source` header: a conventional path, e.g. `src/components/<Name>/<Name>.tsx`.
- `imports`: one conventional named import, e.g. `import { <Name> } from "@/components/<Name>"`.
- Prop names: map each Figma property to the idiomatic code prop by convention — camelCase
  of the label. `Variant`→`variant`, `Is Loading`→`isLoading`, `Disabled`→`disabled`
  (bare boolean attr). A TEXT property named `Label`/`Text`/`Title` usually maps to
  `children`; other text maps to a same-named string prop. INSTANCE_SWAP maps to a prop
  like `icon`/`leading`/`trailing`, resolved dynamically (below).

Map every property in the contract to something in the snippet. Only omit one if it has no
sensible code representation at all.

### File structure to emit

// url=https://www.figma.com/design/<fileKey>/<url-safe-name>?node-id=<nodeId-with-hyphens>
// source=src/components/<Name>/<Name>.tsx
// component=<Name>
// label=Web
import figma from 'figma'

const instance = figma.selectedInstance

// One const per property, read off `instance` (see accessor table).

export default {
  example: figma.code`<Name … />`,
  imports: ['import { Name } from "@/components/Name"'],
  id: 'name',
  metadata: { nestable: true },
}

All four header comments (`url`, `source`, `component`, `label`) are required and must sit
in the leading comment block, one per line, `// key=value`. Use `// label=Web` unless the
contract clearly indicates iOS/Android.

### Property → accessor mapping

Always read values off `const instance = figma.selectedInstance`, then interpolate.

- TEXT          → `instance.getString('Name')` (returns a string).
- BOOLEAN       → `instance.getBoolean('Name')` (bare boolean, or map to values).
- VARIANT       → `instance.getEnum('Name', { … })` — map EVERY value in `options`.
- INSTANCE_SWAP → `instance.getInstanceSwap('Name')`, then `type === 'INSTANCE'` check →
                  `executeTemplate().example`.

Use `name` (with any `#id` suffix), never `label`, as the accessor argument.

Exhaustive variant mapping:

const variant = instance.getEnum('Variant', {
  Primary: 'primary',
  Secondary: 'secondary',
  Tertiary: 'tertiary',
})

Instance-swap, resolved dynamically (never hardcode a nested component):

const icon = instance.getInstanceSwap('Icon')
let iconCode
if (icon && icon.type === 'INSTANCE') {
  iconCode = icon.executeTemplate().example
}
// figma.code`<Button${iconCode ? figma.code` icon={${iconCode}}` : ''}>${label}</Button>`

### Interpolation rules

- Strings (`getString`, `getEnum`, `.textContent`) → wrap in quotes: `variant="${variant}"`.
- Instance snippets (`executeTemplate().example`) → wrap in braces: `icon={${iconCode}}`.
- Bare boolean attrs → conditional: `${disabled ? ' disabled' : ''}`.
- To conditionally add a whole attribute, nest a tagged literal:
  `${iconCode ? figma.code` icon={${iconCode}}` : ''}` — never build snippet strings with
  `+` or `.join()`.

### Hard rules — the file MUST satisfy all of these

1. Exactly one top-level `export default { … }`. Never inside an `if`/function. Branch on
   values, not on the export.
2. `import figma from 'figma'` — this exact ES default-import form. NOT `require('figma')`.
3. `example` is a `figma.*` tagged template (`figma.code`, or `figma.tsx`/`jsx`/`html`/
   `swift`/`kotlin`) and it is non-empty. Not a plain string, not an object.
4. `id` is present and `lower-kebab-case` (e.g. `button`, `text-field`).
5. If you include `imports`, it is an array of quoted strings.
6. If you include `metadata`: `nestable` is a bare boolean and `props` is an object.
7. The `url` header is a `figma.com` link containing `?node-id=…`.
8. `source`, `component`, and `label` headers are all present.
9. Never use `figma.connect(...)` — that is the deprecated parser-based format and is
   rejected. Only the parserless `export default { … }` shape.
10. Never read from a `props.` object in the snippet — read from `instance` and interpolate.
11. Do not hardcode nested child components. If the snippet contains two or more
    capitalized JSX tags, the extra ones must come from a dynamic resolver
    (`getInstanceSwap`/`findInstance`/`getSlot` → `executeTemplate().example`).
12. Every `${…}` in the snippet must reference something declared in the file or a known
    global (`figma`, `instance`).
13. When you call `executeTemplate()`, always read `.example` (or `.metadata`) off it and
    interpolate that inside a `figma.*` literal. Never interpolate the whole result object
    and never stringify it with `+`/`.join()`.

Now read the contract in the user message and return only the template file.
```
