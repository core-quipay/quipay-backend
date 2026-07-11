import { Request, Response, NextFunction } from "express";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config";
import { logger } from "../logger";

// Single source of truth — config/index.ts runs dotenv and fail-fast validation
// at load, so importing it here also guarantees that check runs at boot.
function getPrivyAppId() { return config.privy.appId; }

// Lazy-initialise JWKS per app ID; reset if app ID changes (shouldn't happen in prod).
let cachedAppId = "";
let PRIVY_JWKS: ReturnType<typeof createRemoteJWKSet> | null = null;
function getOrInitJWKS() {
  const appId = getPrivyAppId();
  if (!appId) {
    logger.warn("PRIVY_APP_ID is not set — Privy auth will reject all requests");
    PRIVY_JWKS = null;
    return null;
  }
  if (!PRIVY_JWKS || cachedAppId !== appId) {
    cachedAppId = appId;
    PRIVY_JWKS = createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`)
    );
  }
  return PRIVY_JWKS;
}

export interface PrivyClaims {
  sub:   string;   // Privy DID: "did:privy:xxxx"
  iss:   string;   // "privy.io"
  aud:   string;   // your app ID
  iat:   number;
  exp:   number;
}

declare global {
  namespace Express {
    interface Request {
      privyUser?: PrivyClaims;
    }
  }
}

/**
 * Verifies a raw Privy JWT against Privy's JWKS and returns its claims.
 * Throws if the token is missing, malformed, expired, or the signature
 * doesn't check out. Shared by the mobile-facing middleware below and by
 * rbac.ts, so there is exactly one place that does real Privy verification.
 */
export async function verifyPrivyJwt(token: string): Promise<PrivyClaims> {
  const jwks = getOrInitJWKS();
  if (!jwks) {
    throw new Error("Auth not configured: PRIVY_APP_ID is not set");
  }
  const { payload } = await jwtVerify(token, jwks, {
    issuer:   "privy.io",
    audience: getPrivyAppId(),
  });
  return payload as unknown as PrivyClaims;
}

export async function requirePrivyAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  try {
    req.privyUser = await verifyPrivyJwt(token);
    next();
  } catch (err) {
    logger.debug({ err }, "Privy token verification failed");
    res.status(401).json({ error: "Invalid or expired token" });
  }
}

export async function optionalPrivyAuth(
  req: Request,
  res: Response,
  next: NextFunction
) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return next();
  const token = authHeader.slice(7);
  try {
    req.privyUser = await verifyPrivyJwt(token);
  } catch {}
  next();
}
