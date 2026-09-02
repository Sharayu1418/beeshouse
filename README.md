# The Bee's House — Phase 1

Cabo, played one move at a time, with the turn travelling through WhatsApp.

Nobody has to be online at the same time. You get a link in the group, you
open it, you play in eleven seconds, you close it.

---

## Run it locally

```bash
npm install
npm run dev          # http://localhost:3000, in-memory, wiped on restart
```

With a real database:

```bash
DATABASE_URL="postgresql://..." npm run dev
```

## Run the tests

```bash
npm test
```

That runs four suites, and the second one is the one that matters:

| Suite | What it proves |
|---|---|
| `engine.fuzz.js` | 4,000 randomised full matches. No crashes, no stalls, no duplicate or out-of-range cards, and the Tab settlement arithmetic is exact. |
| `redact.test.js` | Builds every seat's view at every state of hundreds of matches — ~365,000 views — and asserts no card value the seat hasn't earned appears in any of them. Also asserts a reveal never survives into `GET /api/state`. |
| `db.test.js` | Runs one identical suite against both storage backends, so memory and Postgres can't drift. Covers seat-stealing and stale-write rejection. |
| `service.test.js` | Rooms, tokens, turn enforcement, optimistic concurrency and a whole five-player match end to end. |

Browser test (five simulated phones against a live server):

```bash
npm run dev &            # in one shell
npm run test:browser     # in another
```

**The leak test is verified to actually fail.** Deliberately exposing your own
hand, an opponent's hand, or the draw pile each makes it fail loudly with the
offending path and value. A security test that can't fail is decoration.

---

## Deploying

1. **Supabase** — create a project, open the SQL editor, paste `schema.sql`, run it once.
2. Copy the connection string from Project Settings → Database → Connection string → URI. Use the pooled *Transaction* string; serverless functions open a lot of short connections.
3. **Vercel** — import the repo, set `DATABASE_URL` as an environment variable, deploy.

Both free tiers are more than enough for five people. The one thing to know:
**Supabase pauses a project after a week of inactivity.** Given the founding
premise of this group is that you never manage to play, that will happen. Add a
weekly cron that pings `/api/room?code=XXXX` to keep it warm, or accept a slow
first load after a quiet week.

---

## How it's put together

```
lib/engine.js    the game rules. Pure — no DOM, no network, no clock.
                 The identical file runs in the browser and on the server.
lib/redact.js    the security boundary. Full state in, one seat's view out.
lib/db.js        storage. memory | postgres behind one interface.
lib/service.js   rooms, seats, turns, the briefing, the nudge.
api/*.js         thin HTTP wrappers around service.js.
public/          the client. A renderer and nothing else.
server.js        local dev server using the same handlers Vercel will.
```

### The client holds nothing

It has no cards, runs no rules and decides nothing. Every action is a round
trip and the server's answer is the only truth. That is why cheating is
structurally impossible here rather than merely discouraged — and it's why
there's no optimistic UI. For a game played across two days, a round trip
costs nothing.

### What actually crosses the wire

Your own hand arrives as **ids and slots with no values.** So does everybody
else's. The only value in a normal response is the top of the discard pile,
which is face up on the table anyway.

A card you've *earned* sight of comes back exactly once, in a separate
`reveal` envelope on the response to the move that earned it. `GET /api/state`
never carries a reveal — which means **refreshing the page cannot re-show you
a card.** The memory rule survives going online for free.

Listen never ships a card at all: the client sends a question *index*, and the
server computes yes or no.

*Honest caveat:* a revealed value does exist in that one response, so it sits
in the network log of anyone who goes looking. Making that harder isn't worth
it — anyone scrolling XHR responses to beat their friends at Cabo has already
lost in a more important way.

### Identity

No accounts, no passwords, no email. You claim a seat once and a token is
minted into that browser's `localStorage`.

The nudge link is **just the room** — `/g/AB12`, identical for everyone. No
token ever travels in a shared link, so no one else's phone can ever hold
yours. Lost the seat (cleared browser, new phone)? Re-claim it; the seat has
to be freed first, which stops anyone walking into someone else's chair.

### The WhatsApp handoff

No bot, no Meta Cloud API, no template approval. When your turn ends, the app
opens WhatsApp with the message already written and you press send — one tap,
into the group chat, where a turn nobody has taken becomes visible peer
pressure.

The same button appears on the waiting screen so anyone can nudge whoever is
holding things up.

### The briefing

> It reminds you what you did. It never reminds you what you learned.

When you open your turn you get what you did on your *last* turn, everything
public that happened since, and how many things the worst offender has done to
you. Built entirely from the move log's public text, which the engine writes
with values already stripped — so no card value can physically reach it.

### The Tab

Every hostile act is written to an append-only `moves` table with an actor and
victims. The Tab and the briefing are both queries over that table, which is
why they can never disagree with what actually happened.

The list is visible all match. The **price stays hidden** until the settlement
at the end, where everyone deducts a point from the leader for each thing the
leader did to them. In simulation it changes the winner about 10% of the time —
enough to matter, not enough to take over.

---

## Still to do

- Turn clock: 24h is stored in room settings but nothing enforces it yet. Next up is the expiry state and a host-can-skip button, both logged to the Tab.
- Seat recovery UI for someone who clears their browser.
- Phone numbers are stored but the nudge currently opens the group picker rather than a specific chat. That was the deliberate choice — group chat over direct message — so the numbers are only needed if you later want direct nudges.
