Add an orders API to this app, alongside customers.

The orders table already exists in db/migrations/001_init.sql. Follow the way
customers is built: a repository, a service, Hono handlers, and handler tests
in the same style as customers.test.ts.

Endpoints:

- GET /api/orders — the account's orders, newest first. Optional
  ?customerId= filter.
- GET /api/orders/:id
- POST /api/orders — body { customerId, totalCents }. Creates a draft order.
  The customer must exist.
- POST /api/orders/:id/place — draft -> placed.
- POST /api/orders/:id/cancel — draft or placed -> cancelled. A shipped
  order cannot be cancelled.

Wire the routes into api/src/index.ts. Run the tests before you finish.
