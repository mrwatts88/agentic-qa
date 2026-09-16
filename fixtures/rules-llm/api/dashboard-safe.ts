/**
 * Clean control for data.orm.no-query-inside-loop.
 *
 * Same result, same repositories, and it still loops. The loop does no I/O:
 * the customers are fetched once by the whole set of ids, and the loop only
 * stitches the two together in memory. A rule that flags every loop rather
 * than every query inside a loop would wrongly condemn this.
 */
import { orderRepo, customerRepo } from "./repositories/orderRepo";

export async function recentOrdersWithCustomers(limit: number) {
  const orders = await orderRepo.findRecent(limit);
  const customers = await customerRepo.findByIds(
    orders.map((order) => order.customerId),
  );

  const byId = new Map(customers.map((customer) => [customer.id, customer]));

  return orders.map((order) => ({
    ...order,
    customerName: byId.get(order.customerId)?.name ?? "Unknown",
  }));
}
