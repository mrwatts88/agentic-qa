/**
 * VIOLATES data.orm.no-query-inside-loop.
 *
 * One query for the orders, then one more per order. Invisible against five
 * rows in development, and the most common performance bug in production.
 */
import { orderRepo, customerRepo } from "./repositories/orderRepo";

export async function recentOrdersWithCustomers(limit: number) {
  const orders = await orderRepo.findRecent(limit);

  const rows = [];
  for (const order of orders) {
    const customer = await customerRepo.findById(order.customerId);
    rows.push({ ...order, customerName: customer.name });
  }

  return rows;
}
