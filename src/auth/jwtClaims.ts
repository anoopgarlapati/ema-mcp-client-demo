export type JwtClaims = Record<string, unknown>;

export function decodeJwtClaims(jwt: string): JwtClaims {
  const parts = jwt.split(".");
  if (parts.length < 2) throw new Error("invalid JWT");
  const json = Buffer.from(parts[1], "base64url").toString("utf8");
  return JSON.parse(json) as JwtClaims;
}

const CLAIM_KEYS = ["iss", "aud", "sub", "client_id", "resource", "scope", "exp"] as const;

export function claimsForLog(_jwt: string, claims: JwtClaims): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of CLAIM_KEYS) {
    if (k in claims) out[k] = claims[k];
  }
  return out;
}

export function isExpired(claims: JwtClaims, skewSec = 30): boolean {
  const exp = claims.exp;
  if (typeof exp !== "number") return false;
  return exp < Date.now() / 1000 + skewSec;
}
