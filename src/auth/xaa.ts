import type { FetchFn } from "./oidcLogin.ts";

export class XaaError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = "XaaError";
  }
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
    throw new XaaError(`${code}: ${String(json.error_description ?? res.statusText)}`, code);
  }
  return json;
}

export async function exchangeIdJag(
  opts: {
    tokenEndpoint: string;
    clientId: string;
    clientSecret: string;
    subjectToken: string;
    subjectTokenType: string;
    audience: string;
    resource: string;
    scope: string;
  },
  fetchFn: FetchFn = fetch,
) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: opts.subjectToken,
    subject_token_type: opts.subjectTokenType,
    requested_token_type: "urn:ietf:params:oauth:token-type:id-jag",
    audience: opts.audience,
    resource: opts.resource,
    scope: opts.scope,
    client_id: opts.clientId,
    client_secret: opts.clientSecret,
  });
  const res = await fetchFn(opts.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await readOAuthJson(res);
  return { idJag: String(json.access_token), expiresIn: Number(json.expires_in ?? 300) };
}

export async function jwtBearerGrant(
  opts: {
    tokenEndpoint: string;
    resourceClientId: string;
    resourceClientSecret: string;
    assertion: string;
    scope: string;
  },
  fetchFn: FetchFn = fetch,
) {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: opts.assertion,
    scope: opts.scope,
    client_id: opts.resourceClientId,
    client_secret: opts.resourceClientSecret,
  });
  const res = await fetchFn(opts.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const json = await readOAuthJson(res);
  return {
    accessToken: String(json.access_token),
    expiresIn: Number(json.expires_in ?? 7200),
    scope: json.scope ? String(json.scope) : opts.scope,
  };
}

export async function discoverResourceMetadata(mcpUrl: string, fetchFn: FetchFn = fetch) {
  const probe = await fetchFn(mcpUrl, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} }),
  });
  const www = probe.headers.get("www-authenticate") ?? "";
  const metaUrl = /resource_metadata="([^"]+)"/.exec(www)?.[1];
  const url =
    metaUrl ??
    new URL("/.well-known/oauth-protected-resource", new URL(mcpUrl).origin).toString();
  const res = await fetchFn(url);
  if (!res.ok) throw new XaaError(`RFC 9728 discovery failed: ${res.status}`);
  const json = (await res.json()) as { resource?: string; authorization_servers?: string[] };
  return {
    resource: json.resource ?? mcpUrl,
    authorizationServers: json.authorization_servers ?? [],
  };
}
