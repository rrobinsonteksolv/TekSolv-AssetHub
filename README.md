# AssetHub

Equipment inventory, rental, maintenance, and safety-inspection platform for
TekSolv — built internal-first, multi-tenant from day one.

**Stack:** Next.js 15 (App Router, RSC + Server Actions) · TypeScript ·
Tailwind v4 · Prisma · PostgreSQL · NextAuth v5 · Zod.

The specification lives in [`docs/BUILD_SPEC.md`](docs/BUILD_SPEC.md); the
architecture reference in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the
validated UX prototype in [`docs/AssetHubDemo.jsx`](docs/AssetHubDemo.jsx),
which remains the definitive reference for every screen and flow.

---

## Run locally

Needs **Node 20+** and **Docker** (for the bundled Postgres). Nothing else —
no global installs, no cloud account.

### Start it

```bash
npm install                   # once
npm run auth:secret           # once — creates .env and generates AUTH_SECRET

npm run db:up                 # Postgres 16 in Docker, on host port 5433
npm run db:deploy             # apply all migrations
npm run db:seed               # load the real TekSolv fleet
npm run dev                   # http://localhost:3000
```

The first two commands are one-time setup. Day to day it is `npm run db:up`
then `npm run dev`.

> `npm run auth:secret` copies `.env.example` to `.env` if you have no `.env`
> yet, then writes a generated secret into it. It never overwrites a secret you
> already have. Do **not** use `npx auth secret` — the bare `auth` package on
> npm now resolves to a different project's CLI, which prints the wrong
> variable name and writes nothing.

`npm run dev` runs a **preflight check** first and refuses to start with a
specific fix if the database is down, the schema is missing, or `AUTH_SECRET`
is empty. That last one is worth the check: without it the login page renders
normally and sign-in silently never works, with the only clue buried in the
server log. Run `npm run preflight` any time to check the same things.

### Stop it

```bash
Ctrl-C                        # stops the dev server
npm run db:down               # stops Postgres, keeps your data
```

To start over from nothing — wipes the database volume:

```bash
npm run db:nuke               # remove the container AND its data
npm run db:up && npm run db:deploy && npm run db:seed
```

### Required environment

`cp .env.example .env` gives you working defaults for everything except the
secret. Only two variables actually matter to run locally:

| Variable | Required | What it does |
|---|---|---|
| `DATABASE_URL` | **yes** | Postgres connection. The `.env.example` default matches the bundled container — leave it alone unless you moved the port. |
| `AUTH_SECRET` | **yes** | Signs session cookies. Generate with `npm run auth:secret`. Empty = sign-in silently fails. |
| `SEED_PASSWORD` | no | Password for the seeded accounts. Defaults to `assethub-dev`. |
| `CRON_SECRET` | no | Bearer token for `/api/cron/notifications`. Unset = the endpoint is open, which is fine locally. |
| `NETSUITE_*` | no | Phase 8. Blank means the bridge safely no-ops. |

### Sign in

Any seeded account, with the password from `SEED_PASSWORD` — `assethub-dev`
unless you changed it. Each role sees a different app, so it is worth walking
all four:

| Email | Password | Role | What this role can do |
|---|---|---|---|
| `ray@teksolv.com` | `assethub-dev` | **Admin** | Everything, plus Settings: users & roles, categories, locations & trucks, inspection templates, audit log. |
| `sam@teksolv.com` | `assethub-dev` | **Supervisor** (Manager) | Checkout & reservations, custody assignment, maintenance, alerts, audit log. No Settings. |
| `dreyes@teksolv.com` | `assethub-dev` | **Field technician** | Grab equipment, run inspections, check gear in. No checkout to customers, no custody assignment. |
| `audit@teksolv.com` | `assethub-dev` | **Viewer** | Read-only across dashboard, inventory, rentals, inspections. |

Delete these accounts before go-live; the seed refuses to run with
`NODE_ENV=production`.

### Worth clicking

- **⌘K** (or `/`) anywhere — search a tag, serial, customer, or order number.
- **Dashboard** — truck readiness is the signature panel; a unit pulled for
  service drops its truck out of "ready".
- **Rentals → Reserved** — a reserved unit is still `AVAILABLE` today. That is
  the point, not a bug (see §6.6 below).
- **Inspections → Run inspection** — fail a *critical* item and watch it take
  the unit out of service, open a ticket, and drop its truck.
- **Maintenance** — usage readings are labelled `estimate` everywhere they
  appear, because they are inferred from rental days, not measured.

---

## The three invariants

These are the rules the rest of the system is allowed to assume. All three are
enforced by PostgreSQL, not by application code, so no future code path can
quietly violate one. `npm run verify` proves each of them against a live
database.

**1. `assetTag` is user-supplied, never generated.** It is the operational
identifier people read off a device in a warehouse; the cuid `id` is internal.
Unique *per organization*, and a CHECK constraint refuses a blank one. Nothing
in the codebase has a default for it — including the NetSuite importer, which
skips a record rather than inventing a tag.

**2. Reservation integrity lives in the database.** A `btree_gist` EXCLUDE
constraint refuses two OPEN/OVERDUE rentals of the same asset whose windows
overlap. Because Prisma cannot write a `tstzrange`, checkout is necessarily two
statements (INSERT, then `UPDATE … SET period`) — so a *deferred* constraint
trigger additionally refuses to commit an open rental that carries no window at
all. **Consequence for callers: create the rental and set its period inside one
transaction.** Catch `23P01` at the call site and say "that asset is already
reserved for an overlapping window".

Since Phase 4b the same constraint also backs **advance reservations**: a
`RESERVED` rental holds its window exactly as an open one does, so a booking is
a range, not a flag. The qualification that follows is the important one —
status answers "where is this unit right now", but *availability for a date
window* is a query over overlapping rentals. A unit reserved for next month is
still `AVAILABLE` today and can go out on a rental that returns before the
booking starts. Every picker in the app therefore asks
`availableInWindow(window)`, never `status = 'AVAILABLE'`. See
`docs/BUILD_SPEC.md` §6.6 and `src/lib/availability.ts`.

One exception is worth stating because it is not symmetric: for a window that
starts *now*, `OUT_ON_RENT` also disqualifies a unit. An overdue rental's
window has already closed, so it overlaps nothing starting now — while the unit
is very much still on a customer's site. Physical presence is a question about
now; availability is a question about a range.

Every custody change — assign, reassign, and return to general stock — writes
the asset columns, a `CustodyEvent`, an alert to admins and managers, and an
audit row in **one transaction**. The person who made the change is excluded
from the alert: they just did it. A change the database rejects therefore
alerts nobody, because the notification rolls back with it.

**"Assigned" is a display state, never a stored one.** A monitor that is
Bucky's is physically on the shelf and working, so its status stays
`AVAILABLE` — but green "Available" would invite someone to walk off with it.
The label is derived at the point of display from status + custody
([`src/lib/asset-status.ts`](src/lib/asset-status.ts)): stored `AVAILABLE` with
a holder shows amber **Assigned**; only general stock shows green. There is no
`ASSIGNED` enum value, because that would make status mean two things at once
and drag custody changes into the status machine.

**Derived means derived everywhere, including search.** The ⌘K result row used
to print `status` straight from the column, so a truck-staged unit read
"available" in search and "Assigned" the moment it was opened — and the reading
that invited somebody to walk off with it was the one shown first. The fix was
not a matching mapping in the search row; that is a second copy of the rule, and
a second copy is why they drifted. A search hit now carries the two *columns*
and hands them to the same `StatusBadge` the drawer and the inventory list
render. Nothing in the palette maps a status to a label.

The free-to-take pool follows the same rule: the grab, checkout, and reserve
pickers all offer only general-stock units, so nothing is ever labelled
"Assigned" in one place and offered as grabbable in another. To rent out a
staged unit, unassign it first — that step is what drops its truck's readiness.
Custody itself is unaffected by any of this: an assigned unit can still be
reassigned or returned to stock, because availability never gates the custody
dimension.

**3. Custody is single-holder.** An asset is in general stock, assigned to a
person, staged on a truck, or out on rent to a customer — never two at once.
CHECK constraints enforce the shape, and `status = 'OUT_ON_RENT'` forces custody
to null. Deliberately still allowed: a unit staged on a truck may sit in
maintenance. That is the "pulled from Truck 165" case, and it is exactly what
drops a truck's readiness on the dashboard.

---

## Maintenance: what is measured and what is guessed

Two kinds of schedule, and the difference is stated everywhere it surfaces
(`docs/BUILD_SPEC.md` §6.4, `src/lib/maintenance.ts`).

**Calendar schedules are exact.** Annual flow tests, five-year hydros. Next due
is last performed plus the interval; logging service moves both.

**Usage schedules are estimated, and always labelled so.** TekSolv's
compressors have no hour meter, so runtime is inferred:

```
estimated hours = priorUsage + (rental days since the anchor × hoursPerDay)
```

`hoursPerDay` falls back to the asset's category default, then to 8. Every
screen that shows one of these numbers carries an "estimate" badge, and so does
the alert the digest sends — a supervisor pulling a unit for a 500-hour service
should know the 512 was inferred from rental days.

Two consequences worth knowing before touching this:

1. **The reset moves two fields, not one.** Logging service on a usage schedule
   sets `priorUsage` to zero *and* moves `usageAnchorAt` to the service date.
   Zeroing the hours alone leaves it counting from the old anchor and instantly
   due again; moving the anchor alone leaves the banked hours in place. Both,
   or the estimate is wrong. `npm run verify:maintenance` asserts this.
2. **Off-rental runtime is invisible by construction.** The estimate can only
   see rental days, so a compressor run for two days on the yard never shows
   up. That is what the "adjust reading" control is for — `SET` replaces the
   estimate with a real meter reading and restarts accrual from it; `ADD` banks
   extra hours without disturbing the anchor.

**Lead time is per schedule.** Each one carries `leadDays` (default 7) — how
far ahead it starts warning. A monthly calibration and a five-year hydro want
very different notice, so this is not a global constant. On a usage schedule
the same number is converted with the schedule's own hours-per-day factor, so
"7 days' notice" means the same thing on both bases.

The digest cron (`/api/cron/notifications`) marks rentals overdue, flags
reservation no-shows, and alerts on service. Maintenance alerts **escalate**:
one heads-up when a schedule enters its lead window — while there is still time
to book it in — and a second when it actually falls due or goes overdue. That
needs `alertedState` as well as `alertedAt`, because a single "already alerted"
flag cannot express it: stamp it for the heads-up and the alert that matters is
suppressed; clear it and every run re-sends. Each sweep claims its rows with a
conditional write — `status = 'OPEN'`, `noShowAt IS NULL`, `alertedState = <the
previous stage>` — so a retry cannot double-alert. "This schedule is
overdue" stays true until somebody services the unit, and an alert feed that
repeated itself every morning would stop being read. Those routes are excluded
from the auth middleware and authenticate against `CRON_SECRET` instead; a
scheduler has no session and never will.

---

## The dashboard, search, and the audit trail

**One definition per number.** Every figure on the dashboard comes from
[`src/lib/dashboard.ts`](src/lib/dashboard.ts), so "utilization" and "value"
mean one thing in the whole codebase. Both definitions are arguable, so both are
written down:

- **Utilization** is `out on rent ÷ deployable`, where deployable excludes
  retired gear but **includes units in the shop**. Excluding them would flatter
  the number exactly when the fleet is least able to work — a yard full of
  broken monitors would read 100% utilized.
- **Value** prefers `replacementCost`, falling back to `purchaseCost`. What it
  costs to put a unit back on the truck is the number that matters when one goes
  missing, not what it cost in 2019.

**⌘K** resolves assetTag, serial, model, manufacturer, customer, job, and order
number. An exact tag wins outright, because that is what a scanner and a person
reading a label both produce — scan, press Enter, you are on the unit. It runs
through `getDb()` like everything else, so a result set can only contain your
own tenant's rows. One known limit is documented in
[`src/lib/search.ts`](src/lib/search.ts): each group is truncated before ranking,
so a very broad prefix returns an alphabetical slice rather than the most
relevant one. That is a browse, not a lookup, and fixing it properly means
ranking in SQL.

**The audit log** at `/settings/audit` is append-only *by construction* — no
code path in the app updates or deletes an `AuditLog` row, and the viewer offers
no way to. A trail that can be edited from the application it audits is not a
trail. It is supervisor-and-above, a wider gate than the rest of `/settings`,
which is admin-only; managers reach it from the dashboard's activity panel.

**Admin screens.** Categories carry the custom-field definitions the asset form
renders and the `hoursPerDay` default behind usage estimates. Locations and
trucks refuse to deactivate while anything still points at them. Roles refuse
two moves that have no way back: demoting yourself, and removing the last active
admin. Nobody is ever deleted — every rental, inspection, and audit entry points
at a user.

---

## Inspections: the consequence chain

An inspection is not a form that files a record — it is the thing that takes
unsafe equipment off the shelf (`docs/BUILD_SPEC.md` §6.5). Submitting one runs
this, atomically:

1. The inspection and **every** answer are filed to the unit's history — passes
   as well as failures.
2. If any item flagged **critical** was failed, the unit flips to
   `OUT_OF_SERVICE`,
