import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { APP_CONFIG } from "./config";

const QUERY_CLIENT = postgres(APP_CONFIG.database_url, { max: 10 });

export const db = drizzle({ client: QUERY_CLIENT });
