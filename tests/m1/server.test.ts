import { afterAll, describe, expect, it } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startServer } from "../../src/server.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");

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

  it("IdP login stays in the UI browser instead of spawning the OS default", async () => {
    const serverSrc = await readFile(join(root, "src/server.ts"), "utf8");
    expect(serverSrc).not.toMatch(/\bxdg-open\b/);
    expect(serverSrc).not.toMatch(/spawn\(/);
    expect(serverSrc).not.toContain("openBrowser");
    const ui = await readFile(join(root, "public/app.js"), "utf8");
    expect(ui).toMatch(/window\.open\(/);
  });
});
