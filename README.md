# HouseGov (govtracker v2) prototype

Simmons Hall's house government site: proposals, meetings with a live slideshow, elections and full-forum votes, and version-controlled policy documents. See [spec.md](spec.md) for the product spec.

## Running it

```sh
docker compose up --build        # app on http://localhost:3000, Postgres on :5432
```

For development with hot reload:

```sh
docker compose up -d db          # just Postgres
npm install
npm run dev                      # http://localhost:3000 (stop the app container or set PORT), uses database housegov_dev and ./data
npm run dev:client               # (optional, second terminal) rebuild browser bundles on change
npm run typecheck
```

The first boot seeds demo data: two policy docs, proposals, a scheduled meeting, a secret referendum, a ranked-choice election and an org chart.

You're signed in as **perryh with every permission**. Use **/dev** to switch user or permissions (e.g. try a resident with only `govtracker.propose` + `govtracker.vote`) and **/dev/outbox** to read the emails the app would have sent. To try the live view on your phone, set `BASE_URL=http://<your-LAN-IP>:3000` so the slide QR code points there.

| Env var | Default | |
|---|---|---|
| `DATABASE_URL` | `postgres://housegov:housegov@localhost:5432/housegov_dev` | compose sets the container's |
| `DATA_DIR` | `./data` (`/data` volume in Docker) | GovDocs git repositories |
| `BASE_URL` | `http://localhost:3000` | public URL, used in emails and QR codes. **Its path is the sub-path the app is served under** (e.g. `https://example.org/housegov`) |
| `BASE_PATH` | path of `BASE_URL` | override the sub-path explicitly |
| `DEV_AUTH` | `1` | `0` disables the dev login and /dev |
| `SMTP_URL` | unset → outbox table | e.g. `smtp://user:pass@host:587` |
| `DISCORD_WEBHOOK_URL` | unset | forum-channel webhook; each proposal/poll gets a thread |
| `SUMMARY_WORD_LIMIT` | `150` | unofficial summary limit |

## Deploying (e.g. a dev server behind nginx)

```sh
git clone <repo> housegov && cd housegov
cp .env.example .env        # set BASE_URL, SESSION_SECRET
docker compose up -d --build
```

Re-run `docker compose up -d --build` to update. Data lives in the `pgdata` and `govdocs` volumes (back them up). Both containers bind to 127.0.0.1 only; nginx is the public entry.

The app can run under a sub-path. Set `BASE_URL=https://example.org/housegov` and pass the path through **without stripping it**. That means no trailing slash or URI on `proxy_pass`. The `Upgrade` headers are needed for live slides and votes:

```nginx
location /housegov/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
location = /housegov { return 301 /housegov/; }
```

Under a sub-path the session cookie is named `housegov.sid` and scoped to that path, so it doesn't collide with other apps on the domain. It's marked `Secure` when `BASE_URL` is https. While `DEV_AUTH=1`, anyone who can reach the site can sign in as anyone. Keep it behind basic auth or a VPN until the membrane login is wired in.

For developers: templates write links as `<%= base %>/…`, browser code uses `hg.url()` / `hg.postJSON()`, and server code uses `res.redirect("/…")` (prefixed automatically) or `config.basePath` / `config.baseUrl`.

## Stack

- **Node 24 + Express 5 + TypeScript** (server in `src/`, compiled with `tsc`; browser code in `client/`, bundled with esbuild)
- **Postgres 17**: generated `tsvector` columns + GIN indexes for proposal and minutes search
- **EJS** server-rendered pages + **Bootstrap 5**, IBM Plex Sans (site chrome) / Plex Serif (proposal, election and slide content)
- **Socket.IO** for realtime (slides, ad hoc votes, minutes, live results)
- **Toast UI Editor** (markdown + WYSIWYG), **reveal.js** (slides), **Chart.js** (results), **diff2html** (diffs), **d3-org-chart** (org chart), **git** (GovDocs)

