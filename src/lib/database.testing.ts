import { TransactionRollbackError } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { APP_CONFIG } from "./config";
import type { Database } from "./database";

export function with_rollback_transaction(test: (transaction: Database) => Promise<void>): () => Promise<void> {
  return async () => {
    const query_client = postgres(APP_CONFIG.database_url, { max: 1 });
    const database = drizzle({ client: query_client });
    let test_completed = false;

    try {
      try {
        await database.transaction(async (transaction) => {
          await test(transaction as Database);
          test_completed = true;
          transaction.rollback();
        });
      } catch (error) {
        if (!(error instanceof TransactionRollbackError) || !test_completed) {
          throw error;
        }
      }
    } finally {
      await query_client.end();
    }
  };
}