3. a `CRITICAL` MaintenanceTicket opens pointing back at the inspection,
4. supervisors are alerted,
5. and if the unit was staged on a truck, **that truck stops reading ready.**

Step 5 needs no code and has no column. Readiness is derived from whether every
staged unit is Available, so taking a unit out of service *is* the truck going
amber — there is nothing to keep in sync and nothing that can drift.

Three rules worth knowing before changing any of it:

- **N/A is not a pass.** `InspectionResponse.passed` is three-valued on
  purpose: `true`, `false`, and `null` for "did not apply" or free text. Only an
  explicit FAIL/NO trips the chain. Counting N/A as a pass is how a safety
  checklist quietly stops meaning anything.
- **A unit on a customer's site is never flipped by a form.** Status is the
  single source of truth for where a unit physically is (§3.4). A critical
  failure on a rented unit still opens the ticket and still alerts — check-in
  routes it out of service when it actually comes back.
- **Templates and their items are retired, never deleted.** Every inspection
  points at the template and every response at the item it answered; deleting
  either would orphan a safety record. The builder keeps any item that has been
  answered, and the database refuses to delete it regardless.

**Out of service is a filter, not a list.** The Maintenance queue's *Out of
service* tab is `status = 'OUT_OF_SERVICE'` and nothing else. That is the whole
design: a damaged check-in and a failed inspection each already flip the status,
so both appear the moment they happen with no wiring between them and that
screen — and no path can put a unit out of service in a way the tab then
misses. A table of "out of service records" would need every one of those paths
to remember to write to it, and the first one that forgot would leave a unit
quietly absent from the list of units to fix.

Everything else on a row is *evidence* gathered around that filter. The reason
and the work item come from the live ticket. **When** it went out comes from the
audit log rather than a column: that log already knows, it knows for every path
including a hand-set status, and an `outOfServiceAt` column would need stamping
by four actions and clearing by two — four chances to drift and two to leave a
stale date behind. Where nothing is on record the row says "unknown" rather than
inventing a date from `updatedAt`.

The way back out reuses what already exists rather than adding a third path. A
unit with a live ticket goes through `updateTicketAction`, which resolves the
ticket, appends the fix, and **refuses the return while other faults are open** —
clearing one fault does not make a two-fault unit safe. A unit with no ticket
goes through `logServiceAction`, filing the repair to its history. Retiring is
the other way out, admin-only, and is the same control as on the unit's own page.

A damaged check-in now **opens a ticket** as well as flipping the status. It used
to only flip it, which left the unit sitting out of service carrying no work item
anyone could act on, no reason beyond a note on the asset, and nothing telling a
supervisor it had happened — so every out-of-service unit now uniformly has a
reason, a repair work-item, and one consistent way back.

**A unit can also be taken out by hand, from the unit.** The automatic paths
cover what the app was watching; plenty it was not. An AED that fails a *paper*
inspection on a dead battery and expired pads is out of service in the world
whether or not anything here noticed. On the unit's Maintenance tab,
supervisor+, *Take out of service* asks for a reason and posts it to
`createTicketAction` with "take it out of service" set — **the same call the
ticket form makes**, so it flips the status, opens the ticket that carries the
reason, notifies managers, and writes the audit row the Out of Service list
reads to date it. The reason's first line becomes the ticket title, because
asking for both is two boxes for one decision.

That is the point: it is not a third consequence path, it is the existing one
made reachable from where somebody holding a failed AED is actually looking. A
unit already out of service shows *Return to service* in the same place instead
— never both — and that form is
[one component](src/components/maintenance/return-to-service.tsx) shared with
the Out of Service list, because the rules it carries are not cosmetic: which
action to post to depends on whether there is a ticket, a returning unit is
always asked its condition, and the return is refused while other faults are
open. A second copy on the asset page would be a second chance to get one of
those wrong, and the copy that drifted would be the one nobody was watching.

Out on rent is refused rather than offered: status is the single source of truth
for where a unit physically is, and a rented unit is in a customer's hands, not
in the shop. Check it in first — a damaged check-in does this for you.

**Coming back, the condition moves with the status.** Both return paths used to
flip `status` to AVAILABLE and leave `condition` where a damaged check-in had put
it, so a monitor that came back broken, went out of service, was repaired and was
put back on the shelf sat in inventory reading *Available · Damaged* — and the
condition is what a tech reads before signing for it. Two statements, flatly
contradictory, and the wrong one was the sticky one.

The fix is not to stamp GOOD on everything leaving the shop, which would just
replace a stale fact with an invented one. **Every return-to-service path asks**,
because the person who did the repair is the one who knows and is already filling
in a form saying what they did: log service, the ticket board, and the
out-of-service tab all show one `ConditionOnReturn` control, and the answer is
written in the *same conditional update* as the status flip — so a unit the flip
does not touch keeps its condition too, rather than being relabelled while
staying in the shop. DAMAGED is not offered and is refused server-side
(`SERVICEABLE_CONDITIONS`); the box starts on the unit's current condition where
that is still serviceable, so a unit that went in Fair is not quietly promoted to
Good just because somebody worked on it. Absent entirely, the schema defaults it
to GOOD — a backstop against a form that forgets to ask, not the plan.

Units the bug had already left contradicting themselves are repaired by migration
`20260806160000_condition_on_return_to_service`, which is narrow on purpose:
OUT_OF_SERVICE and IN_MAINTENANCE are consistent and left alone, and RETIRED is
left alone because "damaged" is frequently *why* a unit left the fleet.

**Supplies is on the sidebar, not in Settings.** Counting what is on the shelf
and restocking it is something somebody does on a Tuesday, not something an
admin configures once — it sits next to Inventory, at `/supplies`. The old
`/consumables` path redirects rather than 404s: every low-stock alert ever
raised stamped that link into its row, and those rows are history that cannot be
rewritten to point somewhere else.

**Stock is per office.** "22 boxes of gloves" is not a fact anybody can act on
if 20 are in New Castle and 2 are in Oakdale and the crew asking is in Oakdale —
so the count, the reorder point and the low-stock alert all live on
`ConsumableStock`, one row per (item, office). `Consumable` holds no count at
all; the migration moved the old fleet-wide numbers onto each org's stores
location and **dropped** the columns, because a total that is true of nowhere
anybody stands is worse than no number. Totals still exist as sums, computed
where a total is genuinely what is wanted.

A grab draws from the taker's office (`Membership.homeLocationId`). Where the
roster doesn't know one, the grab step asks rather than blocking somebody at 6am
over a field an admin never filled in — and nothing is pre-selected, because a
wrong default silently decrements the wrong building's shelf.

**Lot-tracked items hold dated batches.** Optional per item: gloves and glasses
are a number on a shelf; cal gas and P100 filters come in lots with a number
stamped on them and a date after which they must not be issued. For those,
receiving records lot + expiry + quantity, on-hand is the sum of the lots, and
consumption is **FEFO** — soonest-expiring first, recorded against the lot, so a
month later "which cylinder did that calibration use" has an answer.

An expired lot is on the shelf but is **not available**. Those two numbers are
deliberately different and the gap is the thing somebody has to go and deal
with: the picker offers only in-date stock, the server refuses an issue that
would need an expired lot (whole, never partial), and low-stock is measured on
what can be *issued* — an office holding four expired cylinders and nothing else
has nothing to hand out, and staying quiet because the shelf looked full is the
most expensive kind of wrong available here.

**Both alerts run in the digest**, not just as a flag on a screen somebody has
to open. `sweepLowStock` alerts per (item, office) and names the office, because
that is who has to order. `sweepExpiringLots` warns while there is still time to
reorder — `expiryLeadDays` is per item, since cal gas takes longer to source
than filters — and again, separately, once a lot actually lapses. Both use the
same `alertedState` claim as maintenance schedules, so each stage announces
exactly once and restocking is what re-arms the next warning.

**On hand is never edited.** A count moves only through the ledger, so the item
form has no on-hand field and no office — Receive and Adjust do that, and each
writes a `ConsumableTxn` naming who, where, how much, why, and which lot. Items
are deactivated, never deleted, and re-adding a name revives the item with its
ledger instead of starting a second one under it. Lot tracking cannot be toggled
while stock is on a shelf: turning it on would leave existing stock with no lots
behind it — undated, unorderable by FEFO, invisible to the expiry sweep — on
exactly the items where dating matters most.

Three permissions, one per job: **`consumable.view`** (supervisor+) reads the
page, **`consumable.manage`** (admin) adds, edits and adjusts, and
**`consumable.take`** (field crew) takes supplies to a job through the grab
flow. Technicians never see the page — that job happens in grab.

`consumable.view` exists because the page was briefly gated on `alerts.receive`,
which held the right roles by coincidence. One key doing two jobs means a tenant
re-pointing who gets alerted would silently change who can see the shelf, so the
two were split while `Organization.settings.permissions` was still empty and
there was nothing to migrate. They agree on roles today and can now diverge
without either noticing.

**Photos and signatures.** Signatures are canvas PNG data URLs, format- and
size-checked on the way in — that column is rendered back into an `<img src>`,
so an unchecked string there is stored XSS. Photos are downscaled in the browser
to a ~1600px JPEG before upload, then written through
[`src/lib/storage.ts`](src/lib/storage.ts). Files live under `.uploads/<orgId>/…`
and are served by `/api/files/*`, which re-checks the session's org and answers
404 — not 403 — on a mismatch. The org is in the path so that check needs no
database lookup, and nothing under `public/` is involved, because that would be
served with no session at all. Swapping the local driver for an object store is
a change to that one file.

**Three dates, three questions.** Assets carry `purchaseDate`, `manufactureDate`
and `inServiceDate`, and on safety gear they are genuinely different answers: a
harness *made* in 2019, *bought* in 2023 and *issued* in 2024 is a five-year-old
harness on the day it first goes to work. Manufacturers set retirement from the
manufacture date, inspection intervals run from the in-service date, and only
the purchase date has anything to do with money. Form FP-01 asks for manufacture
and in-service side by side, which is the clearest statement that conflating them
loses information. All three are editable on the create/edit form and shown on
the asset overview.

Manufacture and in-service are entered in AssetHub — FAM has no equivalent for
either — and a NetSuite pull cannot touch them: `sync.ts` writes an explicit
allow-list of NetSuite-owned columns, so anything absent from that object is
immune by construction. `verify:asset-dates` asserts the allow-list itself *and*
the behaviour, by applying a sync-shaped update and checking the two local dates
survive it while the purchase date — which FAM does own — is updated.

**Printed forms.** Some inspections map to a document that exists on paper.
Form **FP-01 — Full Body Harness** reproduces
[`TekSolv_Harness_Inspection_Form.pdf`](TekSolv_Harness_Inspection_Form.pdf) and
is defined in [`src/lib/inspection-forms.ts`](src/lib/inspection-forms.ts): its 22 items, its
four sections (Hardware / Webbing / Stitching / Labels & Tags), and the fact
that every item is critical, because there is no minor defect on a harness. The
wording and order are part of the document, so they live in code rather than
in whatever an admin happens to type; `npm run db:forms` installs or refreshes
them without disturbing items that historical inspections have answered.

**Frequency and the next one.** At sign-off the inspector sets how often this
unit is inspected — Monthly / Quarterly / Semi-annual / Annual / custom days —
and a next-due date that computes from the inspection date plus that interval
and then stays editable. Annual is the default: fall protection needs
competent-person inspection at least annually. Both land on the `Inspection`
row, so the printed form says what was decided rather than inferring it from
whatever schedule the unit happens to carry.

Completing an inspection then **arms a `MaintenanceSchedule`** — CALENDAR, type
INSPECTION, interval = the frequency, `lastPerformed` = the inspection date —
rather than starting a second reminder system. The queue, the digest cron, the
asset's Maintenance tab and the dashboard all read schedules; anything invented
alongside would have to be taught to four places and would drift from three of
them. So the next inspection appears in the same due queue as a calibration and
fires the same "coming up" alert. The next inspection re-arms the same row,
found by `inspectionTemplateId` rather than by label, so renaming a template
cannot silently start a second schedule; a hand-made inspection schedule on the
unit is adopted instead, keeping the operator's label and notice period.

A **failed** inspection gets no next-due date and moves no schedule. It gets a
critical ticket and the unit goes out of service — printing a date next to
"REMOVE FROM SERVICE", or telling the queue this harness is squared away for a
year, would both be lies. The interval is still recorded, because how often a
unit is inspected is a property of the program and not of today's outcome.

Completing one renders the FP-01 layout pre-filled from the record, attaches it
to the unit's documents, and points `Inspection.pdfUrl` at it. A **blank** copy
for hand-filling in the field comes off the same component and the same item
list, so the paper carried into a confined space cannot drift from the one the
app produces.

The layout is the paper's: sections numbered 1–4 and split 1/3 left, 2/4 right;
PASS and FAIL as separate ticked columns; boxed fields with the label above.
Letterhead comes from `Organization.settings.branding` (Settings → Organization
letterhead), never from a constant — an unset address prints nothing rather
than filler, because a compliance record should carry real details or none.

