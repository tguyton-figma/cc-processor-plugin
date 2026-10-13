// ─── Iframe transformer client ───
// The parts of the OAuth + run flow that must happen in the browser iframe, not
// the sandboxed main thread (PLAN.md §5.1):
//   • PKCE generation (crypto.subtle) + the relay/poll dance that works around a
//     Figma plugin's null-origin iframe (see TRANSFORMER_OAUTH_RELAY.md).
//   • Streaming the run response — the iframe can read a ReadableStream reliably
//     where the main-thread fetch sandbox can't.
// The main thread still owns every SECRET: this module never sees the refresh
// token. It hands main the short-lived auth code (to redeem) and streams a run
// using a per-run access token main minted for it.

import { type BackendProfile, backendUrl } from '../../transformer/profile'

// ─── PKCE ───

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function randomVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64url(bytes)
}

// SHA-256 over bytes, pure JS. We need this because the Figma plugin UI iframe is
// usually NOT a secure context (opaque/null origin ⇒ window.isSecureContext false),
// and the browser gates crypto.subtle behind a secure context — so crypto.subtle is
// undefined there even though crypto.getRandomValues works. (This is why PKCE
// libraries that bundle their own SHA-256 work inside Figma while a direct
// crypto.subtle.digest call fails.) The backend requires S256, so we can't fall
// back to a plain challenge — we compute the hash ourselves. Standard FIPS 180-4.
function sha256Bytes(bytes: Uint8Array): Uint8Array {
  const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ])
  let h0 = 0x6a09e667,
    h1 = 0xbb67ae85,
    h2 = 0x3c6ef372,
    h3 = 0xa54ff53a,
    h4 = 0x510e527f,
    h5 = 0x9b05688c,
    h6 = 0x1f83d9ab,
    h7 = 0x5be0cd19
  const l = bytes.length
  const bitLen = l * 8
  // Pad: 0x80, then zeros, so the total is 8 bytes shy of a 64-byte multiple, then
  // the 64-bit big-endian bit length.
  const total = (((l + 8) >> 6) + 1) << 6
  const m = new Uint8Array(total)
  m.set(bytes)
  m[l] = 0x80
  const dv = new DataView(m.buffer)
  dv.setUint32(total - 4, bitLen >>> 0)
  dv.setUint32(total - 8, Math.floor(bitLen / 0x100000000))
  const w = new Uint32Array(64)
  const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n))
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3)
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10)
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0
    }
    let a = h0,
      b = h1,
      c = h2,
      d = h3,
      e = h4,
      f = h5,
      g = h6,
      h = h7
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) | 0
      h = g
      g = f
      f = e
      e = (d + t1) | 0
      d = c
      c = b
      b = a
      a = (t1 + t2) | 0
    }
    h0 = (h0 + a) | 0
    h1 = (h1 + b) | 0
    h2 = (h2 + c) | 0
    h3 = (h3 + d) | 0
    h4 = (h4 + e) | 0
    h5 = (h5 + f) | 0
    h6 = (h6 + g) | 0
    h7 = (h7 + h) | 0
  }
  const out = new Uint8Array(32)
  const odv = new DataView(out.buffer)
  const hs = [h0, h1, h2, h3, h4, h5, h6, h7]
  for (let i = 0; i < 8; i++) odv.setUint32(i * 4, hs[i] >>> 0)
  return out
}

async function s256(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier)
  // Prefer the native digest when the context allows it (faster, audited); fall
  // back to the JS implementation in the Figma iframe where subtle is absent.
  if (typeof crypto !== 'undefined' && crypto.subtle && typeof crypto.subtle.digest === 'function') {
    try {
      const digest = await crypto.subtle.digest('SHA-256', data)
      return base64url(new Uint8Array(digest))
    } catch {
      // Fall through to the JS path.
    }
  }
  return base64url(sha256Bytes(data))
}

// ─── Relay session ───

interface RelayKeys {
  writeKey: string
  readKey: string
}

async function mintRelaySession(profile: BackendProfile): Promise<RelayKeys> {
  const res = await fetch(backendUrl(profile, profile.connector.oauth.relayNew), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: '{}',
  })
  if (!res.ok) throw new Error('couldn’t start a sign-in session (' + res.status + ')')
  const data = (await res.json()) as { writeKey?: unknown; readKey?: unknown }
  if (typeof data.writeKey !== 'string' || typeof data.readKey !== 'string') {
    throw new Error('the transformer’s sign-in session response was malformed')
  }
  return { writeKey: data.writeKey, readKey: data.readKey }
}

