import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { env } from "../env";

let _db: ReturnType<typeof drizzle<typeof schema>> | undefined;

export function db() {
  if (!_db) {
    const sql = postgres(env().DATABASE_URL, { max: 10 });
    _db = drizzle(sql, { schema });
  }
  return _db;
}

export type DB = ReturnType<typeof db>;
export { schema };