One UI detail worth not regressing: the runner's PASS/FAIL controls are real
radios kept *in place* under their label (`absolute inset-0 opacity-0`), never
`sr-only`. `sr-only` is `position:absolute` with no positioned ancestor, so the
inputs escape to the initial containing block — which stretched the checklist
page to ~4,700px of mostly blank space and made every click scroll the window to
the off-screen input it had just focused. `verify:fp01` asserts the document
never exceeds the viewport and that answering an item moves the scroll position
by exactly zero.

One print detail that is not optional: the form's section headings are white on
navy, and browsers drop background colours when printing. `print-color-adjust:
exact` on `.inspection-report` is what stops those bars printing white-on-white
and taking the headings with them.

**PDF export** is the browser's own print-to-PDF, driven by the print
stylesheet at the end of `globals.css`. A server-side PDF toolchain would be a
multi-megabyte dependency plus embedded fonts to render a page of text and two
signatures; print-to-PDF produces a selectable, searchable file everywhere and
stays correct when the report page changes. `Inspection.pdfUrl` is the seam if a
stored artifact is ever needed.

### Areas: everywhere gear lives

An **area** is a place gear lives: each truck, the Rescue Prop, the Ops Manager
Office, a future store room. One concept, because "where is our gear" is one
question — splitting the answer by *kind of place* is how a room ended up
holding fifty-one items with no page to look at them on, which from the outside
was indistinguishable from a failed import.

`/areas` lists them all, trucks and rooms together. Each area's page shows
**kits first, then loose gear** — a kit is what somebody picks up and carries,
and a page that opens on "everything not in a bag" buries the bags that are the
point. A truck's area page is `/trucks/[id]`, because it also carries staging,
labels and move-gear, but both render the same `AreaContents`: the two kinds of
area answer "what is in here" identically rather than in two implementations
that drift.

**Deleting a site is guarded, and deactivating is the usual answer.** A place
gear has passed through is part of how that gear got where it is, so
[`checkSiteDeletable`](src/lib/site-deletion.ts) refuses any site that holds
gear, has a kit sitting at it, is named by a custody record, carries consumable
stock, or is somebody's home office — each with a sentence saying what to do
instead. **Home office is settable by the person it belongs to.** It drives real
defaults — the grab form starts at your shelf instead of asking, and the supply
context follows — and the action to set one existed with *no screen wired to
it*, gated on `user.manage` and callable by nobody. So when the warehouse five
people were homed at turned out to be test data, they were left with none and no
way to fix it, the owner account included.

There are now two ways in and one rule. An admin sets anyone's inline on
**Settings → Users & roles**, where a banner names everybody currently unset;
a person sets their own on **Settings → Your profile**. The action checks the
*target*, not the caller's rank: your own is always yours, anyone else's needs
the permission. Routing "fix my own default" through an administrator is what
makes people stop bothering.

The offices offered are **offices**, narrower than the set that holds stock. A
service bay has a shelf and takes deliveries; nobody is based there. Offering it
would conflate two questions — "where does stock live" and "where does this
person work out of" — that have overlapping answers and are not the same
question. Every office offered does hold stock, which is a property of offices
rather than a reason to widen the list to everything that does. Unset stays a
real, selectable state:
every form that reads it asks when it is missing rather than breaking, and
hiding "none" would mean the only way out was picking somewhere wrong.

**Some of it can be overridden; the important part cannot.** Two blockers are
facts about people and paperwork rather than about equipment — supply stock that
may be demo data, and a roster field pointing at a site nobody works from. Those
can be pushed past deliberately: the override asks for the site's **name typed
out**, not a second click, because a button beside a button gets pressed and a
name gets read first. Stock then leaves the way stock always leaves — an
adjust-out through the ledger with a reason on it — rather than rows vanishing
from a system whose whole claim is that every number traces to a row saying who,
where and why.

Gear held there, kits sitting there and custody history naming it are never
overridable. They are the record of physical things and where they have been,
and no confirmation dialog makes erasing that the right move.

What does *not* block is an asset merely **filed** there: `locationId`
is the catalogue address, a nullable pointer to where a unit is on paper rather
than where it is, and it is cleared on the way out and reported so nobody
deletes a site without seeing how many units it unfiles.

The guard lives in one function that both the Delete button and
`scripts/delete-test-jobsites.ts` call, because a safety net one caller skips is
not a safety net — and a cleanup script is the caller most tempted to skip it.

**Assignment offers every area, from the same source.** The reassignment picker
listed trucks and nothing else, so the Rescue Prop had its own page, fifty-one
items on it, and no way to send a fifty-second there — a gap that reads as the
feature being broken rather than missing, because the place is plainly right
there in the app. `getFormOptions` now calls `listAreas`, the same function
`/areas` calls, and `verify:assign-area` compares the two lists against each
other rather than against a hardcoded expectation. If an area is real enough to
have a page, it is real enough to assign to, and the two cannot drift.

A unit can also be dropped **straight into a kit** — the option carries the area
and the kit together, so the pair can never disagree. Posted apart (a stale tab,
a hand-built form), a kit that sits somewhere other than the chosen area is
refused: a unit filed in a bag that is elsewhere reads as permanently missing
from it.

**A rescue area is not a building.** The Rescue Prop and the Ops Manager Office
were both typed `OFFICE` — the closest label that existed, not the one that
fits — which listed them in settings beside Newark and Oakdale, real offices
with a street address and nobody's rope in them, and offered a place holding
fifty-one items an address field it will never use. They are now
`RESCUE_AREA`: managed from Areas, able to hold kits, never offered as a site.
The `OFFICE` type stays, because three real offices use it and Newark prints on
CAL-01 certificates as where a calibration was performed.

That change was a reclassification and nothing else — same ids, same custody
rows, same kits, same retired and quarantined units. `verify:rescue-areas`
checks that specifically, because a migration that quietly re-created a location
would leave the gear on the old one and read as a successful rename right up
until somebody went looking for it.

BUILD_SPEC §3.3 says a unit has exactly one holder. There are three kinds: a
**person**, a **truck**, and a **location**. Trucks and locations are the two
kinds of area; a person is a holder but not a place. They sit in one exclusive
set: a unit is with somebody, on a vehicle, in an area, in general stock, or out
on rent, never two at once.

A location area is a holder in the full sense, not a filing detail. Assignment
goes through the same `assignCustody` as staging on a truck, so it writes the
same `CustodyEvent`, the same alert and the same audit row — "who had it last"
has to answer the same way whichever kind of holder it was. The importer's
`holder` column places gear at one, creating it if it does not exist: a holder
is a name somebody gave a place, and unlike a truck there is no vehicle to
invent.

**The single-holder rule was extended, not left behind.** Adding a third kind of
holder without touching `asset_custody_single_holder` would have left the
invariant enforced for two of the three — and the one that got through would be
the one nobody was checking. It is still a database CHECK rather than a
convention in the assignment helper, and `verify:holders` proves it by trying to
give a held unit a truck as well, in raw SQL.

`custodyLocationId` is deliberately **not** the same column as `locationId`.
That one is where a unit is catalogued; this is what currently holds it. A unit
can be catalogued at the warehouse and assigned to the Rescue Prop, and
collapsing the two would make "where does this live" and "where is this now" the
same question — which is the confusion custody exists to resolve.

One consequence worth stating: office stock now reads **Assigned**, not
free-to-take, exactly as gear staged on a truck does. Renting one out means
releasing it from the holder first — the same step a truck's gear needs.

**An area does not decide class.** The Rescue Prop's rope gear classifies
RESCUE and the office's gas-detection spares classify RENTAL, and they are the
same kind of area. A truck carries RENTAL meters and RESCUE rope on the same
shelf. Classification follows the category, always.

**An item's location is its area** — via its kit when it is in one, directly
otherwise, and the catalogue address only as a last resort. That resolution
lives in one place, `areaOfAsset`, and the list, the drawer and the area pages
all call it. Before it, the Location column read `locationId` alone, which is
null for held gear, so ninety-three units whose place was recorded perfectly
well rendered an em-dash.

Empty areas are listed rather than hidden — a room that holds nothing today is
still somewhere gear can be sent, and a list that quietly omits it invites
somebody to create a second one.

An area also shows anything **retired** while filed there, kept apart from the
held count and clearly labelled. Retirement releases custody, so counting a
retired unit among the gear at a place would make the number lie — but dropping
it entirely reads as an import that lost a row, which is exactly the ambiguity
this surface exists to remove. The importer files a retired row at the holder
its sheet names for the same reason: retirement releases custody, not the record
of where the thing was.

---

### A rental is an order, holding many assets

A rental used to be one asset. Customers take several things at once, so four
monitors on one truck were four unrelated records with the customer typed four
times, no way to bring them back together, and no figure for what one job was
holding.

**The order groups rentals; it does not replace them.** Every invariant stays
exactly where it was: custody and status are per asset, and `rental_no_overlap`
still refuses to double-book a unit. That GIST constraint is defined on the
*line* row and reads the line's own `assetId` and `period`, which is why a line
carries its own dates rather than reading its order's — the duplication is
forced by the constraint, not chosen, and `verify:rental-orders` asserts every
line agrees with its order so drift is caught rather than assumed away.

A single-item checkout is an order with one line. There is no second shape and
no branch anywhere asking which it is looking at, which is why the migration
gave every historical rental an order of its own and why field grabs,
reservations and the NetSuite sync all open one through the same helper.

**Checkout takes units one after another** — the box clears after each, so a
barcode scanner can work down a pile without touching the keyboard, and an exact
tag match is required before a scan adds anything. Customer, job site and due
date are asked once. The whole order is one transaction: a unit that turns out
to be unavailable on the third line leaves the first two on the shelf rather
than half-checked-out to an order nobody finished.

**Check-in resolves each line, and "never came back" is one of the answers.** A
return used to be yes-or-no with a condition attached, which cannot say *this
one is gone*. Three outcomes now, each reusing the path that already existed
rather than inventing a parallel one:

- **Came back** — available again.
- **Came back damaged** — out of service with a repair ticket, exactly as a
  damaged check-in always did.
- **Never came back** — retired with the `LOST` disposition, writing the same
  columns the Retired flow writes, so it leaves every deployable count and its
  utilization window ends at retirement. The note records which order and
  customer it went out on, and the line carries a **billable flag and an
  amount** captured at that moment — the asset is about to be retired and its
  replacement cost could be edited afterwards.

The flag and the amount are separate columns: a unit can be written off without
being charged on — goodwill, a disputed loss, an internal grab — and an amount
with no flag reads as a bill nobody agreed to send.

`LOST` is a **resolved** line status, not an open one. It releases the
reservation window and stops keeping the order open, because there is nothing
left to wait for. That is what stops a lost unit leaving an order perpetually
out.

**Returns are per line, and the order closes itself.** A crew brings two
monitors back on Tuesday and keeps the tripod until Friday, so each line returns
on its own with its own condition — a damaged unit still goes out of service
rather than back on the shelf. The order's closed state is *derived* from its
lines; a stored tally would be a second number to keep in step and wrong the
first time a unit came back some other way.

**The board is one row per order.** It was one row per unit sorted by due date,
so a four-unit job appeared as four rows scattered among other customers' — the
same customer, site and date printed four times, with nothing saying they
belonged together. Now an order is a row that expands to its units, which are
still where every real fact lives. It searches customer, site, SO number *and*
the tags on the order, because somebody holding a unit wants the order it is on
rather than a reason to go and look it up first.

Sorting by due date sorts on the **stored instant**, never the `MM/DD/YYYY`
string — text order puts November before February, and `verify:rental-board`
seeds an order a year out specifically so a text sort would misplace it.

The header counts orders and units separately. "How many jobs are we waiting on"
and "how much of the fleet is out" are different questions, and one number
pretending to be both is how a board with three orders and seventeen units reads
as either depending on who is looking.

Value on hire sums an order's **open** lines only. A unit that came back last
week is no longer money standing in a field, and `exposureByCustomer` rolls the
same figure up by customer.

---

### Stored status vs shown status, and the one place it lives

`Asset.status` answers exactly one question — where is this unit physically —
so a monitor staged on a truck is correctly stored `AVAILABLE` and correctly
*shown* as **Assigned**, because it is not free to take. That split has now
caught three surfaces: the badges, then search, then the inventory filter, which
was matching the raw column and returning **266 assigned units** under
"Available", each wearing an Assigned badge in the row the filter had just
claimed was free.

`displayStatusWhere` is the query form of `displayStatus`, and lives beside it:

    AVAILABLE → { status: AVAILABLE, custodyType: null }
    ASSIGNED  → { status: AVAILABLE, custodyType: { not: null } }
    anything else → { status: itself }

Any surface filtering or counting by what a unit *looks like* asks there rather
than writing `status: 'AVAILABLE', custodyType: null` by hand — that pair is the
derived rule in longhand, and every copy of it is another place to drift.
`verify:status-filter` ends with a **source guard** that fails if any file
outside `asset-status.ts` writes that pair itself.

The filter also offers **Assigned**, which it previously could not express at
all, and **Retired** now lifts the usual "active inventory" clause — retiring
clears `active`, so that option could only ever have returned nothing, and an
option that is always empty reads as "nothing is retired" rather than as a
filter that cannot work.

**Not offered: Reserved.** A reservation is a rental with a future window; the
unit stays on the shelf and its badge says Available or Assigned. Putting
Reserved in a filter whose contract is "each option returns exactly what its
badge says" would break that contract. It belongs as a separate
"has an upcoming booking" filter if it is wanted.

