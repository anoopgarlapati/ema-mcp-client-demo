import { generatePkce, generateState } from "./pkce.ts";
import { decodeJwtClaims, isExpired, type JwtClaims } from "./jwtClaims.ts";

export class OidcError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "OidcError";
  }
}

export type FetchFn = typeof fetch;

export function buildAuthorizationRequest(opts: {
  issuer: string;
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
  pkce?: { verifier: string; challenge: string };
}) {
  const pkce = opts.pkce ?? generatePkce();
  const state = opts.state ?? generateState();
  const url = new URL(opts.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scopes.join(" "));
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", pkce.challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return { url: url.toString(), state, codeVerifier: pkce.verifier };
}

async function readOAuthJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { error: text };
  }
  if (!res.ok || json.error) {
    const code = String(json.error ?? res.status);
    throw new OidcError(`${code}: ${String(json.error_description ?? res.statusText)}`, code);
  }
  return json;
}

export async function exchangeAuthorizationCode(
  opts: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    code: string;
    codeVerifier: string;
  },
  fetchFn: FetchFn = fetch,
) {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
    code_verifier: opts.codeVerifier,
  });
  const res = await fetchFn(opts.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await readOAuthJson(res);
  const idToken = String(json.id_token ?? "");
  if (!idToken) throw new OidcError("token response missing id_token");
  const claims = decodeJwtClaims(idToken);
  const aud = claims.aud;
  const audOk = aud === opts.clientId || (Array.isArray(aud) && aud.includes(opts.clientId));
  if (!audOk) throw new OidcError(`ID token aud does not match client_id`);
  return {
    idToken,
    refreshToken: json.refresh_token ? String(json.refresh_token) : undefined,
    idTokenClaims: claims as JwtClaims,
    expired: isExpired(claims),
  };
}

export async function discoverOidc(issuer: string, fetchFn: FetchFn = fetch) {
  const base = issuer.replace(/\/$/, "");
  const url = `${base}/.well-known/openid-configuration`;
  const res = await fetchFn(url);
  if (!res.ok) throw new OidcError(`OIDC discovery failed: ${res.status}`);
  return (await res.json()) as {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
  };
}
