import { afterAll, describe, expect, it } from "bun:test";
import { startServer } from "../../src/server.ts";

describe("M1 local UI server", () => {
  const url = "http://127.0.0.1:18734";
  const server = startServer(url);

  afterAll(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  );

  it("serves the single page with MCP disabled", async () => {
    const res = await fetch(url + "/");
    const html = await res.text();
    expect(html).toContain("Setup");
    expect(html).toContain('id="mcp-console"');
    expect(html).toMatch(/disabled/);
  });

  it("Connect uses posted UI settings and returns a visible error if they are incomplete", async () => {
    const res = await fetch(url + "/api/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ settings: { identity: { provider: "idenx" } } }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/identity\./);
  });
});
