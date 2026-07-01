import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import postgres, { type Sql } from "postgres";
import * as schema from "./schema";

let sqlClient: NeonQueryFunction<false, false> | null = null;
let postgresClient: Sql | null = null;
let database: NeonHttpDatabase<typeof schema> | null = null;

export function hasDatabase() {
  return Boolean(process.env.DATABASE_URL);
}

export function getSql() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
  sqlClient ??= neon(process.env.DATABASE_URL);
  return sqlClient;
}

export function getDb() {
  if (database) return database;
  if (process.env.DATABASE_DRIVER === "postgresjs") {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not configured");
    postgresClient ??= postgres(process.env.DATABASE_URL, { max: 3 });
    database = drizzlePostgres(postgresClient, { schema }) as unknown as NeonHttpDatabase<typeof schema>;
    return database;
  }
  database = drizzle(getSql(), { schema });
  return database;
}
