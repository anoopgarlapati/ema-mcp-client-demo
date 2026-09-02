import { homedir } from "node:os";
import { z } from "zod";

export class SettingsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsError";
  }
}

const serverSchema = z.object({
  name: z.string().min(1),
  url: z.string().url(),
  ema: z.boolean(),
});

const settingsSchema = z.object({
  identity: z.object({
    provider: z.enum(["idenx", "okta"]),
    issuer: z.string().url(),
    clientId: z.string().min(1),
    clientSecret: z.string().min(1),
    redirectUri: z.string().url(),
    scopes: z.array(z.string()).min(1),
  }),
  xaa: z.object({
    authorizationServer: z.string().url(),
    resourceClientId: z.string().min(1),
    resourceClientSecret: z.string().min(1),
    scopes: z.array(z.string()).min(1),
  }),
  servers: z.array(serverSchema).min(1),
  tokenCache: z
    .object({
      path: z.string().min(1),
    })
    .optional(),
});

export type ResolvedSettings = z.infer<typeof settingsSchema> & {
  tokenCache: { path: string };
};

function zodPath(err: z.ZodError): string {
  const first = err.issues[0];
  const path = first?.path.join(".") || "settings";
  return `${path}: ${first?.message ?? "invalid"}`;
}

export function expandHome(p: string): string {
  return p.startsWith("~/") ? `${homedir()}/${p.slice(2)}` : p;
}

export function playgroundDefaults() {
  return {
    identity: {
      provider: "idenx" as const,
      issuer: "https://idp.xaa.dev",
      clientId: "",
      redirectUri: "http://localhost:8734/callback",
      scopes: ["openid", "profile", "email", "offline_access"],
    },
    xaa: {
      authorizationServer: "https://auth.resource.xaa.dev",
      resourceClientId: "",
      scopes: ["todos.read", "mcp.access"],
    },
    servers: [{ name: "xaa-playground", url: "https://mcp.xaa.dev/mcp", ema: true }],
  };
}

export function parseSettings(raw: unknown): ResolvedSettings {
  const parsed = settingsSchema.safeParse(raw);
  if (!parsed.success) throw new SettingsError(zodPath(parsed.error));
  return {
    ...parsed.data,
    tokenCache: { path: expandHome(parsed.data.tokenCache?.path ?? "~/.ema-client/tokens.json") },
  };
}

export function settingsPublic(settings: ResolvedSettings) {
  return {
    identity: {
      provider: settings.identity.provider,
      issuer: settings.identity.issuer,
      clientId: settings.identity.clientId,
      redirectUri: settings.identity.redirectUri,
      scopes: settings.identity.scopes,
    },
    xaa: {
      authorizationServer: settings.xaa.authorizationServer,
      resourceClientId: settings.xaa.resourceClientId,
      scopes: settings.xaa.scopes,
    },
    servers: settings.servers,
  };
}
