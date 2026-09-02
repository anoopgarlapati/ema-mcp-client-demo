export function renderPage(state: {
  status: "disconnected" | "awaiting_login" | "connected";
  log: unknown[];
  claims: unknown;
  result: unknown;
  lastError: string | null;
  authorizeUrl: string | null;
}): string {
  const mcpDisabled = state.status !== "connected";
  return `<!doctype html>
<html lang="en">
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>EMA MCP client</title>
<style>
  :root {
    --bg: #f4f4f1;
    --card: #fff;
    --ink: #1c1c1a;
    --muted: #5c5c56;
    --line: #dddcd6;
    --accent: #1f5c45;
    --danger: #8b2e2e;
    --focus: #1f5c45;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.45 "IBM Plex Sans", "Segoe UI", system-ui, sans-serif;
    color: var(--ink);
    background: var(--bg);
    overflow-x: hidden;
  }
  header {
    padding: 1.25rem 1.5rem 0.5rem;
    max-width: 72rem;
    width: 100%;
    margin: 0 auto;
  }
  header p { margin: 0.25rem 0 0; color: var(--muted); font-size: 0.95rem; }
  h1 { font-size: 1.25rem; font-weight: 650; margin: 0; }
  h2 { font-size: 0.82rem; letter-spacing: 0.04em; text-transform: uppercase; color: var(--muted); margin: 0 0 0.85rem; }
  main {
    max-width: 72rem;
    width: 100%;
    margin: 0 auto;
    padding: 1rem 1.5rem 2.5rem;
    display: grid;
    gap: 1rem;
    grid-template-columns: 1fr;
  }
  @media (min-width: 960px) {
    main { grid-template-columns: minmax(0, 1.15fr) minmax(0, 0.85fr); align-items: start; }
  }
  .card {
    background: var(--card);
    border: 1px solid var(--line);
    padding: 1.1rem 1.15rem 1.2rem;
    min-width: 0;
    overflow: hidden;
  }
  .grid { display: grid; gap: 0.75rem 1rem; }
  @media (min-width: 640px) {
    .grid.two { grid-template-columns: 1fr 1fr; }
  }
  label { display: flex; flex-direction: column; gap: 0.28rem; font-size: 0.8rem; color: var(--muted); }
  input, select, textarea {
    font: inherit;
    color: var(--ink);
    border: 1px solid var(--line);
    background: #fff;
    padding: 0.45rem 0.55rem;
    width: 100%;
  }
  input:focus, select:focus, textarea:focus { outline: 2px solid var(--focus); outline-offset: 1px; }
  .check { flex-direction: row; align-items: center; gap: 0.5rem; }
  .check input { width: auto; }
  .actions { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-top: 0.4rem; }
  button {
    font: inherit;
    border: 1px solid var(--ink);
    background: var(--ink);
    color: #fff;
    padding: 0.45rem 0.8rem;
    cursor: pointer;
  }
  button.secondary { background: #fff; color: var(--ink); }
  button:disabled { opacity: 0.45; cursor: not-allowed; }
  #error {
    display: none;
    margin-top: 0.75rem;
    padding: 0.6rem 0.7rem;
    border: 1px solid var(--danger);
    color: var(--danger);
    font-size: 0.9rem;
  }
  #error.show { display: block; }
  .status-row { display: flex; justify-content: space-between; gap: 1rem; align-items: baseline; margin-bottom: 0.75rem; }
  #status { font-weight: 650; }
  #login-link { display: none; margin: 0.5rem 0 0.75rem; }
  #login-link.show { display: block; }
  #login-link a { color: var(--accent); }
  pre {
    margin: 0;
    background: #f7f4ee;
    border: 1px solid var(--line);
    padding: 0.7rem;
    overflow: auto;
    font-size: 0.78rem;
    max-height: 16rem;
    max-width: 100%;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    word-break: break-word;
  }
  .stack { display: grid; gap: 0.75rem; min-width: 0; }
  fieldset { border: 1px solid var(--line); padding: 0.9rem; min-width: 0; }
  legend { padding: 0 0.35rem; color: var(--muted); font-size: 0.8rem; }
</style>
<body>
<header>
  <h1>EMA MCP client</h1>
  <p>Configure in this page, then Connect. MCP calls unlock after the XAA handshake.</p>
</header>
<main>
  <section class="card">
    <h2>Setup</h2>
    <form id="setup">
      <div class="grid two">
        <label>Provider
          <select name="provider">
            <option value="idenx">IdenX (xaa.dev)</option>
            <option value="okta">Okta</option>
          </select>
        </label>
        <label>Issuer <input name="issuer" value="https://idp.xaa.dev" required></label>
        <label>Client ID <input name="clientId" required autocomplete="off"></label>
        <label>Client secret <input name="clientSecret" type="password" required autocomplete="off"></label>
        <label>Resource client ID <input name="resourceClientId" required autocomplete="off"></label>
        <label>Resource client secret <input name="resourceClientSecret" type="password" required autocomplete="off"></label>
        <label>Authorization server <input name="authorizationServer" value="https://auth.resource.xaa.dev" required></label>
        <label>Redirect URI <input name="redirectUri" value="http://localhost:8734/callback" required></label>
        <label>OIDC scopes <input name="oidcScopes" value="openid profile email offline_access"></label>
        <label>Resource scopes <input name="xaaScopes" value="todos.read mcp.access"></label>
        <label>MCP server name <input name="serverName" value="xaa-playground" required></label>
        <label>MCP URL <input name="serverUrl" value="https://mcp.xaa.dev/mcp" required></label>
      </div>
      <p class="check"><label class="check"><input type="checkbox" name="ema" checked> Use EMA / XAA</label></p>
      <div class="actions">
        <button type="button" id="connect">Connect</button>
        <button type="button" id="disconnect" class="secondary">Disconnect</button>
      </div>
      <div id="error"></div>
    </form>
  </section>
  <div class="stack">
    <section class="card">
      <h2>Status</h2>
      <div class="status-row">
        <span>Connection</span>
        <span id="status">${state.status}</span>
      </div>
      <p id="login-link"${state.authorizeUrl ? ' class="show"' : ""}>
        <a href="${state.authorizeUrl ?? "#"}" target="_blank" rel="noreferrer">Open IdP login</a>
      </p>
      <div class="stack">
        <pre id="log">${escapeHtml(JSON.stringify(state.log, null, 2))}</pre>
        <pre id="claims">${escapeHtml(JSON.stringify(state.claims, null, 2))}</pre>
      </div>
    </section>
    <section class="card">
      <h2>MCP</h2>
      <fieldset id="mcp-console" ${mcpDisabled ? "disabled" : ""}>
        <legend>Requests</legend>
        <div class="actions">
          <button type="button" data-mcp="tools/list">List tools</button>
          <button type="button" data-mcp="resources/list">List resources</button>
        </div>
        <label>Resource URI
          <select id="resource-uri">
            <option>todo0://todos</option>
            <option>todo0://todos/completed</option>
            <option>todo0://todos/incomplete</option>
            <option>todo0://todos/stats</option>
          </select>
        </label>
        <div class="actions"><button type="button" data-mcp="resources/read">Read resource</button></div>
        <label>Tool name <input id="tool-name"></label>
        <label>Tool args JSON <textarea id="tool-args" rows="3">{}</textarea></label>
        <div class="actions"><button type="button" data-mcp="tools/call">Call tool</button></div>
        <pre id="result">${escapeHtml(JSON.stringify(state.result, null, 2))}</pre>
      </fieldset>
    </section>
  </div>
</main>
<script src="/app.js"></script>
</body>
</html>`;
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
