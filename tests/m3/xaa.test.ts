import { describe, expect, it, mock } from "bun:test";
import { exchangeIdJag, jwtBearerGrant, discoverResourceMetadata, XaaError } from "../../src/auth/xaa.ts";
import { AppSession } from "../../src/app.ts";
import type { ResolvedSettings } from "../../src/config.ts";

const settings: ResolvedSettings = {
  identity: {
    provider: "idenx",
    issuer: "https://idp.xaa.dev",
    clientId: "client_abc",
    clientSecret: "idp-secret",
    redirectUri: "http://localhost:8734/callback",
    scopes: ["openid", "profile", "email", "offline_access"],
  },
  xaa: {
    authorizationServer: "https://auth.resource.xaa.dev",
    resourceClientId: "client_abc-at-todo0",
    resourceClientSecret: "rs-secret",
    scopes: ["todos.read", "mcp.access"],
  },
  servers: [{ name: "xaa-playground", url: "https://mcp.xaa.dev/mcp", ema: true }],
  tokenCache: { path: "/tmp/unused.json" },
};

describe("M3 XAA token steps", () => {
  it("posts RFC 8693 token exchange with main client and MCP resource", async () => {
    const fetchFn = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://idp.xaa.dev/token");
      const body = String(init?.body);
      expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange");
      expect(body).toContain("requested_token_type=urn%3Aietf%3Aparams%3Aoauth%3Atoken-type%3Aid-jag");
      expect(body).toContain("audience=https%3A%2F%2Fauth.resource.xaa.dev");
      expect(body).toContain("resource=https%3A%2F%2Fmcp.xaa.dev%2Fmcp");
      expect(body).toContain("client_id=client_abc");
      expect(body).toContain("client_secret=idp-secret");
      return new Response(
        JSON.stringify({
          access_token: "idjag.jwt",
          issued_token_type: "urn:ietf:params:oauth:token-type:id-jag",
          token_type: "N_A",
          expires_in: 300,
        }),
        { status: 200 },
      );
    });
    const jag = await exchangeIdJag(
      {
        tokenEndpoint: "https://idp.xaa.dev/token",
        clientId: "client_abc",
        clientSecret: "idp-secret",
        subjectToken: "refresh-or-id",
        subjectTokenType: "urn:ietf:params:oauth:token-type:refresh_token",
        audience: "https://auth.resource.xaa.dev",
        resource: "https://mcp.xaa.dev/mcp",
        scope: "todos.read mcp.access",
      },
      fetchFn,
    );
    expect(jag.idJag).toBe("idjag.jwt");
  });

  it("uses resource client for RFC 7523 jwt-bearer", async () => {
    const fetchFn = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://auth.resource.xaa.dev/token");
      const body = String(init?.body);
      expect(body).toContain("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer");
      expect(body).toContain("assertion=idjag.jwt");
      expect(body).toContain("client_id=client_abc-at-todo0");
      expect(body).toContain("client_secret=rs-secret");
      expect(body).not.toContain("client_secret=idp-secret");
      return new Response(
        JSON.stringify({ access_token: "at.jwt", token_type: "Bearer", expires_in: 7200, scope: "todos.read" }),
        { status: 200 },
      );
    });
    const tok = await jwtBearerGrant(
      {
        tokenEndpoint: "https://auth.resource.xaa.dev/token",
        resourceClientId: "client_abc-at-todo0",
        resourceClientSecret: "rs-secret",
        assertion: "idjag.jwt",
        scope: "todos.read mcp.access",
      },
      fetchFn,
    );
    expect(tok.accessToken).toBe("at.jwt");
  });

  it("maps invalid_client from jwt-bearer", async () => {
    const fetchFn = mock(
      async () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }),
    );
    await expect(
      jwtBearerGrant(
        {
          tokenEndpoint: "https://auth.resource.xaa.dev/token",
          resourceClientId: "wrong",
          resourceClientSecret: "x",
          assertion: "jag",
          scope: "todos.read",
        },
        fetchFn,
      ),
    ).rejects.toBeInstanceOf(XaaError);
  });

  it("discovers RFC 9728 metadata from WWW-Authenticate path", async () => {
    const fetchFn = mock(async (url: string) => {
      if (url === "https://mcp.xaa.dev/mcp") {
        return new Response("{}", {
          status: 401,
          headers: {
            "WWW-Authenticate":
              'Bearer resource_metadata="https://mcp.xaa.dev/.well-known/oauth-protected-resource/mcp"',
          },
        });
      }
      return new Response(
        JSON.stringify({
          resource: "https://mcp.xaa.dev/mcp",
          authorization_servers: ["https://auth.resource.xaa.dev"],
        }),
        { status: 200 },
      );
    });
    const meta = await discoverResourceMetadata("https://mcp.xaa.dev/mcp", fetchFn);
    expect(meta.resource).toBe("https://mcp.xaa.dev/mcp");
    expect(meta.authorizationServers[0]).toBe("https://auth.resource.xaa.dev");
  });
});

