// ─── Backend profile ───
// The plugin talks to a "backend" — any server that speaks our OAuth + run/publish
// contract (PLAN.md §5.1). The profile is split along the axis that actually
// matters, which is NOT run-vs-publish but CONNECTION-vs-FEATURES:
//
//   • CONNECTOR — the one thing every feature depends on: an origin (baseUrl) plus
//     the OAuth surface used to connect to it. Connecting is the precondition for
//     every feature, and the access token minted here is the bearer each feature
//     call carries. There is exactly one connector per profile.
//   • FEATURES — the individual capabilities that hang off a live connector. Each is
//     a route (a `path`, relative to the connector origin) plus its own params:
//       - run:     stream a Code Connect template from the transformer (stage 4).
//       - publish: perform the Variables REST write from Dev Mode (Dev Mode publish).
//     Adding a backend capability means adding a feature here — no auth rework,
//     because the connector already owns the connection and the token.
//
// THE ONE FIGMA CONSTRAINT: manifest.networkAccess.allowedDomains is static (read at
// publish time, no runtime API to add a domain). So the connector's baseUrl origin
// MUST already be listed in manifest.json, or every request to it — run, publish, or
// OAuth — is denied by the sandbox. Features are just paths on that one allowlisted
// origin; a capability that genuinely lives on a DIFFERENT origin is a second
// connector (its own auth, its own allowlist entry), not a feature with a rogue base
// URL. The UI surfaces a network-deny as a helpful "add this origin to the manifest"
// signal rather than a silent fail.
//
// This module is shared by BOTH threads: the main thread (code.ts) reads it to
// persist/redeem tokens and mint per-run access; the iframe (src/ui) reads it to
// drive the PKCE + relay + poll dance and stream the run.

export interface BackendOAuth {
  /**
   * PUBLIC client id (PKCE, no secret). The backend assigns this via a one-time
   * dynamic registration (POST /api/oauth/register), so it's resolved + cached at
   * runtime rather than shipped — this field is only a fallback seed.
   */
  clientId: string
  /** Space-delimited scopes requested at authorize time. */
  scope: string
  /** Path of the dynamic client-registration endpoint (POST, one-time). */
  register: string
  /** Path (relative to baseUrl) of the provider's authorize endpoint. */
  authorize: string
  /** Path of the token endpoint (code→tokens exchange + refresh). */
  token: string
  /** Path of the relay session mint endpoint (POST). See TRANSFORMER_OAUTH_RELAY.md. */
  relayNew: string
  /** Path the plugin opens in a new tab to set the first-party cookie + 302 to authorize. */
  relayStart: string
  /** Path the plugin polls (with the readKey) until the auth code is ready. */
  relayPoll: string
  /**
   * The registered redirect_uri path (the relay callback). The plugin sends this
   * explicitly to both /start and /token so the PKCE exchange's redirect_uri
   * matches the authorize request exactly.
   */
  relayCallback: string
}

// The connection surface: the backend origin + the OAuth used to reach it. Every
// feature depends on this being connected; nothing here is feature-specific.
export interface BackendConnector {
  /** Stable id for this connector (used only for logging / display). */
  id: string
  /** Human label shown in the Environment view. */
  label: string
  /**
   * Origin of the backend. MUST be present in manifest allowedDomains or the
   * sandbox denies every request to it (see module header).
   */
  baseUrl: string
  oauth: BackendOAuth
}

// The transformer RUN feature — streams a Code Connect template (stage 4). The
// iframe POSTs {transformer: slug, input} and reads the reply per `response`.
export interface RunFeature {
  /** Path of the run endpoint the iframe streams from (relative to connector baseUrl). */
  path: string
  /** Which transformer on the backend to invoke (a backend may host several). */
  slug: string
  /** How the run endpoint replies — a streamed body, or a single JSON payload. */
  response: 'stream' | 'json'
}

