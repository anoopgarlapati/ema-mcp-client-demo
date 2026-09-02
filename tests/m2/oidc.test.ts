import { describe, expect, it, mock } from "bun:test";
import { buildAuthorizationRequest, exchangeAuthorizationCode, OidcError } from "../../src/auth/oidcLogin.ts";
import { decodeJwtClaims, claimsForLog } from "../../src/auth/jwtClaims.ts";

function b64url(obj: object) {
  return Buffer.from(JSON.stringify(obj)).toString("base64url");
}

function fakeJwt(payload: object) {
  return `${b64url({ alg: "none" })}.${b64url(payload)}.sig`;
}

describe("M2 PKCE OIDC", () => {
  it("builds authorize URL with code, openid, PKCE S256, state, and redirect", () => {
    const req = buildAuthorizationRequest({
      issuer: "https://idp.xaa.dev",
      authorizationEndpoint: "https://idp.xaa.dev/authorize",
      clientId: "client_abc",
      redirectUri: "http://localhost:8734/callback",
      scopes: ["openid", "profile", "email", "offline_access"],
    });
    const url = new URL(req.url);
    expect(url.origin + url.pathname).toBe("https://idp.xaa.dev/authorize");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe("client_abc");
    expect(url.searchParams.get("redirect_uri")).toBe("http://localhost:8734/callback");
    expect(url.searchParams.get("scope")).toContain("openid");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("state")).toBe(req.state);
    expect(req.codeVerifier).toHaveLength(43);
  });

  it("exchanges code with client_secret_post (body, not Basic)", async () => {
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body);
      expect(body).toContain("grant_type=authorization_code");
      expect(body).toContain("client_id=client_abc");
      expect(body).toContain("client_secret=idp-secret");
      expect(body).toContain("code=abc");
      const headers = new Headers(init?.headers);
      expect(headers.get("authorization")).toBeNull();
      return new Response(
        JSON.stringify({
          id_token: fakeJwt({ aud: "client_abc", iss: "https://idp.xaa.dev", sub: "u1" }),
          refresh_token: "rt-1",
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const tokens = await exchangeAuthorizationCode(
      {
        tokenEndpoint: "https://idp.xaa.dev/token",
        clientId: "client_abc",
        clientSecret: "idp-secret",
        redirectUri: "http://localhost:8734/callback",
        code: "abc",
        codeVerifier: "verifier",
      },
      fetchFn,
    );
    expect(tokens.refreshToken).toBe("rt-1");
    expect(tokens.idTokenClaims.aud).toBe("client_abc");
  });

  it("rejects ID token whose aud does not match client_id", async () => {
    const fetchFn = mock(async () =>
      new Response(
        JSON.stringify({
          id_token: fakeJwt({ aud: "other", iss: "https://idp.xaa.dev" }),
        }),
        { status: 200 },
      ),
    );
    await expect(
      exchangeAuthorizationCode(
        {
          tokenEndpoint: "https://idp.xaa.dev/token",
          clientId: "client_abc",
          clientSecret: "secret",
          redirectUri: "http://localhost:8734/callback",
          code: "abc",
          codeVerifier: "v",
        },
        fetchFn,
      ),
    ).rejects.toThrow(/aud/i);
  });

  it("maps OAuth error codes from the token endpoint", async () => {
    const fetchFn = mock(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    );
    await expect(
      exchangeAuthorizationCode(
        {
          tokenEndpoint: "https://idp.xaa.dev/token",
          clientId: "c",
          clientSecret: "s",
          redirectUri: "http://localhost:8734/callback",
          code: "x",
          codeVerifier: "v",
        },
        fetchFn,
      ),
    ).rejects.toBeInstanceOf(OidcError);
    await expect(
      exchangeAuthorizationCode(
        {
          tokenEndpoint: "https://idp.xaa.dev/token",
          clientId: "c",
          clientSecret: "s",
          redirectUri: "http://localhost:8734/callback",
          code: "x",
          codeVerifier: "v",
        },
        fetchFn,
      ),
    ).rejects.toThrow(/invalid_grant/);
  });

  it("never puts raw JWT into log-safe claims", () => {
    const jwt = fakeJwt({ aud: "client_abc", sub: "u", iss: "https://idp.xaa.dev", exp: 1 });
    const claims = decodeJwtClaims(jwt);
    const logged = JSON.stringify(claimsForLog(jwt, claims));
    expect(logged).not.toContain(jwt);
    expect(logged).toContain("client_abc");
  });
});
