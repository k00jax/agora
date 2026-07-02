import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString = process.env.DATABASE_URL!;

// For queries
const queryClient = postgres(connectionString);
export const db = drizzle(queryClient, { schema });

// For transactions — use a separate client to not exhaust connections
export function createDb() {
  const client = postgres(connectionString);
  return drizzle(client, { schema });
}
