const STORE = "ema-mcp-ui";
let pollTimer = null;

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function form() {
  return document.querySelector("#setup");
}

function collect() {
  const f = form();
  return {
    identity: {
      provider: f.provider.value,
      issuer: f.issuer.value.trim(),
      clientId: f.clientId.value.trim(),
      clientSecret: f.clientSecret.value,
      redirectUri: f.redirectUri.value.trim(),
      scopes: f.oidcScopes.value.split(/\s+/).filter(Boolean),
    },
    xaa: {
      authorizationServer: f.authorizationServer.value.trim(),
      resourceClientId: f.resourceClientId.value.trim(),
      resourceClientSecret: f.resourceClientSecret.value,
      scopes: f.xaaScopes.value.split(/\s+/).filter(Boolean),
    },
    servers: [
      {
        name: f.serverName.value.trim(),
        url: f.serverUrl.value.trim(),
        ema: f.ema.checked,
      },
    ],
  };
}

function fill(s) {
  if (!s) return;
  const f = form();
  const id = s.identity || {};
  const xaa = s.xaa || {};
  const server = (s.servers && s.servers[0]) || {};
  if (id.provider) f.provider.value = id.provider;
  if (id.issuer) f.issuer.value = id.issuer;
  if (id.clientId) f.clientId.value = id.clientId;
  if (id.clientSecret) f.clientSecret.value = id.clientSecret;
  if (id.redirectUri) f.redirectUri.value = id.redirectUri;
  if (id.scopes) f.oidcScopes.value = id.scopes.join(" ");
  if (xaa.authorizationServer) f.authorizationServer.value = xaa.authorizationServer;
  if (xaa.resourceClientId) f.resourceClientId.value = xaa.resourceClientId;
  if (xaa.resourceClientSecret) f.resourceClientSecret.value = xaa.resourceClientSecret;
  if (xaa.scopes) f.xaaScopes.value = xaa.scopes.join(" ");
  if (server.name) f.serverName.value = server.name;
  if (server.url) f.serverUrl.value = server.url;
  f.ema.checked = server.ema !== false;
}

function persist() {
  const data = collect();
  localStorage.setItem(STORE, JSON.stringify(data));
}

function restore() {
  try {
    const raw = localStorage.getItem(STORE);
    if (raw) fill(JSON.parse(raw));
  } catch {
    /* ignore */
  }
}

function showError(msg) {
  const el = document.querySelector("#error");
  if (!msg) {
    el.classList.remove("show");
    el.textContent = "";
    return;
  }
  el.textContent = msg;
  el.classList.add("show");
}

function paintStatus(s) {
  document.querySelector("#status").textContent = s.status;
  document.querySelector("#log").textContent = JSON.stringify(s.log, null, 2);
  document.querySelector("#claims").textContent = JSON.stringify(s.claims, null, 2);
  document.querySelector("#mcp-console").disabled = s.status !== "connected";
  const link = document.querySelector("#login-link");
  const a = link.querySelector("a");
  if (s.authorizeUrl) {
    a.href = s.authorizeUrl;
    link.classList.add("show");
  } else {
    link.classList.remove("show");
  }
  if (s.lastError) showError(s.lastError);
}

function stopPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function pollUntilSettled() {
  stopPoll();
  pollTimer = setInterval(async () => {
    try {
      const data = await api("/api/session");
      paintStatus(data.session);
      if (data.session.status === "connected") {
        stopPoll();
        showError(null);
      }
      if (data.session.status === "disconnected" && data.session.lastError) {
        stopPoll();
        showError(data.session.lastError);
      }
    } catch (e) {
      stopPoll();
      showError(String(e.message || e));
    }
  }, 500);
}

document.querySelector("#connect").onclick = async () => {
  showError(null);
  persist();
  document.querySelector("#status").textContent = "starting…";
  try {
    const settings = collect();
    const data = await api("/api/connect", {
      method: "POST",
      body: JSON.stringify({ settings, server: settings.servers[0].name }),
    });
    paintStatus(data.session);
    if (data.authorizeUrl) {
      window.open(data.authorizeUrl, "ema-idp", "width=480,height=720");
      pollUntilSettled();
    }
  } catch (e) {
    document.querySelector("#status").textContent = "disconnected";
    showError(String(e.message || e));
  }
};

document.querySelector("#disconnect").onclick = async () => {
  stopPoll();
  const s = await api("/api/disconnect", { method: "POST", body: "{}" });
  paintStatus(s.session);
};

document.querySelector("#mcp-console").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-mcp]");
  if (!btn || document.querySelector("#mcp-console").disabled) return;
  const op = btn.getAttribute("data-mcp");
  let extra = {};
  if (op === "resources/read") extra = { uri: document.querySelector("#resource-uri").value };
  if (op === "tools/call") {
    extra = {
      name: document.querySelector("#tool-name").value,
      arguments: JSON.parse(document.querySelector("#tool-args").value || "{}"),
    };
  }
  try {
    const data = await api("/api/mcp", { method: "POST", body: JSON.stringify({ op, ...extra }) });
    document.querySelector("#result").textContent = JSON.stringify(data.result, null, 2);
    showError(null);
    paintStatus(data.session);
    if (op === "resources/list" && data.result?.resources) {
      const sel = document.querySelector("#resource-uri");
      const current = sel.value;
      sel.innerHTML = data.result.resources
        .map((r) => `<option value="${r.uri}">${r.uri}</option>`)
        .join("");
      if ([...sel.options].some((o) => o.value === current)) sel.value = current;
    }
  } catch (err) {
    showError(String(err.message || err));
  }
});

form().addEventListener("change", persist);

restore();
api("/api/settings")
  .then((data) => {
    if (!localStorage.getItem(STORE)) fill(data.defaults);
    paintStatus(data.session);
  })
  .catch((e) => showError(String(e.message || e)));
