import type { ResolvedSettings } from "./config.ts";
import { decodeJwtClaims, claimsForLog, isExpired } from "./auth/jwtClaims.ts";
import { discoverOidc, exchangeAuthorizationCode, buildAuthorizationRequest, type FetchFn } from "./auth/oidcLogin.ts";
import { exchangeIdJag, jwtBearerGrant } from "./auth/xaa.ts";
import { McpError, McpJsonRpc } from "./client/mcpJsonRpc.ts";
import type { CachedTokens } from "./tokenCache.ts";

export type Stage = "login" | "token_exchange" | "jwt_bearer" | "mcp_initialize";

export type LogEntry = {
  stage: Stage;
  ok: boolean;
  message: string;
  at: string;
};

export type ConnectionStatus = "disconnected" | "awaiting_login" | "connected";

export type AppDeps = {
  fetchFn?: FetchFn;
  openUrl?: (url: string) => Promise<void>;
  waitForCode?: (expectedState: string) => Promise<{ code: string; state: string }>;
};

type PendingLogin = {
  settings: ResolvedSettings;
  serverName: string;
  tokenEndpoint: string;
  state: string;
  codeVerifier: string;
};

export class AppSession {
  status: ConnectionStatus = "disconnected";
  log: LogEntry[] = [];
  lastError: string | null = null;
  authorizeUrl: string | null = null;
  claims: {
    idToken?: Record<string, unknown>;
    idJag?: Record<string, unknown>;
    accessToken?: Record<string, unknown>;
  } | null = null;
  lastOidcTokens: CachedTokens | null = null;
  lastCachePath: string | null = null;
  private mcp: McpJsonRpc | null = null;
  private pending: PendingLogin | null = null;
  private readonly fetchFn: FetchFn;
  private readonly openUrl: (url: string) => Promise<void>;
  private readonly waitForCode: (expectedState: string) => Promise<{ code: string; state: string }>;

  constructor(deps: AppDeps = {}) {
    this.fetchFn = deps.fetchFn ?? fetch;
    this.openUrl = deps.openUrl ?? (async () => {});
    this.waitForCode = deps.waitForCode ?? (async () => ({ code: "", state: "" }));
  }

  snapshot() {
    return {
      status: this.status,
      log: this.log,
      lastError: this.lastError,
      claims: this.claims,
      authorizeUrl: this.authorizeUrl,
    };
  }

  async disconnect() {
    this.mcp = null;
    this.pending = null;
    this.authorizeUrl = null;
    this.status = "disconnected";
  }

  async listTools() {
    return this.guard(this.requireMcp().listTools()) as Promise<{ tools: { name: string }[]; note?: string }>;
  }

  async listResources() {
    return this.guard(this.requireMcp().listResources()) as Promise<{ resources: { uri: string }[] }>;
  }

  async readResource(uri: string) {
    return this.guard(this.requireMcp().readResource(uri));
  }

  async callTool(name: string, args: Record<string, unknown>) {
    return this.guard(this.requireMcp().callTool(name, args));
  }