```
src/
  auth/            User + GOVPERMS enum, dev connector, requirePerm()   ← swap for membrane/OIDC
  services/        domain logic (no Express): proposals, meetings, polls,
                   ballots (secret ballot scheme), tally (IRV etc.), govdocs (git)
  routes/          thin HTTP layer per area
  realtime.ts      Socket.IO rooms; clients only listen, every change goes through HTTP
  db.ts            pg pool, transactions via AsyncLocalStorage
db/schema.sql      idempotent schema, applied on boot
views/             EJS templates
client/            browser TypeScript (bundled to public/build/)
```

## How the main pieces work

**Auth.** Everything goes through `req.user.hasPermission(GOVPERMS.X)` (or `requirePerm(...)`). `src/auth/index.ts → resolveUser()` is the single place to plug in the OIDC session and membrane permission lookup. Public pages (proposal list, docs, results, slides, live view) work signed out.

**Proposals.** The v1 form and procedure wording are kept. Funding requests and govdoc amendments are *attachments*; funding optionally names an existing account number to add to (blank = create a new account), which can be corrected later from the edit page (logged). The notification email links to the full text instead of inlining it. The chair can dismiss (kept and logged) or permanently delete (type the number to confirm). The original text is kept; amendments made at a meeting edit `final_text` and are logged.

**Meetings.** Scheduling a meeting sets a proposal cutoff. The home page shows a countdown with a progress bar, and the submit form says which meeting a proposal will reach. The agenda is an ordered mix of proposals and markdown content blocks (drag to reorder). One `buildSlides()` feeds three views:

- `/meetings/:id/slides`: projector (reveal.js) with a QR code, follows the console
- `/meetings/:id/console`: presenter: next/prev, decisions, amend text, ad hoc votes, autosaving minutes
- `/meetings/:id/live`: phone view of the current slide plus a Yay/Nay clicker. The projector shows a QR code and a short typeable link, **`/live`**, which redirects to whichever meeting is live (or the next one).

Opening the console or projector doesn't start a meeting. Until the presenter presses **Start meeting**, every screen sits on the title slide, the console can click through slides locally as a rehearsal, and votes can't be called. "Not started" in the console undoes an accidental start.

There is no Abstain option: not voting is abstaining. Voting needs `govtracker.vote`, i.e. SSO login. On a proposal slide the console can call a clicker vote on that proposal or record a hand count. The counts are saved on the proposal and checked against its requirement (2/3 for constitutional amendments, a strict majority otherwise) so the chair sees whether it passes before recording a decision. All votes are appended to the minutes. Adjourning returns tabled and unreached proposals to the open pool, as in v1.

**Polls.** A form builder with multiple choice, multi-select, vote (pick one or ranked-choice IRV, optional write-in, expandable candidate statements) and free response. Each question can have a threshold. For single-choice and vote questions it means "the leading option must reach X% to carry" (judged on the leader only; a tie carries nothing). For multi-select it applies to each option. There's no Abstain option; a question that isn't required can be left blank, and radio questions have a "Clear selection" button. Results can be live and update in realtime. The public ledger lists every ballot by vote ID; the chair can exclude ballots, and exclusions are visible to everyone. Free-response answers are left out of the ledger and are visible only to poll admins (`govtracker.manage`) on the results page, since writing style can identify a voter. Everyone else sees the response count. A govdoc amendment is attached to one multiple-choice question, together with the option that adopts it ("Applied if **Yes** wins"). At close it is applied if that option leads and meets the question's threshold, or gets more than half the answers if none is set, and rejected otherwise (`tally.amendmentOutcome`, shared by the ballot, results page and close logic). A poll can decide several amendments, one per question. An amendment can't sit on two questions (builder, server validation and a unique index all stop it). Two amendments to the same document are applied in question order, so the second may need conflict resolution.

**Org chart.** Edited as indented text (`Role: user1, user2`) and drawn with d3-org-chart: pan/zoom, collapsible branches, rotate, and click a role for contact details. "Stack" (on by default, remembered per browser) puts roles that have no children of their own into a two-column grid under their parent, so a wide level becomes taller instead of wider. A text version sits below it for screen readers.

