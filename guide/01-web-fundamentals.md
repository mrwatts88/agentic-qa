# Web Fundamentals

*HTTP, REST, browsers and the wire-level rules that every full-stack app lives inside, refreshed for the person who now reviews more code than they write.*

**Read when:** designing or changing HTTP endpoints, status codes, headers, cookies, CORS, pagination or real-time transport.

## HTTP methods and their promises

RFC 9110 defines two properties that matter more than the method names themselves. A method is **safe** if it is read-only from the client's point of view: no state change requested. A method is **idempotent** if sending it N times has the same intended server effect as sending it once. All safe methods are idempotent. Not all idempotent methods are safe.

Clients, proxies and browsers act on these promises. A browser will retry an idempotent request after a dropped connection. A crawler or prefetcher will fire safe requests freely. If your GET deletes something, the promise is broken and the infrastructure will punish you.

- `GET` safe, idempotent. Read a resource. No body (technically allowed, practically ignored).
- `HEAD` same as GET without the body. Used for existence checks and cache validation.
- `OPTIONS` safe. Used almost exclusively for CORS preflight.
- `PUT` idempotent, not safe. Replace the whole resource at this URL. Sending the same PUT twice leaves the same state.
- `DELETE` idempotent, not safe. Second DELETE can return 404 or 204, either is fine, the state is the same.
- `POST` neither. Create, trigger, or "do a thing". Retrying a POST can double-charge a card.
- `PATCH` neither by default. A partial update like `{"status":"shipped"}` is idempotent in practice, `{"qty_delta": 1}` is not.

**Gets you burned:**
- POST used for everything, so nothing can be retried safely and caches can't help.
- GET endpoints with side effects (`/api/logout` as GET, `/reports/generate` as GET) get triggered by link prefetch and monitoring probes.
- PATCH treated as PUT: the client sends a partial object and the server nulls every missing field.

## Status codes

Families first: `2xx` worked, `3xx` go elsewhere, `4xx` the client got it wrong and can fix it, `5xx` the server failed and the client probably can't. The family is what most clients switch on. Within the family, about a dozen codes carry real meaning.

- `200` OK, with a body. `201` Created, ideally with a `Location` header. `204` No Content, for successful DELETE or an update with nothing to say.
- `301` / `308` permanent redirect (308 preserves the method). `302` / `307` temporary (307 preserves the method). `304` Not Modified, the cache validation answer.
- `400` malformed or invalid request. `401` not authenticated (you need to prove who you are). `403` authenticated but not allowed. `404` not found, also the polite way to say "not yours" without leaking existence. `409` conflict with current state (duplicate email, version mismatch). `422` well-formed but semantically invalid, a common choice for validation errors though 400 is equally defensible. `429` rate limited, send `Retry-After`.
- `500` unhandled failure. `502` / `503` / `504` upstream or capacity problems, usually from the proxy tier. 503 with `Retry-After` is the honest "come back later".

**When reviewing AI-written code:**
- 200 with `{"success": false}` in the body. Clients, proxies and monitoring all read the status, not your body.
- 500 returned for validation failures or 404 returned for authorization failures with no consistency across endpoints.
- 401 and 403 swapped. 401 means "log in", 403 means "logging in won't help".

## Headers that matter

Most headers are noise. These are the ones you will actually reason about.

