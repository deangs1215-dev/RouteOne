# ROUTEONE — PROJECT HANDOVER

**Prepared:** 2026-08-28, end of a single long development session
**Branch:** `pricing-convfactaltuom` (NOT `main` — see Section 9)
**Author of this document:** Claude (Sonnet 5), summarising a session that ran from an ad-hoc rep-sales question through six numbered UAT tickets (R1-023–R1-028), plus several unnumbered fixes discovered along the way.

This document exists so a brand-new Claude session (with no memory of this conversation) can pick up RouteOne development immediately, without rediscovering the architecture, the data model, or the reasoning behind decisions already made. Read it fully before touching code.

The project also has its own pre-existing docs at the repo root: `README.md`, `DECISIONS.md`, `DEPLOYMENT.md`, `DEPLOYMENT_GUIDE.md`, `DISCUSSIONS.md`, `TODO.md`, `CHANGELOG.md`, `QUICK_REFERENCE.md`, `IT_SERVER_SETUP_GUIDE.md`, `MONITORING_SETUP.md`, and an older `SESSION_HANDOVER.md`. Skim those too — this document covers *this session's* work in depth, not the whole project history.

---

## 1. ROUTEONE PROJECT OVERVIEW

**What it is.** RouteOne is an enterprise B2B Field Sales CRM built by Navex for South Bakels (`sbakels.co.za`). It gives sales reps customer information, pricing, quotations, order capture, product information, visit planning and customer management, while integrating with SYSPRO (the ERP system of record).

**Business purpose.** RouteOne **complements** SYSPRO — it does not replace it. SYSPRO is the master system for pricing, stock, customer master data, and financial history. RouteOne reads from SYSPRO via synced SQL views and writes its own operational data (visits, orders/quotes captured in the field, notes, tasks) which is then processed into SYSPRO through the normal SYSPRO order-entry workflow (RouteOne does **not** write directly into SYSPRO tables — see Section 6 for the current status of that gap).

**Current phase scope (Phase 1, as observed in this session).** Order/quote capture, customer visit management, contract-aware pricing display, rep KPI reporting, SYSPRO data sync (customers, products, stock, invoices, pricing, rep sales, customer sales), and basic admin/reporting screens. A large amount of this session's work was **UAT bug-fixing** on an already-built Phase 1 system, not net-new feature design — treat existing patterns as intentional unless you find a concrete defect.

**Main workflows:**
- A rep visits a customer (check in via GPS, or manually/offsite), views customer/product/pricing info, and captures an order or quote.
- An office/manager/admin user can also capture orders/quotes on behalf of a customer from the desktop UI.
- SYSPRO data (customers, products, pricing, stock, invoices, rep and customer sales) syncs into RouteOne's own SQLite database on a schedule or on demand.
- Reps get KPI reporting (sales vs target, visit compliance, coverage) sourced from synced SYSPRO data, not RouteOne's own order-capture activity (this distinction was the subject of several fixes this session — see Section 7).

---

## 2. CURRENT ARCHITECTURE

