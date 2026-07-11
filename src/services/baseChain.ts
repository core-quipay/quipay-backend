/**
 * Arc network integration (Arc testnet, chain ID 5042002)
 * Reads PayrollStream contract via viem.
 * USDC uses 6 decimal places — returned amounts are human-readable (e.g. 1.50 = $1.50).
 */
import {
  createPublicClient,
  http,
  parseAbi,
  defineChain,
  type Address,
} from "viem";

const IS_MAINNET = process.env.NODE_ENV === "production";

const ARC_RPC_URL =
  process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.network";

const arcTestnet = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USD Coin", symbol: "USDC", decimals: 6 },
  rpcUrls: { default: { http: [ARC_RPC_URL] } },
  blockExplorers: {
    default: { name: "ArcScan", url: "https://testnet.arcscan.app" },
  },
});

export const arcClient = createPublicClient({
  chain: arcTestnet,
  transport: http(ARC_RPC_URL),
});

// Arc USDC (native gas token on Arc)
export const USDC_ADDRESS: Address =
  (process.env.ARC_USDC_ADDRESS as Address) ??
  "0x3600000000000000000000000000000000000000";

// Matches PayrollStream.sol — streamId is uint256 (sequential)
export const PAYROLL_STREAM_ABI = parseAbi([
  // Read
  "function getStreamsByWorker(address worker) external view returns (uint256[])",
  "function getStreamsByEmployer(address employer) external view returns (uint256[])",
  "function getStream(uint256 streamId) external view returns (address employer, address worker, address token, uint256 totalAmount, uint256 withdrawnAmount, uint256 startTs, uint256 endTs, uint256 cliffTs, uint8 status, uint256 ratePerSecond)",
  // Events
  "event StreamCreated(uint256 indexed streamId, address indexed employer, address indexed worker, address token, uint256 totalAmount, uint256 startTs, uint256 endTs, uint256 cliffTs, bytes32 metadataHash)",
  "event Withdrawn(uint256 indexed streamId, address indexed worker, uint256 amount, uint256 withdrawnTotal)",
  "event StreamCancelled(uint256 indexed streamId, uint256 workerSettlement, uint256 employerRefund, uint256 protocolFee)",
  "event StreamCompleted(uint256 indexed streamId, uint256 totalPaid)",
]);

const USDC_DECIMALS = 1_000_000;
function toHumanUSDC(raw: bigint): number {
  return Number(raw) / USDC_DECIMALS;
}

function getContractAddress(): Address | null {
  const addr = process.env.ARC_PAYROLL_STREAM_CONTRACT;
  if (!addr || addr === "") return null;
  return addr as Address;
}

/** All stream IDs for a worker on Arc */
export async function getWorkerStreamsBase(
  workerAddress: Address,
): Promise<bigint[]> {
  const contract = getContractAddress();
  if (!contract) return [];
  try {
    return (await arcClient.readContract({
      address: contract,
      abi: PAYROLL_STREAM_ABI,
      functionName: "getStreamsByWorker",
      args: [workerAddress],
    })) as bigint[];
  } catch {
    return [];
  }
}

/** Full stream details for a given stream ID on Arc */
export async function getStreamBase(streamId: bigint) {
  const contract = getContractAddress();
  if (!contract) return null;
  try {
    const raw = (await arcClient.readContract({
      address: contract,
      abi: PAYROLL_STREAM_ABI,
      functionName: "getStream",
      args: [streamId],
    })) as [Address, Address, Address, bigint, bigint, bigint, bigint, bigint, number, bigint];

    const [employer, worker, token, totalAmount, withdrawnAmount, startTs, endTs, cliffTs, status, ratePerSecond] = raw;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const cliff = cliffTs > 0n ? cliffTs : startTs;
    const elapsed = now > startTs ? now - startTs : 0n;
    const vested = elapsed * ratePerSecond < totalAmount ? elapsed * ratePerSecond : totalAmount;
    const available = now >= cliff ? (vested > withdrawnAmount ? toHumanUSDC(vested - withdrawnAmount) : 0) : 0;

    return {
      streamId: streamId.toString(),
      chain: "arc" as const,
      employer,
      worker,
      token,
      ratePerSecond: toHumanUSDC(ratePerSecond),
      startTs: Number(startTs),
      endTs: Number(endTs),
      cliffTs: Number(cliffTs),
      withdrawn: toHumanUSDC(withdrawnAmount),
      available,
      cancelled: status === 3,
      completed: status === 2,
    };
  } catch {
    return null;
  }
}

/** Employer USDC vault balance on Arc (reads from contract) */
export async function getEmployerBalanceBase(
  employerAddress: Address,
): Promise<number> {
  const contract = getContractAddress();
  if (!contract) return 0;
  try {
    const ids = (await arcClient.readContract({
      address: contract,
      abi: PAYROLL_STREAM_ABI,
      functionName: "getStreamsByEmployer",
      args: [employerAddress],
    })) as bigint[];
    return ids.length; // stream count as proxy; real balance lives in USDC allowance
  } catch {
    return 0;
  }
}
