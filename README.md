# 360 Field Sales — B2B Field Sales Platform

Skynamo-style field sales operations platform for manufacturers, wholesalers and distributors.
Phase 1 build: customer master, product master with contract pricing, rep login,
visit check-in/out with GPS, order capture, manager dashboard, and a mobile-first rep app.

## Stack

- **Server:** Node + Express + better-sqlite3 (SQLite, WAL mode), JWT auth — `server/`
- **Client:** React 18 + Vite + Tailwind + react-router — `client/`
- API on port **4200**, dev client on port **5190** (proxied)

## Getting started

```bash
npm install
npm run seed     # loads demo data (bakery-ingredient distributor)
npm run dev      # starts API + client together
```

Open http://localhost:5190

## Demo logins (password: `demo123`)

| Email | Role | Lands in |
|---|---|---|
| admin@demo.co.za | Admin | Back office |
| manager@demo.co.za | Sales Manager | Back office |
| office@demo.co.za | Internal Sales | Back office |
| rep@demo.co.za | Field Rep | Mobile app |
| rep2@demo.co.za | Field Rep | Mobile app |

## What's in Phase 1

- **Customer master** — grading (A/B/C), territories, rep assignment, credit limits, contacts, contract prices
- **Product master** — categories, pack sizes, list/cost price, stock on hand
- **Visits** — plan, check-in/check-out with GPS stamps, notes, outcomes
- **Orders** — capture with customer-specific pricing, VAT, status flow (draft → submitted → processing → invoiced), repeat order
- **Dashboard** — sales MTD, rep leaderboard vs target, sales trend, top customers, at-risk customers (no order 30+ days)
- **Mobile rep app** (`/mobile`) — today's route, customer profiles, on-site order capture with category chips and quantity steppers

## What's in Phase 2

- **Offline mode** — the rep app syncs a local snapshot (customers, products with price breaks, contract prices, today's visits, form templates); orders, quotes, visits, photos and forms captured without signal queue in an outbox and sync automatically on reconnect. PWA service worker caches the app shell for the built app (`npm run build` + `npm start`).
- **Pricing rules** — volume/quantity breaks, category promos with date windows, fixed clearance prices (Products → "Pricing rules"). Customer contract prices still beat all rules; the mobile app shows "next break" hints while ordering.
- **Stock visibility** — low/out-of-stock flags in the mobile catalogue, backorder badges on over-committed order lines.
- **Quotes** — capture from field or back office, statuses (sent/accepted/rejected/expired), one-click convert to order at the quoted prices.
- **Forms + photos** — admin-built form templates (text/number/select/checkbox/photo fields, required flags), filled by reps during visits; visit photo attachments. Submissions viewable under Forms.

## What's in Phase 3

- **Route planning** — build a rep's day stop-by-stop (Routes page), pull in due/overdue customers with one click, reorder manually or hit "Optimise route" (nearest-neighbour from the rep's last known position). Reps see the numbered route on their phone with Google Maps navigation links per stop.
- **Visit-frequency compliance** — every customer's weekly/biweekly/monthly cycle is tracked; the coverage engine flags due and overdue accounts, feeds route suggestions, and drives the map colours. Planned visits left in the past show as *missed*.
- **GPS tracking** — check-ins record the rep's distance from the customer's pin (with a "you seem far away" prompt past 500 m); the mobile app pings the rep's position; managers get a **Live map** (Leaflet/OpenStreetMap) of customer coverage states and rep locations, refreshing every minute.
- **Rep KPIs** — per-month scorecards and a leaderboard: sales vs target, orders, average order value, quote acceptance, visits done/missed, route compliance %, strike rate (visits → orders), customer coverage %, and hours on site.

## What's in Phase 4 — SYSPRO integration

See [docs/SYSPRO-INTEGRATION.md](docs/SYSPRO-INTEGRATION.md) for the full spec and SQL view templates.

- **Inbound sync (read-only SQL views)** — customers (incl. credit limit, balance, on-hold), products, stock, and contract prices pulled from four views on the SYSPRO database. SYSPRO stays master of financial/product data; the app keeps rep assignment, grading, GPS and visit data. A "Demo data" source mode exercises the pipeline before SYSPRO is connected. All runs logged on the **Integration** page (admin).
- **Outbound orders by email** — orders are *not* posted into SYSPRO; on submit they're emailed to the orders department (rep in CC) with the SYSPRO account code and stock codes, ready to capture. Manual re-send from the order or the email log.
- **Quotes by email** — one click emails the quotation to the customer contact.
- **Email log** — every email stored first; if SMTP is missing/down it waits as *pending* and can be previewed and re-sent.
- Future option: direct posting via SYSPRO e.net (`SORTOI`) — documented, not built.

## What's in Phase 5

- **Analytics** — period-selectable revenue/margin/AOV, 12-month sales trend, revenue by category and territory, product performance with margin %, quote funnel with acceptance rate, CSV export.
- **Sales AI** — explainable intelligence recomputed live from orders/visits/quotes: RFM scoring and segmentation (Champion → Hibernating), churn risk 0–100 (overdue buying cycle + declining spend + missed visits), a prioritised action list (churn calls, declining accounts, overdue orders, stale quotes, account holds), plus per-customer product suggestions ("others buy, they don't") and lapsed-product win-backs. Intel shows on customer pages and as 💡 selling tips in the rep app.
- **Customer portal** (`/portal`, role `customer` linked to one account) — catalogue at the customer's true effective prices, self-service basket → order (attributed to their rep, emailed to the orders dept like any order), order tracking, quote acceptance (converts to an order at quoted prices), account/rep info. Portal logins are hard-blocked from all staff endpoints. Demo: `customer@demo.co.za` / `demo123`.

**All five phases of the build blueprint are complete.**
