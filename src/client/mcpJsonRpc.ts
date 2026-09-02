import type { FetchFn } from "../auth/oidcLogin.ts";

export class McpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly rpcCode?: number,
  ) {
    super(message);
    this.name = "McpError";
  }
}

const ACCEPT = "application/json, text/event-stream";
const METHOD_NOT_FOUND = -32601;

export class McpJsonRpc {
  private sessionId: string | undefined;
  private id = 1;
  private capabilities: Record<string, unknown> = {};

  constructor(
    private readonly url: string,
    private readonly fetchFn: FetchFn,
    private readonly accessToken?: string,
  ) {}

  async initialize() {
    const result = (await this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "ema-mcp-client-demo", version: "0.1.0" },
    })) as { capabilities?: Record<string, unknown> };
    this.capabilities = result?.capabilities ?? {};
    await this.notify("notifications/initialized", {});
    return result;
  }

  async listTools() {
    if (!this.supports("tools")) {
      return { tools: [], note: "This MCP server does not expose tools. Use List resources / Read resource." };
    }
    try {
      return await this.request("tools/list", {});
    } catch (e) {
      if (isMethodNotFound(e)) {
        return { tools: [], note: "This MCP server does not expose tools. Use List resources / Read resource." };
      }
      throw e;
    }
  }

  async callTool(name: string, args: Record<string, unknown>) {
    if (!this.supports("tools")) {
      throw new McpError("This MCP server does not expose tools. Use Read resource instead.");
    }
    try {
      return await this.request("tools/call", { name, arguments: args });
    } catch (e) {
      if (isMethodNotFound(e)) {
        throw new McpError("This MCP server does not expose tools. Use Read resource instead.");
      }
      throw e;
    }
  }

  async listResources() {
    return this.request("resources/list", {});
  }

  async readResource(uri: string) {
    return this.request("resources/read", { uri });
  }

  private supports(cap: string) {
    if (Object.keys(this.capabilities).length === 0) return true;
    return cap in this.capabilities;
  }

  private async notify(method: string, params: unknown) {
    await this.send({ jsonrpc: "2.0", method, params }, true);
  }

  async request(method: string, params: unknown) {
    const id = this.id++;
    const res = await this.send({ jsonrpc: "2.0", id, method, params }, false);
    if (res.status === 401 || res.status === 403 || res.status === 406) {
      throw new McpError(`${res.status} ${res.statusText || "MCP error"}`, res.status);
    }
    if (!res.ok) throw new McpError(`${res.status} ${res.statusText}`, res.status);
    const payload = await parseBody(res);
    if (payload?.error) {
      const err = payload.error as { code?: number; message?: string };
      throw new McpError(typeof err === "object" ? (err.message ?? JSON.stringify(err)) : String(err), res.status, typeof err?.code === "number" ? err.code : undefined);
    }
    return payload.result;
  }

  private async send(body: unknown, notification: boolean) {
    const headers: Record<string, string> = {
      accept: ACCEPT,
      "content-type": "application/json",
    };
    if (this.accessToken) headers.authorization = `Bearer ${this.accessToken}`;
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId;
    const res = await this.fetchFn(this.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const sid = res.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (notification) return res;
    return res;
  }
}

function isMethodNotFound(e: unknown) {
  return e instanceof McpError && (e.rpcCode === METHOD_NOT_FOUND || /method not found/i.test(e.message));
}

async function parseBody(res: Response): Promise<{ result?: unknown; error?: unknown }> {
  const text = await res.text();
  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("text/event-stream")) {
    for (const line of text.split("\n")) {
      if (line.startsWith("data:")) {
        return JSON.parse(line.slice(5).trim());
      }
    }
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}
