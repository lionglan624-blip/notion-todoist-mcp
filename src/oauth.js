// ─────────────────────────────────────────────
// OAuth 2.1 (stateless, HMAC-signed tokens — single-user)
// ─────────────────────────────────────────────
export const b64u = {
  enc: (buf) => {
    const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  dec: (str) => {
    const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
  encStr: (s) => b64u.enc(new TextEncoder().encode(s)),
  decStr: (s) => new TextDecoder().decode(b64u.dec(s)),
};

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

// Separate the HMAC signing key from the login password.
// MCP_SIGNING_KEY: HMAC-SHA256 secret used to sign/verify OAuth tokens.
// MCP_LOGIN_SECRET: password the user types on the /authorize login page.
// If either is unset, fall back to MCP_SECRET for backwards compatibility
// with existing single-secret deployments.
function getSigningKey(env) {
  return env.MCP_SIGNING_KEY || env.MCP_SECRET;
}
function getLoginSecret(env) {
  return env.MCP_LOGIN_SECRET || env.MCP_SECRET;
}

// Constant-time secret comparison via SHA-256 digest equality.
// Web Crypto has no timingSafeEqual; hashing both sides to fixed-length
// digests lets a byte-wise OR-XOR run in constant time regardless of
// where the first mismatch occurs. Prevents timing side-channels on
// the /authorize login page.
async function secretsEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  const av = new Uint8Array(ha), bv = new Uint8Array(hb);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

// Default redirect_uri host allowlist — covers Claude.ai custom connectors
// and loopback for local MCP clients. Override via ALLOWED_REDIRECT_HOSTS
// (comma-separated; bare host or `*.suffix` wildcards).
const DEFAULT_REDIRECT_HOSTS = [
  "claude.ai", "*.claude.ai",
  "claude.com", "*.claude.com",
  "anthropic.com", "*.anthropic.com",
  "localhost", "127.0.0.1", "[::1]",
];

function redirectHostAllowed(redirectUri, env) {
  let host;
  try { host = new URL(redirectUri).hostname.toLowerCase(); }
  catch { return false; }
  const raw = env.ALLOWED_REDIRECT_HOSTS;
  const patterns = (raw && typeof raw === "string"
    ? raw.split(",").map(s => s.trim()).filter(Boolean)
    : DEFAULT_REDIRECT_HOSTS
  ).map(p => p.toLowerCase());
  for (const pat of patterns) {
    if (pat.startsWith("*.")) {
      const suffix = pat.slice(1); // ".claude.ai"
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (host === pat) {
      return true;
    }
  }
  return false;
}

async function signToken(payload, env) {
  const secret = getSigningKey(env);
  if (!secret) throw new Error("signing key not configured");
  const key = await hmacKey(secret);
  const body = b64u.encStr(JSON.stringify(payload));
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return `${body}.${b64u.enc(sig)}`;
}

export async function verifyToken(token, expectedTyp, env) {
  const secret = getSigningKey(env);
  if (!secret) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64u.dec(sig),
    new TextEncoder().encode(body),
  );
  if (!ok) return null;
  let payload;
  try { payload = JSON.parse(b64u.decStr(body)); } catch { return null; }
  if (payload.typ !== expectedTyp) return null;
  if (typeof payload.exp !== "number" || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

async function sha256b64u(input) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return b64u.enc(hash);
}

export const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Mcp-Protocol-Version",
};

function oauthJson(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

export function handleProtectedResourceMetadata(url) {
  return oauthJson({
    resource: `${url.origin}/mcp`,
    authorization_servers: [url.origin],
    bearer_methods_supported: ["header"],
  });
}

export function handleAuthServerMetadata(url) {
  return oauthJson({
    issuer: url.origin,
    authorization_endpoint: `${url.origin}/authorize`,
    token_endpoint: `${url.origin}/token`,
    registration_endpoint: `${url.origin}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: ["mcp"],
    // RFC 8707 — clients SHOULD send `resource` at /authorize and /token
    // so tokens are audience-bound to this MCP server.
    resource_indicators_supported: true,
  });
}

export async function handleRegister(request) {
  let body = {};
  try { body = await request.json(); } catch {}
  return oauthJson({
    client_id: "mcp-public-client",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    redirect_uris: body.redirect_uris ?? [],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, 201);
}

// Only round-trip standard OAuth/PKCE parameters through the login form.
// Attacker-controlled keys would otherwise ride through `/authorize` → POST
// unchanged; keeping this tight avoids surprises if Notion/Todoist/other
// clients start emitting non-standard params we haven't reviewed.
const ALLOWED_AUTHZ_PARAMS = new Set([
  "response_type", "client_id", "redirect_uri", "scope", "state",
  "code_challenge", "code_challenge_method", "resource",
  "prompt", "nonce", "audience",
]);

function loginPage(params, errorMsg) {
  const hidden = Object.entries(params)
    .filter(([k]) => ALLOWED_AUTHZ_PARAMS.has(k))
    .map(([k, v]) => `<input type="hidden" name="${k}" value="${escapeHtml(v ?? "")}">`)
    .join("");
  const err = errorMsg ? `<p style="color:#b00">${escapeHtml(errorMsg)}</p>` : "";
  return new Response(
    `<!doctype html><html><head><meta charset="utf-8"><title>MCP Sign-in</title>
<style>body{font-family:system-ui;max-width:420px;margin:80px auto;padding:0 20px}
input[type=password]{width:100%;padding:10px;font-size:16px;box-sizing:border-box}
button{margin-top:12px;padding:10px 20px;font-size:16px;cursor:pointer}</style></head>
<body><h2>MCP Server Sign-in</h2>
<p>Enter your login secret (<code>MCP_LOGIN_SECRET</code>) to authorize this client.</p>
${err}<form method="POST" action="/authorize">${hidden}
<input type="password" name="secret" autofocus required>
<button type="submit">Authorize</button></form></body></html>`,
    { status: errorMsg ? 401 : 200, headers: { "Content-Type": "text/html; charset=utf-8" } },
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export async function handleAuthorize(request, url, env) {
  if (request.method === "GET") {
    const p = Object.fromEntries(url.searchParams);
    if (!p.redirect_uri || !p.code_challenge || p.code_challenge_method !== "S256") {
      return new Response("invalid_request: redirect_uri and PKCE S256 required", { status: 400 });
    }
    // Block phishing / code-harvesting flows where an attacker crafts an
    // authorize URL pointing to their own host. Without an allowlist, a
    // user who logs in under the attacker's flow would forward the code
    // to the attacker (who owns the matching verifier).
    if (!redirectHostAllowed(p.redirect_uri, env)) {
      return new Response("invalid_request: redirect_uri host not allowed", { status: 400 });
    }
    return loginPage(p);
  }
  if (request.method === "POST") {
    const form = await request.formData();
    const p = Object.fromEntries(form);
    // Re-check on POST — the hidden field could have been rewritten by a
    // client-side tool before submission, and we must not mint a code for
    // a host that wasn't allowed at GET time.
    if (!p.redirect_uri || !redirectHostAllowed(p.redirect_uri, env)) {
      return new Response("invalid_request: redirect_uri host not allowed", { status: 400 });
    }
    const expectedLogin = getLoginSecret(env);
    const submitted = typeof p.secret === "string" ? p.secret : "";
    const ok = expectedLogin ? await secretsEqual(submitted, expectedLogin) : false;
    if (!ok) {
      // Raise the per-attempt cost a bit — Workers have no built-in rate
      // limit and we don't want to introduce KV just for this. The delay
      // is advisory; run Cloudflare WAF/Rate-Limiting Rules on /authorize
      // POST for real brute-force protection (see README).
      await new Promise(r => setTimeout(r, 250));
      // Strip the submitted secret so it isn't echoed back into the HTML
      // (view-source leak, browser history, shared-screen exposure).
      const { secret: _drop, ...safeParams } = p;
      return loginPage(safeParams, "Invalid secret");
    }
    const code = await signToken({
      typ: "code",
      exp: Math.floor(Date.now() / 1000) + 300,
      cc: p.code_challenge,
      ru: p.redirect_uri,
      ci: p.client_id || "mcp-public-client",
      // RFC 8707 resource indicator — always bind an audience so every
      // issued token is scoped. If the client didn't specify one, default
      // to this MCP resource URL. Prevents tokens from ever being
      // unscoped in case this Worker is ever paired with another RS.
      aud: p.resource || `${url.origin}/mcp`,
    }, env);
    const redirect = new URL(p.redirect_uri);
    redirect.searchParams.set("code", code);
    if (p.state) redirect.searchParams.set("state", p.state);
    return new Response(null, { status: 302, headers: { Location: redirect.toString() } });
  }
  return new Response("Method Not Allowed", { status: 405 });
}

export async function handleToken(request, env) {
  try {
    return await handleTokenInner(request, env);
  } catch {
    // Never echo request body, headers, or internal error details.
    // Raw token-endpoint bodies contain secrets (authorization_code,
    // code_verifier, refresh_token) and must not reach response bodies
    // or unhandled-exception logs on the Cloudflare runtime side.
    return oauthJson({ error: "server_error" }, 500);
  }
}

async function handleTokenInner(request, env) {
  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });
  const form = await request.formData();
  const grant = form.get("grant_type");
  const now = Math.floor(Date.now() / 1000);

  if (grant === "authorization_code") {
    const code = form.get("code");
    const verifier = form.get("code_verifier");
    const redirectUri = form.get("redirect_uri");
    const clientId = form.get("client_id");
    const resource = form.get("resource");
    const payload = await verifyToken(code ?? "", "code", env).catch(() => null);
    if (!payload) return oauthJson({ error: "invalid_grant" }, 400);
    if (payload.ru !== redirectUri) return oauthJson({ error: "invalid_grant" }, 400);
    // client_id must match the value bound at /authorize if the client sends one.
    if (clientId && payload.ci && clientId !== payload.ci) {
      return oauthJson({ error: "invalid_grant" }, 400);
    }
    // If /authorize bound a resource, the /token call must ask for the same one
    // (or omit it). This enforces RFC 8707 audience restriction end-to-end.
    if (resource && payload.aud && resource !== payload.aud) {
      return oauthJson({ error: "invalid_target" }, 400);
    }
    const challenge = await sha256b64u(verifier ?? "");
    if (challenge !== payload.cc) return oauthJson({ error: "invalid_grant" }, 400);
    const aud = payload.aud || resource || null;
    const access = await signToken({
      typ: "access",
      exp: now + 3600,
      ci: payload.ci,
      ...(aud ? { aud } : {}),
    }, env);
    const refresh = await signToken({
      typ: "refresh",
      exp: now + 60 * 60 * 24 * 30,
      ci: payload.ci,
      ...(aud ? { aud } : {}),
    }, env);
    return oauthJson({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: refresh,
      scope: "mcp",
    });
  }

  if (grant === "refresh_token") {
    const rt = form.get("refresh_token");
    const resource = form.get("resource");
    const payload = await verifyToken(rt ?? "", "refresh", env).catch(() => null);
    if (!payload) return oauthJson({ error: "invalid_grant" }, 400);
    // Down-scoping is allowed only if the new resource matches the original.
    if (resource && payload.aud && resource !== payload.aud) {
      return oauthJson({ error: "invalid_target" }, 400);
    }
    const access = await signToken({
      typ: "access",
      exp: now + 3600,
      ci: payload.ci,
      ...(payload.aud ? { aud: payload.aud } : {}),
    }, env);
    return oauthJson({
      access_token: access,
      token_type: "Bearer",
      expires_in: 3600,
      scope: "mcp",
    });
  }

  return oauthJson({ error: "unsupported_grant_type" }, 400);
}
