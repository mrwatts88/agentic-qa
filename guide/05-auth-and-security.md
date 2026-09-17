# Auth and Security

*Who the user is, what they may do, and the handful of attack classes that account for most real-world web app breaches.*

**Read when:** touching login, sessions, tokens, permissions, secrets, security headers, or any user input that reaches a query, a command or the page.

## Authentication vs authorization

Authentication (authn) answers "who is this." Authorization (authz) answers "what may they do." They are separate problems with separate failure modes and the most common serious bug in web apps is doing the first and forgetting the second: the user is logged in, so the code assumes any record they ask for is theirs.

- Authn happens once per session at the edge. Authz happens on every request, for every resource, at the layer that touches data.
- The identity that comes out of authn (user id, tenant id, roles) is the *input* to authz. Never let the client supply it.
- "Logged in" is not a permission.

## Sessions vs JWT

Both are ways to remember who the user is between requests. The tradeoff is where the state lives.

**Server-side sessions.** The server stores session data (in Redis, the DB, or memory) keyed by a random id in a cookie. The cookie carries nothing meaningful. Revocation is trivial: delete the row. Every request does a lookup, which is cheap and fine for the vast majority of apps.

**JWT (stateless tokens).** The server signs a token containing the claims (user id, roles, expiry) and the client presents it. No lookup needed, which helps when many services need to verify identity without sharing a session store. The cost is that you cannot revoke a token before it expires without adding back the state you were trying to avoid (a denylist, a version check), at which point you have a session with extra steps.

Current guidance for a typical web app with its own backend: use server-side sessions in an `HttpOnly` cookie. Use JWTs when a third party issues them (OIDC id tokens, access tokens for an external API) or when you have a genuine multi-service verification need, and keep them short-lived.

- Cookie attributes: `HttpOnly` (script cannot read it), `Secure` (HTTPS only), `SameSite=Lax` or `Strict` (blocks most CSRF), a tight `Path`, and no wildcard `Domain` unless you need subdomains.
- Do not store tokens in `localStorage`. Any XSS reads them. A cookie with `HttpOnly` is strictly better.
- If you use JWTs: validate the signature *and* the algorithm (reject `none`), the issuer, the audience, and the expiry. Every one of those has been skipped in a real breach.
- Rotate the session id on login (prevents session fixation). Invalidate all sessions on password change.

### Refresh tokens

Short-lived access token (minutes) plus a long-lived refresh token (days or weeks) used only to mint a new access token. The refresh token is the sensitive one: store it `HttpOnly`, rotate it on each use, and detect reuse of an old one as a signal of theft (revoke the whole family). This pattern is mostly relevant when you are the OAuth client or the API is consumed by native apps. A web app with a session cookie does not need it.

**Gets you burned:**
- JWT in localStorage "because the tutorial did it."
- A 30-day JWT with no revocation. The user is fired, and they can still call the API for a month.
- Trusting claims in a token without verifying the signature.

## OAuth2 and OIDC

OAuth2 is delegated authorization: let this app act on my behalf at that provider. OIDC is a thin identity layer on top that answers "who logged in" with a signed id token. "Sign in with Google" is OIDC.

The flow you should be using is **authorization code with PKCE**, for both web and native apps. The shape:

1. Your app redirects the user to the provider with a client id, redirect URI, requested scopes, a random `state`, and a PKCE code challenge.
2. The user authenticates with the provider and consents.
3. The provider redirects back to your registered URI with a short-lived code and the `state`.
4. Your backend exchanges the code (plus the PKCE verifier and, for confidential clients, the client secret) for tokens.
5. You get an id token (who they are, verify it), an access token (call the provider's API), and possibly a refresh token.

After step 5 you create *your own* session. The provider's tokens are for talking to the provider, not for authenticating requests to your own API.

- Implicit flow is deprecated. If you see tokens in the URL fragment, it is old.
- Verify `state` on the callback or you have a CSRF login hole.
- Registered redirect URIs must be exact. Wildcards there are a takeover vector.

### SSO at a glance

Single sign-on for a workplace means your app trusts a corporate identity provider (Okta, Entra, Google Workspace) via OIDC or SAML. Enterprise customers will ask for it. Buy or use a library rather than implementing SAML by hand. Provisioning (SCIM) is the follow-up ask: create and deactivate users automatically from the IdP.

## Passkeys and WebAuthn

Passkeys are the current direction for primary authentication. A public/private keypair per site, the private key kept in the device's secure hardware or synced password manager, with the browser's WebAuthn API doing a challenge-response signed for the exact origin. Phishing-resistant by construction: a fake domain gets a signature for the wrong origin. No shared secret to leak from your database.

Practical stance in 2026: offer passkeys, keep password plus MFA as a fallback, and use a library or your identity provider for the ceremony. Do the registration and assertion verification on the server. The hard parts are product, not crypto: account recovery, multiple devices, and what happens when someone loses their phone.

## Passwords

If you store passwords, hash them with a slow, salted, memory-hard algorithm: argon2id first choice, bcrypt still acceptable, scrypt fine. Never plain SHA-256, never your own scheme, never encryption (which implies decryption).

- Use the library's defaults for cost and raise them over time. Rehash on login when the cost parameter is out of date.
- Minimum length matters more than composition rules. Check against breached-password lists. Do not cap length at 20.
- Compare hashes with a constant-time function. Return the same error and timing for "no such user" and "wrong password."
- Password reset tokens: random, single-use, short expiry, sent to the verified address, and never echoed in a URL that gets logged.

## MFA

A second factor makes a stolen password insufficient. Options in rough order of strength: passkey or hardware key, TOTP app, push notification, SMS (weakest, SIM swapping). Offer TOTP at minimum, encourage passkeys, and generate recovery codes at enrollment.

- Rate-limit code attempts. Require fresh MFA for sensitive actions: changing email, disabling MFA, viewing payment details.

## Authorization models

**RBAC** (role-based): users have roles, roles have permissions. Simple, auditable, right for most apps. Keep the role list short and permissions explicit ("invoice:approve") rather than implied by the role name.

**ABAC** (attribute-based): decisions from attributes of the user, resource, and context. "Owner can edit their own draft before 5pm." More flexible, harder to reason about. Most apps end up with RBAC plus a few ownership rules, which is fine.

### Check at the service layer, not just the UI

Hiding a button is UX. Rejecting the request is security. Every service method that reads or mutates a resource takes the caller's identity and checks it can act on *that* resource. The controller should not be the only guard, because the same service gets called from jobs, other endpoints, and admin tools.

- Load the resource scoped to the caller (`WHERE id = ? AND owner_id = ?`), not load-then-check. The scoped query cannot forget.
- Deny by default. A new endpoint with no explicit rule should fail closed.
- Centralize the policy (one module, one function per action) so it can be tested and audited.

### Multi-tenant data isolation

In a shared-database SaaS every row has a `tenant_id`, every query filters by it, and the tenant comes from the authenticated session, never from the request body or URL. Enforce it structurally: a repository base class that injects the filter, row-level security in Postgres, or a scoped connection per request. Relying on each developer to remember the `WHERE` clause is how tenant leaks happen.

**Gets you burned:**
- Checking the role in middleware, then fetching by id in the service with no ownership check. The classic IDOR.
- An admin-only endpoint that checks `isAdmin` from a request header or a client-set field.
- Background jobs that run with a system identity and skip tenant scoping.

## The attack classes that matter

OWASP's 2025 Top 10 leads with Broken Access Control, Security Misconfiguration, Supply Chain Failures, Cryptographic Failures, Injection. Below is the practical subset for a web app team.

**Injection.** Untrusted input becomes part of a command: SQL, shell, LDAP, template, log. Fix: parameterized queries always, ORMs or query builders that bind parameters, no string-built shell commands. An LLM prompt assembled from user input is the new member of this family.

**XSS.** Attacker's script runs in your users' browsers with their session. Fix: output encoding by default (every modern framework does this for templates), never `innerHTML` or the framework's "dangerously set" escape hatch with user data, a Content Security Policy as a backstop, `HttpOnly` cookies so a successful XSS at least cannot read the session.

**CSRF.** A malicious site makes the user's browser send a request to yours with their cookies attached. Fix: `SameSite` cookies (default protection now), plus a CSRF token or origin check for state-changing requests if you support old browsers or cross-site cases. Never do state changes on GET.

**SSRF.** Your server fetches a URL the user supplied and the attacker points it at internal services or the cloud metadata endpoint. Fix: allowlist destinations, resolve and block private ranges, no redirects following, egress restrictions on the network.

**Broken access control and IDOR.** Covered above. Guess the id, get the record. Consistently the number one category.

**Security misconfiguration.** Debug mode in production, default credentials, open S3 buckets, verbose stack traces to the client, permissive CORS (`*` with credentials), directory listing. Fix: a hardened baseline in infrastructure as code, and a pre-deploy checklist.

**Secrets in code.** API keys in the repo, in the Docker image, in the client bundle, in logs. Git history is forever.

### Input validation and output encoding

Validate input at the boundary against a schema: type, length, range, format, allowlisted values. Reject, do not sanitize. Then encode output for the context it lands in: HTML body, HTML attribute, URL, JavaScript, SQL, shell each need different escaping. Validation on the way in and encoding on the way out are both required. Neither substitutes for the other.

**When reviewing AI-written code:**
- String concatenation anywhere near a query, a shell call, or an HTML template.
- `dangerouslySetInnerHTML`, `v-html`, `innerHTML =` with anything derived from user data.
- A fetch to a URL that came from the request without an allowlist.
- `cors({ origin: '*' })` next to `credentials: true`.

## Secrets management

Secrets live in environment variables injected at runtime or in a secrets manager (AWS Secrets Manager, Vault, cloud-native equivalents), never in the repository, never in the image, never in the client bundle.

- `.env` files are local-only and gitignored. Commit a `.env.example` with names and no values.
- Rotate on a schedule and immediately on any suspected leak. Design so rotation does not require a redeploy (read at startup, support two valid keys during rotation).
- Scope each secret: one key per service per environment. A leaked staging key should not open production.
- Run a secret scanner in CI and as a pre-commit hook. If a secret hits git, rotate it. Rewriting history is not enough because clones exist.

## Dependencies and supply chain

Most of your running code is someone else's. The 2025 OWASP list made supply chain failures its own category.

- Commit the lockfile and install from it in CI (`npm ci`, `pip install` from a lock, etc.). No lockfile means a different tree on every build.
- Run vulnerability audits in CI and automated update PRs (Dependabot, Renovate). Merge patch updates routinely so you are not forced to leap five majors during an incident.
- Prefer few, well-maintained dependencies. A left-pad sized package is not worth a transitive risk.
- Pin GitHub Actions and Docker base images to digests, not floating tags. Wait a few days before adopting a brand-new package version.

## Security headers

Set once in the framework or reverse proxy, verified with an online scanner.

- `Content-Security-Policy`: restricts where scripts, styles, and connections may load from. The strongest XSS mitigation. Start with report-only mode, use nonces for inline scripts, tighten over time.
- `Strict-Transport-Security`: force HTTPS for a long max-age.
- `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY` (or CSP `frame-ancestors`), `Referrer-Policy: strict-origin-when-cross-origin`, `Permissions-Policy` to disable camera, mic, and geolocation you do not use.
- CORS is not a security header for your API. It controls which *browser origins* may read responses. Set an explicit origin list.

## Rate limiting and brute force

Any endpoint that verifies a secret (login, MFA code, password reset, API key) needs a limit per account and per IP, with exponential backoff or temporary lockout. Any expensive endpoint (search, export, LLM calls) needs a limit per user to protect capacity and your bill.

- Enforce at the edge (gateway, CDN) for volume and in the app for per-user rules.
- Return `429` with `Retry-After`.
- Lockout by account alone lets an attacker lock out victims. Combine signals.

## Logging without leaking

Logs are a data store with weaker access control than your database. Treat them accordingly.

- Never log passwords, tokens, session ids, full card numbers, authorization headers, or request bodies wholesale. Redact at the logger level with an allowlist of fields.
- Log the user id, not the email, where possible. PII in logs is a retention and compliance problem.
- Do log security events: login success and failure, MFA changes, permission changes, admin actions, with who, what, when, from where. OWASP's logging category is about detecting an attack in progress.

## Least privilege for service accounts

Every service, job, and CI pipeline runs as an identity with permissions. Give it only what it needs. The database user for the web app does not need `DROP`. The CI runner that deploys to staging does not need production credentials. The reporting service gets a read replica.

- One identity per service per environment. Shared credentials cannot be revoked without an outage.
- Prefer short-lived credentials from the platform (IAM roles, workload identity) over static keys.

## When there is an incident

At a glance, in order:

1. Contain: revoke the credential, block the IP, disable the endpoint, take the box off the network. Stop the bleeding before understanding it.
2. Preserve evidence: snapshot logs and disks before rebuilding anything.
3. Assess: what was accessed, for how long, which users and tenants. Be pessimistic.
4. Rotate every secret that could have been exposed, not just the one you know about.
5. Notify: internal stakeholders immediately, affected customers and regulators per your obligations (GDPR has a 72-hour clock).
6. Write it up blamelessly: timeline, root cause, what would have detected it sooner, what changes.

Have the contact list, the runbook, and the authority to pull the plug decided before you need them.

## Key takeaways

- Logged in is not a permission, authorize every resource on every request.
- Default to server-side sessions in HttpOnly cookies, not JWTs.
- Long-lived JWTs without revocation keep working after a firing.
- Validate JWT signature, algorithm, issuer, audience and expiry.
- Use authorization code with PKCE, verify state, exact redirect URIs.
- Create your own session after OIDC, provider tokens are for the provider.
- Hash passwords with argon2id or bcrypt, never SHA-256 or encryption.
- Load resources scoped to the caller, not load-then-check.
- Tenant id comes from the session, never the request, enforced structurally.
- Parameterize every query, never innerHTML with user data.
- Reject invalid input at the boundary, encode output for its context.
- If a secret hits git, rotate it, rewriting history is not enough.