---

### The category tree, and why the report looked wrong

Utilization groups by category, so a broken tree reads as nonsense groupings.
The cause was **two taxonomies coexisting**: some categories properly nested
(`Confined Space` → `Ventilation`) and others flat rows whose *name* contained
the separator (`Fall Protection > Harnesses`, with no parent at all). The same
family then rendered as two unrelated buckets, and "Fall Protection" appeared
not to contain its own children — because it did not.

`scripts/fix-category-taxonomy.ts` nests the Fall Protection family properly and
merges `Access` up into `Confined Space`, which is what "rename Access →
Confined Space" means in the tree as it stands: Confined Space already existed
and was Access's own parent, so a rename would have produced
`Confined Space > Confined Space`.

**Re-classification promotes, never demotes.** `classifyAssetType` is an
import-time default that leans RESCUE on purpose, and re-running it as an
override would demote units somebody deliberately made rentable — the tripods
and lifelines here are on live rental orders. So a move to a path that says
RENTAL promotes; a move to one that does not leaves the existing class alone.

**Assets may be filed on a parent.** Seven sit directly in `Confined Space`
beside its `Ventilation` child. The category picker used to offer only children
where a parent had them, so those assets could not be represented at all —
opening one for edit showed no selection and saving cleared its category. The
picker now offers the parent as well.

**The whole tree is now one shape** — eight top-level families, no flat rows
left. `Rope Rescue`, `Rescue` and `Medical` were created as real parents for the
children that named them. `SCBA > Cylinders` needed a judgement rather than a
rename: a spare cylinder is respiratory kit, and `Respiratory > SCBA` already
held the sets, so it became `Respiratory > SCBA Cylinders` — a *sibling* of
SCBA, not a child, because the category picker renders exactly two levels and a
third would be invisible to the form that has to select it.

A keyword scan for mis-parented items turned up only false positives, which is
worth stating: a *litter harness* is patient restraint rather than fall
protection, and a wire-rope *ladder* is confined-space access rather than rope
rescue. Nothing was moved on the strength of a matching word.

---

### Calibration gas is usually a blend

`Consumable.gasType` + `Consumable.concentration` could describe a single-gas
cylinder and nothing else. Most of what a shop calibrates with is a blend: a
4-gas carries H2S, CO, O2 and LEL/CH4 together, each with its own number **and
its own unit** — PPM for the toxics, % by volume for oxygen, % LEL for the
combustible. One text box could hold that only by having somebody type all four
into it, which is a list pretending to be a value, and it printed onto Form
CAL-01 as whatever they happened to type.

Components are now rows: [`GasComponent`](prisma/schema.prisma) with a `GasUnit`
enum. `amount` stays free text because labels read "2.5" and "20.9" and a
certificate that rewrote what the label says would be worse than one that copied
it; the *unit* is structured because that is the part that varies per component
and that a printed form has to get right. The three units are not convertible —
%LEL depends on which gas it measures — so nothing does arithmetic on them.

**A single gas is a one-row list.** There is no simple mode to leave and no
second form to find: the row is already there with its unit defaulted to PPM, so
the common case is two boxes and a dropdown, exactly as it was.

On Form CAL-01 the blend prints across the two existing columns — gases in one,
concentrations in the other, **in the same order**, which is the only reason a
reader can pair them. That ordering is asserted, not assumed. The technician can
still type over both: the paper form always could, and a cylinder that does not
match its catalogue entry is exactly when somebody needs to say so.

The old pair was backfilled into a single component and then dropped. Two places
to look for the same fact is how they drift.

---

### Supplies, at catalogue size

The page was a stack of expandable cards. That reads pleasantly at five items
and stops working at sixty: nothing to search, no column to sort, no way to see
only what needs ordering, and opening one row pushed every other off the screen.
The per-office breakdown and the lots lived *inside* the row, printed as a run
of inline spans — `25-3007 ×5 · 09/14/2025` — that wrapped into each other until
two dates overlapped and neither could be read.

It is now a table: one row per item, sortable on every column, with search,
status chips carrying their own counts, and filters by office and category above
it. Detail moved into a panel beside the list rather than inside it, where the
per-office table and the lots each get columns — a lot has four facts worth
knowing (which one, how many, when it lapses, whether it still counts) and four
facts want four columns. Lots stay in issue order, soonest-expiring first,
because that is the order the shelf actually empties.

**Categories are derived, not stored.** There is no category column and adding
one would be a change to the data model rather than to the screen, so
[`supplyCategory`](src/lib/supply-categories.ts) sorts the catalogue from what
the record already says: a gas type means a cylinder, "cartridge" or "filter"
means something that clips onto a respirator. The honest limit is that a name
nobody anticipated lands in Consumables — which is the right place for
"everything else", but is not the same as somebody having chosen it. That
function is the one place to swap for a lookup when curated categories earn
their column.

**Adding a catalogue is one paste.** Sixty items through a one-at-a-time modal
is sixty dialogs, and that friction is why a catalogue never gets entered. "Add
several" takes the list somebody already has, one item per line, and previews
exactly which lines will land *before* anything is written. An item that already
exists is skipped rather than refused, so re-pasting a list to add the two new
things on it does what somebody expects.

The ledger promise is unchanged and better placed: the sentence sits directly
above the movement feed it is making a claim about, instead of pointing at a
column that had taken a third of the width from the list.

Both states are captured in [`docs/supplies-redesign/`](docs/supplies-redesign/)
— before and after at five items and at sixty-seven, plus the detail panel and a
filtered, sorted view. `scripts/seed-supplies-scale.ts` builds that catalogue
and removes it again with `--undo`.

---

### Dates: `MM/DD/YYYY` on screen, ISO underneath

This is an American shop, and `2026-11-06` is not how anybody here reads a date.
Every displayed date goes through one formatter,
[`src/lib/dates.ts`](src/lib/dates.ts) — asset details, inspections, the
calibration certificate and its sticker, the due queue, cert expiry, list
columns, the dashboard, kits and areas. Eleven files had each grown their own
`toISOString().slice(0, 10)`; there is now one, and a verification check fails
the build if a component grows a twelfth.

**Storage and ordering stay ISO.** `'11/06/2026' < '02/02/2027'` is false as
text, so a list sorted on the displayed value puts November after February and
nobody notices until a due date is missed. Formatting is therefore the last
thing that happens, on the way to the screen, and nothing downstream ever sees
the result. Filenames, JSON snapshots, CSV exports and validators keep ISO
deliberately — that is the same decision, not an exception to it.

**The timezone question, answered once.** A date-only value is stored as
midnight UTC of the day it means, so every function reads UTC components.
Reading *local* components west of Greenwich gives the previous day — a due date
printed a day early, which on a calibration sticker outlives the mistake. This
also matches what the eleven hand-rolled helpers already did, so no date changed
its day when they were replaced, only its arrangement.

**Input accepts either order.** `parseUsDate` takes `MM/DD/YYYY` or
`yyyy-mm-dd` and returns ISO, and it checks the calendar rather than the shape:
`02/30/2026` is refused instead of quietly becoming 2 March. The date pickers
stay native `<input type="date">`, which the HTML spec defines as submitting
`yyyy-mm-dd` whatever it displays — and the document is `lang="en-US"` so it
displays `MM/DD/YYYY` on every machine rather than on most of them.

---

### Kits and bags

A container — "George's Red Rigging Bag" — is a named grouping **within** an
area, not a replacement for one. It belongs to exactly one area, shows that area
everywhere it appears, and moving it moves it and its contents together —
`/containers` groups every kit under its area for the same reason. The bag sits on Truck 167; the gear in it is
staged on Truck 167 too. Membership and custody are separate columns answering
separate questions: *which kit is this part of*, and *where is it right now*.

**A bag's name is unique within its holder, not across the org.** Two rooms are
each entitled to keep a bag called "Harnesses". Enforced org-wide, the second
sheet imported bound its rows to the first sheet's bag, and that bag then read
incomplete forever because half its contents were in another building — with
nothing erroring. Two partial unique indexes rather than one composite, because
exactly one holder column is ever set and NULLs do not collide in a plain unique
index, so `(orgId, truckId, locationId, name)` would enforce nothing at all.

**That separation is what makes "incomplete" answerable without a manifest.**
Membership is the expectation — an item assigned to the bag is supposed to be in
the bag — and custody is the presence. An item whose container is this bag but
whose custody is elsewhere is missing from it, and the app names the item and
the reason using columns it already maintains. A hand-kept contents list would
be a second source of truth that goes stale the first time somebody moves a rope
without updating it; this cannot, because the same checkout that takes the rope
is what marks the bag short. It is the truck-readiness rule applied one level
down, deliberately.

An empty kit is **not** complete. A green tick on a bag with nothing in it is
the kind of reassurance nobody should be given.

**Moving a kit reuses the move-kit machinery**, not a copy of it: every unit
goes through the shared `assignCustody`, so each gets a single holder, a
`CustodyEvent`, an alert and an audit row exactly as if it had been scanned
across. One transaction — a half-moved bag is worse than an unmoved one, because
nobody can tell by looking which half went. Unlike the truck flow there is
nothing to tick: a kit is a thing that travels as a unit, and per-item
checkboxes would invite splitting a bag in half. What *cannot* travel — out on
rent, quarantined, retired — is listed in the confirmation **before** committing:
the difference between choosing to leave two ropes behind and discovering you
did.

Kits are org-scoped and can live under a truck or a location, enforced by
`container_has_one_holder` — a bag is on a truck or in a room, never both, and a
bag that is nowhere is a bag nobody can be sent to fetch. The importer honours a
`container` column and creates unnamed kits on commit, at whatever holds their
first row.

---

### Retired: what left the fleet, and why

`OUT_OF_SERVICE` is temporary — the unit is in the shop and coming back, and it
is still capital the business owns. `RETIRED` is permanent, and the two must not
share a list: a report that mixes "being repaired" with "sold last March"
answers neither question.

**A disposition is required.** "Retired" alone is a row that has stopped being
useful. Sold, scrapped and lost are the same status and completely different
facts about how a fleet is being run — one is recovered capital, one is a
write-off, one is worth investigating. A year later, a Retired list with no
reasons on it cannot answer any of the questions it gets opened with. So
retiring is a short form (admin-only, existing guards unchanged) asking what
happened and for a note, and `OTHER` with no note is refused.

**The database refuses a half-retired row.** `asset_retirement_is_complete`
checks that a unit is either RETIRED *and* inactive *and* carrying a date and a
reason, or none of those things. Retire and un-retire are otherwise two
independent writes that can each half-succeed, and the failure mode is a Retired
list showing units nobody can account for beside units that are quietly back in
service.

**Excluded from everything deployable**, which is what `active: false` already
bought — inventory, the dashboard KPIs and composition bar, availability, grab,
checkout, reservations, inspections, maintenance, and scan-to-stage. That is not
taken on trust: `verify:retired` retires a real unit and then walks each of
those surfaces asserting it is gone from all of them, because a retired unit
that survives in *one* query is worse than one that survives in none — it gets
offered for checkout exactly once, to somebody with no reason to doubt the list.

**Utilization measures it up to the day it went.** A unit sold in June was in
the fleet for half the year and earned real rental days in it, so the report
keeps it and closes its window at `retiredAt`. Dropping it would erase days the
fleet genuinely earned; carrying it to December would count gear the business no
longer owns as idle capacity. A unit retired before a year began has a window
that closes before that year opens, contributes nothing, and is filtered out —
no special case needed.

**Un-retire exists for the case it is really for**: the wrong tag was retired,
or a unit written off as lost turned up. Admin-only, offered only from the
Retired list, and it returns the unit to `AVAILABLE` rather than to whatever it
was before — that state is months stale and anything coming back off a shelf
needs looking at. Logged as `asset.unretire` rather than as an edit, because
"this came back from retirement" is a thing somebody will search for.

---

### Utilization: what earned its shelf space

Two questions, one calculation. "What are our workhorses" is asked when quoting
and buying; "what have we been storing for three years" is asked when deciding
what to sell. They are the same ranking read from opposite ends, so
[`utilization.ts`](src/lib/utilization.ts) computes one table and the screen
offers both views. Two reports would be two definitions of the same number, and
they would eventually disagree.

**Grouped by category, ranked within.** A gas monitor at 40% and a light tower
at 40% mean completely different things about how well each is doing its job,
so one flat league table produces a list nobody can act on. Category subtotals
sit on each group header so the other comparison — which category carries the
fleet — is on the same screen.

**Days on rent is the headline; utilization sits beside it, never instead.** A
percentage alone hides its denominator: a unit bought three weeks ago and out
for two of them reads 66%, which is true and says nothing about what it earned.

**It is a *yearly* report, and that framing is what makes it honest.**

A trailing window implied every unit was measurable for the whole of it, and
most of this fleet has no acquisition date because it predates the system it is
recorded in. Reaching for `createdAt` to fill the gap is how a harness bought in
2019 came to read *owned 2.3 days, 0% utilized* — a measurement of when the
**row** was made, inviting exactly the wrong decision: sell the gear that looks
idle.

A calendar year carries no such implication. The report says *utilization in
2026*, so counting an undated unit from 1 January is not a guess about when it
was bought — it is what the period means. The shortest window any unit can have
is "since the first of January", so nothing can read "2.3 days" however sparse
its paperwork. **No per-unit acquisition dates were invented**, and the formula
is untouched; only the window it counts over changed.

