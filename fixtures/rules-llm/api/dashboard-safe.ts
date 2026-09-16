/**
 * Recent orders with their customers, for the dashboard.
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
