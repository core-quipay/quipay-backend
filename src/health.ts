import { getPool } from "./db/pool";
import { vaultService } from "./services/vaultService";
import { nonceManager } from "./index";

export type DependencyState = "healthy" | "unhealthy";

export interface DependencyHealth {
  status: DependencyState;
  latencyMs: number;
  details?: string;
}

export interface HealthResponseBody {
  status: "ok" | "degraded";
  uptime: string;
  timestamp: string;
  version: string;
  service: string;
  dependencies: {
    database: DependencyHealth;
    arcRpc: DependencyHealth;
    vault: DependencyHealth;
    nonceManager: DependencyHealth;
  };
}

const SERVICE_NAME = "quipay-automation-engine";
const CHECK_TIMEOUT_MS = 5000;

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error: unknown) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}

async function checkDatabase(): Promise<DependencyHealth> {
  const startedAt = Date.now();
  const pool = getPool();

  if (!pool) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startedAt,
      details: "DATABASE_URL not configured or pool not initialized",
    };
  }

  try {
    await withTimeout(pool.query("SELECT 1"), CHECK_TIMEOUT_MS);
    const total = pool.totalCount;
    const idle = pool.idleCount;
    const waiting = pool.waitingCount;
    const max = (pool as any).options?.max as number | undefined;

    return {
      status: "healthy",
      latencyMs: Date.now() - startedAt,
      details: `pool(total=${total}, idle=${idle}, waiting=${waiting}, max=${
        max ?? "unknown"
      })`,
    };
  } catch (error) {
    const total = pool.totalCount;
    const idle = pool.idleCount;
    const waiting = pool.waitingCount;
    const max = (pool as any).options?.max as number | undefined;

    return {
      status: "unhealthy",
      latencyMs: Date.now() - startedAt,
      details:
        error instanceof Error
          ? `${error.message}; pool(total=${total}, idle=${idle}, waiting=${waiting}, max=${
              max ?? "unknown"
            })`
          : `Database query failed; pool(total=${total}, idle=${idle}, waiting=${waiting}, max=${
              max ?? "unknown"
            })`,
    };
  }
}

async function checkArcRpc(): Promise<DependencyHealth> {
  const startedAt = Date.now();
  const rpcUrl =
    process.env.ARC_RPC_URL || "https://rpc.testnet.arc.network";

  try {
    const response = await withTimeout(
      fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] }),
      }),
      CHECK_TIMEOUT_MS,
    );

    const data = (await response.json()) as { result?: string };
    const blockNumber = data.result ? parseInt(data.result, 16) : null;

    if (!blockNumber) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startedAt,
        details: "Missing block number in response",
      };
    }

    return {
      status: "healthy",
      latencyMs: Date.now() - startedAt,
      details: `block=${blockNumber}`,
    };
  } catch (error) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startedAt,
      details: error instanceof Error ? error.message : "Arc RPC check failed",
    };
  }
}

async function checkVault(): Promise<DependencyHealth> {
  const startedAt = Date.now();

  if (!process.env.VAULT_ADDR) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startedAt,
      details: "VAULT_ADDR is not configured",
    };
  }

  if (!process.env.VAULT_TOKEN) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startedAt,
      details: "VAULT_TOKEN is not configured",
    };
  }

  try {
    const [healthy, tokenValid] = await Promise.all([
      withTimeout(vaultService.isHealthy(), CHECK_TIMEOUT_MS),
      withTimeout(vaultService.isTokenValid(), CHECK_TIMEOUT_MS),
    ]);

    if (!healthy) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startedAt,
        details: "Vault health check failed",
      };
    }

    if (!tokenValid) {
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startedAt,
        details: "Vault token is invalid or expired",
      };
    }

    return {
      status: "healthy",
      latencyMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startedAt,
      details: error instanceof Error ? error.message : "Vault check failed",
    };
  }
}

async function checkNonceManager(): Promise<DependencyHealth> {
  const startedAt = Date.now();

  try {
    const isHealthy = nonceManager.isHealthy();
    const state = nonceManager.getCurrentState();

    if (!isHealthy) {
      const error = nonceManager.getInitializationError();
      return {
        status: "unhealthy",
        latencyMs: Date.now() - startedAt,
        details: error?.message || "Nonce manager not initialized",
      };
    }

    return {
      status: "healthy",
      latencyMs: Date.now() - startedAt,
      details: `sequence=${state.currentSequence}, poolSize=${state.availableNonces.length}`,
    };
  } catch (error) {
    return {
      status: "unhealthy",
      latencyMs: Date.now() - startedAt,
      details:
        error instanceof Error ? error.message : "Nonce manager check failed",
    };
  }
}

export async function getHealthResponse(
  startTimeMs: number,
): Promise<{ httpStatus: 200 | 503; body: HealthResponseBody }> {
  const [database, arcRpc, vault, nonceManagerHealth] = await Promise.all([
    checkDatabase(),
    checkArcRpc(),
    checkVault(),
    checkNonceManager(),
  ]);

  const allHealthy =
    database.status === "healthy" &&
    arcRpc.status === "healthy" &&
    vault.status === "healthy" &&
    nonceManagerHealth.status === "healthy";

  const body: HealthResponseBody = {
    status: allHealthy ? "ok" : "degraded",
    uptime: `${Math.floor((Date.now() - startTimeMs) / 1000)}s`,
    timestamp: new Date().toISOString(),
    version: process.env.npm_package_version || "0.0.1",
    service: SERVICE_NAME,
    dependencies: {
      database,
      arcRpc,
      vault,
      nonceManager: nonceManagerHealth,
    },
  };

  return {
    httpStatus: allHealthy ? 200 : 503,
    body,
  };
}
