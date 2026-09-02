import { describe, expect, it, mock } from "bun:test";
import { AppSession } from "../../src/app.ts";
import type { ResolvedSettings } from "../../src/config.ts";

const settings: ResolvedSettings = {
  identity: {
    provider: "idenx",
    issuer: "https://idp.xaa.dev",
    clientId: "client_abc",
    clientSecret: "idp-secret",
    redirectUri: "http://localhost:8734/callback",
    scopes: ["openid"],
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

function mcpFetch() {
  return mock(async (url: string, init?: RequestInit) => {
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
      return new Response(
        JSON.stringify({ access_token: "jag", issued_token_type: "urn:ietf:params:oauth:token-type:id-jag" }),
      );
    }
    if (u === "https://auth.resource.xaa.dev/token") {
      return new Response(JSON.stringify({ access_token: "at", expires_in: 7200 }));
    }
    const rpc = JSON.parse(String(init?.body ?? "{}"));
    const headers = new Headers(init?.headers);
    expect(headers.get("accept")).toBe("application/json, text/event-stream");
    expect(headers.get("authorization")).toBe("Bearer at");
    if (rpc.method === "initialize") {
      return jsonRpc(rpc.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "t", version: "1" } });
    }
    if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
    if (rpc.method === "tools/list") {
      return jsonRpc(rpc.id, { tools: [{ name: "ping", inputSchema: { type: "object" } }] });
    }
    if (rpc.method === "tools/call") {
      return jsonRpc(rpc.id, { content: [{ type: "text", text: "pong" }] });
    }
    if (rpc.method === "resources/list") {
      return jsonRpc(rpc.id, { resources: [{ uri: "todo0://todos", name: "todos" }] });
    }
    if (rpc.method === "resources/read") {
      expect(rpc.params.uri).toBe("todo0://todos");
      return jsonRpc(rpc.id, {
        contents: [{ uri: "todo0://todos", mimeType: "application/json", text: '{"todos":[]}' }],
      });
    }
    return new Response("no", { status: 500 });
  });
}

function jsonRpc(id: unknown, result: unknown) {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), {
    headers: { "content-type": "application/json" },
  });
}

const cached = {
  idToken: ["h", Buffer.from(JSON.stringify({ aud: "client_abc", exp: 9_999_999_999 })).toString("base64url"), "s"].join("."),
  refreshToken: "rt",
  obtainedAt: Date.now(),
};

describe("M4 MCP requests", () => {
  it("lists tools, reads todo0://todos, and calls a tool after connect", async () => {
    const session = new AppSession({ fetchFn: mcpFetch(), openUrl: async () => {}, waitForCode: async () => ({ code: "c", state: "s" }) });
    await session.connect(settings, "xaa-playground", { cached });
    const tools = await session.listTools();
    expect(tools.tools[0].name).toBe("ping");
    const res = await session.readResource("todo0://todos");
    expect(JSON.stringify(res)).toContain("todo0://todos");
    const call = await session.callTool("ping", {});
    expect(JSON.stringify(call)).toContain("pong");
    const listed = await session.listResources();
    expect(listed.resources[0].uri).toBe("todo0://todos");
  });

  it("does not send MCP requests while disconnected", async () => {
    const fetchFn = mock();
    const session = new AppSession({ fetchFn, openUrl: async () => {}, waitForCode: async () => ({ code: "c", state: "s" }) });
    await expect(session.readResource("todo0://todos")).rejects.toThrow(/connected/i);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("disconnects and rejects MCP on 401", async () => {
    let n = 0;
    const fetchFn = mock(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("openid-configuration")) {
        return new Response(JSON.stringify({ token_endpoint: "https://idp.xaa.dev/token", authorization_endpoint: "https://idp.xaa.dev/authorize", issuer: "https://idp.xaa.dev" }));
      }
      if (u === "https://idp.xaa.dev/token" || u === "https://auth.resource.xaa.dev/token") {
        return new Response(JSON.stringify({ access_token: "x", issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", expires_in: 7200 }));
      }
      const rpc = JSON.parse(String(init?.body ?? "{}"));
      if (rpc.method === "initialize") return jsonRpc(rpc.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "t", version: "1" } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      n++;
      return new Response("nope", { status: 401 });
    });
    const session = new AppSession({ fetchFn, openUrl: async () => {}, waitForCode: async () => ({ code: "c", state: "s" }) });
    await session.connect(settings, "xaa-playground", { cached });
    await expect(session.listTools()).rejects.toThrow(/401/);
    expect(session.status).toBe("disconnected");
  });

  it("surfaces 406 Accept header errors", async () => {
    const fetchFn = mock(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("openid-configuration")) {
        return new Response(JSON.stringify({ token_endpoint: "https://idp.xaa.dev/token", authorization_endpoint: "https://idp.xaa.dev/authorize", issuer: "https://idp.xaa.dev" }));
      }
      if (u === "https://idp.xaa.dev/token" || u === "https://auth.resource.xaa.dev/token") {
        return new Response(JSON.stringify({ access_token: "x", issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", expires_in: 7200 }));
      }
      const rpc = JSON.parse(String(init?.body ?? "{}"));
      if (rpc.method === "initialize") return jsonRpc(rpc.id, { protocolVersion: "2025-03-26", capabilities: {}, serverInfo: { name: "t", version: "1" } });
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      return new Response("need accept", { status: 406 });
    });
    const session = new AppSession({ fetchFn, openUrl: async () => {}, waitForCode: async () => ({ code: "c", state: "s" }) });
    await session.connect(settings, "xaa-playground", { cached });
    await expect(session.listTools()).rejects.toThrow(/406/);
  });

  it("treats tools/list method-not-found as an empty tool list", async () => {
    const fetchFn = mock(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("openid-configuration")) {
        return new Response(JSON.stringify({ token_endpoint: "https://idp.xaa.dev/token", authorization_endpoint: "https://idp.xaa.dev/authorize", issuer: "https://idp.xaa.dev" }));
      }
      if (u === "https://idp.xaa.dev/token" || u === "https://auth.resource.xaa.dev/token") {
        return new Response(JSON.stringify({ access_token: "x", issued_token_type: "urn:ietf:params:oauth:token-type:id-jag", expires_in: 7200 }));
      }
      const rpc = JSON.parse(String(init?.body ?? "{}"));
      if (rpc.method === "initialize") {
        return jsonRpc(rpc.id, { protocolVersion: "2025-03-26", capabilities: { resources: {} }, serverInfo: { name: "t", version: "1" } });
      }
      if (rpc.method === "notifications/initialized") return new Response(null, { status: 202 });
      if (rpc.method === "tools/list") {
        return new Response(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, error: { code: -32601, message: "Method not found" } }));
      }
      return new Response("no", { status: 500 });
    });
    const session = new AppSession({ fetchFn, openUrl: async () => {}, waitForCode: async () => ({ code: "c", state: "s" }) });
    await session.connect(settings, "xaa-playground", { cached });
    const tools = await session.listTools();
    expect(tools.tools).toEqual([]);
    expect(tools.note).toMatch(/resources/i);
  });

  it("disconnect disables MCP again", async () => {
    const session = new AppSession({ fetchFn: mcpFetch(), openUrl: async () => {}, waitForCode: async () => ({ code: "c", state: "s" }) });
    await session.connect(settings, "xaa-playground", { cached });
    await session.disconnect();
    expect(session.status).toBe("disconnected");
    await expect(session.listTools()).rejects.toThrow(/connected/i);
  });
});
