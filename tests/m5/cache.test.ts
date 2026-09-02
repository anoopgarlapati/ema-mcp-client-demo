import { describe, expect, it, mock } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statSync } from "node:fs";
import { FileTokenCache } from "../../src/tokenCache.ts";
import { AppSession } from "../../src/app.ts";
import type { ResolvedSettings } from "../../src/config.ts";

describe("M5 token cache", () => {
  it("writes cache file with 0600 permissions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ema-m5-"));
    const path = join(dir, "tokens.json");
    const cache = new FileTokenCache(path);
    await cache.save({
      idToken: "id.jwt",
      refreshToken: "rt",
      obtainedAt: Date.now(),
    });
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("reuses a still-valid refresh token and does not open the browser", async () => {
    const openUrl = mock();
    const settings: ResolvedSettings = {
      identity: {
        provider: "idenx",
        issuer: "https://idp.xaa.dev",
        clientId: "client_abc",
        clientSecret: "s",
        redirectUri: "http://localhost:8734/callback",
        scopes: ["openid", "offline_access"],
      },
      xaa: {
        authorizationServer: "https://auth.resource.xaa.dev",
        resourceClientId: "rc",
        resourceClientSecret: "rs",
        scopes: ["todos.read"],
      },
      servers: [{ name: "s", url: "https://mcp.xaa.dev/mcp", ema: true }],
      tokenCache: { path: "/tmp/x.json" },
    };
    const fetchFn = mock(async (url: string, init?: RequestInit) => {
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
        expect(String(init?.body)).toContain("refresh_token");
        return new Response(
          JSON.stringify({ access_token: "jag", issued_token_type: "urn:ietf:params:oauth:token-type:id-jag" }),
        );
      }
      if (String(url) === "https://auth.resource.xaa.dev/token") {
        return new Response(JSON.stringify({ access_token: "at", expires_in: 7200 }));
      }
      const rpc = JSON.parse(String(init?.body ?? "{}"));
      if (rpc.method === "initialize") {
        return new Response(
          JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "t", version: "1" } } }),
        );
      }
      return new Response(null, { status: 202 });
    });
    const session = new AppSession({ fetchFn, openUrl, waitForCode: async () => ({ code: "nope", state: "nope" }) });
    const exp = Math.floor(Date.now() / 1000) + 3600;
    await session.connect(settings, "s", {
      cached: {
        idToken: ["h", Buffer.from(JSON.stringify({ aud: "client_abc", exp })).toString("base64url"), "s"].join("."),
        refreshToken: "rt-live",
        obtainedAt: Date.now(),
      },
    });
    expect(openUrl).not.toHaveBeenCalled();
    expect(session.status).toBe("connected");
  });
});
