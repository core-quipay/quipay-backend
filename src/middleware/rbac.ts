import { Request as ExpressRequest, Response, NextFunction } from "express";
import { setWalletAddressInContext } from "./requestId";
import { verifyPrivyJwt } from "./privyAuth";
import { getOrCreateAccountByPrivyId, getEmployerIdForAccount } from "../db/queries";
import { logger } from "../logger";

// ─── Role Definitions ────────────────────────────────────────────────────────

/**
 * Standard user roles for Quipay. Higher numeric value = broader privilege.
 * Use bitmask-compatible powers of 2 to allow composing permissions.
 */
export enum Role {
  User = 1, // Standard authenticated user
  Admin = 2, // Has access to admin management endpoints
  SuperAdmin = 4, // Full access including dangerous overrides
}

// Human-readable string to Role mapping (used when decoding JWT/API-key claims)
export const ROLE_MAP: Record<string, Role> = {
  user: Role.User,
  admin: Role.Admin,
  superadmin: Role.SuperAdmin,
  role_user: Role.User,
  role_admin: Role.Admin,
  role_superadmin: Role.SuperAdmin,
};

// ─── Extended Request ─────────────────────────────────────────────────────────

/**
 * Augments the base Express Request with the authenticated user payload.
 * Populated by `authenticateRequest` middleware above the RBAC check.
 */
export interface AuthenticatedRequest
  extends ExpressRequest<Record<string, string>, any, any, any> {
  user?: {
    id: string;
    role: Role;
    email?: string;
    evmAddress?: string;
    accountId: number;
    quipayId: string;
  };
}

// ─── Auth Extraction ──────────────────────────────────────────────────────────

/**
 * Verifies a real Privy JWT (`Authorization: Bearer <token>`) and resolves it
 * to a Quipay account, creating one on first sight of that Privy DID.
 *
 * There is no header-trust fallback — a request either carries a token that
 * verifies against Privy's JWKS, or it's unauthenticated. `req.user.id` still
 * resolves to the caller's legacy `employer_id` (a wallet address) when one
 * exists, so every existing route handler that reads `req.user.id` keeps
 * working unchanged during the migration to `accountId`/`quipayId`.
 */
export async function authenticateRequest(
  req: AuthenticatedRequest,
  res: Response,
  next: NextFunction,
): Promise<void> {
  const authHeader = req.headers.authorization;
  const bearerMatch =
    typeof authHeader === "string"
      ? authHeader.match(/^Bearer\s+(.+)$/i)
      : null;

  if (!bearerMatch) {
    res
      .status(401)
      .json({ error: "Unauthorized: missing or invalid credentials" });
    return;
  }

  let claims;
  try {
    claims = await verifyPrivyJwt(bearerMatch[1]);
  } catch (err) {
    logger.debug({ err }, "authenticateRequest: token verification failed");
    res
      .status(401)
      .json({ error: "Unauthorized: missing or invalid credentials" });
    return;
  }

  let account;
  let legacyEmployerId: string | null;
  try {
    account = await getOrCreateAccountByPrivyId(claims.sub);
    legacyEmployerId = await getEmployerIdForAccount(account.id);
  } catch (err) {
    logger.error({ err }, "authenticateRequest: failed to resolve account");
    res.status(500).json({ error: "Failed to resolve account" });
    return;
  }

  const role = ROLE_MAP[account.role] ?? Role.User;

  req.user = {
    id: legacyEmployerId ?? account.quipay_id,
    role,
    email: account.email ?? undefined,
    accountId: account.id,
    quipayId: account.quipay_id,
  };
  // Propagate the wallet / user address into the async context so that every
  // downstream log line automatically includes it without extra plumbing.
  setWalletAddressInContext(req.user.id);
  next();
}

/**
 * Role-Based Access Control middleware factory.
 *
 * Accepts one or more allowed roles. The request is permitted when the
 * authenticated user holds **at least one** of the required roles (bitmask OR).
 *
 * @example
 *   // Only SuperAdmins can call this route
 *   router.delete("/users/:id", authenticateRequest, requireRole(Role.SuperAdmin), handler);
 *
 *   // Both Admins and SuperAdmins can call this route
 *   router.get("/analytics", authenticateRequest, requireRole(Role.Admin, Role.SuperAdmin), handler);
 */
export function requireRole(...allowedRoles: Role[]) {
  const allowedMask = allowedRoles.reduce((acc, r) => acc | r, 0);

  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction,
  ): void => {
    if (!req.user) {
      res.status(401).json({ error: "Unauthorized: not authenticated" });
      return;
    }

    const hasPermission = (req.user.role & allowedMask) !== 0;
    if (!hasPermission) {
      res.status(403).json({
        error: "Forbidden: insufficient permissions",
        required: allowedRoles.map((r) => Role[r]),
        actual: Role[req.user.role],
      });
      return;
    }

    next();
  };
}

/**
 * Shorthand middleware factories for common role checks.
 */
export const requireAdmin = requireRole(Role.Admin, Role.SuperAdmin);
export const requireSuperAdmin = requireRole(Role.SuperAdmin);
export const requireUser = requireRole(Role.User, Role.Admin, Role.SuperAdmin);