// The Variables PUBLISH feature — the Dev Mode publish path. Called with the same
// OAuth bearer token a run uses; the backend — which holds the Figma App grant —
// performs one atomic Variables REST write on the user's behalf, so no Figma OAuth
// secret ever lives in this plugin. Contract (a DECLARATIVE publish spec):
//   POST {baseUrl}{path}
//   Authorization: Bearer <access token>   Content-Type: application/json
//   body: { file_key | file_url, collection: {action, …}, variables: PublishVariable[] }
//   → 200 { file_key, tempIdToRealId, counts } on success;
//     non-2xx { error, recoveryHint? } on failure (403 = plan/seat/scope gate).
// There is NO backend find-or-create: CREATE always makes a new collection, UPDATE
// targets an existing one by real id. The plugin does the find-or-create itself
// (buildPublishSpec in code.ts) using Dev-Mode-legal reads, mirroring TemplateStore:
// a STRING variable named `<component>/<label>` in the flat `.code-connect` collection.
export interface PublishFeature {
  /** Path of the Variables publish endpoint (POST), relative to connector baseUrl. */
  path: string
}

// The capabilities that hang off a connected backend. Extend this to add a feature.
export interface BackendFeatures {
  run: RunFeature
  publish: PublishFeature
}

export interface BackendProfile {
  connector: BackendConnector
  features: BackendFeatures
}

// The shipped default. connector.baseUrl is EMPTY on purpose — the plugin doesn't
// hardcode a backend. The user sets the URL in the Environment view's Advanced
// disclosure, and it persists to document pluginData once saved. Until a URL is
// set, Connect is a no-op with a "set a URL first" nudge.
//
// DEV NOTE: whatever origin is used MUST also be in manifest.json's allowedDomains
// (read at publish time, not runtime). The reference backend origin ships in the
// allowlist already; a different backend needs its origin added there too.
export const DEFAULT_BACKEND_PROFILE: BackendProfile = {
  connector: {
    id: 'figma',
    label: 'Figma backend',
    baseUrl: '',
    oauth: {
      // Resolved at runtime via dynamic registration (see register). Empty ⇒ "not
      // registered yet"; the main thread registers once and caches the assigned id.
      clientId: '',
      scope: 'mcp:read mcp:write',
      register: '/api/oauth/register',
      authorize: '/api/oauth/authorize',
      token: '/api/oauth/token',
      relayNew: '/api/oauth/relay/new',
      relayStart: '/api/oauth/relay/start',
      relayPoll: '/api/oauth/relay/poll',
      relayCallback: '/api/oauth/relay/callback',
    },
  },
  features: {
    run: {
      path: '/api/transformers/run',
      slug: 'code-connect-template',
      response: 'stream',
    },
    publish: {
      path: '/api/adapters/figma/variables/publish',
    },
  },
}

// The blanked profile written on Disconnect: every user-facing route/URL field is
// emptied ('null'), so the Backend field and its subfields reset to their placeholder
// state. The OAuth surface is kept (it's structural, not a subfield the user edits) so
// a fresh connect works the moment a Backend URL is entered again. normalizeProfile
// preserves these explicit empties (an absent field still falls back to the default;
// only an explicit '' stays empty), so the reset survives the read-back.
export const EMPTY_BACKEND_PROFILE: BackendProfile = {
  connector: {
    id: DEFAULT_BACKEND_PROFILE.connector.id,
    label: DEFAULT_BACKEND_PROFILE.connector.label,
    baseUrl: '',
    oauth: { ...DEFAULT_BACKEND_PROFILE.connector.oauth },
  },
  features: {
    run: { path: '', slug: '', response: DEFAULT_BACKEND_PROFILE.features.run.response },
    publish: { path: '' },
  },
}

/** Join the connector's baseUrl with one of the profile's paths, tolerant of slashes. */
export function backendUrl(profile: BackendProfile, path: string): string {
  const base = profile.connector.baseUrl.replace(/\/+$/, '')
  const p = path.startsWith('/') ? path : '/' + path
  return base + p
}

