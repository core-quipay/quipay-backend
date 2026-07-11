import { Router } from "express";
import { requirePrivyAuth } from "../middleware/privyAuth";
import { getWorkerStreamsBase, getStreamBase } from "../services/baseChain";
import { getWorkerStreamsStellar } from "../services/stellarChain";
import { query } from "../db/pool";
import { logger } from "../logger";
import { getOrCreateAccountByPrivyId } from "../db/queries";

export const workersRouter = Router();
workersRouter.use(requirePrivyAuth);

/** Chain-agnostic stream shape returned to the mobile app. Amounts are human USDC. */
interface WorkerStreamDto {
  streamId: string;
  chain: "arc" | "stellar";
  employer: string;
  ratePerSecond: number;
  startTs: number;
  endTs: number;
  cliffTs?: number;
  available: number;
  withdrawn: number;
  token: string;
  status: string;
}

/** Active Arc (EVM) streams mapped to the DTO. Never throws — a chain outage returns []. */
async function loadArcStreams(walletBase: string): Promise<WorkerStreamDto[]> {
  try {
    const ids = await getWorkerStreamsBase(walletBase as `0x${string}`);
    const details = await Promise.all(ids.map((id) => getStreamBase(id)));
    return details
      .filter(Boolean)
      .filter((s: any) => !s.cancelled && !s.completed)
      .map((s: any) => ({
        streamId: s.streamId,
        chain: "arc" as const,
        employer: s.employer,
        ratePerSecond: s.ratePerSecond,
        startTs: s.startTs,
        endTs: s.endTs,
        cliffTs: s.cliffTs,
        available: s.available,
        withdrawn: s.withdrawn,
        token: "USDC",
        status: "active",
      }));
  } catch (err) {
    logger.warn({ err }, "Arc chain read failed");
    return [];
  }
}

/** Active Stellar (Soroban) streams mapped to the DTO. Never throws — a chain outage returns []. */
async function loadStellarStreams(walletStellar: string): Promise<WorkerStreamDto[]> {
  try {
    const { streams } = await getWorkerStreamsStellar(walletStellar);
    const now = Math.floor(Date.now() / 1000);
    return streams
      .filter((s) => s.status === 0) // 0 = active
      .map((s) => {
        const cliff = s.cliffTs > 0 ? s.cliffTs : s.startTs;
        const elapsed = Math.max(0, now - s.startTs);
        const vested = Math.min(elapsed * s.ratePerSecond, s.totalAmount);
        const available = now >= cliff ? Math.max(0, vested - s.withdrawnAmount) : 0;
        return {
          streamId: s.streamId,
          chain: "stellar" as const,
          employer: s.employer,
          ratePerSecond: s.ratePerSecond,
          startTs: s.startTs,
          endTs: s.endTs,
          cliffTs: s.cliffTs,
          available,
          withdrawn: s.withdrawnAmount,
          token: "USDC",
          status: "active",
        };
      });
  } catch (err) {
    logger.warn({ err }, "Stellar chain read failed");
    return [];
  }
}

/** Load a worker's active streams across every linked chain, in parallel. */
async function loadAllStreams(walletBase: string | null, walletStellar: string | null) {
  const [arc, stellar] = await Promise.all([
    walletBase ? loadArcStreams(walletBase) : Promise.resolve<WorkerStreamDto[]>([]),
    walletStellar ? loadStellarStreams(walletStellar) : Promise.resolve<WorkerStreamDto[]>([]),
  ]);
  return { arc, stellar };
}

/**
 * GET /workers/me/streams
 * All active streams across every chain the worker has linked (Arc + Stellar).
 */
