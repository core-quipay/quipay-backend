import { Pool } from "pg";
import path from "path";
import dotenv from "dotenv";
import { MigrationRunner } from "./migrationRunner";

dotenv.config();

function getPool(): Pool {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    throw new Error("DATABASE_URL environment variable is required");
  }
  return new Pool({ connectionString: dbUrl });
}

function getRunner(pool: Pool): MigrationRunner {
  return new MigrationRunner(pool, path.join(__dirname, "migrations"));
}

export async function runMigrations(): Promise<void> {
  const pool = getPool();
  try {
    await getRunner(pool).migrate();
  } finally {
    await pool.end();
  }
}

export async function printStatus(): Promise<void> {
  const pool = getPool();
  try {
    const status = await getRunner(pool).getStatus();
    console.log(
      `Applied: ${status.appliedMigrations.length}/${status.totalMigrations}`,
    );
    for (const m of status.pendingMigrations) {
      console.log(`  pending: ${m.version}_${m.name}`);
    }
  } finally {
    await pool.end();
  }
}

export async function rollbackLast(): Promise<void> {
  const pool = getPool();
  try {
    await getRunner(pool).rollback();
  } finally {
    await pool.end();
  }
}

if (require.main === module) {
  const command = process.argv[2];
  const action =
    command === "status"
      ? printStatus
      : command === "rollback"
        ? rollbackLast
        : runMigrations;

  action().catch((err) => {
    console.error("❌ Migration command failed:", err);
    process.exit(1);
  });
}
