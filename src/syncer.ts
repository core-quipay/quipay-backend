/**
 * Arc event syncer — polls PayrollStream contract logs and writes to DB.
 * Replaces the old Soroban/Stellar syncer.
 */
import {
  createPublicClient,
  http,
  parseAbi,
  defineChain,
  decodeEventLog,
  type Address,
} from "viem";
import { getPool } from "./db/pool";
import {
  getLastSyncedLedger,
  updateSyncCursor,
  upsertStream,
  recordWithdrawal,
  getStreamById,
} from "./db/queries";
import { logServiceInfo, logServiceWarn, logServiceError } from "./audit/serviceLogger";
import { generateAndStoreProof } from "./services/proofService";
import { emitStreamEvent } from "./websocket/server";

const SVC = "arc-syncer";

const ARC_RPC_URL =
  process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";
const CONTRACT_ID = (process.env.ARC_PAYROLL_STREAM_CONTRACT ?? "") as Address;
const SYNC_START_BLOCK = parseInt(process.env.SYNC_START_LEDGER ?? "0", 10);
const POLL_INTERVAL_MS = parseInt(process.env.SYNCER_POLL_MS ?? "10000", 10);
const BATCH_BLOCKS = 1000;

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
});

const client = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL),
});

const STREAM_ABI = parseAbi([
  "event StreamCreated(uint256 indexed streamId, address indexed employer, address indexed worker, address token, uint256 totalAmount, uint256 startTs, uint256 endTs, uint256 cliffTs, bytes32 metadataHash)",
  "event Withdrawn(uint256 indexed streamId, address indexed worker, uint256 amount, uint256 withdrawnTotal)",
  "event StreamCancelled(uint256 indexed streamId, uint256 workerSettlement, uint256 employerRefund, uint256 protocolFee)",
  "event StreamCompleted(uint256 indexed streamId, uint256 totalPaid)",
]);

let syncerStopping = false;
let syncerTimeoutId: NodeJS.Timeout | null = null;
let inFlightSyncCycle: Promise<void> | null = null;