- `Content-Type` what the body is. `application/json; charset=utf-8` for APIs. Mismatch here causes silent parse failures.
- `Accept` what the client wants back. Rarely important unless you serve multiple formats.
- `Authorization: Bearer <token>` the standard place for a token. Never in the query string (it ends up in logs).
- `Cookie` / `Set-Cookie` session state. Flags: `HttpOnly` (JS can't read it), `Secure` (HTTPS only), `SameSite=Lax|Strict|None` (cross-site sending rules), `Path`, `Domain`, `Max-Age`.
- `Cache-Control` the caching contract. `no-store` for anything private or dynamic, `private, max-age=0, must-revalidate` for per-user pages, `public, max-age=31536000, immutable` for hashed static assets.
- `ETag` / `If-None-Match` and `Last-Modified` / `If-Modified-Since` cache validation. Server returns 304 if unchanged. ETags also drive optimistic concurrency via `If-Match`.
- `Location` where the created or redirected resource lives.
- `Retry-After` seconds or a date, on 429 and 503.
- `X-Request-Id` or `traceparent` correlation id, generated at the edge, logged everywhere.
- CORS headers: `Access-Control-Allow-Origin`, `-Allow-Methods`, `-Allow-Headers`, `-Allow-Credentials`, `-Max-Age`, `-Expose-Headers`. Covered below.
- Security headers on HTML responses: `Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`.

## Request and response lifecycle

A browser request goes: DNS lookup, TCP (or QUIC) connect, TLS handshake, send request line and headers, send body, server reads, routes, runs middleware, runs handler, writes status and headers, streams body, connection is kept alive for reuse. Each stage has its own failure mode and its own timeout.

On the server side the useful mental model is a pipeline: raw socket, HTTP parser, router, middleware chain (in order), handler, then the response unwinds back through the same middleware. Anything that must apply to every request (request id, auth, logging, error translation) belongs in that chain, not in handlers.

- The status line and headers are sent before the body. Once they are out you cannot change the status. Streaming responses that fail mid-way look like a 200 that got cut off.
- HTTP/2 and HTTP/3 multiplex requests over one connection, so the old "six connections per host" limit and domain sharding tricks are obsolete.

## REST conventions and resource naming

REST in practice means: nouns for resources, HTTP methods for verbs, status codes for outcomes, JSON for bodies. The hypermedia parts of the original thesis are rarely used and that is fine.

- Plural nouns, lowercase, hyphens if needed: `/orders`, `/orders/{id}`, `/orders/{id}/line-items`.
- Nest only one level for ownership. `/users/{id}/orders` is fine. `/users/{id}/orders/{oid}/items/{iid}/notes` is not, give `items` its own top-level route.
- Actions that don't map to CRUD get a sub-resource or a verb-noun endpoint, used sparingly: `POST /orders/{id}/cancel`, `POST /orders/{id}/refunds`.
- Filters, sorting and pagination live in the query string. Identity lives in the path. State changes live in the body.
- Consistent casing in JSON keys across the whole API. Pick `camelCase` or `snake_case` once.

**When reviewing AI-written code:**
- Verbs in paths (`/getUser`, `/createOrder`) mixed with proper resource routes in the same API.
- `GET /orders?id=123` when `/orders/123` exists elsewhere.
- Route parameters trusted as-is with no ownership check (`/orders/{id}` returns any order for any user).

## Query vs path vs body

- **Path** identifies which resource. Required, positional, part of the resource's identity.
- **Query** modifies how you read: filter, sort, page, fields, search. Optional. Shows up in logs and browser history, so never secrets.
- **Body** carries the representation on POST, PUT, PATCH. Never on GET. Structured, validated, typed.
- Headers carry metadata about the request (auth, content negotiation, idempotency key), not domain data.

## Pagination

Two styles, each with a clear home.

- **Offset/limit** (`?page=3&per_page=50`): simple, supports "jump to page 7", cheap to build. Breaks under inserts and deletes (rows shift, items skipped or repeated) and gets slow on deep pages because the database still walks the skipped rows.
- **Cursor/keyset** (`?after=<opaque>&limit=50`): stable under writes, constant cost per page, the right choice for feeds and anything infinite-scroll. No random access. The cursor should be opaque (base64 of the sort key plus id) so you can change the internals later.
- Always return the page size actually used and either `next_cursor` or total count. Cap `limit` server-side. Sort on a unique tiebreaker (`created_at, id`) or keyset pagination will drop rows.

## Versioning

Most APIs need less versioning than they fear. Additive changes (new optional fields, new endpoints) are not breaking. Removing or renaming fields, changing types or semantics is.

- URL prefix (`/v1/orders`) is the pragmatic default. Obvious, cacheable, easy to route.
- Header versioning (`Accept: application/vnd.acme.v2+json`) is cleaner in theory and harder to debug in practice.
- Date-based versions (Stripe style) work when you have real external consumers and the discipline to keep transforms.
- Avoid breaking changes with expand/contract: add the new field, dual-write, migrate clients, remove the old field later.

## Cookies vs bearer tokens

The current default for a browser-facing app: session identifier or refresh token in an `HttpOnly; Secure; SameSite=Lax` (or Strict) cookie, short-lived access token (minutes) either also in a cookie or held in memory. Refresh tokens are rotated on each use and revocable server-side. Never put tokens in `localStorage`, any XSS can read it.

Bearer tokens in an `Authorization` header are the default for non-browser clients, mobile apps and service-to-service calls. They are not sent automatically, so they don't have CSRF exposure, but the client has to store and attach them.

- Cookies: automatic, HttpOnly protects against XSS theft, but exposed to CSRF. `SameSite=Lax` plus a CSRF token or origin check on state-changing requests closes that.
- Bearer JWTs: stateless verification is nice until you need to revoke one. Keep them short-lived and pair with a server-side refresh token.
- Opaque session ids with server-side storage remain a perfectly good choice and are the simplest to revoke.

**Gets you burned:**
- Long-lived JWTs with no revocation path, then a leaked token or a fired employee.
- `SameSite=None` set because "the cookie wasn't being sent" with no thought about why.
- Tokens logged in request logs because they were in a query string.

## Same-origin and CORS

An **origin** is scheme + host + port. The same-origin policy stops JavaScript on `evil.com` from reading responses from `bank.com`. CORS is the server-side opt-out: the server tells the browser which origins may read its responses. CORS is enforced by browsers only. It does nothing against curl, server-side code, or a mobile app.

For "non-simple" requests (JSON content type, custom headers, methods other than GET/POST/HEAD) the browser first sends an `OPTIONS` **preflight**. The server must answer with the allowed origin, methods and headers. Only then is the real request sent. `Access-Control-Max-Age` caches the preflight answer.

- `Access-Control-Allow-Origin: *` cannot be combined with `Allow-Credentials: true`. Browsers reject it. To send cookies cross-origin you must echo a specific, allowlisted origin.
- Reflecting whatever `Origin` header arrives is the same as `*` with credentials, and that one browsers do not block. That is the classic exploitable misconfig.
- Preflight failing usually means the OPTIONS route hits auth middleware and returns 401. OPTIONS must be answered before auth.
- The simplest fix for a first-party SPA is to avoid CORS entirely: serve the API under the same origin via a path prefix or a reverse proxy.

## HTTPS and TLS, what it gives you

TLS gives you three things: confidentiality (nobody on the path reads the traffic), integrity (nobody modifies it), and server authentication (you are talking to the holder of a certificate for that hostname). It does not authenticate the client, hide which host you connected to (SNI is visible, though encrypted ClientHello is spreading), or protect data at rest.

- Certificates are free and automated (ACME). There is no reason for HTTP anywhere user-facing.
- Terminate TLS at the edge (load balancer, CDN, reverse proxy). Internal hop encryption is a separate decision.
- `Strict-Transport-Security` tells browsers to never try plain HTTP again. Set it once you are sure.

## DNS and CDN at a glance

DNS maps names to addresses with caching governed by TTL. A change is not "live" until every resolver's cache expires, so lower the TTL a day before a migration. `CNAME` points a name at another name, `A`/`AAAA` at addresses. Apex domains can't carry a CNAME, hence provider-specific ALIAS/ANAME records.

A CDN is a cache plus a TLS terminator plus a network edge close to users. It serves static assets from cache, can cache API responses that carry public `Cache-Control`, absorbs bursts, and provides DDoS and WAF layers. Everything dynamic still hits your origin.

- Hashed asset filenames plus `immutable` caching mean you never need to purge. HTML itself stays short-lived.
- If a CDN caches a personalised response, users see each other's data. `Cache-Control: private` or `no-store` on anything with a user in it.

## WebSockets vs SSE vs polling

- **Polling** (client asks every N seconds): simplest, works everywhere, wastes requests. Fine for low-frequency status checks.
- **Long polling** (server holds the request until there is news): a step up, still HTTP, still stateless-ish. Rarely the right answer now.
- **SSE** (Server-Sent Events): one-way server-to-client stream over plain HTTP. Auto-reconnect built in, works through proxies and CDNs, trivially simple. Right choice for notifications, progress, live feeds and LLM token streaming.
- **WebSockets**: full duplex, low overhead per message. Right choice for chat, collaborative editing, games, anything where the client sends frequently too. Costs: sticky connections, harder to load balance, own auth and reconnection story, no HTTP semantics.

Default to SSE for server-push and add WebSockets only when the client genuinely needs to push a lot.

## GraphQL and RPC vs REST

- **REST** is the default for public and resource-shaped APIs. Cacheable, tool-friendly, boring in the good way.
- **GraphQL** earns its keep when many different clients need different shapes of the same graph and over/under-fetching is a real cost. It brings its own problems: N+1 by default, cache complexity, query cost limiting, a schema layer to maintain. Not a fit for a single first-party frontend with one backend team.
- **RPC** (gRPC, tRPC, plain "POST /rpc/doThing" JSON) is right for service-to-service calls and for tightly coupled frontend+backend in one repo where types flow end to end. It gives up HTTP caching and uniform semantics in exchange for speed of development.

## JSON conventions

- Consistent key casing. Dates as ISO 8601 strings in UTC with the `Z` suffix. Money as integer minor units or decimal strings, never floats.
- Ids as strings, even when they are numbers in the database. JavaScript loses precision above 2^53.
- `null` means "known to be empty", absent means "not provided". Decide whether your PATCH semantics distinguish them and document it.
- Wrap lists in an object (`{"data": [...], "next_cursor": ...}`) so you can add metadata without a breaking change.
- Error bodies in one shape everywhere. RFC 9457 Problem Details (`type`, `title`, `status`, `detail`, `instance`) is a fine ready-made one.

## Timeouts

Every network call needs a timeout. The default in most HTTP clients is infinite. Nothing else in this document will hurt you as quietly.

- Connect timeout (a few seconds) and read timeout (bounded by what the caller can tolerate) are separate.
- Server-side request timeouts should be shorter than the load balancer's idle timeout, or the LB returns 504 while your handler keeps working.
- Downstream calls inside a request should have budgets that add up to less than your own timeout.
- Retries need backoff with jitter and a cap. Retry only idempotent operations, or only with an idempotency key.

**When reviewing AI-written code:**
- HTTP client created with no timeout configured.
- Retry loop with no maximum attempts or no backoff.
- A user-facing request that fans out to five downstream calls sequentially with no overall deadline.

## Key takeaways

- GET must never have side effects, prefetchers and probes will trigger it.
- Never return 200 with a failure body, clients switch on status.
- 401 means log in, 403 means logging in will not help.
- Once headers are sent the status cannot change, streaming failures look like 200.
- Cursor pagination for feeds, offset only when jump-to-page matters.
- Keyset pagination needs a unique tiebreaker or rows drop.
- Never store tokens in localStorage, any XSS reads them.
- Long-lived JWTs without revocation are a leaked-token time bomb.
- Reflecting the Origin header with credentials is the classic CORS hole.
- Answer OPTIONS before auth middleware or preflight fails with 401.
- Every HTTP client needs a timeout, defaults are infinite.
- Retry only idempotent calls, with backoff, jitter and a cap.