describe("M3 connect enables MCP", () => {
  it("records stages and enables MCP after initialize", async () => {
    const session = new AppSession({
      fetchFn: mock(async (url: string, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("openid-configuration")) {
          return new Response(
            JSON.stringify({
              issuer: "https://idp.xaa.dev",
              authorization_endpoint: "https://idp.xaa.dev/authorize",
              token_endpoint: "https://idp.xaa.dev/token",
            }),
          );
        }
        if (u === "https://idp.xaa.dev/token") {
          const body = String(init?.body);
          if (body.includes("token-exchange")) {
            return new Response(JSON.stringify({ access_token: "jag", issued_token_type: "urn:ietf:params:oauth:token-type:id-jag" }));
          }
        }
        if (u === "https://auth.resource.xaa.dev/token") {
          return new Response(JSON.stringify({ access_token: "at", expires_in: 7200 }));
        }
        const rpc = JSON.parse(String(init?.body ?? "{}"));
        if (rpc.method === "initialize") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: rpc.id,
              result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "todo", version: "1" } },
            }),
            { headers: { "content-type": "application/json" } },
          );
        }
        if (rpc.method === "notifications/initialized") {
          return new Response(null, { status: 202 });
        }
        return new Response("no", { status: 500 });
      }),
      openUrl: async () => {},
      waitForCode: async () => ({ code: "c", state: "s" }),
    });
    await session.connect(settings, "xaa-playground", {
      cached: {
        idToken: ["a", Buffer.from(JSON.stringify({ aud: "client_abc", exp: 9_999_999_999 })).toString("base64url"), "b"].join("."),
        refreshToken: "rt",
        obtainedAt: Date.now(),
      },
    });
    expect(session.status).toBe("connected");
    expect(session.log.map((e) => e.stage)).toEqual([
      "login",
      "token_exchange",
      "jwt_bearer",
      "mcp_initialize",
    ]);
  });

  it("leaves MCP disabled when initialize fails", async () => {
    const session = new AppSession({
      fetchFn: mock(async (url: string, init?: RequestInit) => {
        if (String(url).includes("openid-configuration")) {
          return new Response(
            JSON.stringify({
              token_endpoint: "https://idp.xaa.dev/token",
              authorization_endpoint: "https://idp.xaa.dev/authorize",
              issuer: "https://idp.xaa.dev",
            }),
          );
        }
        if (String(url) === "https://idp.xaa.dev/token") {
          return new Response(JSON.stringify({ access_token: "jag", issued_token_type: "urn:ietf:params:oauth:token-type:id-jag" }));
        }
        if (String(url) === "https://auth.resource.xaa.dev/token") {
          return new Response(JSON.stringify({ access_token: "at", expires_in: 7200 }));
        }
        return new Response("fail", { status: 401 });
      }),
      openUrl: async () => {},
      waitForCode: async () => ({ code: "c", state: "s" }),
    });
    await expect(
      session.connect(settings, "xaa-playground", {
        cached: {
          idToken: ["a", Buffer.from(JSON.stringify({ aud: "client_abc", exp: 9_999_999_999 })).toString("base64url"), "b"].join("."),
          refreshToken: "rt",
          obtainedAt: Date.now(),
        },
      }),
    ).rejects.toThrow();
    expect(session.status).toBe("disconnected");
    await expect(session.listTools()).rejects.toThrow(/connected/i);
  });
});