  /** Interactive UI: start OIDC and return the authorize URL. Does not wait. */
  async startConnect(settings: ResolvedSettings, serverName: string, opts: { cached?: CachedTokens | null } = {}) {
    this.resetAttempt();
    this.lastCachePath = settings.tokenCache.path;
    try {
      const server = this.server(settings, serverName);
      if (!server.ema) {
        await this.connectNoEma(server.url);
        return { authorizeUrl: null as string | null };
      }
      if (opts.cached?.refreshToken || (opts.cached?.idToken && !isExpired(decodeJwtClaims(opts.cached.idToken)))) {
        await this.stage("login", async () => {
          this.lastOidcTokens = opts.cached!;
          this.claims = { idToken: claimsForLog(opts.cached!.idToken, decodeJwtClaims(opts.cached!.idToken)) };
        });
        await this.runXaaAndMcp(settings, server, opts.cached!);
        return { authorizeUrl: null as string | null };
      }
      const oidc = await discoverOidc(settings.identity.issuer, this.fetchFn);
      const auth = buildAuthorizationRequest({
        issuer: settings.identity.issuer,
        authorizationEndpoint: oidc.authorization_endpoint,
        clientId: settings.identity.clientId,
        redirectUri: settings.identity.redirectUri,
        scopes: settings.identity.scopes,
      });
      this.pending = {
        settings,
        serverName,
        tokenEndpoint: oidc.token_endpoint,
        state: auth.state,
        codeVerifier: auth.codeVerifier,
      };
      this.authorizeUrl = auth.url;
      this.status = "awaiting_login";
      return { authorizeUrl: auth.url };
    } catch (e) {
      this.status = "disconnected";
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  async finishConnect(code: string, state: string) {
    const pending = this.pending;
    if (!pending) throw new Error("no login in progress");
    if (state !== pending.state) throw new Error("OIDC state mismatch");
    const server = this.server(pending.settings, pending.serverName);
    try {
      const tokens = await this.stage("login", async () => {
        const result = await exchangeAuthorizationCode(
          {
            tokenEndpoint: pending.tokenEndpoint,
            clientId: pending.settings.identity.clientId,
            clientSecret: pending.settings.identity.clientSecret,
            redirectUri: pending.settings.identity.redirectUri,
            code,
            codeVerifier: pending.codeVerifier,
          },
          this.fetchFn,
        );
        this.claims = { idToken: claimsForLog(result.idToken, result.idTokenClaims) };
        return {
          idToken: result.idToken,
          refreshToken: result.refreshToken,
          obtainedAt: Date.now(),
        };
      });
      this.lastOidcTokens = tokens;
      this.pending = null;
      this.authorizeUrl = null;
      await this.runXaaAndMcp(pending.settings, server, tokens);
    } catch (e) {
      this.status = "disconnected";
      this.mcp = null;
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  async connect(settings: ResolvedSettings, serverName: string, opts: { cached?: CachedTokens | null } = {}) {
    this.resetAttempt();
    this.lastCachePath = settings.tokenCache.path;
    const server = this.server(settings, serverName);
    try {
      if (!server.ema) {
        await this.connectNoEma(server.url);
        return;
      }
      const oidc = await discoverOidc(settings.identity.issuer, this.fetchFn);
      const tokens = await this.stage("login", async () => this.obtainOidc(settings, oidc, opts.cached));
      this.lastOidcTokens = tokens;
      await this.runXaaAndMcp(settings, server, tokens);
    } catch (e) {
      this.status = "disconnected";
      this.mcp = null;
      this.lastError = (e as Error).message;
      throw e;
    }
  }

  private server(settings: ResolvedSettings, serverName: string) {
    const server = settings.servers.find((s) => s.name === serverName);
    if (!server) throw new Error(`unknown server: ${serverName}`);
    return server;
  }

  private resetAttempt() {
    this.log = [];
    this.lastError = null;
    this.status = "disconnected";
    this.mcp = null;
    this.pending = null;
    this.authorizeUrl = null;
  }

  private async connectNoEma(url: string) {
    this.mcp = new McpJsonRpc(url, this.fetchFn);
    await this.stage("mcp_initialize", async () => {
      await this.mcp!.initialize();
    });
    this.status = "connected";
  }

  private async runXaaAndMcp(
    settings: ResolvedSettings,
    server: { url: string; ema: boolean },
    tokens: CachedTokens,
  ) {
    const oidc = await discoverOidc(settings.identity.issuer, this.fetchFn);
    const subject = tokens.refreshToken
      ? { token: tokens.refreshToken, type: "urn:ietf:params:oauth:token-type:refresh_token" }
      : { token: tokens.idToken, type: "urn:ietf:params:oauth:token-type:id_token" };

    const jag = await this.stage("token_exchange", async () =>
      exchangeIdJag(
        {
          tokenEndpoint: oidc.token_endpoint,
          clientId: settings.identity.clientId,
          clientSecret: settings.identity.clientSecret,
          subjectToken: subject.token,
          subjectTokenType: subject.type,
          audience: settings.xaa.authorizationServer,
          resource: server.url,
          scope: settings.xaa.scopes.join(" "),
        },
        this.fetchFn,
      ),
    );
    try {
      this.claims = { ...(this.claims ?? {}), idJag: claimsForLog(jag.idJag, decodeJwtClaims(jag.idJag)) };
    } catch {
      /* mock tokens */
    }

    const at = await this.stage("jwt_bearer", async () =>
      jwtBearerGrant(
        {
          tokenEndpoint: `${settings.xaa.authorizationServer.replace(/\/$/, "")}/token`,
          resourceClientId: settings.xaa.resourceClientId,
          resourceClientSecret: settings.xaa.resourceClientSecret,
          assertion: jag.idJag,
          scope: settings.xaa.scopes.join(" "),
        },
        this.fetchFn,
      ),
    );
    try {
      this.claims = {
        ...(this.claims ?? {}),
        accessToken: claimsForLog(at.accessToken, decodeJwtClaims(at.accessToken)),
      };
    } catch {
      /* mock */
    }

    this.mcp = new McpJsonRpc(server.url, this.fetchFn, at.accessToken);
    await this.stage("mcp_initialize", async () => {
      await this.mcp!.initialize();
    });
    this.status = "connected";
  }

  private requireMcp() {
    if (this.status !== "connected" || !this.mcp) {
      throw new Error("MCP requests are disabled until connected");
    }
    return this.mcp;
  }

  private async guard<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (e) {
      if (e instanceof McpError && (e.status === 401 || e.status === 403)) {
        await this.disconnect();
      }
      throw e;
    }
  }

  private async obtainOidc(
    settings: ResolvedSettings,
    oidc: { authorization_endpoint: string; token_endpoint: string },
    cached?: CachedTokens | null,
  ) {
    if (cached?.refreshToken) {
      const claims = decodeJwtClaims(cached.idToken);
      this.claims = { idToken: claimsForLog(cached.idToken, claims) };
      return cached;
    }
    if (cached?.idToken && !isExpired(decodeJwtClaims(cached.idToken))) {
      const claims = decodeJwtClaims(cached.idToken);
      this.claims = { idToken: claimsForLog(cached.idToken, claims) };
      return cached;
    }
    const auth = buildAuthorizationRequest({
      issuer: settings.identity.issuer,
      authorizationEndpoint: oidc.authorization_endpoint,
      clientId: settings.identity.clientId,
      redirectUri: settings.identity.redirectUri,
      scopes: settings.identity.scopes,
    });
    await this.openUrl(auth.url);
    const cb = await this.waitForCode(auth.state);
    if (cb.state !== auth.state) throw new Error("OIDC state mismatch");
    const tokens = await exchangeAuthorizationCode(
      {
        tokenEndpoint: oidc.token_endpoint,
        clientId: settings.identity.clientId,
        clientSecret: settings.identity.clientSecret,
        redirectUri: settings.identity.redirectUri,
        code: cb.code,
        codeVerifier: auth.codeVerifier,
      },
      this.fetchFn,
    );
    this.claims = { idToken: claimsForLog(tokens.idToken, tokens.idTokenClaims) };
    return {
      idToken: tokens.idToken,
      refreshToken: tokens.refreshToken,
      obtainedAt: Date.now(),
    };
  }

  private async stage<T>(stage: Stage, fn: () => Promise<T>): Promise<T> {
    try {
      const result = await fn();
      this.log.push({ stage, ok: true, message: "ok", at: new Date().toISOString() });
      return result;
    } catch (e) {
      this.log.push({ stage, ok: false, message: (e as Error).message, at: new Date().toISOString() });
      throw e;
    }
  }
}
