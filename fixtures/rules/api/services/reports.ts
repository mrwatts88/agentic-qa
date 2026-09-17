import { sql } from "../db/client";

export async function monthlyTotals(accountId: string) {
  return sql`select sum(total) from orders where account_id = ${accountId}`;
}
