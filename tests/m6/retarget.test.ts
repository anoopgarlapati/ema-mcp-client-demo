import { describe, expect, it, mock } from "bun:test";
import { parseSettings } from "../../src/config.ts";
import { AppSession } from "../../src/app.ts";
import type { ResolvedSettings } from "../../src/config.ts";

describe("M6 config retarget and ema:false", () => {
  it("accepts an Okta issuer with no code change (schema only)", () => {
    const s = parseSettings({
      identity: {
        provider: "okta",
        issuer: "https://example.okta.com/oauth2/default",
        clientId: "0oa123",
        clientSecret: "a",
        redirectUri: "http://localhost:8734/callback",
        scopes: ["openid", "profile", "email", "offline_access"],
      },
      xaa: {
        authorizationServer: "https://example.okta.com/oauth2/default",
        resourceClientId: "0oa123-at-sf",
        resourceClientSecret: "b",
        scopes: ["api"],
      },
      servers: [
        { name: "atlassian", url: "https://mcp.atlassian.com/v1/mcp", ema: true },
        { name: "salesforce", url: "https://your-salesforce-mcp.example.com", ema: false },
      ],
      tokenCache: { path: "/tmp/t.json" },
    });
    expect(s.identity.provider).toBe("okta");
    expect(s.servers.find((x) => x.name === "salesforce")?.ema).toBe(false);
    expect(s.servers.find((x) => x.name === "atlassian")?.url).toBe("https://mcp.atlassian.com/v1/mcp");
  });

  it("skips token exchange when ema is false", async () => {
    const settings: ResolvedSettings = {
      identity: {
        provider: "idenx",
        issuer: "https://idp.xaa.dev",
        clientId: "c",
        clientSecret: "s",
        redirectUri: "http://localhost:8734/callback",
        scopes: ["openid"],
      },
      xaa: {
        authorizationServer: "https://auth.resource.xaa.dev",
        resourceClientId: "rc",
        resourceClientSecret: "rs",
        scopes: ["todos.read"],
      },
      servers: [{ name: "salesforce", url: "https://example.com/mcp", ema: false }],
      tokenCache: { path: "/tmp/t.json" },
    };
    const fetchFn = mock(async (_url: string, init?: RequestInit) => {
      const rpc = JSON.parse(String(init?.body ?? "{}"));
      if (rpc.method === "initialize") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: rpc.id,
            result: { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "sf", version: "1" } },
          }),
        );
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response("no", { status: 500 });
    });
    const session = new AppSession({ fetchFn, openUrl: async () => {}, waitForCode: async () => ({ code: "c", state: "s" }) });
    await session.connect(settings, "salesforce");
    expect(session.status).toBe("connected");
    expect(session.log.map((e) => e.stage)).toEqual(["mcp_initialize"]);
    const urls = fetchFn.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("/token"))).toBe(false);
  });
});
