# Architecture & Design Decisions

Record of significant technical decisions, rationale, and trade-offs.

## 2026-07-31: SECRET_KEY unconditionally required (no insecure fallback)

**Decision:** `server/crypto.js` now requires `SECRET_KEY` in `.env` unconditionally and throws at startup if missing. Previously only threw when `NODE_ENV=production`; test/dev modes fell back to a hardcoded insecure key.

**Rationale:**
- Earlier incident: `SECRET_KEY` was accidentally omitted from server `.env` but the app started silently on the fallback key, encrypting real SYSPRO/SMTP passwords under that key. Days later, SYSPRO authentication failed with no obvious cause — the startup output had scrolled past and the error was invisible.
- The fallback key's purpose was dev convenience, but a test box holding real customer data is not "dev" — it's staging/pre-production and deserves production rigor.
- A loud, immediate startup failure forces the error into visibility: the operator sees it, fixes it, and moves on. A silent fallback hides the error until decryption fails, costing time to diagnose.

**Implementation:**
- Removed `FALLBACK_KEY` and the conditional check for `NODE_ENV=production`
- App now throws with a clear message: "SECRET_KEY is not set. Copy .env.example to .env and set SECRET_KEY..."
- Updated `.env.example` to clarify that `SECRET_KEY` is **always** required, not just in production.

**Trade-offs:**
- Breaks a dev convenience (local testing without .env), but the error is loud and the fix is one line in .env.
- Makes the test server stricter, reducing gap between test and production behavior (intentional).

**Status:** Implemented in commit `8284944`. All 10 integration tests pass; test suite gets `SECRET_KEY` from project's .env automatically.

---

## 2026-07-31: Production deployment via NSSM Windows service

**Decision:** Run the app as a Windows Service via NSSM (Non-Sucking Service Manager) instead of a manually-started `npm start` process in an RDP window.

**Rationale:**
- **RDP window problem:** `npm start` in an RDP session dies when the user disconnects, killing the app even though no one told it to stop. Scheduled tasks (syncs, backups) fail silently overnight.
- **Windows Service solution:** NSSM wraps Node as a real Windows service that starts at boot with no one logged in, auto-restarts on crash, and integrates with Windows monitoring/alerting (Event Log, SC, Services.msc).
- **Production-grade:** This is non-negotiable for a box holding real customer data. A test server should not behave differently from production in ways that hide availability gaps.
- **No extra dependencies:** NSSM is a single `.exe`, not a service that needs its own infrastructure.

**Implementation:**
- Download NSSM from `nssm.cc`, register service with `nssm install RouteOne ...`
- Log output to `C:\RouteOne\server\logs` with rotation (10MB per file)
- `AppExit Default Restart` — crash restarts automatically
- `Start SERVICE_AUTO_START` — starts at boot
- Restart via: `nssm restart RouteOne`

**Trade-offs:**
- Ties deployment to Windows Server; Linux/cloud migration will need systemd or equivalent.
- NSSM is a third-party tool, but stable and widely used for exactly this (wrapping Node/Python as services).

**Testing:**
- Verified service is `SERVICE_RUNNING` after startup
- Verified app stays up after RDP session disconnects (the real test)
- Verified restart via `nssm restart` works (used instead of manual npm stop/start)

**Status:** Implemented and tested in commit `8284944`. Full walkthrough in DEPLOYMENT.md §8.

---

## 2026-07-26: Opt-in email model for orders/quotes

**Decision:** Changed order and quote email sending from opt-out (always send to orders dept, no visibility) to opt-in (user explicitly checks boxes on capture screen).

**Rationale:**
- Fixes audit finding: users had no visibility into or control over orders-department emails
- Reduces accidental email spam during testing/demo scenarios
- Clear audit trail: email intent is captured with the order itself
- Backward-compatible: default boxes are checked in the UI, approximating prior behavior

**Implementation:**
- New `email_to_orders_dept`, `email_to_customer`, `email_to_rep` columns on orders/quotes
- Capture screen checkboxes control these flags
- Email sending logic consults these flags before delivery

**Status:** Implemented in recent commits. See order/quote capture screens.

---

## 2026-07-26: SYSPRO as master system (read-only from RouteOne)

**Decision:** RouteOne does not write back to SYSPRO. All master data (customers, pricing, stock, history) originates from SYSPRO; RouteOne only reads and caches.

**Rationale:**
- Simplifies data consistency: single source of truth
- Reduces SYSPRO integration complexity (no sync conflicts, rollback logic)
- Audit trail: SYSPRO remains the system of record for all business operations
- Compliance: easier to audit "where did this price come from?"

**Implementation:**
- Periodic SYSPRO sync job (via `repDigest.js`) imports updates
- RouteOne captures orders/quotes locally, then sends to SYSPRO (via email/manual, not auto-sync)
- No foreign-key constraints to SYSPRO; RouteOne holds local copies

**Status:** Foundational design. See `server/utils/syspro.js` and sync scheduler.

---

## 2026-07-26: SQLite for local app data, SYSPRO SQL for master

**Decision:** Use SQLite (simple, file-based, no server) for RouteOne's operational data; use SYSPRO's SQL Server as the master ERP database.

