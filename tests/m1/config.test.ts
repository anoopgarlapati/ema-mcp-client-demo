import { describe, expect, it } from "bun:test";
import { parseSettings, playgroundDefaults, SettingsError } from "../../src/config.ts";
import { AppSession } from "../../src/app.ts";
import { renderPage } from "../../src/ui/page.ts";

const valid = {
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
};

describe("M1 settings schema", () => {
  it("parses UI payload including secrets", () => {
    const settings = parseSettings(valid);
    expect(settings.identity.issuer).toBe("https://idp.xaa.dev");
    expect(settings.identity.clientSecret).toBe("idp-secret");
    expect(settings.xaa.resourceClientSecret).toBe("rs-secret");
    expect(settings.servers[0].url).toBe("https://mcp.xaa.dev/mcp");
  });

  it("fails fast with the missing field name", () => {
    expect(() => parseSettings({ identity: { provider: "idenx" } })).toThrow(SettingsError);
    expect(() => parseSettings({ identity: { provider: "idenx" } })).toThrow(/identity\.(issuer|clientId|clientSecret)/);
  });

  it("fails when client secret is missing", () => {
    const { identity, ...rest } = valid;
    expect(() => parseSettings({ ...rest, identity: { ...identity, clientSecret: "" } })).toThrow(
      /identity.clientSecret/,
    );
  });
});

describe("M1 MCP panel gated until connected", () => {
  it("starts disconnected so MCP ops are rejected", async () => {
    const session = new AppSession();
    expect(session.status).toBe("disconnected");
    await expect(session.listTools()).rejects.toThrow(/connected/i);
  });

  it("renders MCP controls disabled when disconnected", () => {
    const html = renderPage({ status: "disconnected", log: [], claims: null, result: null, lastError: null, authorizeUrl: null });
    expect(html).toMatch(/id="mcp-console"[^>]*disabled|fieldset[^>]*id="mcp-console"[^>]*disabled/);
    expect(html).toContain("Setup");
    expect(html).toContain("MCP");
  });

  it("enables MCP fieldset only when connected", () => {
    const html = renderPage({ status: "connected", log: [], claims: null, result: null, lastError: null, authorizeUrl: null });
    expect(html).not.toMatch(/id="mcp-console"\s+disabled/);
  });

  it("ships playground defaults for the UI", () => {
    const d = playgroundDefaults();
    expect(d.identity.issuer).toBe("https://idp.xaa.dev");
    expect(d.xaa.authorizationServer).toBe("https://auth.resource.xaa.dev");
    expect(d.servers[0].url).toBe("https://mcp.xaa.dev/mcp");
  });

  it("uses password inputs for secrets", () => {
    const html = renderPage({ status: "disconnected", log: [], claims: null, result: null, lastError: null, authorizeUrl: null });
    expect(html).toMatch(/name="clientSecret"[^>]*type="password"|type="password"[^>]*name="clientSecret"/);
    expect(html).toMatch(/name="resourceClientSecret"[^>]*type="password"|type="password"[^>]*name="resourceClientSecret"/);
  });

  it("wraps long result text so the page width stays fixed", () => {
    const html = renderPage({ status: "connected", log: [], claims: null, result: null, lastError: null, authorizeUrl: null });
    expect(html).toMatch(/overflow-wrap:\s*anywhere/);
    expect(html).toMatch(/white-space:\s*pre-wrap/);
  });
});
