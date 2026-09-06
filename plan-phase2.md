# THE BEE'S HOUSE, Phase 2

*The things a game needs once people have actually played it a few times.*

Four features on top of a finished engine. All four are built.

---

## What was on the list

| | What | State |
|---|---|---|
| 1 | **The match recap** | Built. `recap.test.js`, `recap.browser.js`. |
| 2 | **Seasons** | Built and tested end to end. No UI yet. |
| 3 | **The turn clock** | Built. `clock.test.js`, `clock.browser.js`. |
| 4 | **Seat recovery** | Built. `seat.test.js`, `seat.browser.js`. |

The `scores` table that nothing had ever written to is now written to on
every round of every match, whether or not a season is running. That was
your call: keep a tab of all of it.

---

## 1. The match recap

Between the standings and the settlement, so the reading happens before the
arithmetic.

- **Most swept** who wiped the pile most, and how many cards died doing it
- **Most interfered with** who spent the match being stung, spied on and swapped
- **Cabo record** who called, and how many of those calls cost ten points
- **Red kings** who was holding one when the hands flipped, because that is now the prize
- **Skipped** who ran out of time, and how often
- **Slowest** who took the longest between turns
- **The worst thing anybody did** one line quoted straight off the Tab, ranked so it does not just requote the sweep already in the headline
- **The quiet one** how many times Hush left a hole, and the fact that nobody can say what went in it

It is a query over `moves`, so it cannot disagree with the match. The test
asserts no rank, suit or value can reach it, and that assertion is proved
to fail by planting five kinds of leak into it on purpose.

---

## 2. Seasons

A season is a set of matches between the same five people. Rooms belong to
a season, `scores` is used, standings carry across weeks, and the season
closes itself once its match target is played.

One bug worth remembering, because only Postgres caught it: `scores.player_id`
is a UUID foreign key, and player rows are **per game**. Aggregating by
`player_id` would have listed each person once per match. The animal is what
identifies a person across matches, so writes use the real UUID and the
standings query joins back for the animal.

Built in Phase 3. See `plan-phase3.md`.

---

## 3. The turn clock

- Under a day, the waiting screen says how long it has been
- Past a day it says it in red and the nudge button pulses
- Past two days, anybody except the person holding things up can skip, in two taps

A skip is not a turn played for somebody. One card off the top, face up, no
power fires, and it goes on the Tab under their name with everybody who
waited on the other side of it. Nothing auto-plays before that.

The clock starts at the last move made by **somebody else**, so drawing a
card and vanishing does not wind it back.

One deviation from this plan: it said the *host* can skip. There is no host
in this game and inventing one to hold this button would be worse than the
four people who can already see who is sitting on it. Anybody but the
offender can press it.

---

## 4. Seat recovery

- A claimed seat gets a small **This is me** on the picker
- The new device gets a token that does nothing until somebody approves it
- The request appears on every other player's screen
- Any claimed player except that seat can approve, and the seat moves

No email, no passwords, no recovery codes. Approving locks the old device
out, which is the point, since the usual reason for asking is that the old
device is gone. Requests are kept forever, approved and denied alike, and a
seat change goes on the Tab with no victims, because it is not a hostile
act.

---

## What is left

- Direct nudges, if the group ever wants them instead of the group chat