async function processSyncCycle(fromBlock: bigint): Promise<bigint> {
  if (!CONTRACT_ID) return fromBlock;

  const latest = await client.getBlockNumber();
  if (fromBlock > latest) return latest;

  const toBlock =
    fromBlock + BigInt(BATCH_BLOCKS) < latest
      ? fromBlock + BigInt(BATCH_BLOCKS)
      : latest;

  const logs = await client.getLogs({
    address: CONTRACT_ID,
    fromBlock,
    toBlock,
    events: STREAM_ABI,
  });

  for (const log of logs) {
    try {
      const block = await client.getBlock({ blockNumber: log.blockNumber! });
      const blockTs = Number(block.timestamp);
      const blockNum = Number(log.blockNumber!);

      const decoded = decodeEventLog({
        abi: STREAM_ABI,
        data: log.data,
        topics: log.topics as [`0x${string}`, ...`0x${string}`[]],
      });

      if (decoded.eventName === "StreamCreated") {
        const { streamId, employer, worker, totalAmount, startTs, endTs } =
          decoded.args as {
            streamId: bigint;
            employer: Address;
            worker: Address;
            totalAmount: bigint;
            startTs: bigint;
            endTs: bigint;
          };
        await upsertStream({
          streamId: Number(streamId),
          employer,
          worker,
          totalAmount,
          withdrawnAmount: 0n,
          startTs: Number(startTs),
          endTs: Number(endTs),
          status: "active",
          ledger: blockNum,
        });
        emitStreamEvent(
          "stream_created",
          String(streamId),
          { employer, worker, totalAmount: totalAmount.toString() },
          employer,
          worker,
        );
      } else if (decoded.eventName === "Withdrawn") {
        const { streamId, worker, amount, withdrawnTotal } =
          decoded.args as {
            streamId: bigint;
            worker: Address;
            amount: bigint;
            withdrawnTotal: bigint;
          };
        await recordWithdrawal({
          streamId: Number(streamId),
          worker,
          amount,
          ledger: blockNum,
          ledgerTs: blockTs,
        });
        const existing = await getStreamById(Number(streamId));
        if (existing) {
          await upsertStream({
            streamId: Number(streamId),
            employer: existing.employer_address,
            worker: existing.worker_address,
            totalAmount: BigInt(existing.total_amount),
            withdrawnAmount: withdrawnTotal,
            startTs: existing.start_ts,
            endTs: existing.end_ts,
            status: existing.status,
            ledger: blockNum,
          });
        }
        emitStreamEvent(
          "withdrawal",
          String(streamId),
          { worker, amount: amount.toString() },
          existing?.employer_address,
          worker,
        );
      } else if (decoded.eventName === "StreamCancelled") {
        const { streamId } = decoded.args as { streamId: bigint };
        const existing = await getStreamById(Number(streamId));
        if (existing) {
          await upsertStream({
            streamId: Number(streamId),
            employer: existing.employer_address,
            worker: existing.worker_address,
            totalAmount: BigInt(existing.total_amount),
            withdrawnAmount: BigInt(existing.withdrawn_amount ?? "0"),
            startTs: existing.start_ts,
            endTs: existing.end_ts,
            status: "cancelled",
            closedAt: blockTs,
            ledger: blockNum,
          });
        }
        emitStreamEvent(
          "stream_cancelled",
          String(streamId),
          {},
          existing?.employer_address,
          existing?.worker_address,
        );
      } else if (decoded.eventName === "StreamCompleted") {
        const { streamId, totalPaid } = decoded.args as {
          streamId: bigint;
          totalPaid: bigint;
        };
        const existing = await getStreamById(Number(streamId));
        if (existing) {
          await upsertStream({
            streamId: Number(streamId),
            employer: existing.employer_address,
            worker: existing.worker_address,
            totalAmount: totalPaid,
            withdrawnAmount: totalPaid,
            startTs: existing.start_ts,
            endTs: existing.end_ts,
            status: "completed",
            closedAt: blockTs,
            ledger: blockNum,
          });
        }
        emitStreamEvent(
          "stream_completed",
          String(streamId),
          { totalPaid: totalPaid.toString() },
          existing?.employer_address,
          existing?.worker_address,
        );
        void generateAndStoreProof(Number(streamId)).catch((err) =>
          void logServiceWarn(SVC, "Proof generation failed", { streamId: streamId.toString(), err: String(err) }),
        );
      }
    } catch (err) {
      void logServiceWarn(SVC, "Error processing event log", {
        txHash: log.transactionHash ?? "unknown",
      });
    }
  }

  await updateSyncCursor(CONTRACT_ID, Number(toBlock));
  return toBlock + 1n;
}

async function runOneSyncCycle(): Promise<void> {
  if (!getPool()) {
    void logServiceWarn(SVC, "DB not configured, skipping sync");
    return;
  }
  const lastSynced = await getLastSyncedLedger(CONTRACT_ID);
  const fromBlock = BigInt(lastSynced > 0 ? lastSynced + 1 : SYNC_START_BLOCK);
  await processSyncCycle(fromBlock);
}

function scheduleNext(): void {
  if (syncerStopping) return;
  syncerTimeoutId = setTimeout(() => {
    inFlightSyncCycle = runOneSyncCycle()
      .catch((err) => void logServiceError(SVC, "Sync cycle error", { err: String(err) }))
      .finally(() => {
        inFlightSyncCycle = null;
        scheduleNext();
      });
  }, POLL_INTERVAL_MS);
}

export function startSyncer(): void {
  if (!CONTRACT_ID) {
    void logServiceWarn(SVC, "ARC_PAYROLL_STREAM_CONTRACT not set — syncer disabled");
    return;
  }

  inFlightSyncCycle = runOneSyncCycle()
    .catch((err) => void logServiceError(SVC, "Initial sync cycle error", { err: String(err) }))
    .finally(() => {
      inFlightSyncCycle = null;
      scheduleNext();
    });

  void logServiceInfo(SVC, "Arc event syncer started", {
    contract: CONTRACT_ID,
    rpc: ARC_RPC_URL,
  });
}

export async function stopSyncer(): Promise<void> {
  syncerStopping = true;
  if (syncerTimeoutId) {
    clearTimeout(syncerTimeoutId);
    syncerTimeoutId = null;
  }
  if (inFlightSyncCycle) {
    await inFlightSyncCycle.catch(() => {});
    inFlightSyncCycle = null;
  }
  void logServiceInfo(SVC, "Arc event syncer stopped");
}