**Icons.** Buttons use Bootstrap Icons through the `icon('name')` template helper. Toolbar buttons put their text in `.hg-label`: on screens narrower than 768px the text is visually hidden (still read by screen readers), and buttons also carry `aria-label`/`title`. The main nav turns into an icon tab row under the brand instead of a burger menu. Primary form buttons always keep their text.

**GovDocs.** Each document is its own git repo (`DATA_DIR/govdocs/<slug>`). "Propose an amendment" makes a draft that records its base commit. The editor autosaves and shows a live diff. Attaching the draft to a proposal locks it and freezes its `.patch`. Approval rebases it onto the current HEAD with a 3-way merge and commits it under the author's name. Conflicts (the document changed on or next to the same lines since the draft was started) are flagged with `<<<<<<<` markers for a docs manager to resolve in the same editor; the amendment can't be applied until the markers are gone, and then only via "Apply approved amendment". An amendment belongs to one proposal or poll question at a time; the only handoff is from a proposal MOVED TO FULL FORUM to the poll question that decides it (enforced in `services/amendments.ts` and by unique indexes). Manual apply only works for amendments the House already passed. History and per-commit diffs are browsable. `/docs/:slug/embed` (iframe) and `/docs/:slug/raw.md` export the current version.

## Secret ballot threat model

As specified: the ballot row stores only `vote_id` + answers. `poll_voters` records *that* you voted, with no link to the ballot. `ballot_keys` holds `SHA-256(vote_id:code)`. The voter is emailed both values. The code is 128 random bits, so the public vote ID can't be brute-forced into it.

What this does protect against: anyone reading the database (or a backup) can't tell who cast which ballot, and nobody can change someone else's vote without their code.

What it doesn't:
- **The server sees who is voting and what they vote in the same request.** We never log or store that pairing, but a malicious operator could modify the code to do so. This is "trust the server" secrecy, not end-to-end cryptographic secrecy.
- **Email.** The confirmation email pairs your address with your vote ID, so whoever can read mail logs can link them. (In dev, the outbox table does exactly this.)
- **Withdrawing** removes your `poll_voters` row so you can vote again; at that moment the server again sees both identities.
- The unlocked state lives only in the browser tab. Storing the vote ID in the server session would link it to the user at rest.

## Next milestone

- **Collaborative editing with ShareDB.** Today Socket.IO broadcasts with last-write-wins: minutes avoid overwriting someone mid-typing, but two people typing at once can lose edits. Planned scope:
  - **Meeting minutes** (first): several secretaries/presenters type into the same minutes at once, with cursors. Decision/vote lines the console appends become ops instead of whole-text saves.
  - **Proposal text** (`summary` / `final_text` on the edit page and from the console during a meeting), so the chair and the author can amend wording live. The original text stays frozen and every saved revision is still logged.
  - **Amendment drafts** (maybe): co-authoring a draft before it's locked. The git commit on apply stays the source of truth.
  - Approach: `sharedb` + `sharedb-postgres` on the existing Postgres, plain-text OT (`ot-text-unicode`) bound to the minutes textarea and the Toast UI editor, sharing the HTTP server and session auth. Permission checks run in ShareDB middleware (same rules as today's POST routes). A doc snapshot is written back to the existing columns on a debounce, so the rest of the app (slides, emails, history) doesn't change.
- **Import of old govtracker data** and a deployment target (later).

## Not done yet / known gaps

- **PDF export** of docs (embed/raw exist; PDF would need headless Chromium in the image).
- CSRF tokens (SameSite=Lax cookies cover most of it), rate limiting, automated test suite, migration tool (schema is applied idempotently on boot).
- Edits to an attached amendment by a docs manager don't create an audit trail yet.
- git's 3-way merge treats edits on *adjacent* lines as conflicts. That's conservative for legal text, but manual resolution will come up more often than you might expect.
