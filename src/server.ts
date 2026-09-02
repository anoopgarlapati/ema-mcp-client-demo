import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { AppSession } from "./app.ts";
import { parseSettings, playgroundDefaults } from "./config.ts";
import { FileTokenCache } from "./tokenCache.ts";
import { renderPage } from "./ui/page.ts";

const root = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(root, "..");

const session = new AppSession();

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(cmd, args, { stdio: "ignore", detached: true }).unref();
}

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  try {
    if (req.method === "GET" && url.pathname === "/callback") {
      const code = url.searchParams.get("code") ?? "";
      const state = url.searchParams.get("state") ?? "";
      try {
        await session.finishConnect(code, state);
        if (session.lastOidcTokens && session.lastCachePath) {
          await new FileTokenCache(session.lastCachePath).save(session.lastOidcTokens);
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<p>Login complete. Return to the app tab — it will finish connecting.</p>");
      } catch (e) {
        res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
        res.end(`<p>Login failed: ${escapeHtml((e as Error).message)}</p>`);
      }
      return;
    }
    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderPage({ ...session.snapshot(), result: null }));
      return;
    }
    if (req.method === "GET" && url.pathname === "/app.js") {
      const js = await readFile(join(projectRoot, "public/app.js"), "utf8");
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(js);
      return;
    }
    if (url.pathname === "/api/settings" && req.method === "GET") {
      return json(res, { defaults: playgroundDefaults(), session: session.snapshot() });
    }
    if (url.pathname === "/api/session" && req.method === "GET") {
      return json(res, { session: session.snapshot() });
    }
    if (url.pathname === "/api/connect" && req.method === "POST") {
      const body = await readJson(req);
      const settings = parseSettings(body.settings);
      const cache = new FileTokenCache(settings.tokenCache.path);
      const cached = await cache.load();
      const started = await session.startConnect(settings, body.server || settings.servers[0].name, { cached });
      if (started.authorizeUrl) openBrowser(started.authorizeUrl);
      if (session.lastOidcTokens && session.status === "connected") await cache.save(session.lastOidcTokens);
      return json(res, { session: session.snapshot(), authorizeUrl: started.authorizeUrl });
    }
    if (url.pathname === "/api/disconnect" && req.method === "POST") {
      await session.disconnect();
      return json(res, { session: session.snapshot() });
    }
    if (url.pathname === "/api/mcp" && req.method === "POST") {
      const body = await readJson(req);
      let result: unknown;
      if (body.op === "tools/list") result = await session.listTools();
      else if (body.op === "resources/list") result = await session.listResources();
      else if (body.op === "resources/read") result = await session.readResource(body.uri);
      else if (body.op === "tools/call") result = await session.callTool(body.name, body.arguments ?? {});
      else throw new Error("unknown op");
      return json(res, { result, session: session.snapshot() });
    }
    res.writeHead(404);
    res.end("not found");
  } catch (e) {
    json(res, { error: (e as Error).message, session: session.snapshot() }, 400);
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
}

function json(res: ServerResponse, body: unknown, status = 200) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

export function startServer(listenUrl = process.env.LISTEN_URL || "http://localhost:8734") {
  const port = Number(new URL(listenUrl).port || 8734);
  const host = new URL(listenUrl).hostname;
  return createServer(handle).listen(port, host, () => {
    console.log(`EMA MCP client http://${host}:${port}`);
  });
}

const isMain = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) startServer();