// Build the /start URL the plugin opens in a top-level tab. Per the contract, the
// relay FORCES the redirect_uri to its own callback — we never pass one — so the
// exchange's redirect_uri (main-side) must equal that same relayCallback path.
function startUrl(profile: BackendProfile, keys: RelayKeys, challenge: string): string {
  const q = [
    'writeKey=' + encodeURIComponent(keys.writeKey),
    'client_id=' + encodeURIComponent(profile.connector.oauth.clientId),
    'code_challenge=' + encodeURIComponent(challenge),
    'code_challenge_method=S256',
    'scope=' + encodeURIComponent(profile.connector.oauth.scope),
  ].join('&')
  return backendUrl(profile, profile.connector.oauth.relayStart) + '?' + q
}

// Poll the relay until the auth code lands, backing off gently. Bounded so a user
// who abandons the consent tab doesn't leave us polling forever (the relay's own
// TTL is 10 min; we give up a touch sooner). `sleep` is injected so the pipeline
// can pass a timer — the iframe has setTimeout, but keeping it a param keeps this
// unit testable and free of ambient globals.
async function pollForCode(
  profile: BackendProfile,
  readKey: string,
  sleep: (ms: number) => Promise<void>,
  deadlineMs = 8 * 60 * 1000,
): Promise<string> {
  const startedAt = Date.now()
  let delay = 1200
  for (;;) {
    if (Date.now() - startedAt > deadlineMs) throw new Error('sign-in timed out — try connecting again')
    const res = await fetch(
      backendUrl(profile, profile.connector.oauth.relayPoll) + '?readKey=' + encodeURIComponent(readKey),
      { headers: { Accept: 'application/json' } },
    )
    if (res.status === 404) throw new Error('the sign-in session expired — try connecting again')
    if (res.status === 429) {
      // The relay asked us to slow down. Back off harder and retry — don't fail.
      delay = Math.min(delay + 1000, 5000)
      await sleep(delay)
      continue
    }
    if (res.ok) {
      const data = (await res.json()) as { status?: unknown; code?: unknown }
      if (data.status === 'ready' && typeof data.code === 'string') return data.code
      if (data.status === 'expired') throw new Error('the sign-in session expired — try connecting again')
      // else pending — fall through to back off and retry.
    }
    await sleep(delay)
    delay = Math.min(delay + 400, 3000)
  }
}

export interface ConnectDeps {
  /** Open the consent tab (top-level context so the relay's cookie is first-party). */
  openTab: (url: string) => void
  /** Async sleep for the poll loop. */
  sleep: (ms: number) => Promise<void>
  /** Progress hook for the Environment view's status chip. */
  onStatus?: (status: 'connecting' | 'authorizing' | 'finishing') => void
}

// Run the whole client-side connect flow and return the auth code + verifier for
// the main thread to redeem. Throws with a user-facing message on any failure.
export async function connectTransformer(
  profile: BackendProfile,
  deps: ConnectDeps,
): Promise<{ code: string; codeVerifier: string; redirectUri: string }> {
  // We need getRandomValues for the PKCE verifier (available even in an insecure
  // context); the S256 hash falls back to pure JS when crypto.subtle is absent.
  if (typeof crypto === 'undefined' || typeof crypto.getRandomValues !== 'function') {
    throw new Error('this browser can’t generate a secure sign-in request')
  }
  if (deps.onStatus) deps.onStatus('connecting')
  const codeVerifier = randomVerifier()
  const challenge = await s256(codeVerifier)
  const redirectUri = backendUrl(profile, profile.connector.oauth.relayCallback)
  const keys = await mintRelaySession(profile)
  if (deps.onStatus) deps.onStatus('authorizing')
  deps.openTab(startUrl(profile, keys, challenge))
  const code = await pollForCode(profile, keys.readKey, deps.sleep)
  if (deps.onStatus) deps.onStatus('finishing')
  return { code, codeVerifier, redirectUri }
}

// ─── Run streaming ───