The window opens at:

```
max(1 January, inServiceDate ?? purchaseDate)   ← but never later than
min(that, earliest checkout on record)          ← the first evidence it existed
```

- **1 January is the floor.** A unit here before the year, or with no date at
  all, is counted over the whole year. Both mean the same thing to a yearly
  report and the row says so.
- **A mid-year arrival counts from the day it arrived**, so a September purchase
  is measured over four months rather than twelve.
- **Evidence outranks paperwork.** A unit out on rent before its recorded
  in-service date demonstrably existed then. Without this clause the ratio is
  not bounded — the rental counts while the window opens later. That is not
  hypothetical: an earlier version of this report showed **605%**.

`createdAt` is never consulted.

**The year picker is bounded by the records, not a hard-coded list.** Years
before `Organization.settings.trackingBaseline` are not offered, because a year
with no rental history shows every unit at 0% — a statement about the records
rather than about the business. The prior year is computed alongside for the
trend when there is one; with a single year of history the comparison is
correctly absent instead of inventing a collapse.

Three more decisions where the obvious implementation is wrong:

- **Rental time is fractional.** A monitor out for six hours is not zero days.
  Rounding each hire to whole days before summing turns a busy unit doing many
  one-day jobs into a sell candidate.
- **Rentals count checkouts that *started* in the range**, so one long hire is
  one rental rather than being credited to whichever month you are looking at.
  "How often does this go out" is a question about events.
- **Category utilization is Σdays ÷ Σowned, not the mean of the per-unit
  percentages.** Averaging percentages gives every unit an equal vote regardless
  of how long it has been here, which is how one new arrival flatters a dead
  category.

**What it does not know: time out of service.** AssetHub stores a unit's current
status, not a history of it, so a unit that spent three months being repaired
reads as under-utilized. Reconstructing it from the audit log would be a guess
dressed as a measurement. For a sell-or-keep decision that is arguably the right
signal — it was not earning either way — but it is a limitation, and the screen
says so rather than letting somebody find it in a number that looks wrong.

RESCUE gear never appears: it is not rentable, and including it would report
dozens of permanently idle units and make every category average meaningless.
Retired units are gone too — that decision has already been made. CSV export
recomputes from the same function the page renders, so an export cannot be a
differently-shaped copy of what was on screen.

---

### Form CAL-01 — Calibration Report

The gas-monitor counterpart to FP-01, reproducing
[`TekSolv_Calibration_Report.pdf`](TekSolv_Calibration_Report.pdf) and built the
same way — except that a calibration is not an inspection, so it is generated
from the **service record** rather than from a checklist. Logging service with
type *Calibration* opens the CAL-01 fields on the log-service form: time,
temperature, the gases used, and remarks. Arriving from a calibration schedule
selects that type for you, because having to remember to change a dropdown is
how a calibration gets logged as something else and silently never produces its
certificate.

**The gases table is the part that earns its complexity.** Each row is picked
from Supplies, and picking the cylinder does three things at once: it fills in
Gas Type and Concentration from the item, Lot # and Expiration from the *lot*,
and it draws that lot down through the consumable ledger with reason
`CALIBRATION`. That is the whole argument for tracking cal gas by lot — an
expired cylinder reads exactly like a good one on a shelf and produces a
calibration certifying a monitor that has not actually been proven — so the
picker never offers a lapsed lot and the action refuses one again at write time,
in case the form sat open across the date. Every cell then stays editable: the
label on the cylinder is the authority. A row with no cylinder picked is written
in by hand and consumes nothing.

The rest of the form fills itself from the unit: Manufacturer / Model / ID or SN
from the asset, Customer and Rental Order # from the rental it is out on,
Location from its office, Calibration Due Date from where the schedule lands
after the reset, Technician from whoever logged it.

**"ID or SN" is one box because ID and serial are two ways of naming the same
device** — the number stamped on the monitor, or whatever the customer has it
labelled as on their own register. It appears in the details block and again per
gas row, naming the device each gas was applied to, and both are pre-filled from
the unit (`assetIdOrSn`: serial where there is one, asset tag otherwise) and stay
editable, so a technician can write the customer's own label where that is what
the customer will look for. Picking a different cylinder deliberately does *not*
touch it: reaching for another bottle does not change which unit is being
calibrated.

**What is snapshotted, and why.** `MaintenanceRecord.calibration` stores the gas
rows, the due date, the customer, the order number and the location as *copies*
— the one place in this schema where that is the right answer. A certificate
asserts that on a date this unit was calibrated with lot 4417-B expiring
2027-02-28 for a named customer. Read live, a corrected expiry or a
re-intervalled schedule would silently rewrite a document somebody has signed
and filed, and the Customer box would quietly empty itself the week the monitor
came back off rent. The lot ids are kept alongside the copies, so the ledger
rows behind the consumption stay reachable. Everything that cannot go stale —
make, model, serial — is still read live.

The report attaches to the unit's documents as a `CALIBRATION_CERT` pointing at
the printable route, is reachable from the service history on the asset's
Maintenance tab, and is printable and emailable. A **blank** CAL-01 for the
bench comes off the same component (Maintenance → Blank CAL-01), for the same
reason the blank FP-01 does: a static PDF in `public/` would be a second source
of truth nobody remembers to regenerate.

Gas Type and Concentration live on the supply item
(`Consumable.gasType` / `.concentration`, set on the item form once lot tracking
is on) rather than being parsed out of a name somebody is free to rename. Both
are free text — "50 PPM", "2.5% vol" and "20.9%" all appear on real cylinder
labels, and a report that normalized what the label says would be worse than one
that copied it. Leaving them blank costs nothing but retyping.

### Finding a report again

A generated report is worth nothing if it cannot be produced on demand, and all
three ways of reaching one used to be broken in the same way: completing a
report **saved it and navigated somewhere else**. The document existed, nothing
said where it had gone, and there was no list of finished reports anywhere —
which is indistinguishable from the report never having been made.

**Completing one lands on it.** Filing an inspection goes to its FP-01, logging a
calibration goes to its CAL-01, both with Print and Email in the header and a
banner saying it is filed rather than a preview. An inspection whose template has
no printed layout still lands on the record, because there the record *is* the
document. The banner names where it went — the unit's documents and the Reports
list — so the next person does not need the banner.

**Every completed report is an `Attachment` on the unit**, typed `INSPECTION_PDF`
or `CALIBRATION_CERT`, listed on the Documents tab with its date and marked as
something to open and print rather than a file to download. The attachment's URL
is the printable route, not a stored binary, so reopening it re-renders from the
record and cannot go stale against it.

**Reports** (`/reports`) is the central list: both kinds together, newest first,
each row carrying type, unit, form code, date, technician and result, linking to
the same printable form. It is a *view* — `listCompletedReports` reads the
`Inspection` and `MaintenanceRecord` tables that already exist, so a report
cannot be missing from it, because appearing in it is not a step anybody has to
remember. Calibrations deliberately show no PASS badge: CAL-01 states the unit
passes *unless noted in Remarks*, which is a sentence for a human, and computing
a green verdict from the absence of remarks would put a determination on the
record that nobody gave.

### Zebra label printing

Calibration stickers print on a **Zebra GC420t** over USB, from the browser.

A web page cannot reach a USB printer. Zebra's answer is **Browser Print**: a
small utility installed on the workstation that owns the USB connection and
exposes it on localhost with permissive CORS. `src/lib/labels/browser-print.ts`
talks to that local HTTP API directly rather than loading Zebra's
`BrowserPrint.js` — the SDK is a thin callback wrapper over the same four
endpoints, and going direct means no vendored unversioned blob in the bundle, a
promise API instead of nested callbacks, and something a test can stand a stub
server in front of.

**The printer language is a first-class choice, because getting it wrong is
invisible.** A GC420t ships as one of two firmware flavours speaking unrelated
languages, and Windows names the driver after it: "ZDesigner GC420t" is ZPL,
"ZDesigner GC420t (EPL)" is EPL. Send ZPL to an EPL unit and **nothing happens**
— no error, no partial label, no status. Browser Print reports the job as
delivered, the app says "Sent to …", and the printer sits there, because every
layer honestly did its job and the bytes were simply not addressed to anyone.

So `LabelLanguage` is a dimension of the registry, not a build-time decision:
every template renders in both, the choice is remembered per workstation beside
the printer, and the print dialog shows it with the driver-name tell and the
advice that matters — *if a job reports as sent and nothing comes out, try the
other one*. The default is EPL, which is what the bench GC420t here speaks.

The two renderings are not translations of each other. EPL has no scalable font
— five fixed bitmap cells and integer multipliers — so the ZPL layout's 26/30/22
dot heights become 24/48/20, and the EPL calibration sticker puts "CALIBRATED"
and the date on one line where ZPL uses two. Each language gets its own
coordinate block (`CAL`, `EPL_CAL`) for the same reason: a shared table would be
wrong for both and quietly worse for whichever was not measured.

**The label is ZPL or EPL, built in one testable place.** `zpl.ts` holds the primitives
and the escaping; `templates.ts` is a registry keyed by type — today
`calibration`, `asset-tag`, `inspection` and `alignment`, all on the same
2.25" x 1.25" / 203 dpi stock (457 x 254 dots). Adding a label costs a template
and no new plumbing, which is the point: the second and third label is where a
one-off print button usually becomes three divergent ones.

EPL has its own silent failures. Its `b` command is kept to the minimal QR form
(`m` and `s` only) because firmware varies in which optional parameters it
accepts and **discards a command with one it does not recognise** — the same
class of bug as the wrong language. If a test print produces no code, the first
knob to turn is `QR_DATA_PREFIX` in `epl.ts`: some firmware wants the
error-correction level and input mode in the data, ZPL-style. Code 128 on EPL
throws rather than guessing a symbology code, for exactly this reason. EPL also
has no `^CI28` equivalent, so every EPL field is ASCII — a byte goes out through
whatever codepage the printer is set to.

Two things in the ZPL are not obvious and both fail silently if wrong. Every
field is emitted under `^FH` with non-ASCII written as `_xx` per UTF-8 byte,
because `^` and `~` are the format and control prefixes — a model number like
`ALTAIR 4X~R` would otherwise be read as *commands* mid-label. And `^MTT`
selects thermal **transfer**: a GC420t set to direct thermal prints a blank
label, which looks exactly like a failed print. The QR's magnification is
computed from its payload rather than fixed, because the printer picks the
symbol version from how much data it gets and says nothing when the result runs
past the label edge — which is how deploying behind a longer hostname breaks
labels months later.

**Two paths to paper, and the app says which one ran.** Browser Print is the
good path — dot-addressed commands, no dialog, no driver in between. The
fallback is the **OS driver**: the browser lays the label out at 2.25" x 1.25"
in a detached iframe with its own `@page` size, and the operator picks the
ZDesigner queue in the normal print dialog. That needs no local service at all,
so a workstation where Browser Print will not connect still gets a sticker. It
is a third rendering of the same template (`renderHtml`), not a screenshot of
the first, and every template has one — a fallback that covers only some labels
is not a fallback. Which path a job took is on the button (`Sent to … · Browser
Print` / `· Windows driver`), because the two go wrong differently: a misaligned
label from the OS path is a driver page-size problem, the same symptom on the
Browser Print path is the coordinate block.

**Browser Print's own default is deliberately ignored.** On the bench
workstation it keeps reverting to the EPL *driver* entry, and a driver queue
does not pass raw EPL through untouched — it reinterprets the job, so a correct
label arrives as something else or as nothing. So the picker distinguishes the
raw USB endpoint (`connection: "usb"`, the printer itself) from a Windows queue
(`connection: "driver"`) and says which is which; the raw device sorts first and
wins when nothing is remembered; and a **remembered printer is never
substituted** — if it is unplugged the app names it and stops, rather than
quietly printing somewhere else. That last rule is the actual fix: the old code
fell back to the default and every job went through the spooler.

**One label is one page, and the layout is clipped so it cannot become two.**
The OS-driver document sets `@page { size: 2.25in 1.25in; margin: 0 }`, then
fixes the size and sets `overflow: hidden` at every level. That second part is
the one that matters on a roll of die-cut stock: a single element a millimetre
too tall otherwise starts a second page, and a second page *is* the next label.
Clipping a corner is a bad print; running onto the neighbour wastes stock and
hides the cause. `verify:labels` proves it by generating a real PDF through the
print pipeline and asserting one page on 2.25 x 1.25 media — including with an
over-long model name and a long deployed hostname, which is how this fails in
the field.

Everything is laid out inside a **0.06" keep-out band**. A die cut wanders by a
fraction of a millimetre, the stock creeps, and the printer's registration is
not exact either, so artwork at the nominal edge is artwork *at the cut* — which
is how a QR loses its right-hand column and silently stops scanning while every
other field looks fine. Coordinates in the HTML template are measured from
inside that band, and a headless measuring pass in the verify suite asserts no
field escapes it.

**What none of that can fix is the driver.** `@page` is a *request*: if the
Windows queue's stock is set to something else, the browser lays out at
2.25 x 1.25 and the driver prints it on whatever it believes is loaded — which
looks exactly like a layout bug. When a printout is the wrong size despite the
above, set the stock in the queue's printing preferences and choose margins
**None** and scale **100%** in the print dialog. The in-app panel says so, next
to the button.

