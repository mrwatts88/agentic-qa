/**
 * Recent orders with their customers, for the dashboard.
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