// Some models wrap their answer in a Markdown code fence (```ts … ```) even though
// the system prompt asks for raw file text — and a fenced file trips the validation
// signals (the header comments and `import` land inside a string). Strip a fence
// that wraps the WHOLE output: a leading ```lang line and the matching trailing
// ```. We only ever touch a fence at the very start/end — never interior backticks,
// because a Code Connect template legitimately contains its own (figma.code`…`).
// Runs on partial stream chunks too, so the editor never flashes the opening fence;
// mid-stream the closing ``` simply hasn't arrived yet and is left alone.
export function stripCodeFence(text: string): string {
  const s = text.trim()
  // Opening fence must be the first line: ``` optionally followed by a language
  // token (no backticks/newlines), then a newline.
  const open = /^```[^\n`]*\n/.exec(s)
  if (!open) return s
  const body = s.slice(open[0].length).replace(/\n?```\s*$/, '')
  return body.trim()
}

// Pull a template file from a JSON run envelope, tolerantly. The contract's JSON
// (responseFormat: "json") shape is `{text}`; we also accept `{file}` / `{template}`
// for forward-compat, else fall back to the raw body. (Stream mode treats the raw
// accumulated text as the file directly, so this is the JSON-mode path.)
function fileFromJson(body: string): string {
  try {
    const data = JSON.parse(body) as { text?: unknown; file?: unknown; template?: unknown }
    const f =
      typeof data.text === 'string'
        ? data.text
        : typeof data.file === 'string'
          ? data.file
          : typeof data.template === 'string'
            ? data.template
            : ''
    if (f) return stripCodeFence(f)
  } catch {
    // Not JSON — treat the whole body as the file.
  }
  return stripCodeFence(body)
}

// Read the `{error}` message from a non-2xx run response, best-effort.
async function errorBody(res: Response): Promise<string> {
  try {
    const data = JSON.parse(await res.text()) as { error?: unknown }
    if (typeof data.error === 'string' && data.error.trim()) return data.error.trim()
  } catch {
    // Non-JSON error body — fall through to the status-derived message.
  }
  return ''
}

export interface RunGrant {
  componentKey: string
  url: string
  token: string
  slug: string
  response: 'stream' | 'json'
  contract: unknown
}

export interface RunDeps {
  /** Live partial output — the accumulated text so far — for the stage-5 editor. */
  onChunk?: (text: string) => void
}

// Stream (or fetch) one transformer run. Never throws — always resolves to a
// result so the caller can report success/failure back to main uniformly.
export async function streamTransformRun(
  grant: RunGrant,
  deps: RunDeps = {},
): Promise<{ ok: boolean; file: string; error?: string; status?: number }> {
  try {
    const res = await fetch(grant.url, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + grant.token,
        'Content-Type': 'application/json',
        Accept: grant.response === 'stream' ? 'text/plain' : 'application/json',
      },
      // Contract run body: {transformer: <slug>, input: <string>}. The contract
      // serializes the Code Connect contract as the `input` string; the transformer
      // config decides how it's fed to the model.
      body: JSON.stringify({ transformer: grant.slug, input: JSON.stringify(grant.contract) }),
    })
    if (!res.ok) {
      // Prefer the backend's own {error} message; fall back to a status gloss.
      // 404 = transformer missing/disabled, 403 = visibility, 413 = input too large.
      const server = await errorBody(res)
      const detail =
        server ||
        (res.status === 401 || res.status === 403
          ? 'the transformer rejected the request (' + res.status + ') — try reconnecting'
          : res.status === 404
            ? 'the transformer isn’t available (404) — check the slug in Advanced'
            : res.status === 413
              ? 'the contract was too large for the transformer (413)'
              : 'the transformer returned ' + res.status)
      return { ok: false, file: '', error: detail, status: res.status }
    }
    // Stream mode: read the body incrementally so the editor fills in live.
    if (grant.response === 'stream' && res.body && typeof res.body.getReader === 'function') {
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let acc = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        acc += dec.decode(value, { stream: true })
        // Strip a wrapping code fence live so the editor never renders it (and its
        // signals stay clean). Mid-stream only the opening fence exists yet.
        if (deps.onChunk) deps.onChunk(stripCodeFence(acc))
      }
      acc += dec.decode()
      const file = stripCodeFence(acc)
      if (!file) return { ok: false, file: '', error: 'the transformer returned an empty template' }
      if (deps.onChunk) deps.onChunk(file)
      return { ok: true, file }
    }
    // JSON (or no readable stream): take the whole body at once.
    const text = await res.text()
    const file = grant.response === 'stream' ? stripCodeFence(text) : fileFromJson(text)
    if (!file) return { ok: false, file: '', error: 'the transformer returned an empty template' }
    if (deps.onChunk) deps.onChunk(file)
    return { ok: true, file }
  } catch (e) {
    return { ok: false, file: '', error: e instanceof Error ? e.message : String(e) }
  }
}