**Printing asks as little as possible.** The chosen printer lives in
`localStorage`, not on the account: the printer belongs to the *desk*, and the
same supervisor at the counter and on the warehouse laptop wants two different
ones. A workstation with a single Zebra never sees a dialog at all. The button
says "Sent to ‹printer›", never "printed" — Browser Print acknowledges that it
handed the bytes over, not that a label came out.

**Alignment is a physical step nothing here can do for you.** `Test print` sends
a target that draws the label's own boundary and an edge tick on each side: one
print says whether the stock is seated square, whether the origin is where ZPL
thinks it is, and whether anything is clipped. Measure, then adjust the `CAL`
coordinate block at the top of `templates.ts` — hoisted there precisely so that
pass is one edit rather than an archaeology exercise.

**Getting Browser Print is the fiddly part of rollout, not the install.** The
download is gated: Zebra asks for a short request form and, since July 2026, an
MFA sign-in, so it is minutes and a login rather than a file. Its page also
offers two separate things — the **Browser Print application** for the Windows
PC, which owns the USB connection and is what the workstation needs, and the
**Browser Print JavaScript library**, which is a developer artifact. AssetHub
speaks the application's local HTTP service directly and does not load the
library, so there is nothing to add to this app; take it anyway if your IT
standard requires the full package. The in-app message says all of this, because
somebody meets it for the first time on the day their printer will not print.

`verify:labels` stubs Browser Print at the browser's network layer rather than
running a server on port 9100, for two reasons that both bite on a workstation
set up for labelling: a machine running the genuine utility already owns that
port, and interception guarantees the suite can never reach a real printer and
spit four physical labels out of the GC420t every run. It closes with a
**read-only** probe of the real utility — `/available` only, never `/write` — so
where a Zebra is attached the run reports it, which is the one thing a stub
structurally cannot check: that the shape this client expects matches what Zebra
actually returns.

The download URL lives in one constant (`BROWSER_PRINT_DOWNLOAD`) and
`verify:labels` pins the rendered link to it exactly rather than by substring.
Zebra has already moved this page once — the old `/printer-software/by-product/`
path 404s — and a loose assertion would have gone on passing while the link
rotted inside an error message nobody reads until they are already stuck.

**Sticker dates are `MM/DD/YYYY`; everywhere else stays ISO.** The label is the
one place this app writes a date the American way — a sticker is read at arm's
length off a shelf, and 02/02/2027 is the form that reads without thinking.
Reports, forms and the database keep ISO, which is unambiguous on a document
that may be read anywhere. The conversion slices the string rather than parsing
a `Date`: `new Date('2027-01-01')` is midnight *UTC*, and formatting that west
of Greenwich prints 12/31/2026 — a due date a day early, on a sticker that
outlives the mistake.

### The calibration sticker's QR is a public certificate

A calibration sticker goes out on a monitor to a customer site, and the person
who scans it is standing next to the monitor — usually their safety officer, on
a phone, with no TekSolv login. So the sticker's code does **not** point at
`/api/scan/<tag>`: that answers "which unit is this", behind the session guard,
and lands an anonymous scanner on a sign-in page while they are holding a gas
detector. It points at `/c/<token>` — a read-only copy of *that calibration*:
gases, lot numbers, expiry dates, due date, technician.

**The token is the authorization.** There is no session on that route and
therefore no tenant to scope by, so the secret in the URL carries the whole
weight. That is a deliberate trade: a leaked link shows one calibration
certificate to whoever holds it. It is the right trade here because it is the
same certificate that goes out on paper with the unit, and the blast radius is
bounded to one report by construction — no id to increment, no listing, no
navigation, nothing editable, and `noindex` so a crawler cannot publish one.
`verify:labels` proves the boundary in a **fresh browser context with no
session**: the token opens, a wrong token 404s, the record id is not a
substitute, and the internal report still redirects to login.

The token is *stored*, not an HMAC over the record id, for a physical reason:
the URL is printed on the label in text as well as encoded in the QR, so it has
to be short enough to read off a sticker. A signature over a 25-character cuid
is not. Being stored also means one certificate's link can be rotated without
invalidating every other.

**The asset ID label still points at `/api/scan/`.** Two labels, two questions:
which unit is this, and what does its calibration say. A calibration logged
before public reports existed has no token, and its sticker falls back to the
unit lookup rather than to nothing.

**1D scanners.** The default symbology is a QR carrying the full `/api/scan/`
URL, so a phone camera opens the unit with no app. If the handhelds in the field
are 1D lasers — which cannot read a 2D symbol at all — pass
`options={{ symbology: 'code128' }}` to `PrintLabelButton`; that variant encodes
the asset tag alone, which is the durable identifier the scan route resolves
anyway.

### Trucks: labels, scanning, and moving a kit

**A truck label is a third question.** An asset label asks "which unit is
this"; a calibration sticker asks "what does this unit's calibration say"; a
truck label asks *what is on this vehicle*. Its QR encodes
`/api/scan/truck/<id>`, which resolves to the truck's page — the staged kit,
the scan box, and the move action. That route stays behind the session guard,
unlike the calibration certificate: what is loaded on a rescue truck is fleet
information, not something to hand to whoever finds the sticker. It also
resolves by the number painted on the door, so a label reprinted from an older
template still lands.

**Printed from two places, from one definition.** The truck's own page prints
its label; *Settings → Locations & trucks* prints any one of them, or the whole
fleet. Both build their artwork through
[`truckLabelData`](src/lib/labels/truck-labels.ts) — server-side, because the QR
is drawn by the same `qrcode` the on-screen scan card uses and the URL has to
carry the *request* host, or a label printed on a dev machine points a door at
`localhost` for the rest of the vehicle's life. One definition of
`/api/scan/truck/<id>`, because a second spelling in the second place is a
sticker that scans to a 404 nobody notices until somebody is standing at a truck
with a phone. Supervisor+, the same bar as moving the truck's gear.

**A fleet is one job, not one dialog per truck.** Setting up means labelling
every vehicle at once, and ten print dialogs each needing the same paper size
confirmed is how a batch gets half done. `renderTruckSheetHtml` builds one
document with a page per truck for the Windows path; the printer-language path
needs no equivalent, because ZPL and EPL jobs are self-delimiting and
concatenating them *is* the batch. Two rules there are load-bearing and both
fail silently: without a break after each label they overprint, and *with* a
break after the **last** one every run feeds a blank label off the roll. The
batch and a single print run the same renderer, so an alignment check on one
label describes the whole run.

**Truck labels preview before they print.** Off by default elsewhere — a
supervisor printing the same cal sticker forty times a week should not confirm
it forty times — but a fleet is labelled once, where getting the alignment right
the first time is worth one look. The preview is the *same document the Windows
path prints*, in an iframe at true size with a magnifier, because the one thing
a preview must never do is agree with itself while disagreeing with the printer.

**Staging is scanning.** The truck page is one autofocused box: scan, submit,
refocus, scan the next. It takes a bare tag from a 1D gun, a whole URL from a
phone camera, or a typed tag from a scuffed label — sorting out which is
`identifierFromScan`'s job, not the operator's. Re-scanning a unit already
aboard says so rather than erroring, because a scanner that double-fires must
not write a second history row.

**Moving a kit is one transaction, and it starts empty.** Nothing is ticked
when the dialog opens: emptying a truck is a big, quiet change — a dozen units
change hands and two readiness panels move — so the default is that it does
nothing. *Move all* is one click for the common case of swapping vehicles, and
unticking the two that stay is easier than hunting the ten that go. A
confirmation step spells out what moves and what cannot before anything
commits, and every rule is then re-checked server-side, because that screen was
drawn from a snapshot and a unit can be checked out in between.

All of it moves or none of it does. Each unit goes through the *same*
`assignCustody` the single-unit form uses — one holder, a `CustodyEvent`, an
alert, an audit row — because a bulk move that forgot any of those would be a
second, worse implementation of something that already works. The move itself
is logged as one event against the source truck: who, when, from which truck to
which, what moved, **what could not travel and why, and what was deliberately
left behind**. Those last two are kept apart on purpose: a unit that is out of
service is an obstacle, a unit somebody unticked is a choice, and a log that
conflated them would answer neither question later. The unmovable set is
computed from the truck's whole kit rather than from what was ticked — the
screen never offers an ineligible unit, so "it was never ticked" is not a
reason anybody reading the log would accept.

`OUT_ON_RENT` is in the unmovable list as a **race guard**, not a case the
screen normally shows: checkout clears custody
(`asset_rent_clears_custody`), so a rented unit has already left the truck and
never appears in its kit. It can only be hit by a unit checked out between the
confirmation rendering and the move committing. `IN_MAINTENANCE` is
deliberately *not* unmovable — a unit in the shop is coming back, and it should
come back to whichever truck now owns the kit.

**Readiness needs no wiring.** Staged is custody, not a second table, so the
dashboard panel, the truck page and `getTruckReadiness` all read the same
column: staging by scan and moving a kit update both trucks without either
knowing the other exists.

---

### Scanning from anywhere

The gun on this floor is a USB keyboard wedge. To the browser it is not a
scanner at all — it is a keyboard that types the contents of a code very fast
and presses Enter. There is no device, no event, and nothing in the keystrokes
to say a machine sent them.

**So the burst is caught at the window, not in a box.** Without that, scanning
only works if somebody first clicks the search field, and at a counter — device
in one hand, gun in the other — that click is the entire cost of the feature.
[`ScanCapture`](src/components/layout/scan-capture.tsx) lives in the app shell
and listens everywhere.

**Cadence is the only available signal, and it is a clean one.** A wedge emits
characters 5–30 ms apart because it is replaying a buffer; a fast human typist
averages ~120 ms and rarely sustains under 60. So a scan is at least four
characters at a sub-55 ms rhythm, terminated by an Enter arriving in the same
rhythm — see [`scan-burst.ts`](src/lib/scan-burst.ts), kept pure so the
thresholds are testable against real cadences without a browser. The assertion
that matters is not "does a burst fire", it is **"does ordinary typing ever
fire"**: this is a global Enter listener, and a false positive would hijack the
Enter key across the whole app.

**Focus is respected.** A burst is only claimed when it is not going into a
field. The truck's stage box and the palette already know what to do with a
scan; stealing their keystrokes would break the flows this exists to complement.

It listens in the **capture** phase and swallows keys once a burst is in flight,
for a specific reason: our labels encode URLs, a URL is thick with `/`, and `/`
is the shortcut that opens the palette. Uninterrupted, scanning an asset label
would pop the palette open partway through the URL and dump the rest into it.

**What a scan means is decided on the server.** The listener recognises a scan;
it does not know what a label says. [`classifyScan`](src/lib/scan.ts) sorts the
string by shape — `/c/<token>` is a calibration sticker, `/api/scan/truck/<id>`
a truck, `/api/scan/<tag>` a unit, anything else plain text — and
[`/api/scan/resolve`](src/app/api/scan/resolve/route.ts) turns that into a
destination through the org-scoped client, with `inventory.view` checked once
rather than trusted to the page it lands on. A sticker is a physical object:
another tenant's, or one forwarded by a customer, can be waved at any
workstation, so a scan is answered from *this session's* organization or not at
all.

Two deliberate calls in that resolver:

- **A cal sticker opens the internal report, not the public certificate.** The
  QR points at `/c/<token>` because its usual reader is a customer's safety
  officer with no login — but a tech scanning the same sticker at the bench gets
  the real record, with the print action and the unit around it. A token that is
  not ours falls back to the public page it literally points at.
- **A bare string opens a unit only when it names exactly one.** An exact tag,
  or a serial exactly one unit carries. Anything else goes to the palette
  pre-filled, because a scan that silently opens the wrong monitor is worse than
  one that shows a list — and serials are only unique per manufacturer in
  practice, so the count is checked rather than assumed.

A QR that is none of ours — a manufacturer's sticker on the same gas monitor,
which is common — is searched, never followed. Navigating an operator onto the
open web on the strength of a barcode is not a thing this app does.

---

### Importing a loaded truck

A spreadsheet of gear is almost never a list of bare assets. It arrives as
*what is on a vehicle* — a truck number in one column, rope and harnesses and
SCBAs in the rest — and the importer reads it that way.

**A `truck` column stages the unit as it is created.** Not a note saying where
it lives: the same `assignCustody` the scan box and the move dialog call, so
each imported unit gets a real holder, a `CustodyEvent`, and an audit row. An
import is just a very fast pair of hands. Unknown truck numbers *are* an error
— inventing a vehicle from a typo is not recoverable by looking at the screen —
so the preview names the truck each batch lands on and how many go there.

**An `assetType` column (`RENTAL` | `RESCUE`) is a classification, not a
location.** When the sheet does not say, it is inferred from the category:
**SCBA, gas detection and ventilation are rental gear; everything else defaults
to rescue.** That direction is deliberate. Wrong-towards-rescue is visible and
harmless — the unit turns up in the Rescue tab, somebody notices it should be
rentable, and flips it. Wrong-towards-rental is quiet and costly: the unit joins
the utilization denominator and reads as idle capital forever, because rescue
gear is *supposed* to sit on a truck waiting for a callout.