**Frontend:** React 18 + React Router 7, built with Vite, styled with Tailwind CSS. No TypeScript currently in use despite `CLAUDE.md` saying "Always use TypeScript" — the codebase is plain `.jsx`/`.js`. (Worth flagging to the user if a new session is asked to introduce TS; don't do it unprompted.)

**Backend:** Node.js + Express 5 (ESM modules — `import`/`export`, not `require`). Single process serves both the JSON API and the built frontend as static files.

**Database:** SQLite via `better-sqlite3` (synchronous driver). This is RouteOne's **own** operational database — separate from SYSPRO. SYSPRO is SQL Server, reached only via the sync layer (`server/integration/`), never written to.

**Authentication:** JWT-based. `signToken(user)` in `server/auth.js` signs `{ id, role: role_name }` with a secret persisted in the `settings` table (`jwt_secret`, auto-generated on first run if absent). Token is delivered as an HTTP-only cookie named `routeone_session` (`SESSION_COOKIE`), 12-hour expiry (`SESSION_MAX_AGE_MS`). `COOKIE_SECURE` env var controls whether the cookie is `Secure`-only (must be `0` on the internal HTTP test server, or logins silently bounce back to the login screen — this is a documented gotcha in `.env.example`).

**Ports:**
- API: `API_PORT` env var, default **4200**. `server/index.js` calls `startServer(port = process.env.API_PORT || 4200)`.
- The same Express process serves the built React app as static files from `../dist` (i.e. `dist/` at repo root) when it exists — there is no separate frontend server in production.
- Dev-only: Vite dev server for `npm run dev:client` runs on its own port (5173 by default, though `server/index.js`'s CORS allow-list also references `5190` — check `vite.config` / actual dev output if this matters).
- CORS allow-list in `server/index.js`: `http://localhost:4200`, `http://127.0.0.1:4200`, `http://localhost:5190`, `http://127.0.0.1:5190` (plus whatever `APP_ORIGIN` resolves to in production).

**Folder structure (repo root):**
```
client/               React frontend
  src/
    App.jsx            top-level routing
    api.js             api.get/post/put/del helpers, fmtR/fmtDate/fmtDateTime, todayISO
    auth.jsx            useAuth() hook
    offline.js          offline write queue (queueWrite) + offline snapshot fallback
    index.css           Tailwind + a few hand-written classes (.modal-panel, .modal-scroll — see R1-003)
    components/         shared components (office-oriented, but some helpers reused by mobile)
    pages/              desktop/office pages (Orders.jsx, Quotes.jsx, CustomerDetail.jsx, Kpis.jsx, Integration.jsx, ...)
    mobile/             rep-facing mobile screens (RepOrderCapture.jsx, RepCustomer.jsx, MobileApp.jsx, ...)
server/                Node/Express backend
  index.js              app entrypoint, route mounting, static serving
  db.js                 SQLite connection, schema.sql execution, ALTER-TABLE migration list, shared business logic (round2, VAT_RATE, effectivePrice, productUnitPrice, priceBreaks, activeRules, adjustOrderStock, nextNumber, logActivity, getSetting/setSetting, getTodayISO/getLocalDateISO)
  schema.sql             full CREATE TABLE IF NOT EXISTS schema (does NOT add columns to existing tables — see migration list in db.js)
  auth.js                JWT + cookie auth, requireAuth, requireRole, scopeForUser, userCanAccessCustomer
  routes/                one file per resource (see Section 4)
  integration/           SYSPRO sync engine (sync.js, providers.js, scheduler.js, email.js, pdf.js, repDigest.js)
  import-reps.js          one-time/insert-only rep onboarding script
  reconcile-reps.js       NEW this session — read-only rep-vs-SYSPRO drift report
  handover-rep.js         NEW this session — writes a rep-code handover
  data/                  the live SQLite file lives here in each environment (fieldsales.db)
  backups/, uploads/     runtime state, gitignored
docs/sql/                SYSPRO-side SQL scripts (views) — see Section 3
dist/                   built frontend (generated by `npm run build`, gitignored... check .gitignore, but treated as build output)
```

**Important configuration:** `.env` (gitignored) holds `SECRET_KEY` (mandatory — app refuses to start without it, used to encrypt stored SYSPRO/SMTP passwords at rest), `NODE_ENV`, `APP_ORIGIN`, `API_PORT`, `TRUST_PROXY`, `COOKIE_SECURE`. SYSPRO connection details (host, port, database, user, password, view names) are stored in the `settings` table via the Integration admin page, not in `.env` — password is encrypted with `SECRET_KEY` via `server/crypto.js`.

**How frontend talks to the API:** `client/src/api.js` wraps `fetch`, always same-origin (no separate API host in production — the Express server serves both), sends/receives the `routeone_session` cookie automatically, throws typed errors the UI catches (`err.isNetworkError` is checked in a few offline-queueing paths, e.g. order/quote submission).

---

## 3. DATABASE

RouteOne's SQLite schema. This list reflects the schema **as of this session's end** — several tables/columns were added or changed this session (flagged below).

**Core tables (pre-existing, not modified this session unless noted):**
- `settings` (key/value) — JWT secret, SYSPRO connection config, feature toggles, sync schedules.
- `roles`, `users` — `users.role_id → roles.id`; `users.rep_code`, `users.warehouse_id` are the fields that tie a RouteOne user to a SYSPRO salesperson (see Section 7, rep matching).
- `territories`, `warehouses` (SYSPRO branches, synced).
- `customers` — synced from SYSPRO (`vw_FS_Customers`), plus RouteOne-managed fields (onsite_*, notes, classification/grade, visit_frequency, GPS pin). `customers.rep_id` is **overwritten every sync** by `matchRep()` — SYSPRO is authoritative for rep assignment (a decision made *before* this session, reaffirmed during it).
- `customer_contacts`, `customer_intel` (rep-captured "soft" account intelligence — competitor, decision-maker, etc. — distinct from `customer_notes`, see below).
- `product_categories`, `products` — synced from SYSPRO (`vw_FS_Products`). Key fields: `code` (SYSPRO stock code — the canonical join key used throughout), `name`, `uom` (SYSPRO `OtherUom` — the **selling unit**, e.g. `EA`, `KG`), `pack_size` (SYSPRO `StockUom`, largely superseded — see below), `pack_weight_kg` (**deprecated**, kept only as a fallback), `conv_factor_alt_uom` (SYSPRO `ConvFactAltUom` — the correct per-kg→per-selling-unit conversion factor, added this session, see Section 7), `list_price` (the "G Price" — SYSPRO's normal per-kg selling price, preferentially the `PriceCode='G'` row), `cost_price`, `stock_qty`, `discontinued` (added this session), `active`.
- `product_stock` (per-warehouse stock, synced).
- `customer_prices` (RouteOne-native manual price override table — distinct from `syspro_customer_pricing`).
- `syspro_customer_pricing` (SYSPRO's own contract/buying-group/price-code pricing per customer+product, date-windowed, synced from `vw_FS_CustomerPricing_ContractBuyingGroup`).
- `visits`, `rep_locations`.
- `orders`, `order_items` — RouteOne-captured orders. `orders.customer_order_no` **added this session** (R1-004 — the customer's own PO/reference, kept out of `notes` deliberately).
- `quotes`, `quote_items` — same shape as orders; `quote_items` currently has **no real discount support** — `discount_pct` is always stored as `0` server-side regardless of what's sent (a deliberate finding this session, not changed — see Section 7).
- `invoices`, `invoice_items` — synced from SYSPRO (`vw_FS_Invoices` / `vw_FS_InvoiceLines`). `invoice_items.delivery_customer_id` / `delivery_customer_code` **added this session** to fix a group-billing visibility bug (see Section 7). **Important, unresolved finding:** `invoices.balance` and `invoices.status` are effectively fabricated — the SYSPRO invoice view has no real balance/payment columns, so a fallback always computes `balance = total` and `status = 'outstanding'`. This was hidden from the UI this session (R1-015) rather than fixed at the source (fixing it needs new SYSPRO view columns — `ArInvoice.InvoiceBal1` or similar — not yet investigated).
- `rep_monthly_sales` — synced from `vw_FS_RepSalesByMonth` (pre-existing before this session).
- `customer_monthly_sales` — **new table this session** (R1-005), synced from a **new view** `vw_FS_CustomerSalesByMonth`, mirroring the rep-sales pattern but keyed on `customer_code`. Drives "Sales MTD" and "Sales 12 months" on the customer profile.
- `customer_notes` — **new table this session**, append-only rep contact log (call/email/whatsapp/meeting/sample/note) that is deliberately **not** a visit (see Section 7 for why).
- `rep_budgets`, `tasks`, `route_cycles`, `activity_log`, `form_templates`, `form_submissions`, `drafts`, `sync_runs`, `email_recipients`, and others not touched this session (a full audit of every table was not performed — this list is what came up in the course of the work, not a schema dump).

**Migrations:** `server/schema.sql` uses `CREATE TABLE IF NOT EXISTS` only — it never adds a column to an existing table. Actual column-level migrations live in a big ordered list of `ALTER TABLE ... ADD COLUMN` statements near the top of `server/db.js`, each wrapped in try/catch (`try { db.exec(stmt); } catch { /* column already exists */ }`) so re-running is safe. **Critical rule learned the hard way this session:** any `CREATE INDEX` on a newly-added column must go in this migration list, **not** in `schema.sql` — `schema.sql` runs first and is *not* error-tolerant, so an index referencing a column that doesn't exist yet on an un-migrated database crashes the whole app on startup. This exact bug was introduced and fixed this session (see Section 7, "startup crash").

**SYSPRO/SQL integration — views and scripts.** All SYSPRO-side SQL lives in `docs/sql/*.sql` (never applied automatically — someone runs each script by hand in SSMS against the `SysproCompany001` database, then RouteOne syncs against the resulting view). Current/live view definitions, in the order they'd need to be (re)applied on a fresh SYSPRO setup:

| View | File | Status this session | Purpose |
|---|---|---|---|
| `vw_FS_Warehouses` | (not touched) | — | branches |
| `vw_FS_Customers` | (not touched) | — | customer master |
| `vw_FS_Products` | `vw_FS_Products-discontinued.sql` | **RUN, live** | products + `conv_factor_alt_uom` + `discontinued` flag; admits a discontinued product only if invoiced in the last 90 days |
| `vw_FS_Stock` | (not touched) | — | per-warehouse stock |
| `vw_FS_CustomerPricing_ContractBuyingGroup` | (not touched) | — | SYSPRO contract/buying-group/price-code pricing |
| `vw_FS_Invoices` | `vw_FS_Invoices-exclude-credit-notes.sql` | **RUN, live** | invoice headers; fixes double-counted VAT and excludes credit notes (see Section 7) |
| `vw_FS_InvoiceLines` | `vw_FS_InvoiceLines-delivery-customer.sql` | **RUN, live** | invoice line detail; exposes the **delivery customer** (not just the billed account) and widened from 30→90 days |
| `vw_FS_RepSalesByMonth` | `vw_FS_RepSalesByMonth.sql` | pre-existing | rep monthly sales (ex-VAT) |
| `vw_FS_CustomerSalesByMonth` | `vw_FS_CustomerSalesByMonth.sql` | **NEW, RUN, live** | customer monthly sales (ex-VAT), mirrors the rep view |
| `vw_FS_Reps` | `vw_FS_Reps.sql` | pre-existing (rewritten 2026-08-13, before this session) | drives FROM `SalSalesperson` joined on branch+code — the correct way to resolve rep identity |

Superseded/historical scripts also present in `docs/sql/` and safe to ignore unless doing archaeology: `vw_FS_Products-fix.sql`, `vw_FS_Products-ConvFactAltUom.sql`, `vw_FS_InvoiceLines.sql`, `vw_FS_Invoices-vat-fix.sql`. Each superseded file's replacement has a `ROLLBACK` block at the bottom reproducing the version it replaced.

**Known SYSPRO data-quality findings (not fixed, flagged for awareness):**
- `ArInvoice.OrigTaxableAmt` is **VAT-inclusive** despite its name — the original view read it as ex-VAT and added VAT again, double-counting it. Fixed in `vw_FS_Invoices-exclude-credit-notes.sql`.
- Credit notes are typed `DocumentType = 'I'` in `ArInvoice` (not `'C'`) and use a `_CR` number prefix with a **non-unique** number that collapses when synced (RouteOne's `invoices.number` is `UNIQUE`). Excluded via a `_CR` prefix filter. A cleaner `DocumentType`-based filter was investigated but not applied (see Section 8).
- ~6,000 genuinely zero-valued invoices remain unexplained (`DocumentType='I'`, not `_CR`, `OrigTaxableAmt = 0`) — open item, not investigated further.
- Two products share the name "THIN RND 279MM" under codes `8934700010` and `8934700010 N` — an item-master duplication, flagged to the user, not resolved (it's a SYSPRO data question, not a RouteOne bug).
- Rep codes are **not unique** — the same code can belong to different people at different branches (confirmed real case: code `101` = Siyabonga Sigwili at branch `01`, Joseph Shabangu at branch `12`). `matchRep(warehouseCode, repCode)` in `server/integration/sync.js` has always keyed on the (branch, code) **pair**, which is correct — but two of this session's own new scripts (`reconcile-reps.js`, `handover-rep.js`) initially keyed on code alone and had to be rewritten (see Section 7).

---

## 4. BACKEND

**API routes/endpoints** (`server/routes/*.routes.js`, all mounted in `server/index.js`):
- `auth.routes.js` — login/logout/password reset/change-password.
- `customers.routes.js` — customer CRUD, `/customers/:id` detail (stats, invoices, notes, timeline), `/customers/:id/notes` (**new** — customer_notes CRUD), `/customers/:id/timeline` (unified activity feed — orders/quotes/visits/tasks/forms/invoices/**notes**), `/customers/:id/intel-notes`.
- `products.routes.js` — `/products` (list), **`/products/for-customer/:customerId`** (the important one — returns every product with `effective_price`, `has_contract_price`, `syspro_pricing_tier`, `price_breaks`, stock, purchase history; this is what both order-capture screens consume).
- `orders.routes.js` — order CRUD, `createOrder()`, PDF/email send.
- `quotes.routes.js` — quote CRUD, `createOrder`-equivalent, convert-to-order, PDF/email send.
- `visits.routes.js`, `forms.routes.js`, `cycles.routes.js`, `tasks.routes.js` — visit planning/forms/call cycles/tasks.
- `planning.routes.js` — Rep KPIs (`/kpis`, `/kpis/monthly-history`) — sourced from `rep_monthly_sales`, **not** RouteOne's own orders (deliberate, pre-existing).
- `dashboard.routes.js` — the main dashboard stats/leaderboard/sales trend.
- `integration.routes.js` — SYSPRO connection settings, sync-now buttons, sync schedules. **SYNC_ENTITIES list here must be kept in sync with the server's own list in `sync.js`** — they were found out of sync this session (the new `customer_sales` entity had no UI) and fixed by deriving both from one constant.
- `invoices.routes.js` — invoice list/detail, now scoped by **both** billed customer and delivery customer (see Section 7).
- `intelligence.routes.js` — customer segmentation/churn scoring.
- `sales-pushes.routes.js`, `drafts.routes.js`, `monitoring.routes.js`, `backups.routes.js`, `documents.routes.js`, `settings.routes.js`, `sync.routes.js` — supporting features, not deeply touched this session.

**Important server files:**
- `server/db.js` — the single most important file. Holds the schema application, the migration list, and every shared money/pricing function: `round2()` (epsilon-safe rounding — **new this session**, fixes a real floating-point bug), `VAT_RATE = 0.15`, `productUnitPrice(product)` (the "G Price" per selling unit — **now rounds to cents, fixed this session**), `effectivePrice(customerId, productId, qty)` (the full pricing waterfall — **now rounds to cents, fixed this session**), `priceBreaks()`, `activeRules()`, `adjustOrderStock()`, `nextNumber()` (ORD-xxxxx / QUO-xxxxx sequence generator), `logActivity()`, `getSetting`/`setSetting`, `getTodayISO`/`getLocalDateISO`.
- `server/auth.js` — `scopeForUser(user)` returns `{ isRep, isOffice, isCustomer }`-style flags used everywhere for authorization; `userCanAccessCustomer()`; `requireRole(...)`.
- `server/integration/sync.js` — the sync engine. `SYNC_ENTITIES` array (order matters: warehouses before customers, invoices before invoice_lines), one `upsertX()` function per entity, `matchRep(warehouseCode, repCode)` (the branch+code rep-resolution function — read this before touching anything rep-related), `CLEAR_BEFORE_SYNC` map for entities that accumulate (rep_sales, customer_sales, invoice_lines — these are fully wiped and rebuilt each sync, not upserted).
- `server/integration/providers.js` — `demoProvider` (canned rows for dev without a SYSPRO connection) vs `sysproProvider` (live `mssql` queries against configured views), per-entity row-count safety limits and query timeouts, view-name resolution from `settings`.
- `server/integration/scheduler.js` — per-entity cron-like scheduling read from `settings`.
- `server/integration/email.js` / `pdf.js` — order/quote confirmation emails and PDFs. Both were touched this session to surface the new `customer_order_no` field.
- `server/import-reps.js` — **insert-only** rep onboarding from `vw_FS_Reps`; explicitly skips any `rep_code` that already has a user, which is *why* rep drift (a code changing hands) was never caught automatically (see Section 7).
- `server/reconcile-reps.js` — **new this session**, read-only. Compares RouteOne's rep users against `SalSalesperson`, keyed on **(branch, code)**, reports name mismatches, branch mismatches, missing/stale codes. Run it with `node server/reconcile-reps.js` **on the server** (it needs the live SYSPRO connection and the live local database — running it from a laptop reads the wrong database).
- `server/handover-rep.js` — **new this session**. Hands a `(rep_code, branch)` pair from a departing rep to a new user: clears the outgoing rep's code, deactivates them (never deletes — they may own orders/visits/quotes), creates the incoming rep on that code+branch. Usage: `node server/handover-rep.js --code 111 --branch 01 --name "Bernice Molokwe" --email bernice@sbakels.co.za --dry` (run `--dry` first, then without it). **`--branch` is required** — an earlier version without it was unsafe on multi-branch codes and was rewritten.

**Authentication/security logic:** JWT + HTTP-only cookie (see Section 2). `scopeForUser()` is the authorization backbone — almost every route checks `scopeForUser(req.user).isRep` to decide whether a rep can only see their own data, and (critically for pricing) whether a client-supplied `unit_price`/`discount_pct` on an order/quote line is honoured at all — **a rep's submitted price is always ignored server-side**, only office/manager/admin can override price, and this session's client-side price-editing UI (R1-026) was built to match that existing server rule exactly, not to change it.

**Business logic worth knowing:**
- Rep-to-customer assignment is 100% SYSPRO-driven: every customer sync re-resolves `customers.rep_id` via `matchRep(branch, code)` and overwrites whatever was there. This is a **pre-existing, deliberate decision** (reaffirmed, not changed, this session) — RouteOne never manually reassigns customers; you fix the *rep's* branch/code instead and the customer follows automatically on the next sync.
- Rep sync itself is manual/scripted, not automatic — `import-reps.js` for onboarding new reps, `reconcile-reps.js` to find drift, `handover-rep.js` to fix it. There is currently **no automatic nightly rep sync**.
- Pricing waterfall (`effectivePrice`): SYSPRO contract price (date-windowed) → SYSPRO buying-group price (date-windowed) → SYSPRO price-code price → RouteOne-native `customer_prices` override → RouteOne quantity-break price rules → plain G price (`productUnitPrice`). All SYSPRO-sourced per-kg prices are scaled by `conv_factor_alt_uom` to get a real per-selling-unit price, and (as of this session) rounded to cents at that point, not left as a raw float.
- **Anything partially implemented / known gaps:** RouteOne does not currently push captured orders/quotes back into SYSPRO automatically — see Section 6 for the exact current state of that workflow, which is a significant open area.

---

## 5. FRONTEND

**Screens/pages/components already created** (non-exhaustive — this lists what came up this session; there are more office pages not touched, e.g. `Products.jsx`, `Users.jsx`, `Analytics.jsx`, `Monitoring.jsx`, `SettingsAdmin.jsx`):

Office/desktop (`client/src/pages/`):
- `Orders.jsx`, `Quotes.jsx` — list pages, each renders `NewOrderModal` for "New order"/"New quote".
- `OrderDetail.jsx`, `QuoteDetail.jsx` — read-only detail pages.
- `CustomerDetail.jsx` — the customer profile: stats (Sales MTD, Sales 12 months, Total orders, Credit limit), SYSPRO info, RouteOne info, sales intelligence, contacts, **Notes & activity** (new, R1-0xx), visit/order/quote history, **Invoices — last 30 days** (Status and Balance columns hidden this session — see Section 7, R1-015).
- `Integration.jsx` — SYSPRO connection settings, view-name fields, sync-now buttons, sync schedules (extended this session for `customer_sales`).
- `Kpis.jsx`, `RepDetail.jsx`, `Dashboard.jsx` — reporting.
- `Invoices.jsx` — invoice list.

Shared components (`client/src/components/`):
- **`NewOrderModal.jsx`** — the office order/quote builder. This file is also the **shared pricing-helper module** — it exports `unitPriceFor`, `kgPriceFor`, `gPriceFor`, `discountPctFor`, and `round2`, all imported by the mobile capture screen too. Read this file's top before touching pricing math anywhere in the app.
- `OrderSummary.jsx` — the printable/review summary used by both the office review screen and the mobile review screen, and reused for the PDF-equivalent on-screen layout.
- **`CustomerNotes.jsx`** — new this session. Shared note-logging component (typed activity: call/email/whatsapp/meeting/sample/note), used by both `CustomerDetail.jsx` (office) and `RepCustomer.jsx` (mobile).
- `SignatureCapture.jsx` — a standalone signature pad used by `OrderSummary.jsx`. **Known latent bug, not fixed:** its three buttons have no `type="button"`, so they'd default to `type="submit"` if this component were ever placed inside a `<form>` — currently harmless because it isn't, but worth fixing before someone wraps it in one.
- `ui.jsx` — the design-system primitives: `Card`, `Table`, `Modal` (its scroll/height CSS was fixed this session — see R1-003), `Field`, `Badge`, `Spinner`, `ErrorNote`, `Pagination`/`usePagination`.

Mobile (`client/src/mobile/`):
- **`RepOrderCapture.jsx`** — the main rep order/quote capture screen. Heavily modified this session (see Section 7/8): quantity entry, UOM display, "In your order" filter, product-code sorting, contract/G-price/discount% badges, rounding fixes.
- `RepCustomer.jsx` — the mobile customer detail/timeline screen. Contains `FormFillModal`/`FormSignatureField` (the Sample Requisition form uses this — fixed this session, R1-003) and now renders `CustomerNotes` in `compact` mode.
- `MobileApp.jsx` — mobile shell, header, bottom nav.
- Other mobile screens exist (RepStockCheck, MyCycle, Tasks, etc.) — not touched this session.

**Navigation:** `client/src/App.jsx` is the top-level router (React Router 7). Office routes are plain paths; mobile routes live under `/mobile/...` and are the ones reps actually use day-to-day. `Layout.jsx` (office chrome — sidebar/header/footer) had its NAVEX Africa logo removed this session (a one-line request, unrelated to everything else).

**Customer screens:** covered above (`CustomerDetail.jsx` office, `RepCustomer.jsx` mobile).

**Product screens:** `Products.jsx` (office list, not deeply touched this session beyond adding a `discontinued` red badge and removing a hardcoded `active=true` filter so discontinued-but-recently-sold products stay visible — see Section 7).

**Visit/check-in functionality:** exists (`visits.routes.js`, visit capture in `RepCustomer.jsx`) — not a focus of this session beyond the Sample Requisition form's scrolling bug (R1-003), which lives inside the visit/form-filling flow, not visits themselves.

**Order/quote capture:** the single biggest area of work this session — see Section 6 for the full current process, and Section 7/8 for every specific fix.

**Manager/dashboard functionality:** `Dashboard.jsx`, `Kpis.jsx` exist; `Dashboard.jsx`'s sales trend and "Sales by rep" leaderboard were **not** modified this session (still worth auditing — they read from `invoices`/`rep_monthly_sales` which had real bugs found and fixed elsewhere this session, so their *inputs* are now more correct even though the queries themselves weren't touched).

**Mobile behaviour:** RouteOne is explicitly mobile-first for reps. This session fixed a real mobile-only scrolling bug (R1-003 — a signature pad became a touch "dead zone" blocking scroll), a real mobile-only quantity-entry race condition (R1-023), and added mobile-specific UX (typed quantity, UOM display, "In your order" filter) that the desktop builder already effectively had via its always-visible cart list. **When building anything new, check the mobile screen's actual behaviour yourself — don't assume parity with the desktop screen just because the same helper functions are shared.**

---

## 6. ORDER AND QUOTE PROCESS (current, as of this session's end)

1. **Customer selection.** Office: pick from a customer dropdown (or preselected if launched from a customer's own page). Mobile: the rep is already inside a specific customer's screen (`RepCustomer.jsx`), taps "New order"/"New quote", landing on `RepOrderCapture.jsx` for that customer.

2. **Products.** Fetched once via `GET /products/for-customer/:customerId`, which returns every active-or-recently-discontinued product with: purchase history (`times_bought`, `last_bought_at` — combining RouteOne order history and SYSPRO invoice history), current warehouse stock, and **pre-computed pricing** (see next point). Both capture screens filter/search this in-memory list client-side; nothing is re-fetched per keystroke.

3. **Pricing.** Computed server-side per product via `effectivePrice()`'s waterfall (Section 4) and returned as `effective_price`, plus `syspro_pricing_tier` (`'syspro_contract'` / `'syspro_buying_group'` / `'syspro_price_code'` / null) and `has_contract_price`. The client never invents a price for a rep — `unitPriceFor(product, qty)` on the client picks between this server-computed `effective_price` and RouteOne's own quantity-break tiers (`price_breaks`, which the server only populates when there's **no** SYSPRO/RouteOne-native override — a contract price never varies with quantity).

4. **Contract pricing.** Shown with a coloured badge next to the price (contract=green, buying group=blue, price code=purple) — **this session fixed mobile**, which was previously mislabelling all three tiers as generically "contract" (R1-018).

5. **G Price.** The normal SYSPRO selling price (`products.list_price × conv_factor_alt_uom`, rounded to cents), shown alongside the negotiated price wherever a SYSPRO pricing tier applies, via the shared `gPriceFor()` helper (R1-019, new this session).

6. **Discount percentage.** `discountPctFor(gPrice, negotiatedPrice) = round((G − negotiated) / G × 100)`, shown next to the G price, only when there's a real SYSPRO-tier saving (never for RouteOne's own quantity-break pricing, and never showing a discount when the "negotiated" price is actually ≥ G) — R1-020, new this session.

7. **Quantities.** Office: a plain number input per cart line (worked correctly before this session). Mobile: previously tap-only +/- stepper with a real stale-closure double-tap bug (fixed) and no way to type an exact number (a proper numeric input was added) — R1-023.

8. **Customer Order No. / Reference.** A dedicated field (`customer_order_no`), separate from `notes`, captured on both builders, shown on the order/quote detail page, the printable summary, the confirmation PDF, and both the customer-facing and internal confirmation emails — R1-004, new this session. Orders only (a quote has no customer PO yet).

9. **Delivery address.** **Not investigated or changed this session** despite being explicitly named in the user's later handover request ("Delivery address must use the AR Customer Delivery Address") — this is an **open item**, see Section 8. Currently `orders.delivery_instructions` is free-text notes captured per order, not sourced from a structured SYSPRO delivery-address field. Needs investigation into what SYSPRO field/view holds the AR customer's actual delivery address before any fix is designed.

10. **Saving.** Office and mobile both support saving an in-progress order/quote as a **draft** (`drafts` table, `drafts.routes.js`) — but this is **rep-initiated** (a "Save draft" button), **not automatic**. The user's handover request explicitly asks for **automatic** draft-save on every line added, "so that if connectivity drops or the app closes they can reopen and continue" — this is an **open item**, not built this session (see Section 8).

11. **Submission.** `POST /orders` or `POST /quotes`. Server re-validates everything (customer access, product active/discontinued status, quantity bounds, price/discount authorization by role), computes each line total with `round2()`, sums to a subtotal, computes VAT, computes the final total — all using the epsilon-safe rounding fixed this session. Quote lines are automatically sorted by product code (lowest→highest) at creation time, regardless of the order the rep added them (R1-017, new this session) — orders are **not** sorted this way (out of scope for that ticket; flagged as a possible follow-up).

12. **SYSPRO integration/status.** **This is the biggest open gap.** As far as this session established, a captured RouteOne order/quote does **not** automatically flow into SYSPRO — there is no confirmed "push to SYSPRO" mechanism, and no RouteOne-side field tracking a SYSPRO processing/order status. The user's handover request explicitly names "RouteOne/Syspro order processing status workflow" as an open item (Section 8) — a new session should treat this as **unstarted design work**, not a bug fix, and should ask the user how orders are meant to reach SYSPRO today (manual re-capture by an office admin? a file export? a direct API integration not yet built?) before proposing anything.

---

## 7. ALL DEVELOPMENT DECISIONS MADE (and why)

Read this section before changing anything nearby — most of these were arrived at only after investigation, and re-deciding them from scratch would waste time or reintroduce a bug.

1. **SYSPRO is authoritative for rep-to-customer assignment.** Every customer sync overwrites `customers.rep_id` via `matchRep()`. Do not build a "manually reassign a customer to a rep" feature — the fix for a wrong assignment is always to correct the *rep's* branch/code in `users`, never the customer.

2. **Rep codes are not unique — always key on (branch, code) together, never code alone.** This was learned the hard way: `reconcile-reps.js` and `handover-rep.js` were both initially written keyed on code alone, and both had to be rewritten after a real case surfaced (code `101` = two different people at two different branches). `matchRep()` in `sync.js` already got this right from the start.

3. **Reps are not auto-synced.** A deliberate, pre-existing decision (the code comment cites unreliable branch data as the reason) — reaffirmed this session. Onboarding/reconciliation is by hand-run script (`import-reps.js`, `reconcile-reps.js`, `handover-rep.js`), not a scheduled sync entity.

4. **A departing/replacing rep gets a NEW user record, not a renamed old one.** Renaming would silently rewrite history (every visit/order/quote the old rep captured would show the new rep's name and use their login). `handover-rep.js` creates a new user, deactivates the old one (never deletes — they own foreign-keyed history), and relies on the *next customer sync* to move the customer book across (no manual reassignment needed, per decision #1).

5. **`round2()` must be epsilon-safe, not plain `Math.round(n*100)/100`.** Plain rounding misrounds real values at exact half-cent boundaries due to IEEE-754 representation error (verified via a 20,000-case fuzz test — about 2% of realistic totals were affected). Centralized in `server/db.js`, mirrored client-side in `NewOrderModal.jsx` (the client has no access to the server module, so it's a deliberate duplicate — keep both in sync if the algorithm ever changes).

6. **Unit prices must be rounded to cents at the point they're computed (`productUnitPrice`, `effectivePrice`), not only at the line-total stage.** A per-kg SYSPRO price scaled by `conv_factor_alt_uom` can land on many decimal places; leaving that unrounded and only rounding the final line total lets the error compound with quantity (verified: R44 drift on a 10,000-unit line). Both server functions were fixed to round their own return value.

7. **Office price/discount editing is gated to non-rep roles, matching the server's existing (unchanged) authorization rule exactly.** The server has always ignored a rep-submitted `unit_price`/`discount_pct` — this session's new client-side editing UI (R1-026) was built to respect that, not to loosen it. `canEditPrice = !!user && user.role !== 'rep'` (fail-closed — defaults to *no* edit UI if the user object hasn't loaded yet, not the reverse).

8. **Quotes have no discount concept server-side** (`quote_items.discount_pct` is always stored `0`, regardless of what's sent) — this is pre-existing, not a bug introduced this session, but it was newly *discovered* this session. The new discount-editing UI is hidden entirely for quotes so the preview can never show a total the created quote wouldn't actually have.

9. **Customer contact must never be recorded as a visit.** The new `customer_notes` feature (append-only call/email/whatsapp/meeting/sample/note log) was deliberately built as its own table, not as an "offsite visit" — because visits drive rep KPIs (compliance, coverage, strike rate) with no filter on check-in type, so recording a phone call as a visit would inflate those numbers. This was almost certainly *why* the rep asked for the feature in the first place.

10. **The "Outstanding Amount" on the customer profile was fabricated, not sourced from SYSPRO, and has been hidden rather than "fixed" with a fake source.** `vw_FS_Invoices` has no real balance/payment-status columns; `sync.js`'s fallback (`balance ?? (total - paid)` with `paid` always `0`) meant `balance` always equalled `total` and every invoice showed status `'outstanding'`. Rather than ship a misleading number, the Outstanding badge, per-invoice Status column, and per-invoice Balance column were all removed from the customer profile (R1-015). **The real fix (sourcing a genuine SYSPRO balance field) is still open** — see Section 8.

11. **Sales MTD and Sales 12 Months must be genuine SYSPRO invoiced sales, not RouteOne's own order-capture activity.** Both previously summed the `orders` table (only what happened to be captured in the app). Both now read the new `customer_monthly_sales` table (synced from a new SYSPRO view), which correctly attributes sales to the **delivery** customer, not the billed account — fixing a related group-billing bug (see #12). `order_count`/`sales_total` on the same profile deliberately stay RouteOne-native, since they measure a genuinely different thing (app-capture activity).

12. **Invoice visibility and sales attribution must use the delivery customer, not just the billed account.** Central/head-office billing (e.g. a store invoiced through "PICK N PAY RETAILERS") meant a rep serving the actual store could see none of that store's invoices, because the old code joined only on the invoice header's billed customer. Both `invoices.routes.js` (a rep now owns an invoice if they own *either* the billed account *or* any delivery-line customer on it) and the new `customer_monthly_sales` view (aggregates by delivery customer, from `ArTrnDetail`, not the billed-account header) were fixed to account for this.

13. **G Price and contract-discount display are scoped to genuine SYSPRO pricing tiers only, never to RouteOne's own quantity-break pricing.** Conflating the two would misrepresent both a real negotiated discount and a volume discount as the same thing.

14. **Product code sorting** (R1-016, list search; R1-017, quote line order) uses `localeCompare(..., { numeric: true })`, not a plain string sort — because real SYSPRO codes include trailing-letter variants (e.g. `8934700010` vs `8934700010 N`) that must sort adjacent to their base code, not wherever a plain string compare would place them.

15. **An index over a newly-added column must live in `db.js`'s migration list, never in `schema.sql`.** `schema.sql` runs first, before migrations, and is not error-tolerant — this exact mistake caused a full startup crash on the production server this session (fixed, and now documented with a comment in `schema.sql` itself).

16. **Credit notes are excluded from `vw_FS_Invoices` by number prefix (`_CR`), because SYSPRO types them `DocumentType='I'`, not `'C'`** — a `DocumentType`-based filter alone would not have caught them. A cleaner combined filter (`DocumentType='I' AND prefix<>'_CR'`) was designed but never actually applied to the live view — see Section 8.

17. **`ArInvoice.OrigTaxableAmt` is VAT-inclusive despite its name.** Verified against 3,000 sampled invoices (89% reconciled exactly under this reading; the 11% that didn't were explained by non-stock lines the line-detail view excludes). Fixed in the view, not worked around in RouteOne code — RouteOne stores whatever the view returns.

18. **The Products page and both order-capture pickers show discontinued-but-recently-sold products, struck through and disabled, rather than hiding them.** A rep who knows a product exists (because it's still being invoiced) needs to see *why* they can't order it, not have it silently vanish. The 90-day "still selling" window is self-pruning — a genuinely dead product drops out on its own.

---

## 8. ALL OPEN DEVELOPMENT ITEMS

Every item below is either explicitly still open, was investigated but deliberately not fixed yet, or was named in the user's handover request but not addressed this session. Ordered roughly by how the session encountered them; no formal priority was assigned by the user except where noted.

### Explicitly named in the handover request, not yet addressed this session

- **Delivery address must use the AR Customer Delivery Address.**
  - Requirement: order capture's delivery address/instructions should be sourced from SYSPRO's actual AR customer delivery address, not free-text notes.
  - Current behaviour: `orders.delivery_instructions` is a free-text field the rep types per order. No structured SYSPRO delivery-address field is synced or used.
  - Needed: identify the correct SYSPRO field/view (likely `ArCustomer` or a dedicated delivery-address table — not yet investigated), decide whether it should pre-fill and stay editable, or be authoritative and read-only, then implement.
  - Priority: named explicitly by the user as a "recent requirement" in the handover ask — treat as high.

- **Automatic draft-save on every order/quote line added.**
  - Requirement: every time a rep adds a line, the in-progress order/quote should auto-save as a draft, so connectivity loss or the app closing doesn't lose captured work.
  - Current behaviour: draft-save exists (`drafts` table/routes) but is **rep-initiated only** (a manual "Save draft" button) on both builders.
  - Needed: wire an effect that calls the existing draft-save logic automatically after each `addLine`/`setQty`/cart mutation, debounced sensibly so it isn't firing on every keystroke. The mobile screen's offline-queue pattern (`queueWrite`) should be considered for the case where the auto-save itself can't reach the server.
  - Priority: named explicitly, treat as high — this is a real risk of lost work for reps in poor-connectivity areas.

- **RouteOne/SYSPRO order processing status workflow.**
  - Requirement: unclear from the conversation alone — the user named this as an open item without RouteOne having investigated it this session.
  - Current behaviour: no confirmed mechanism pushes a captured RouteOne order into SYSPRO, and no RouteOne field tracks a SYSPRO-side processing status.
  - Needed: **ask the user** how orders are meant to reach SYSPRO today before designing anything — this is a discovery task, not a bug fix.
  - Priority: unknown — surfaced but not scoped.

### Investigated and diagnosed, fix designed but not applied

- **Credit-note filter could be tightened.** A combined `DocumentType='I' AND LEFT(number,3)<>'_CR'` filter for `vw_FS_Invoices` was written and verified in principle but never actually applied to the live view (the current live filter is `_CR`-prefix-only, which already works — this is a refinement, not a live bug). Low priority.

- **The ~6,000 genuinely zero-valued `ArInvoice` rows** (real `DocumentType='I'`, no `_CR` prefix, `OrigTaxableAmt = 0`) are unexplained. Not investigated further this session. Affects invoice-list completeness and the Dashboard sales trend (which still reads `invoices.total` directly, not the more-correct `ArTrnDetail`-sourced `customer_monthly_sales`).

- **`invoices.balance`/`status` are fabricated** (see Section 7, decision #10). Hidden from the UI, not fixed at the source. Needs a real SYSPRO balance/payment-status field identified and synced before this can be un-hidden correctly. Ticket was R1-015.

- **Duplicate product codes** `8934700010` / `8934700010 N` (same name) — flagged as an item-master question for the SYSPRO side, not something RouteOne code can safely resolve on its own guess.

- **Backup monitor threshold is too loose.** A missed nightly backup (2026-08-22) wasn't flagged because the monitor's "age acceptable" check doesn't account for a full skipped day cleanly. Not fixed. Low priority but a real gap.

- **The SQLite WAL file was observed very large (~836MB against a ~1.17GB main database file)** during this session, suggesting infrequent checkpointing under heavy sync write load. Not actively fixed; restarting the service checkpoints it. Worth monitoring, not urgent.

### Fully resolved this session (listed here only so the next session doesn't reopen them without new evidence)

R1-003 (Sample Requisition mobile scrolling/Submit button), R1-004 (Customer Order No./Reference), R1-005 (Sales 12 Months from real SYSPRO sales, later extended to Sales MTD), R1-015 (fabricated Outstanding Amount hidden), R1-016 (product code low→high sort in order/quote product search), R1-017 (automatic product-code sort on quote lines), R1-018 (correct contract-price tier badge on mobile), R1-019 (G Price display), R1-020 (contract discount % display), R1-023 (mobile quantity capture — stale-closure bug + typed input), R1-024 (UOM display on mobile capture row), R1-025/026 (line recalculation correctness + inline price/discount editing without delete-and-recreate), R1-027/028 (client/server total reconciliation + the epsilon-safe rounding fix + unit-price-rounded-at-source fix). Also: NAVEX Africa logo removal (cosmetic, unrelated), the rep reconciliation/handover scripts and the multi-branch rep-code bug they surfaced (Bernice Molokwe / Nasief Isaac on code 111; Siyabonga Sigwili / Joseph Shabangu on code 101), the schema.sql startup-crash bug, the VAT double-counting bug, the credit-notes-in-invoices bug, and the discontinued-products-invisible bug.

**Do not re-investigate these from scratch.** If a new symptom appears in one of these areas, start from this document's explanation of what was found and fixed, and look for what's *different* about the new report, rather than re-deriving the whole diagnosis.

### Numbering gap, for awareness

Tickets **R1-001, R1-002, R1-006 through R1-014, R1-021, R1-022** were never mentioned in this conversation. They may exist in the user's tracker as separate, not-yet-raised items, or may have been handled in an earlier session this document has no visibility into. Don't assume they don't exist — ask the user if a complete R1-series list is needed.

---

## 9. DEPLOYMENT

**Development machine:** `C:\Projects\RouteOne` on the developer's laptop (Windows). Git repo, branch **`pricing-convfactaltuom`** (not `main` — every commit made this session is on this branch; it has not been merged). `server/data/fieldsales.db` here is a **stale/local demo-ish copy**, not production data — do not trust it for any real investigation; it was observed missing recently-onboarded reps that the production database had.

**Windows server:** production/test box, reachable at `http://routeone-test.sbakels.net:4200`. The app lives at `C:\RouteOne` on that server, which the laptop reaches over a mapped network share as `Z:\`. So `Z:\` on the laptop **is** `C:\RouteOne` on the server — they're the same files. The live SQLite database is at `Z:\server\data\fieldsales.db` (i.e. `C:\RouteOne\server\data\fieldsales.db` on the server itself) — roughly 1.2–1.3 GB, with a WAL file that gets large under load (see Section 8).

**Node:** the server runs Node directly (`node --use-system-ca server/index.js`, per `package.json`'s `start` script — the `--use-system-ca` flag matters for the SYSPRO SQL Server TLS connection).

**NSSM / the RouteOne service:** the app runs as a Windows service via NSSM, at `C:\nssm\nssm-2.24\win64\nssm.exe`, service name **`RouteOne`**. To restart after any server-side code change (route files, `db.js`, `sync.js`, anything under `server/`):
```
C:\nssm\nssm-2.24\win64\nssm.exe restart RouteOne
```
A restart is **required** for server-side changes to take effect — Node doesn't hot-reload. It's also required after any schema/migration change, since migrations run once at startup. `SERVICE_START_PENDING` messages during restart are usually not an error — the service does come up; verify with `curl http://routeone-test.sbakels.net:4200/api/health` (expect `{"ok":true}`), not by trusting the NSSM message alone.

**Build/deployment procedure — from the laptop:**
```
cd C:\Projects\RouteOne
.\deploy.ps1
```
This: (1) runs `npm run build` locally first, aborting before touching the server if the build fails; (2) `robocopy`s the whole working tree to `Z:\` (**excludes** `node_modules`, `.git`, `dist` (synced separately with `/MIR`), `server/data`, `server/backups`, `server/uploads`, `.env*`, and `*.db*` — so it never overwrites the live database or secrets); (3) mirrors the freshly-built `dist/` folder to the server. **It does not restart the service** — that's always a separate manual step (see above). There's also `server-deploy.bat` meant to be run **on the server itself** (self-elevates, runs `npm install` + `npm run build` + the NSSM restart in one go) — used once this session to deploy `reconcile-reps.js` before the user ran it.

**Deploy state as of this handover — read carefully:** `deploy.ps1` syncs the **entire working tree**, so every deploy carries forward whatever was committed at that moment, not just the files relevant to why it was run. Deploys definitely happened (confirmed via server-side file checks and/or `curl` health checks) around: the NAVEX logo removal, the pricing/`ConvFactAltUom` fix, the discontinued-products feature (including a crash-and-redeploy cycle), and — most recently confirmed — around the rep-reconciliation script work (`reconcile-reps.js`/`handover-rep.js`), which required a deploy+restart before the user could run them. **What is NOT confirmed deployed:** the R1-015 through R1-028 batch (Outstanding Amount hiding, product-code sorting, G-price/discount display, quantity/UOM/rounding fixes) — these were built and committed *after* the last deploy this document's author can confirm happened. **Treat the server as behind the laptop's committed code. Run `.\deploy.ps1` and then restart the `RouteOne` service before testing or continuing work on anything from R1-015 onward**, and don't assume any specific commit is "live" without checking (`grep` a distinctive string from the change in the file at `Z:\...` the way this session repeatedly did to verify).

**SYSPRO SQL scripts are separate from app deploys entirely** — they must be run by hand in SSMS against the SYSPRO SQL Server (host `192.168.0.53`, database `SysproCompany001`, login `RouteOneApp` — **not** `routeone_ro`, a wrong placeholder name that was in several of this session's earlier scripts and had to be corrected everywhere). See Section 3 for which views are confirmed live.

**Order to deploy a change that touches both a SYSPRO view and RouteOne code** (the pattern used repeatedly and successfully this session): (1) run the SQL script in SSMS, including its `GRANT SELECT ... TO [RouteOneApp]` line — dropping and recreating a view drops its grants; (2) `.\deploy.ps1` from the laptop; (3) restart the `RouteOne` NSSM service; (4) re-sync the relevant entity/entities from the Integration admin page (in dependency order if more than one — e.g. invoices before invoice_lines); (5) verify against the live database directly if in doubt, rather than trusting the UI alone.

**Future Linux/cloud deployment:** mentioned only in `CLAUDE.md`'s hosting roadmap ("Windows Server (Current), Linux (Future), Cloud (Future)") — **not discussed or worked on at all this session.** No decisions were made about it.

---

## 10. FILES — every file this session created or edited, and why

**New files:**
- `docs/sql/vw_FS_Products-discontinued.sql` — current live products view (discontinued flag + 90-day still-selling window).
- `docs/sql/vw_FS_InvoiceLines-delivery-customer.sql` — current live invoice-lines view (delivery customer, 90-day window).
- `docs/sql/vw_FS_Invoices-exclude-credit-notes.sql` — current live invoices view (VAT fix + credit-note exclusion).
- `docs/sql/vw_FS_CustomerSalesByMonth.sql` — new view backing `customer_monthly_sales`.
- `docs/sql/vw_FS_Invoices-vat-fix.sql`, `docs/sql/vw_FS_Products-ConvFactAltUom.sql`, `docs/sql/vw_FS_InvoiceLines.sql` — superseded intermediate versions, kept for history/rollback reference only.
- `server/reconcile-reps.js` — read-only rep-vs-SYSPRO drift report (Section 4/7).
- `server/handover-rep.js` — rep-code handover script (Section 4/7).
- `client/src/components/CustomerNotes.jsx` — shared customer contact-log component (Section 5).

**Significantly edited files (server):**
- `server/db.js` — added `round2()`, fixed `productUnitPrice()` and `effectivePrice()` to round to cents, added the `customer_order_no`/`discontinued`/`customer_notes`/`invoice_items.delivery_customer_*`/`customer_monthly_sales` migrations, added the `schema.sql`-vs-migrations comment explaining the startup-crash lesson.
- `server/schema.sql` — added `customer_order_no` (orders), `discontinued` (products), `customer_notes` table, `invoice_items.delivery_customer_id`/`delivery_customer_code` + index (moved to migrations, not schema.sql, per the lesson learned), `customer_monthly_sales` table.
- `server/integration/sync.js` — `upsertProduct` now syncs `discontinued` and sets `active` unconditionally from it; `upsertInvoiceLine` now resolves and stores the delivery customer (with an in-run memoisation cache since the view can be ~285k rows); new `upsertCustomerSales`; `matchRep` unchanged but re-confirmed correct.
- `server/integration/providers.js` — added the `customer_sales` entity (view name setting, row limit, timeout).
- `server/routes/orders.routes.js` — `customer_order_no` capture/storage, better error messages when a blocked product is submitted, quote-independent sort untouched, imports the shared `round2` instead of a local buggy copy.
- `server/routes/quotes.routes.js` — same `round2` fix; quote lines now sorted by product code at creation (R1-017); all `quote_items` reads now have explicit `ORDER BY id`.
- `server/routes/customers.routes.js` — `sales_mtd`/`sales_12m` repointed at `customer_monthly_sales`; new `customer_notes` CRUD endpoints; timeline feed extended to include notes.
- `server/routes/products.routes.js` — `/products/for-customer` no longer filters out discontinued products (shows them, client disables ordering); `discontinued` badge data included.
- `server/routes/invoices.routes.js` — rep/customer ownership check extended to the delivery customer, not just the billed account, on both the list and detail endpoints.
- `server/routes/integration.routes.js` — `customer_sales` schedule settings whitelisted.
- `server/import-reps.js` — read for its `REP_CODES`/`fetchReps` exports, not modified (reused by `reconcile-reps.js`).

**Significantly edited files (client):**
- `client/src/components/NewOrderModal.jsx` — the big one. Added `round2`, `gPriceFor`, `discountPctFor` shared exports; product-code sort toggle; G-price/discount% display; `customer_order_no` field; inline price/discount editing per cart line (`priceForLine`, `updateLine`, `editingPriceFor` state), gated to non-rep roles; preview subtotal/vat/total now rounds in the same order of operations as the server.
- `client/src/mobile/RepOrderCapture.jsx` — product-code sort toggle; "In your order" filter; UOM display on the picker row; the qty stale-closure fix (`adjustQty`) plus a typed numeric quantity input; G-price/contract-tier badge fix (was mislabelling all tiers "contract"); `customer_order_no` field; rounding fixes mirroring the server.
- `client/src/pages/CustomerDetail.jsx` — `sales_mtd`/`sales_12m` sub-labelled "SYSPRO invoiced, excl. VAT"; renders `CustomerNotes`; Outstanding Amount badge, per-invoice Status column, and per-invoice Balance column removed from the "Invoices — last 30 days" card.
- `client/src/pages/OrderDetail.jsx` — `customer_order_no` shown in its own card, above Notes.
- `client/src/components/OrderSummary.jsx` — shows `customer_order_no` under the order number.
- `client/src/components/ui.jsx` — `Modal`'s height/scroll classes fixed (see R1-003: `100dvh` with a `100vh` fallback, `min-h-0`/`flex-1` on the scroll body, safe-area bottom padding).
- `client/src/index.css` — added `.modal-panel`/`.modal-scroll` classes backing the above.
- `client/src/mobile/RepCustomer.jsx` — `FormSignatureField` reworked to swap the live signature canvas for a static `<img>` once signing is done (the canvas's required `touch-action:none` was blocking scroll — the actual root cause of R1-003's "can't reach Submit" symptom); renders `CustomerNotes` in compact mode.
- `client/src/pages/Integration.jsx` — `SYNC_ENTITIES` now a single shared constant (was two independently-hardcoded arrays that had drifted); added the `customer_sales` view-name field.
- `client/src/components/Layout.jsx` — NAVEX Africa logo/footer removed (unrelated one-off request).

---

## 11. CURRENT STATE

**What currently works** (verified this session, against real production data where noted):
- SYSPRO sync for warehouses, customers, products (with correct discontinued handling and `conv_factor_alt_uom` pricing), stock, invoices (VAT-correct, credit-notes-excluded), invoice lines (delivery-customer-aware), customer pricing, rep sales, and the new customer sales entity.
- Contract/buying-group/price-code pricing resolution, G Price display, discount % display — verified against real data (Mondeor Homebake Supplies contract price, Orley Whip conversion factor).
- Rep-to-customer assignment via SYSPRO sync, including the multi-branch rep-code case (verified: Siyabonga Sigwili and Joseph Shabangu both correctly resolve on code `101` at their respective branches after the fix).
- Customer notes (call/email/etc. logging) end to end, confirmed not to touch visit KPIs.
- Order/quote creation with correct rounding (verified via direct numeric simulation against the server's exact formula, not just eyeballed).
- Rep reconciliation/handover scripts, run successfully against production by the user, correctly resolving the two real drift cases found.

**What does not work / is known-fabricated:**
- Invoice balance and payment status (hidden from the UI rather than shown wrong).
- Any automated push of a RouteOne order/quote into SYSPRO (unconfirmed to exist at all).
- Automatic draft-saving (only manual draft-save exists).
- Delivery address sourced from SYSPRO (currently free-text only).

**What is partially implemented:**
- Discount support exists for orders but not quotes (by original design, newly documented this session).
- Office price/discount line editing is built and gated correctly but has not been exercised against a live logged-in session in this environment (verified via code reading, build success, and isolated numeric simulation — not a live click-through, since this session had no browser login credentials for the deployed app).

**What we were working on immediately before this handover:** the R1-023 through R1-028 batch (mobile quantity capture, UOM, price/discount editing, rounding correctness) — just committed (`8f261d1` on `pricing-convfactaltuom`), **not yet deployed to the server**. This is the natural next action for whoever picks this up.

---

## 12. NEXT STEPS (recommended sequence)

1. **Deploy the current committed state.** `.\deploy.ps1` from the laptop, then restart the `RouteOne` NSSM service. Verify with `/api/health` and spot-check a few of this session's fixes against the live database (the pattern used throughout this session: query `Z:\server\data\fieldsales.db` directly with `better-sqlite3` in read-only mode to confirm, rather than trusting the UI alone).
2. **Get the user's sign-off / live testing on R1-023–028** now that they're deployed, especially the mobile quantity input and the office price/discount editing — neither was exercised in a live browser this session.
3. **Pick up the three explicitly-named open items in the order the user gave them:** delivery address from SYSPRO's AR customer record, automatic draft-saving, and the SYSPRO order-processing-status workflow (**discovery/questions to the user first** on this last one — don't design blind).
4. **Consider the smaller open items** (Section 8) as time allows — the credit-note filter refinement and the unexplained zero-value invoices are the most likely to eventually cause another UAT ticket if left alone.
5. **Merge `pricing-convfactaltuom` into `main`** at some natural checkpoint — ask the user when, don't do it unprompted.

---

## 13. INSTRUCTIONS FOR THE NEXT CLAUDE SESSION

You are continuing an existing, working, in-production system that a real team of reps uses daily. Treat this document as the authoritative handover from the previous development session — it was written by carefully reviewing the entire prior conversation, not reconstructed from a short summary.

- **Do not redesign working functionality unnecessarily.** Most of what you'll encounter is correct and was arrived at through real investigation (Section 7 explains why). If something looks odd, assume there's a reason before assuming it's a bug — check Section 7 and Section 8 first.
- **Continue from the existing codebase and branch** (`pricing-convfactaltuom` unless the user says it's been merged to `main` since this document was written — check `git log`/`git branch` yourself rather than assuming).
- **Preserve current naming and architecture** unless there's a concrete technical reason to change it. Don't introduce TypeScript, a different state-management library, a different ORM, etc. without being asked.
- **Before changing any file, read it and understand its current purpose** — several files in this codebase (`db.js`, `sync.js`, `NewOrderModal.jsx`) carry a lot of load-bearing logic that isn't obvious from a glance.
- **When you find a bug, verify it before fixing it.** This session's most valuable fixes (the floating-point rounding bug, the stale-closure quantity bug, the group-billing invoice-visibility bug) were all confirmed with a concrete reproduction — a fuzz test, a simulation of React's update semantics, or a direct query against real production data — before being fixed. Don't guess-and-patch.
- **When providing code changes, give complete code or very clearly-delimited replacement sections** — this codebase has been edited via precise search-and-replace throughout this session; ambiguous partial snippets cause mistakes.
- **Keep RouteOne mobile-first.** The mobile screens (`client/src/mobile/`) are what reps actually use in the field. Never assume a fix that works on the desktop/office screen automatically applies to mobile — check both, as this session repeatedly found real divergences between them.
- **Maintain SYSPRO compatibility.** RouteOne reads from SYSPRO via synced views; it does not write to SYSPRO tables directly (per `CLAUDE.md`'s standing rule: "Do not directly update ERP tables unless specifically requested"). Any SYSPRO-side SQL change needs a script in `docs/sql/`, run by hand in SSMS, with a validation section and a rollback block — follow the exact pattern of the existing scripts there.
- **A deploy is not automatic and not implied by a commit.** Nothing reaches the server until `.\deploy.ps1` is run *and* the `RouteOne` NSSM service is restarted. Never assume a change is live without checking.
- **This document, plus the repo's own `README.md`/`DECISIONS.md`/`DEPLOYMENT.md`/`TODO.md`, are your ground truth.** Where they conflict, investigate rather than pick one arbitrarily — they may simply be out of date relative to each other.

---

## STARTING PROMPT FOR NEW CLAUDE SESSION

Paste the following into a brand-new Claude Code session in this repository, together with this handover document (attach the file, or paste its full contents first):

```
I'm continuing development on RouteOne, a field-sales CRM integrated with
SYSPRO. Attached/pasted above is a complete project handover document from
the previous development session — read it in full before doing anything
else. It covers the architecture, database, backend, frontend, the full
order/quote process, every development decision made and why, every open
item, deployment procedure, and the exact files already touched.

Once you've read it:

1. Confirm you understand the current git branch (pricing-convfactaltuom)
   and deploy state (the server is likely BEHIND the laptop's committed
   code — do not assume anything is live without checking).
2. Ask me which of the open items in Section 8 I want you to work on first
   — don't pick for me. The three I called out explicitly are: the delivery
   address needing to come from SYSPRO's AR customer delivery address,
   automatic draft-saving on every order/quote line added, and the
   RouteOne/SYSPRO order processing status workflow (this last one needs
   you to ask me clarifying questions before designing anything, per the
   handover doc).
3. Do not redesign or "clean up" anything that the handover document says
   is already working correctly, and don't re-investigate anything listed
   as already resolved unless I tell you I'm seeing a new symptom in that
   area.

Work the same way the previous session did: verify things against the real
production database and real SYSPRO data before claiming something is
fixed, and be upfront with me about anything you can't verify from where
you're running.
```