**Rationale:**
- SQLite: stateless app instances, zero ops overhead, easy backup/restore (single file)
- SYSPRO SQL: already exists, managed by ops, read-only from RouteOne reduces risk
- Fits Windows Server deployment model (no extra services to manage)

**Trade-offs:**
- SQLite is single-writer: constrains to single Node process per instance (documented in PRODUCTION-READINESS-AUDIT)
- No query distribution across replicas; horizontal scale requires app-layer sharding

**Status:** Current production configuration. See `server/db/index.js`.

---

## 2026-07-26: JWT for session auth, no server-side session store

**Decision:** Use stateless JWT tokens with no server-side session table or Redis.

**Rationale:**
- Stateless: aligns with single-writer SQLite constraint (no session-lock contention)
- Simple: fits Windows Server deployment (no extra infrastructure)
- Mobile-friendly: tokens work offline (for eventual offline-sync feature)

**Trade-offs:**
- Token revocation is not immediate (relies on expiry or client discard)
- Logout is client-side only (no server-side "blacklist" of revoked tokens yet)

**Status:** Current implementation. See `server/auth/jwt.js`.

---

## 2026-07-26: BAKELS logo + white-label placeholder structure (not yet used)

**Decision:** Login page displays actual BAKELS branding; client config allows future white-label overrides.

**Rationale:**
- Current customer is BAKELS; branding is correct for day-one deployment
- Config structure future-proofs for multi-tenant or white-label scenarios
- Code comments document where to swap logos/colors for different customers

**Status:** Implemented. See `client/public/` and login page component.

---

## 2026-07-26: Documents feature uses admin/manager roles (not dedicated "marketing manager")

**Decision:** Documents upload is gated to existing admin/manager roles, not a new dedicated "marketing manager" role.

**Rationale:**
- Simpler: reuses existing role hierarchy (no new permissions to audit)
- Faster: ready for initial launch
- Follow-up: See TODO.md "Marketing manager permissions" if a dedicated role is needed later

**Status:** Current implementation. See Documents page server routes.

**Follow-up decision needed:** If marketing managers should NOT have access to orders/settings/admin area, create a dedicated `documents_manager` role with narrower permissions.

---

## 2026-07-26: Churn-risk calculated from app orders + SYSPRO invoice history

**Decision:** `last_order_at` (used in churn risk calculations) checks both app-captured orders AND SYSPRO invoices, not just app orders.

**Rationale:**
- Audit finding: earlier logic only checked app orders, missing the customer's history in SYSPRO → false-positive churn risk
- More accurate: captures both "orders entered via RouteOne" and "invoices from direct SYSPRO entry or other sales channels"
- Consistent with "SYSPRO is master system" principle

**Status:** Fixed in recent commits. See customer churn-risk calculations.

---

## 2026-07-26: Per-kg pricing shown in emails/PDFs

**Decision:** Include per-kg unit price breakout in order/quote emails and PDF attachments (HTML body and PDF).

**Rationale:**
- Pricing transparency: reps and customers see the cost-per-unit context
- Improves order accuracy: customer can verify pricing before payment
- Audit trail: email/PDF captures the exact pricing at order time

**Implementation:**
- Calculate from order line items: `price_per_kg = total_price / weight_kg`
- Include in email template and PDF generation logic

**Status:** Implemented in recent commits. See email templates and PDF generator.

---

## 2026-07-09: Tasks module (Phase 2 & 3) with mobile rep + manager features

**Decision:** Implement Tasks as a distinct module (separate from orders/quotes) with rep creation, manager assignment, and inline Done/Reschedule actions in Today call cycle.

**Rationale:**
- Reps need lightweight task capture (not full order form)
- Manager visibility into rep workload (assignment, completion tracking)
- Integrates into existing "Today" flow (familiar to reps)
- Offline-capable design (tasks sync on connection)

**Status:** Implemented. See `client/pages/Tasks` and `server/routes/tasks.js`.

**Remaining:** Full offline mode and push notifications (see TODO.md).

---

## 2026-07-08: Mobile-first UI with responsive design

**Decision:** Build UI responsive-first, optimizing for mobile (rep phones), then desktop (back-office).

**Rationale:**
- Reps live on mobile; desktop is secondary (back-office only)
- React component reuse: single codebase for both
- Tailwind CSS: rapid responsive iteration

**Status:** Ongoing. See component library and Tailwind config.

---

## 2026-07-07: TypeScript + async/await + parameterized SQL

**Decision:** All code uses TypeScript, async/await (no callbacks), and parameterized SQL queries (no string concatenation).

**Rationale:**
- Type safety: catch bugs at build time
- Readability: async/await is clearer than callback chains
- Security: parameterized queries prevent SQL injection

**Status:** Project-wide standard. See CLAUDE.md development rules.

---

## 2026-07-07: Graphify knowledge graph for codebase orientation

**Decision:** Build and maintain a Graphify knowledge graph (`graphify-out/`) covering code + docs + brand assets.

**Rationale:**
- Orientation aid: graphify query/path/explain for architecture questions
- Faster onboarding: graph shows relationships without reading whole files
- Living documentation: graph updates with `graphify update` after structural changes

**Status:** Implemented. Graph currently has 711 nodes, 1757 edges across 52 communities. See CLAUDE.md for query examples.

**Maintenance:** Run `graphify update` after major structural changes (new modules, file moves, significant refactors).
