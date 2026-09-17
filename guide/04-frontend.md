# Frontend

*How a modern web frontend is put together, what the pieces are for, and where the judgment calls live.*

**Read when:** building or changing UI: components, state, data fetching, forms, routing, accessibility or browser storage.

## Component model and composition

A component is a function from inputs to UI. Every mainstream framework (React, Vue, Svelte, Solid, Angular) converges on the same shape: small units that own their markup, take inputs, and get composed into trees. The framework's job is to re-render efficiently when inputs change so you can write UI as "what it should look like given this data" instead of "what to mutate when this event fires."

The judgment call is where to cut. Split when a piece has its own reason to change, its own state, or is reused. Do not split just because a file is long. A component that needs twelve props to render one button is a bad cut.

- Props down, events up. Parents pass data in, children signal what happened, the parent decides what it means. Children should not reach up and mutate parent state directly.
- Prefer composition (children, slots) over configuration (boolean props that switch behavior). A `Card` that takes children beats a `Card` with `showHeader`, `showFooter`, `variant`.
- Keep "smart" components (fetch, coordinate) few and near routes. Keep "dumb" presentational components many and pure.
- Lifting state up is the first tool. Global state is the last.

**When reviewing AI-written code:**
- Watch for prop drilling five levels deep being "solved" with a global store. Usually the tree is cut wrong.
- Watch for components that both fetch data and render a form field. Too many responsibilities.
- Watch for a child that mutates an object it received as a prop. That breaks the framework's change detection in subtle ways.

## The four kinds of state

Most frontend mess comes from treating all state the same. There are four kinds and each has a natural home.

- **Local UI state.** Is the dropdown open, what has the user typed so far, which tab is selected. Lives in the component. Dies when the component unmounts. That is fine.
- **Server state (cache).** Users, orders, anything the backend owns. The frontend holds a *copy* that can be stale. It needs fetching, caching, invalidation, refetching, and error handling. This is what libraries like TanStack Query, SWR, RTK Query, and Apollo exist for.
- **URL state.** Current page, filters, search query, selected item id, pagination. If the user should be able to bookmark it, refresh into it, or share it, it belongs in the URL, not in memory.
- **Global client state.** Auth session, theme, feature flags, a shopping cart before checkout. Genuinely shared, genuinely client-owned. This list is short. A store (Redux, Zustand, Pinia, signals, context) is for this.

Mixing them hurts in predictable ways. Server data copied into a global store goes stale and nobody invalidates it. Filter state kept in memory means the back button does nothing and refresh loses the user's place. Form input kept in a global store re-renders the whole app on each keystroke.

**Gets you burned:**
- Putting API responses in a global store and then hand-writing the caching and invalidation the query library would have done.
- Modal open/closed in the global store. Now every modal in the app is coupled.
- Selected filters in component state. Refresh, and they are gone.

## Data fetching and caching

Server state is a cache and should be treated like one. The standard pattern is stale-while-revalidate: show what you have immediately, fetch fresh data in the background, swap it in when it arrives. Keyed by the request (URL plus params), deduplicated across components, with a configurable staleness window.

Invalidation is the hard part. After a mutation, you invalidate the queries that could have changed and let them refetch. Or you update the cache directly from the mutation response. Do not manually patch five different stores.

- Fetch at the route or feature boundary, not in every leaf. Leaves read from the cache.
- Handle four states for every fetch: loading, error, empty, success. "Empty" is the one that gets skipped.
- Abort in-flight requests when the user navigates away or the query key changes, or you get responses landing out of order.
- Loading spinners for every fetch cause layout churn. Prefer skeletons that match the final layout, and only show a loading state after a short delay for fast requests.

### Optimistic updates

Apply the change in the UI before the server confirms, then reconcile. Good for likes, toggles, reorders, anything low-stakes and likely to succeed. On failure, roll back and tell the user. Do not do this for payments, deletes with no undo, or anything where the server may legitimately say no often.

**When reviewing AI-written code:**
- A `useEffect` with a manual `fetch`, a `loading` boolean, and a `data` state variable is the 2019 pattern. It has no caching, no dedup, no cancellation, and races on fast navigation. Use the query library the project already has.
- Optimistic updates with no rollback path.

## Forms and validation

Forms are where client and server meet and where the "never trust the client" rule matters most. Client-side validation exists for fast feedback. Server-side validation exists for correctness and security. You need both, and the server one is the real one.

