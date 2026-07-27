# Discussions

Decisions made, open questions, and things deliberately deferred — the "why"
that TODO.md and CHANGELOG.md don't carry. Add to this whenever a real choice
gets made or punted on; prune entries once they're fully resolved and acted on
(move the resolution into CLAUDE.md if it's a standing convention).

## Resolved

**Product naming: RouteOne, not OneRoute.**
The 2026-07-26 production audit used "OneRoute" throughout. Confirmed with the
user this was a slip in that document, not a rename. Treat "OneRoute" anywhere
as a typo. See CLAUDE.md.

**Documents feature: where reps find it, and how the alert works.**
Considered adding Documents as a 6th icon in the mobile bottom nav, or as a
card on the Today screen. Decided against both — it only appears in the shared
back-office menu (reachable via the rep's existing "Main Menu" link), keeping
the mobile bottom nav untouched. The "new document" alert is a red "!" badge on
that same Main Menu link, checked on page load. Explicitly *not* a push
notification — no service worker/web-push infrastructure exists for that.

**Documents upload permission: reuse admin/manager, no new role.**
Considered adding a dedicated "marketing manager" role scoped only to
Documents. Decided to reuse the existing admin/manager roles instead — simpler,
no new role to maintain in Users admin. Revisit if the marketing manager
shouldn't have access to the rest of the admin area (orders, customers,
settings). See the "Feature follow-ups" item in TODO.md.

**Order/quote email sending: opt-in, not opt-out.**
Originally the orders-department copy sent unconditionally on every submitted
order (no checkbox at all), and the customer-confirmation/rep-copy checkboxes
defaulted checked. The user was clear: nothing should email anyone unless they
explicitly tick the box. Changed all three (orders department, customer
confirmation, rep copy) to strict opt-in, default unticked, on both the mobile
capture screen and the desktop send modal.

## Open / unresolved

**Backfilling emails from the `email_auto_send` outage.**
That setting was found disabled for an unknown stretch of time, meaning no
order emails went out at all during that window (not to the orders department,
not to customers, not to any typed-in recipient) — discovered when the user
tested ORD-00003 and got nothing. We fixed the setting and manually resent that
one order's email, but never established how far back the outage went or
whether any real (non-test) customer orders need a manual resend to the orders
department. Needs a decision: audit the order log for the affected window, or
treat it as acceptable loss since it was mid-build/testing.

**The two `.docx` files graphify couldn't read.**
`Master Blueprint Claud info.docx` and
`RouteOne_Engineering_Library_Volume_1_Product_Constitution_v1.docx` were
skipped during the knowledge-graph build (office-format conversion isn't
installed). Unknown whether these contain current project spec/decisions worth
folding into README/CLAUDE.md, or whether they're stale planning docs. Someone
should open them and decide.

**True push notifications for Documents (and possibly Tasks).**
Flagged as a "bigger separate project" when Documents was built — the app has
no service worker push infrastructure today. Not scoped or scheduled; raise
again if in-app-only alerts turn out to be insufficient in practice.

**`CONTINUE.MD` in the project root.**
An untracked file containing only a handover-doc *template* (not filled in) —
looks like a prior session started to prepare a context-limit handover and
never completed it. Superseded by this file + TODO.md + CHANGELOG.md going
forward. Safe to delete once confirmed nobody needs the old format; left alone
for now since it wasn't part of this request.