workersRouter.get("/me/streams", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;

    const workerResult = await query(
      `SELECT wallet_base, wallet_stellar FROM workers WHERE privy_id = $1 LIMIT 1`,
      [privyId],
    );

    if (!workerResult.rows.length) {
      res.json({ streams: [], totalAvailableUSDC: 0, chains: { arc: 0, stellar: 0 } });
      return;
    }

    const { wallet_base, wallet_stellar } = workerResult.rows[0];
    const { arc, stellar } = await loadAllStreams(wallet_base, wallet_stellar);

    const streams = [...arc, ...stellar];
    const totalAvail = streams.reduce((sum, s) => sum + (s.available ?? 0), 0);

    res.json({
      streams,
      totalAvailableUSDC: parseFloat(totalAvail.toFixed(6)),
      chains: { arc: arc.length, stellar: stellar.length },
    });
  } catch (err) {
    logger.error({ err }, "GET /workers/me/streams failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /workers/me/balance
 * Aggregated real-time USDC balance across Arc + Stellar. Mobile polls this every 30s.
 */
workersRouter.get("/me/balance", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;
    const now = Math.floor(Date.now() / 1000);

    const workerResult = await query(
      `SELECT wallet_base, wallet_stellar FROM workers WHERE privy_id = $1 LIMIT 1`,
      [privyId],
    );

    const row = workerResult.rows[0];
    if (!row || (!row.wallet_base && !row.wallet_stellar)) {
      res.json({ available: "0.000000", streamingPerSec: "0.00000000", withdrawn: "0.000000", currency: "USDC", timestamp: now });
      return;
    }

    const { arc, stellar } = await loadAllStreams(row.wallet_base, row.wallet_stellar);
    const all = [...arc, ...stellar];

    const available = all.reduce((s, x) => s + (x.available ?? 0), 0);
    const streamingPerSec = all.reduce((s, x) => s + (x.ratePerSecond ?? 0), 0);
    const withdrawn = all.reduce((s, x) => s + (x.withdrawn ?? 0), 0);

    res.json({
      available: available.toFixed(6),
      streamingPerSec: streamingPerSec.toFixed(8),
      withdrawn: withdrawn.toFixed(6),
      currency: "USDC",
      timestamp: now,
    });
  } catch (err) {
    logger.error({ err }, "GET /workers/me/balance failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * POST /workers/me/register
 * Called by the mobile app after Privy login to link the worker's wallet
 * addresses. Accepts an EVM address (Arc/Base) and/or a Stellar address; either
 * may be omitted, and COALESCE keeps any previously-linked address.
 */
workersRouter.post("/me/register", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;
    const { walletArc, walletBase, walletStellar, email } = req.body as {
      walletArc?: string;
      walletBase?: string;
      walletStellar?: string;
      email?: string;
    };

    // walletArc/walletBase are the same EVM format → wallet_base column.
    const evmWallet = walletArc ?? walletBase ?? null;
    const stellarWallet = walletStellar ?? null;

    const account = await getOrCreateAccountByPrivyId(privyId, email);

    await query(
      `INSERT INTO workers (privy_id, email, wallet_base, wallet_stellar, account_id, created_at)
       VALUES ($1, $2, $3, $4, $5, NOW())
       ON CONFLICT (privy_id) DO UPDATE
         SET wallet_base    = COALESCE(EXCLUDED.wallet_base, workers.wallet_base),
             wallet_stellar = COALESCE(EXCLUDED.wallet_stellar, workers.wallet_stellar),
             email          = COALESCE(EXCLUDED.email, workers.email),
             account_id     = EXCLUDED.account_id`,
      [privyId, email ?? null, evmWallet, stellarWallet, account.id],
    );

    res.json({ success: true, privyId, quipayId: account.quipay_id });
  } catch (err) {
    logger.error({ err }, "POST /workers/me/register failed");
    res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * GET /workers/me/profile
 * Returns the worker's registered wallet addresses (both chains) and Privy DID.
 */
workersRouter.get("/me/profile", async (req, res) => {
  try {
    const privyId = req.privyUser!.sub;
    const result = await query(
      `SELECT privy_id, email, wallet_base, wallet_stellar, created_at FROM workers WHERE privy_id = $1 LIMIT 1`,
      [privyId],
    );

    if (!result.rows.length) {
      res.json({ registered: false });
      return;
    }

    const row = result.rows[0];
    res.json({
      registered: true,
      ...row,
      walletArc: row.wallet_base,
      walletStellar: row.wallet_stellar,
    });
  } catch (err) {
    logger.error({ err }, "GET /workers/me/profile failed");
    res.status(500).json({ error: "Internal server error" });
  }
});