Ventilation is on that list because it was the case that got it wrong.
Canister fans and blowers rent out exactly like meters and SCBAs do, and were
being classified as rescue gear for the wrong reason — they live on a truck,
which is *custody*, not classification. The two are independent on purpose. Rescue
rope and a rental SCBA ride the same truck; what differs is what they mean to a
report. A truck's page is **class-agnostic** — it shows everything staged on
it, because a truck carries what it carries. The filtering happens where the
class actually matters: the Rescue Gear tab lists `RESCUE`, the rental fleet
lists `RENTAL`, and utilization counts rentals only. Without that split, forty
rescue items would read as permanently idle gear and quietly wreck the number
the fleet is judged by. Fleet *value* deliberately stays whole-fleet: a rescue
harness is still an asset on the books.

**Unknown categories are created, not rejected.** A supplier's list always
brings a handful ("Rescue Rope", "Patient Handling"), and making somebody hand-
create fifteen before the file will load is how a good file gets abandoned. The
preview names every category it is about to create, which is the check against
a typo quietly making a sixteenth.

**A `holder` column places non-truck stock.** A truck number stages the unit on
that vehicle; anything else — "Ops Manager Office" — resolves to a **location**,
created on commit if new. Location and custody are not interchangeable: custody
(a person or a truck) means *assigned, staged for deployment*, and a location
means *this is where it lives*. Office and spare stock is held somewhere without
being staged for anything, so giving it custody would put it on the readiness
panel as gear somebody is carrying. Unknown holder locations are created and
named in the preview; unknown *trucks* are still an error, because a truck is a
physical vehicle and inventing one from a typo puts real gear on it.

**A `status` column can bring a unit in already retired or quarantined.**
`RETIRED` lands it in the Retired section with a disposition read out of the
comment — `SOLD`, `LOST`, `DAMAGED_BEYOND_REPAIR`, `SCRAPPED`, or `OTHER` when
the comment says nothing recognisable, with the operator's own words kept
verbatim as the note. Nothing is invented: the `asset_retirement_is_complete`
constraint means a retired row without a disposition would fail the whole batch,
so there is always a fallback rather than a null.

**Quarantined is its own status, not an out-of-service with a reason.** The two
*end* differently, and that is the whole argument: out-of-service ends when
somebody repairs the unit and returns it; quarantine ends when somebody
**decides**, and one of the decisions is "retire it". Sharing a status would put
held gear in the Out of Service list beside a standing *Return to service*
button — a safety hold cleared in one click by somebody who did not know it was
a hold. So `listOutOfService` stays `OUT_OF_SERVICE`-only, and quarantined units
appear in inventory badged violet: held, not hidden. They are excluded from
availability, checkout, reservations and truck moves, and counted in the
dashboard's "off the shelf" — still owned, just not usable.

The cost of a new enum value is every exhaustive map that has to learn it, and
that cost is paid by the type checker rather than by a reviewer: `Record<AssetStatus, …>`
made the compiler list all of them.

**The paperwork columns come along.** `partNumber`, `certExpiry`,
`certification` and `lastInspectionResult` land as custom fields — with org-wide
definitions created alongside them, because a custom field with no definition is
stored but renders nowhere, which is indistinguishable from data loss. `dom` and
`firstUse` are *not* custom fields: they map to the real manufacture-date and
in-service-date columns, where the inspection scheduler can already see them.
`comment` joins the notes.

The whole commit is one transaction, and `npm run verify:truck-import` drives
the real wizard with a 45-row truck file end to end — created, staged,
classified, split across the tabs, and counted on the truck.

---

## On a phone

The app is used at a truck, not only at a desk, and it was not built for that.
The starting state was worse than "cramped": there was **no viewport meta tag
at all**, so a phone rendered the page at a ~980px virtual width and scaled the
result down — every control a third of its real size and the whole app a
pinch-zoom exercise. Underneath that, the shell spent a fixed 230px on the
sidebar. On a 390px screen that is 59% of the viewport, and what remained was
not merely tight: `PageHeader` puts a `min-w-0` title beside `shrink-0` actions,
and a `min-w-0` box beside a `shrink-0` one surrenders **all** its width. The
Inventory `h1` computed to zero. The page had no title, and nothing said so.

This was done in two phases, and the third is deliberately not built.

### Phase 1 — the layout

**The shell splits at `lg`.** Below it the sidebar is not narrowed, it is gone,
and two things take over: a **drawer** holding the same `NavList` the sidebar
renders — shared, so a destination cannot exist in one and not the other — and a
**bottom bar** carrying the three things somebody standing at a truck reaches
for. The split is the point: everything is reachable in the drawer; the bar is a
shortlist, which is why Reports and Settings are not on it and Scan is the
largest thing on it. What the topbar drops on a phone lands somewhere real —
Grab on the bottom bar, Add asset on the page it belongs to, theme and sign-out
in the drawer. Hidden in one place and absent from the other would mean a field
user simply cannot sign out.

**Tables become cards, from one declaration.**
[`DataTable`](src/components/ui/data-table.tsx) takes a column list and renders a
table from `md` up and a card per row below it, where the columns become
labelled fields. A column says what it is on a phone — `title`, `badge`, `note`,
`field`, `hide` — and grouping, row expansion, sortable headers and row actions
are all in the one component. Two hand-written copies of a table are two tables
that drift, and the one nobody is looking at is the one that rots. Nine lists
come from it: inventory, the rentals order board and its per-unit and
reservation boards, supplies, the service due-queue, customers, retired units
and utilization. The three that do not are named below.

**44px is a rule, not a taste**, and it lives in one place: `--spacing-touch`,
which is where `size-touch` and `min-h-touch` come from. It applies below `md`
only — a desktop table would grow to three screens if every inline chip in it
were 44px tall — and it is enforced from the primitives outward, so `Button`,
`Input`, `Select` and the shared `TAB_CHIP` carry it rather than each caller
remembering. Extracting that chip was not tidying: the same class string was
written out in ten files and had already drifted into three idle backgrounds and
two active borders that nobody had chosen.

