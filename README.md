# EMA MCP client demo

Local requesting app for Cross App Access / EMA against an MCP server. Configure everything in the UI.

## Prerequisites

- [Bun](https://bun.sh) 1.3+
- An OAuth client registered at [xaa.dev/developer/register](https://xaa.dev/developer/register)

## Register on xaa.dev

1. Open [Test Your Requesting App](https://xaa.dev/developer/register).
2. Use any email (namespacing key, no password).
3. Redirect URI must match exactly: `http://localhost:8734/callback`
4. Connect to the playground MCP resource (`todos.read`, `mcp.access`).
5. Copy **both** clients from the modal:
   - Main client ID + secret (OIDC and token exchange)
   - Resource client `{id}-at-…` + secret (JWT bearer)

## Run

```bash
bun install
bun start
```

Open [http://localhost:8734](http://localhost:8734). Playground URLs are pre-filled.

1. Paste client ID, client secret, resource client ID, and resource client secret.
2. Click **Connect**. An IdenX window should open (any email, any 6-digit code). If it does not, use **Open IdP login**.
3. After login, the status log should show `login` → `token_exchange` → `jwt_bearer` → `mcp_initialize`.
4. The MCP panel enables when status is `connected`.

Settings stay in this browser (`localStorage`). Secrets are not written to a repo file. Tokens are cached at `~/.ema-client/tokens.json` (mode `0600`).

If you previously used `settings.yaml`, you can ignore it. The server no longer reads it.

Optional: `LISTEN_URL` (default `http://localhost:8734`). Keep the registered redirect in sync if you change the port.

## Tests

```bash
bun test
```

Milestone suites: `bun run test:m1` … `test:m6`.

## Spec

[docs/PRD-mcp-ema-client.md](docs/PRD-mcp-ema-client.md)

## License

MIT. Copyright (c) 2026 Anoop Garlapati. See [LICENSE](LICENSE).