Share the schema where you can (same validation library on both ends, or generate client rules from the server's schema). Where you cannot, accept that the server will sometimes reject what the client allowed and design the form to show server errors per field.

- Validate on blur or submit, not on every keystroke, unless the field is a password strength meter or similar.
- Preserve user input on error. Clearing the form on a failed submit is hostile.
- Disable the submit button during submission and handle double-submit on the server too (idempotency key).
- Uncontrolled inputs plus a form library are fine and faster. Controlled inputs for every field re-render on each keystroke.

**Gets you burned:**
- Validation logic that exists only on the client. Anyone with curl bypasses it.
- Server returning a single generic "invalid input" string. The client cannot map it to a field.

## Routing

The router maps URL to component tree and usually owns loading data for that tree. Nested routes mirror nested layouts. Route params and query strings are the URL state described above.

- Put the loader (data fetching for a route) with the route, so navigation and data are coordinated and can be prefetched on hover.
- Guard routes on the client for UX (redirect to login) but never as the security boundary. The API enforces access.
- Deep links must work. If a page only functions after visiting the page before it, that is a bug.

## Rendering modes

Where the HTML gets produced determines first paint, SEO, server cost, and complexity.

- **CSR (client-side rendering).** Server sends an empty shell and a bundle. Browser builds everything. Simplest to host. Slow first paint, bad for SEO on content pages, fine for logged-in dashboards.
- **SSR (server-side rendering).** Server renders HTML for each request, browser hydrates it into a live app. Fast first paint, good SEO, needs a server, doubles the places your code runs.
- **SSG (static site generation).** Render at build time, serve from a CDN. Fastest and cheapest, only for content that changes on deploy. Incremental regeneration variants rebuild single pages on a schedule or on demand.
- **Streaming and islands.** Server streams the shell immediately and fills slow sections as they resolve. Islands ship JavaScript only for interactive parts of a mostly static page. Server components (React's flavor) let some components run only on the server and never ship to the client.

Most apps mix these per route: SSG for marketing, SSR or streaming for logged-in pages, CSR for heavy interactive tools. Pick per page, not per app.

### Hydration at a glance

Hydration is the browser attaching event handlers and state to server-rendered HTML so it becomes interactive. Until it finishes, buttons look clickable and do nothing. The HTML the server produced must match what the client would render, or you get hydration mismatch errors. Common causes: rendering `Date.now()`, reading `window`, browser-only locale, or a random id.

**Gets you burned:**
- Code that touches `window`, `document`, or `localStorage` at module load. It runs on the server and crashes.
- Rendering timestamps or anything user-locale-dependent on the server without knowing the user's locale.

## Build step, bundling, code splitting

The build turns many source files (and TypeScript, JSX, CSS modules, etc.) into a few optimized files the browser can load. The bundler (Vite, esbuild, Rollup, webpack, Turbopack, Rspack) resolves imports, transpiles, minifies, and hashes filenames for cache busting.

- **Tree shaking** drops exports nothing imports. It only works for ES modules with no side effects at import time. Importing a whole utility library for one function can defeat it.
- **Code splitting** breaks the bundle into chunks loaded on demand, usually per route. The user downloads the admin panel only when they open it. Most routers do this by default with dynamic `import()`.
- Check the bundle analyzer occasionally. A single dependency (a date library, a charting library, a rich text editor) is usually the surprise.

### Environment variables in the frontend are public

Anything the build inlines into the client bundle ships to every user and is readable in devtools. Frameworks require a prefix (`VITE_`, `NEXT_PUBLIC_`, etc.) to make this explicit. A "secret" with that prefix is not a secret. API keys for third parties that must stay private go through your backend.

**When reviewing AI-written code:**
- Any key, token, or credential in a public-prefixed env var. Check what it grants.
- `import * as _ from 'lodash'` style imports that pull in everything.

## Accessibility basics

Accessibility is mostly using HTML correctly. Screen readers, keyboard users, and voice control all depend on semantics the browser already provides. Every `div` with an `onClick` throws that away.

- Use `button` for actions, `a` for navigation, real `input`, `select`, `label`. A `div` styled as a button has no focus, no keyboard activation, no role.
- Every input has a label, associated by `for`/`id` or wrapping. Placeholder is not a label.
- Everything reachable by mouse is reachable by Tab and operable by Enter/Space. Modals trap focus and return it on close. Focus is visible.
- Color contrast of at least 4.5:1 for body text. Do not convey state by color alone.
- Images have `alt` text, decorative images have empty `alt`.
- Run an automated checker (axe or similar) in CI. It catches maybe a third of issues, but it catches them every time.

## Responsive basics

Mobile is the majority of traffic for most consumer products and a large minority for most B2B ones. Layout with flexbox and grid, size with relative units, and use media or container queries for breakpoints. Design mobile-first and add complexity at wider widths, not the reverse.

- Set the viewport meta tag or nothing works on phones.
- Touch targets around 44px. Hover has no meaning on touch, so nothing critical lives only in a hover state.

## Error boundaries and loading states

A render error in one component should not blank the whole page. Error boundaries catch render errors in a subtree and show a fallback. Put one around each route and around risky widgets (third-party embeds, charts). Loading boundaries (Suspense-style) do the same for pending data.

- Report boundary-caught errors to your error tracker with component context.
- The fallback should offer a way out: retry, go home, reload.
- Async errors (in event handlers, in fetches) are not caught by render error boundaries. Handle them explicitly.

## Design systems and component libraries

A design system is a shared vocabulary of tokens (colors, spacing, type scale) plus a set of components built from them. The value is consistency and not rebuilding a date picker for the fourth time. Use an established library (headless ones like Radix or Headless UI give behavior and accessibility, styled ones give the look too) and wrap it in your own thin layer so you can swap later.

- Tokens live in one place. Hardcoded hex values in components are the leak.
- Do not fork a library component to tweak it. Wrap or compose.

## Browser storage

Four places to keep things in the browser, and what is safe in each.

- **Cookies.** Sent automatically with every request to their domain. The right place for session identifiers, set by the server with `HttpOnly` (JavaScript cannot read it), `Secure`, and `SameSite`. Small (4KB). Anything else in a cookie is wasting bandwidth.
- **localStorage.** Synchronous, persists forever, readable by any script on the origin. Fine for preferences, drafts, UI state. Never for tokens or anything sensitive: one XSS and it is gone.
- **sessionStorage.** Same as localStorage but per tab and cleared on close. Multi-step form progress, that kind of thing.
- **IndexedDB.** Asynchronous, large, structured. Offline data, large caches. Use a wrapper library.

Everything in the browser is readable by the user and by any script running on the page. Storage is not a security boundary.

## Performance basics

Core Web Vitals are the metrics that matter for perceived speed and the ones search ranking uses. Measured at the 75th percentile of real users.

- **LCP** (Largest Contentful Paint), under 2.5s. Mostly about the hero image or main text arriving fast: server response, render-blocking resources, image size.
- **INP** (Interaction to Next Paint), under 200ms. Responsiveness after load. Long JavaScript tasks, heavy re-renders, and synchronous work in handlers are the culprits. This is the one most sites fail.
- **CLS** (Cumulative Layout Shift), under 0.1. Content jumping. Reserve space for images and ads, do not inject banners above content after load.

- Images are the usual biggest win: serve modern formats (AVIF, WebP), size them for the slot, set `width`/`height` to reserve space, lazy-load anything below the fold, never lazy-load the LCP image.
- Defer third-party scripts. Analytics and chat widgets are routinely the heaviest thing on the page.
- Measure in the field (real user monitoring), not just Lighthouse on your laptop.

## Internationalization and time on the client

Dates, numbers, and currencies render differently per locale, and the browser knows how. Use `Intl` (or a library on top of it) rather than string formatting.

- Store and transmit time as UTC (ISO 8601). Convert to the user's zone only at render. The browser's zone comes from the device, which may not be where the user "is." Let them override for calendar-like features.
- "Date only" values (birthday, invoice date) have no timezone. Do not put them through a `Date` object that will shift them by a day.
- Translation keys, not English strings, in components. Plurals and gender need ICU message format, not string concatenation.

## Feature detection

Check whether the browser supports a thing before using it. Do not sniff the user agent. `'share' in navigator`, `CSS.supports()`, `@supports` in CSS. Ship a fallback or hide the feature. Browserslist config drives what the build transpiles and polyfills, so keep it aligned with who actually uses the product, not with a default from 2020.

## Key takeaways

- Props down, events up, children never mutate parent state.
- Split components by reason to change, not by file length.
- Four kinds of state: local, server cache, URL, global. Keep them apart.
- Server data in a global store goes stale, use a query library.
- Bookmarkable or shareable state belongs in the URL.
- Handle loading, error, empty and success for every fetch.
- useEffect plus fetch plus loading boolean is the 2019 pattern, avoid it.
- Client validation is for feedback, server validation is the real one.
- Client route guards are UX, the API is the security boundary.
- Touching window or localStorage at module load crashes SSR.
- Public-prefixed env vars ship to every user, they are not secrets.
- Never store tokens in localStorage, storage is not a security boundary.