Two of those fixes were bugs rather than ergonomics. The maintenance header's
three buttons sat in a `flex` that could not wrap, so at 360px the third was
pushed past the right edge and **clipped** — in the DOM, unreachable with a
thumb. And the dashboard's away-unit tags were a comma-separated sentence, which
made the one thing anybody reaches for on the readiness panel ("which unit is
missing?") the smallest target on the page; they are chips now, because inline
text cannot be made bigger without wrecking the line it sits in.

**Overlays fit a phone.** `Modal` is a bottom sheet below `sm` and the centered
dialog above it — the centered form spent 84px of scrim above a panel whose
fields then had 358px, and any dialog with more than four fields opened with its
submit below the fold. `FormActions` inverts a form's action row the same way:
right-aligned on a desktop, primary action full-width and thumb-height on a
phone. The Grab submit — the entire point of that screen — was a 189px button
hugging the right edge of a 390px display.

**What is deliberately left as a table.** The CSV import preview and the
supply-drawer's lot and office tables keep their table shape and scroll inside
their own card. A bulk import is not a one-handed field flow, and four short
columns of lot numbers read better as a table than as four cards. The page
itself never scrolls sideways at any width — that is the line.

**The camera.** The shop's USB gun already works on every screen through
`ScanCapture`, but a gun is a thing you have at a counter. `/scan` reads a label
with the phone's camera and hands the string to `/api/scan/resolve` — the same
org-scoped, permission-checked resolver the gun's keystroke burst uses. A camera
is a new way to read a sticker, not a new way to look things up. Where
`BarcodeDetector` does not exist there is no half-working viewfinder: the panel
says so, and the typed field — always present, because scuffed labels are a fact
of life — becomes the whole interface.

### Phase 2 — installable

A manifest, a service worker, and icons generated by
[`npm run icons`](scripts/make-icons.ts). The supplied logo is a wide wordmark on
transparency, which is the wrong shape and the wrong contrast for a 48px tile;
the icon is built from the distinctive part of the mark — the swoosh — reversed
out of the brand maroon, drawn inside the middle 80% so one file serves both
`any` and `maskable`.

The service worker's scope is stated plainly in
[`public/sw.js`](public/sw.js), because a worker that quietly does more than you
think is how data goes missing. **Reads may be served stale**: a navigation is
tried on the network first and falls back to the last cached copy, so a flaky
yard connection shows the page you had rather than a blank screen. **Writes are
never touched** — anything that is not a GET goes straight to the network.
**Nothing under `/api/` is cached**, because those answers are about where gear
is *right now*, and a cached scan resolution would send somebody to the wrong
truck. In development it caches nothing at all: Next's dev chunks are not
content-hashed, and a worker holding yesterday's chunk is a debugging session
nobody enjoys.

`sw.js`, `manifest.webmanifest` and `/offline` are excluded from the auth
matcher. A service worker fetched through the guard receives a redirect to
`/login` instead of a script and never installs.

The offline banner does two things, and the second matters more. It **says** the
connection is gone — trusting a real request rather than `navigator.onLine`,
which reports the network interface and not whether anything is reachable — and
it **blocks form submits** while it is showing. In this phase a write needs the
network, and a form submitted offline does not fail cleanly, it hangs; a hang at
a truck reads as "it went through". Blocking the submit and saying why is the
honest version of the same answer.

### Phase 3 — not built

Queued offline writes are out of scope until there is a proven field need, and
the reason is in the invariants rather than the effort. A queued check-in has to
be reconciled against custody and rental state that moved while the device was
dark — the unit may have been checked in by somebody else, retired, or sent out
on another order. Accepting one now and reconciling later would mean an operator
walks away believing a unit is booked out when it is not, which is worse than
being told to reconnect. The offline page says so in as many words.

### What is measured

`npm run verify:mobile` walks twelve screens at **360, 390 and 430px** and
asserts no page scrolls sideways, every page still has a visible title, and
every control clears 44px — then walks grab, check-out, stage-to-truck and
inspections with a touch viewport, because a page can pass every measurement and
still be unusable. Its search terms and truck route come from the database, not
from constants: a hardcoded `TS-` prefix passed for the wrong reason, since that
is the placeholder text and not this shop's tag format.

`npm run verify:pwa` checks the manifest, both icon sizes, the maskable purpose,
the viewport meta, and that the worker registers *and becomes active*. The
offline half cuts the connection with CDP rather than faking `navigator.onLine`
— a banner driven by a property the test sets is a banner that tests itself —
and the write-blocking check carries a control: the same probe must go through
once back online, or it proves nothing.

`npm run verify:polish` now runs its clipping and overflow audit at **four**
widths rather than two. The failures it looks for are width failures, and they
are far more likely at 390px than at 1440px.

`npm run audit:touch` is the working tool rather than a suite: it lists every
control under 44px, grouped and ranked, so a fix has something to aim at. It
skips two things on purpose — links inside a running sentence, which are prose
that happens to be clickable, and a checkbox wrapped in a label at least 44px
tall, since tapping the label is what toggles it and a 44px checkbox looks like
a rendering bug.

---

## Multi-tenancy

Every tenant-scoped table carries `orgId`. `getDb()` returns a Prisma client
bound to the caller's organization — there is no way to get a client without
one, so "forgot to scope this query" is not a failure mode the app can have.
See [`src/lib/tenant-db.ts`](src/lib/tenant-db.ts) for what scoping does and
does not cover; the two gaps (nested writes, raw SQL) both fail loudly at the
database rather than leaking.

Users are global — one login, one email — and a `Membership` row carries the
role *within* an organization. `prisma/rls/enable-rls.sql` adds Postgres RLS as
an independent second layer when the second tenant arrives.

Roles are a static matrix in [`src/lib/rbac.ts`](src/lib/rbac.ts), with one
seam: the permissions listed in `ORG_CONFIGURABLE` can be re-pointed per tenant
from Settings (today, just "who can reserve ahead"). `can()` stays a pure
function — it takes the overrides as an argument rather than looking them up —
which is what keeps it safe to call from client components. The server guards
in [`src/lib/guard.ts`](src/lib/guard.ts) read the overrides off the session and
pass them in, so every existing action became tenant-aware without being
edited. `rbac.ts` must never import a *value* from the session, database, or
auth modules; doing so drags the Prisma client into the browser bundle.

---

## Commands

The verification suites run against the **live development database** and clean
up after themselves. That makes one rule non-negotiable: **a fixture must never
share a name with real data.** The importer resolves a holder by name, so a
fixture called "Ops Manager Office" imports its rows into the actual office —
and the teardown then deletes it. Two suites did exactly that and took the
Rescue Prop's four bags with them; both now name their places
`… (verification)` and scope every delete to their own holder, and a teardown
only removes a place once nothing is left at it. The bags came back from
`RescueProp_inventory_import.csv` via `scripts/restore-prop-bags.ts`, which
reads the container column and touches nothing but `containerId`.

| Command | Does |
|---|---|
| `npm run dev` | Dev server (runs `preflight` first) |
| `npm run preflight` | Check env, database, schema, and seed data |
| `npm run auth:secret` | Create `.env` if missing and generate `AUTH_SECRET` |
| `npm run build` | Production build (runs `prisma generate` first) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run verify` | Run every check below against the live database |
| `npm run verify:invariants` | Prove the three hard rules are DB-enforced |
| `npm run verify:inventory` | Asset validation, filters, custom fields, usage estimates |
| `npm run verify:import` | CSV header mapping, row validation, a committed batch |
| `npm run verify:rentals` | Checkout, check-in, custody, board ordering, readiness |
| `npm run verify:grab` | Field grab, stock decrement, alerts, window availability |
| `npm run verify:reservations` | Booking a window, pickup, cancel, no-shows, per-org permissions |
| `npm run verify:maintenance` | Schedule arithmetic, the two resets, tickets, the alert sweeps |
| `npm run verify:inspections` | Answer semantics, the critical-fail chain, template safety |
| `npm run verify:dashboard` | KPI definitions, search scoping, audit filters, admin guards |
| `npm run verify:lead-time` | Lead windows, the calendar reset, and alert escalation |
| `npm run verify:custody` | Assign, unassign, reassign, and who gets alerted |
| `npm run verify:assigned` | Derived "Assigned" status and the free-to-take pool |
| `npm run verify:asset-dates` | Purchase / manufacture / in-service kept separate, NetSuite immunity, FP-01 |
| `npm run verify:fp01` | Form FP-01 end to end. Needs `npm run dev` |
| `npm run verify:cal01` | Form CAL-01 end to end — gas consumption, snapshot, attachment. Needs `npm run dev` |
| `npm run verify:reports` | Complete → find → print, both report types. Needs `npm run dev` |
| `npm run verify:cmdk` | ⌘K survives keystrokes with no `key`, and still works. Needs `npm run dev` |
| `npm run verify:search-status` | Search and the drawer agree on a unit's status across four states. Needs `npm run dev` |
| `npm run verify:scan` | Wedge-scanner burst detection, and each label family routed. Needs `npm run dev` |
| `npm run verify:truck-labels` | Truck label artwork, the batch sheet, both print surfaces, and a real scan. Needs `npm run dev` |
| `npm run verify:trucks` | Truck labels, staging by scan, moving a kit between trucks. Needs `npm run dev` |
| `npm run verify:holders` | Non-truck holders as custody, the extended invariant, and both real sheets. Needs `npm run dev` |
| `npm run verify:containers` | Kits: completeness derived from custody, and moving one whole. Needs `npm run dev` |
| `npm run verify:rental-orders` | Four units on one order, each with its own custody and reservation window; partial return leaves the order open; the last return closes it. Needs `npm run dev` |
| `npm run verify:checkin-outcomes` | Four units resolved four ways: two back, one damaged to OOS with a ticket, one lost to retired-and-billable, and the order closing on resolution. Needs `npm run dev` |
| `npm run verify:rental-board` | The board grouped by order: one row per order, units underneath, order-level overdue, and a due-date sort that is chronological rather than alphabetical. Needs `npm run dev` |
| `npm run verify:status-filter` | Every filter option returns exactly what its badge says, Available excludes assigned units, and no file outside the helper spells the derived rule out by hand |
| `npm run verify:taxonomy` | Fall Protection really contains its children, Harnesses holds only harnesses, Confined Space holds the entry gear, and the report groups by the corrected tree. Needs `npm run dev` |
| `npm run verify:gas-blends` | A 4-gas blend through the form, onto the item, and into CAL-01 with every unit intact — and a single-gas item still being one row. Needs `npm run dev` |
| `npm run verify:supplies-view` | Supplies at sixty-five items: search, filters, sorting, category grouping, the detail panel and a pasted bulk add. Needs `npm run dev` |
| `npm run verify:mobile` | Twelve screens at 360/390/430px: nothing scrolls sideways, every page keeps its title, every control clears 44px — then grab, check-out, stage-to-truck and inspections walked with a touch viewport. Needs `npm run dev` |
| `npm run verify:pwa` | Manifest, both icon sizes and a maskable purpose, viewport meta, a service worker that becomes active, and an offline banner that blocks writes — proved by cutting the connection, with a back-online control. Needs `npm run dev` |
| `npm run audit:touch` | Lists every control under 44px, grouped and ranked. A working tool, not a suite. Needs `npm run dev` |
| `npm run icons` | Regenerates the home-screen icons from the brand swoosh |
| `npm run verify:home-office` | An admin sets anyone's, a person sets their own, nobody sets somebody else's, and the grab form defaults to it — or asks when unset. Needs `npm run dev` |
| `npm run verify:site-deletion` | Sites delete only when nothing real is attached; held gear, kits and custody history each refuse with a reason. Needs `npm run dev` |
| `npm run verify:assign-area` | The picker offers every area and their kits, from the same source as the area pages; picking one moves the unit. Needs `npm run dev` |
| `npm run verify:rescue-areas` | Rescue areas are not offices: the type moved, the contents did not, and settings no longer lists them. Needs `npm run dev` |
| `npm run verify:dates` | US dates on screen, ISO in storage and in every sort, and a typed date round-tripping without shifting a day. Needs `npm run dev` |
| `npm run verify:areas` | Areas: the index, a room and a truck through the same component, kits nested under areas, and every item resolving to one. Needs `npm run dev` |
| `npm run verify:import-office` | Non-truck holders, retire-on-import, quarantine. Needs `npm run dev` |
| `npm run verify:truck-import` | A 45-row loaded-truck CSV: staged on import, rental vs rescue, the loadout. Needs `npm run dev` |
| `npm run verify:labels` | ZPL output, printer discovery, and the remembered choice, against a stub Browser Print. Needs `npm run dev` |
| `npm run verify:inspection-schedule` | Frequency, next-due, and the schedule an inspection arms. Needs `npm run dev` |
| `npm run verify:utilization` | Range arithmetic, category weighting, RESCUE exclusion, CSV. Needs `npm run dev` |
| `npm run verify:retired` | Retirement with a disposition, the exclusion sweep, and un-retire. Needs `npm run dev` |
| `npm run verify:oos` | Out of service: damaged check-in, failed inspection, and both resolve paths. Needs `npm run dev` |
| `npm run verify:manual-oos` | Taking a unit out by hand and bringing it back, from the unit. Needs `npm run dev` |
| `npm run verify:rts` | Returning to service resets the condition — no unit is rentable while reading Damaged. Needs `npm run dev` |
| `npm run verify:supplies` | Per-office stock, lots, FEFO, expiry alerts, and who can do what. Needs `npm run dev` |
| `npm run verify:browser` | Real Chromium: sign in, grab, reserve, service, inspect, ⌘K. Needs `npm run dev` |
| `npm run db:up` / `db:down` | Start / stop the dev Postgres container |
| `npm run db:nuke` | Stop it and delete the data volume — full reset |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:deploy` | Apply pending migrations (CI / production) |
| `npm run db:seed` | Seed the TekSolv fleet |
| `npm run db:forms` | Install/refresh the built-in printed forms (FP-01) |
| `npm run db:studio` | Prisma Studio |
| `npm run netsuite:sync [org-slug]` | Manual NetSuite pull |
| `npm run verify:netsuite-write` | Write-back guards, dry run, idempotency. Sends nothing — `fetch` is trapped |

---

## Build phases

Per `docs/BUILD_SPEC.md` §9. Each phase ships runnable.

- [x] **1 — Foundation.** Prisma schema + migrations + GIST constraint + seed;
  NextAuth with the four roles; multi-tenant scaffolding; the `(app)` shell
  with role-gated nav.
- [x] **2 — Inventory.** Asset table with URL-backed search and filters,
  create/edit with custom fields, the five-tab detail drawer, QR labels that
  resolve through `/api/scan/<tag>`, and CSV import with a preview step.
- [x] **3 — Rentals + custody.** Checkout capturing the NetSuite order #,
  check-in that routes damaged returns out of service, the open/overdue board,
  customer history, custody assignment to people and trucks (supervisor+), and
  the truck-readiness panel.
- [x] **4 — Self-service grab + alerts + consumables.** Field self-checkout that
  *is* the checkout, consumable decrement with a ledger, the manager alert feed,
  and a digest job seamed for an email provider.
- [x] **4b — Advance reservations** (`docs/BUILD_SPEC.md` §6.6). Reserve ahead
  with a future window, convert to pickup, cancel; window-aware pickers that
  say "reserved &lt;dates&gt;" before the database has to; no-show flagging in the
  digest cron; and the first per-organization permission. Shipped as the
  required two-part migration — the enum value has to be committed before the
  constraint predicate can name it.
- [x] **5 — Maintenance.** Calendar and usage schedules, the due/overdue queue,
  service records with the "log service" reset, manual reading adjustment,
  tickets that can pull a unit off the shelf, and the digest cron that marks
  rentals overdue and alerts on due service — once each, not every run.
- [x] **6 — Inspections.** Template builder, the runner (per-item response,
  note, photo, inspector signature, optional witness and GPS), the critical-fail
  chain, and PDF export.
- [x] **7 — Dashboard + cross-cutting.** Exec/ops KPIs with one definition
  each, ⌘K global search, the append-only audit viewer, and the admin screens:
  categories &amp; custom fields, locations &amp; trucks, users &amp; roles.
- [ ] **8 — NetSuite.** Confirm the env ids, first production pull, schedule.

Routes for unbuilt phases exist, are role-gated, and say which phase fills them
in — so nobody has to guess whether a screen is broken or pending.

---

## NetSuite

The pull is read-only (SELECT-only SuiteQL, view-only integration role). The
bridge lives in [`src/lib/netsuite/`](src/lib/netsuite/) and no-ops entirely
until credentials are supplied. Credentials resolve per organization from
`NetsuiteConfig`, falling back to the `NETSUITE_*` env vars for the org named by
`NETSUITE_ORG_SLUG` (TekSolv).

Two ids still need confirming in the NetSuite UI before the first pull — see
`docs/BUILD_SPEC.md` §7 and §10.

### Write-back: one path, one direction, opt-in

There is now **one** exception to read-only, and its scope is the point. When a
rental starts or ends, AssetHub updates a single custom field on the matching
FAM asset. Nothing else is written, and the read sync keeps treating NetSuite as
truth for everything else.

**Why the asset record and not the sales order.** The obvious alternative is to
update the SO line the rental came from, and it is the wrong first choice: a
sales order is a financial document somebody is invoicing against, and a write
there can move revenue. The FAM asset record is a description of a physical
unit — the same record the read sync already mirrors and already holds a
`NetsuiteRef` for — so the blast radius of a bad write is one custom field on
one asset, and the fix is to write the previous value back. That previous value
is recorded on every attempt for exactly that reason.

**Field ownership is a rule, not a comment.**
[`field-ownership.ts`](src/lib/netsuite/field-ownership.ts) holds two lists, and
the split is the whole subtlety. What AssetHub owns is an abstract **role** —
"is this unit out on a rental" — because the NetSuite field id is per-account
and a guessed `custrecord_…` in source would either be rejected or, far worse,
land on a real field meaning something else. What NetSuite owns is a set of
**real field ids**, checked against whatever id gets configured. Both halves are
enforced on every write: a correct role aimed at the wrong field is still
refused.

The important entry on that list is `assetstatus`. NetSuite's FAM record already
has one and it drives depreciation and disposal; the fact AssetHub tracks is a
different fact about the same unit. Pointed at the same id, a checkout would
silently move an asset through the ledger's own lifecycle. AssetHub also refuses
any id that is not `custrecord…`, which excludes the entire native namespace in
one check rather than by a list that could never be exhaustive.

**No creates, by construction.** Every request is a `PATCH` against an id
resolved from `NetsuiteRef`. There is no create anywhere in the path: a unit
NetSuite has never heard of is a gap in the *read* sync, and inventing an asset
over there to close it would be the worst possible response — so it is refused
and recorded.

**Idempotent, and retryable.** One key per logical transition
(`rental:<rentalId>:<assetId>:start|end`), keyed on the local event rather than
the payload, so a double-submit is the same write. A prior success
short-circuits; a **partial** unique index — unique on the key *where status =
SENT* — is the database-level backstop. Partial on purpose: a plain unique index
would have made a failed attempt un-retryable and let a dry run consume the slot
the real send needs.

**Sandbox until proven, in two switches.** `writeMode` is `DISABLED` → `DRY_RUN`
→ `SEND`, and a non-sandbox account id is refused at `SEND` unless
`allowProductionWrites` is separately true. Two switches rather than one enum
value, because turning writes on and turning them on *against the real ledger*
are different decisions made by different people at different times — one
control for both means the day somebody enables SEND for a sandbox they have
also armed production for whenever credentials are swapped.

**Dry run is a rehearsal, not a description.** It builds the payload with the
same code that would send it and records it in the same table, with no response
— which is what makes it a rehearsal rather than a second implementation that
agrees with the real one until the day it does not. *Settings → NetSuite
write-back* runs it against today's open rentals so a payload is proven against
real data before any mode moves.

**Everything is on the record.** `NetsuiteWrite` holds every attempt — planned,
sent, refused, failed, duplicate — with the request, the response, who triggered
it, and the field's prior value. A bad write is only reversible if you can see
it happened and what it replaced.

**It cannot take a counter down.** The write runs *after* the rental transaction
commits and every failure inside it is caught. An accounting system being
unreachable is not a reason a customer cannot be handed a gas monitor, and an
operator should never be shown a NetSuite error for an operation that already
succeeded locally.
