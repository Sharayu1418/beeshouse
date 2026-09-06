# THE BEE'S HOUSE, Phase 3

*The season, which existed and had no door.*

Seasons worked end to end after Phase 2 and nothing on screen could reach
them. This is the screen, plus the three service pieces the screen turned
out to need.

---

## The three decisions

**Where a season starts.** Not the home screen. Nobody knows whether they
want five matches before they have played one, and the home screen is two
buttons and a joke that should not have furniture put next to it. The offer
appears after the Tab settles, and the match just played becomes match 1.

**What the standings show.** The table, then the recap treatment at season
scale: who swept, who has spent the season being stung, who calls Cabo and
misses. Same source as the match recap, one layer up.

**What happens when it fills up.** The same ceremony a match ends with.
Lowest total is ahead, then everybody deducts one point for every thing that
person did to them across every match, and it can flip the winner.

---

## What was built

| | What | Where |
|---|---|---|
| 1 | `createSeason({fromCode, token})` promotes a finished match to match 1 | `lib/service.js` |
| 2 | `nextMatch(code, token)` deals the next one, roster carried over | `lib/service.js`, `api/next-match.js` |
| 3 | Season superlatives and the settlement | `seasonExtras`, `settleSeason` |
| 4 | `seasonStandings` answers to a room code as well as a season code | `lib/service.js` |
| 5 | `view.season` so the end of a match knows where it is | `getState` |
| 6 | The season screen, and `/s/CODE` for people holding no seat | `public/index.html` |

---

## The parts that needed thinking

**The next-match button is pressed five times.** It is the one button in the
app that five phones hit within the same second. If an unfinished later match
already exists it returns that room rather than dealing another, so everybody
lands in the same place. `existing: true` says which happened.

**A season code is not the code people have.** They have a game link, from
the group chat. So `GET /api/season?code=` accepts either, and falls back to
looking up the room's season.

**Only finished matches count.** A match still being played would otherwise
contribute half a Tab to a season superlative and, worse, move the standings
under people mid-round. Asserted with a season left deliberately half-played.

**The settlement is not shown until the season closes.** A provisional one
every week would have people playing the settlement instead of the game.

---

## The test that was wrong

The settlement recounts every debt straight off the Tab rather than trusting
the number the service returned, which sounds airtight. It is not. A
sabotaged settlement that billed the leader's entire Tab to everybody
**passed**, because a Cabo call already lists every other player as a victim
and with three players the two readings coincide.

The fix: plant one Tab row aimed at exactly one person, then assert that
exactly one debt moves and the bystanders' do not. Four sabotages are now
proved to fail the suite, including that one.

---

## Still open

- Direct nudges. Phone numbers are stored; the nudge goes to the group by choice.
- Nothing else. Seasons name themselves by number.