// The pre-split flat shape we still migrate persisted profiles from: connector
// fields lived at the top level and each feature route was its own field.
interface LegacyFlatProfile {
  id: string
  label: string
  baseUrl: string
  oauth: Partial<BackendOAuth>
  runPath: string
  publishPath: string
  slug: string
  response: 'stream' | 'json'
}

// Coerce an arbitrary (possibly persisted / partial / OLD-shape) object into a valid
// profile, filling any missing field from the default. Handles three inputs:
//   • the new { connector, features } shape,
//   • the old flat { baseUrl, oauth, runPath, publishPath, slug, response } shape,
//   • a partial edit of either (e.g. a user's Advanced edit of just a baseUrl).
export function normalizeProfile(raw: unknown): BackendProfile {
  const d = DEFAULT_BACKEND_PROFILE
  if (!raw || typeof raw !== 'object') return d
  const r = raw as Partial<BackendProfile> & Partial<LegacyFlatProfile>

  const str = (v: unknown, fallback: string): string => (typeof v === 'string' && v ? v : fallback)
  // Like str, but preserves an EXPLICIT empty string (a user-blanked route, e.g. from
  // Disconnect) — only a missing/non-string field falls back to the default. Used for
  // the editable route fields so a reset-to-null survives normalization.
  const keep = (v: unknown, fallback: string): string => (typeof v === 'string' ? v : fallback)

  // Connector: prefer the nested new shape; fall back to the old top-level fields.
  const c: { id?: string; label?: string; baseUrl?: string; oauth?: Partial<BackendOAuth> } =
    r.connector && typeof r.connector === 'object'
      ? r.connector
      : { id: r.id, label: r.label, baseUrl: r.baseUrl, oauth: r.oauth }
  const o: Partial<BackendOAuth> = c.oauth && typeof c.oauth === 'object' ? c.oauth : {}

  // Features: prefer the nested new shape; fall back to the old flat route fields.
  const feat = r.features && typeof r.features === 'object' ? r.features : undefined
  const run: Partial<RunFeature> =
    feat && feat.run && typeof feat.run === 'object'
      ? feat.run
      : { path: r.runPath, slug: r.slug, response: r.response }
  // The publish route the pre-split plugin shipped as its DEFAULT — never editable in
  // the UI back then, so any profile carrying it just inherited a since-corrected
  // default (the real endpoint moved under /api/adapters/figma/…). Treat it as unset
  // when migrating a legacy flat profile so it upgrades to the current default rather
  // than faithfully preserving a 404. An explicit new-shape choice is left untouched.
  const LEGACY_DEFAULT_PUBLISH_PATH = '/api/variables/publish'
  const publish: Partial<PublishFeature> =
    feat && feat.publish && typeof feat.publish === 'object'
      ? feat.publish
      : { path: r.publishPath === LEGACY_DEFAULT_PUBLISH_PATH ? undefined : r.publishPath }

  return {
    connector: {
      id: str(c.id, d.connector.id),
      label: str(c.label, d.connector.label),
      baseUrl: keep(c.baseUrl, d.connector.baseUrl),
      oauth: {
        clientId: typeof o.clientId === 'string' ? o.clientId : d.connector.oauth.clientId,
        scope: str(o.scope, d.connector.oauth.scope),
        register: str(o.register, d.connector.oauth.register),
        authorize: str(o.authorize, d.connector.oauth.authorize),
        token: str(o.token, d.connector.oauth.token),
        relayNew: str(o.relayNew, d.connector.oauth.relayNew),
        relayStart: str(o.relayStart, d.connector.oauth.relayStart),
        relayPoll: str(o.relayPoll, d.connector.oauth.relayPoll),
        relayCallback: str(o.relayCallback, d.connector.oauth.relayCallback),
      },
    },
    features: {
      run: {
        path: keep(run.path, d.features.run.path),
        slug: keep(run.slug, d.features.run.slug),
        response: run.response === 'json' || run.response === 'stream' ? run.response : d.features.run.response,
      },
      publish: {
        path: keep(publish.path, d.features.publish.path),
      },
    },
  }
}
