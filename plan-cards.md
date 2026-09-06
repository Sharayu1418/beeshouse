# THE BEE'S HOUSE — real cards

*Swapping the 0–13 deck for 52 cards with suits, and building the animations on top.*

Plan doc. Edit anything. Decisions I need are at the bottom. Nothing gets written until you say go.

---

## 0. This is a rules change, not a re-skin

Worth being clear up front: you're not just putting spades on the backs of the same numbers. A real deck brings back a mechanic the 0–13 deck doesn't have, and it's the best one in Cabo.

**Red kings are worth minus one.**

That single rule changes how the whole game feels. Right now zero is the floor and everyone is scrabbling toward it. With a real deck the floor is *below* zero, holding a red king is a small secret triumph, and the two red kings become the most wanted cards in the deck.

It also makes the framed gift literally true. Two red kings is the best pair the deck can produce — the "perfect hand" caption stops being a joke about house rules and starts being a fact about the game.

---

## 1. The deck

52 cards. No jokers (see decisions).

| Card | Value | Why |
|---|---|---|
| Ace | 1 | |
| 2–10 | face value | |
| Jack | 11 | |
| Queen | 12 | |
| King ♠ ♣ | **13** | the worst card in the deck |
| King ♥ ♦ | **−1** | the best card in the deck |

Powers stay on rank, exactly as now:

| Rank | Power |
|---|---|
| 7, 8 | **Peek** — one of your own |
| 9, 10 | **Spy** — one of somebody else's |
| J, Q | **Swap** — blind, one of yours for one of theirs |

I checked the arithmetic that shifts:

```
deck size            52 (was 56)
value range          −1 … 13   (was 0 … 13)
best 4-card hand      0        two red kings + two aces
worst 4-card hand    50
best hand at all     −2        two red kings, everything else dumped
power cards          24 of 52  (was 24 of 56 — slightly more frequent, 46% vs 43%)
```

**Scores can now go negative.** That's new and it touches more than it looks: the round table, the season totals, the Tab settlement (which subtracts) and every place a score is rendered. Minus signs need to look deliberate rather than like a bug.

---

## 2. Rules that actually change

### Matching is by rank, not by value
The Feast (slapping cards that match the discard top) now matches on **rank**. Which means **all four kings match each other** — you can slap a black king onto a red king, even though one is worth 13 and the other −1.

That's correct by the standard rules and it's a good trap: dumping a king feels great until you realise you just threw away a −1.

### Listen gets much better
This is the part I'm most pleased about. The current questions are weak because a bare number has few interesting properties. Suits fix that:

| Old | New |
|---|---|
| Is it even? | **Is it red?** |
| Is it under 5? | Is it under 5? |
| Is it over 9? | **Is it a face card?** (J, Q, K) |
| Is it a power card? | Is it a power card? |

"Is it red?" is the best question in the game now, because red is where the −1s live. A yes means either a small heart or diamond, or the single best card on the table — and you have to decide which. That's exactly the kind of half-knowledge Listen is supposed to give the good listener.

### The Cabo penalty, and why it stays at 10
Calling Cabo means *"I think I'm lowest, end the round."* Everyone else takes one final turn, then all hands flip.

- Right — you are lowest → you score **0**.
- Wrong — somebody beat you → you score your hand **+10**.

The penalty is the only thing that makes calling a gamble. Without it, calling on turn one every round would be free and correct. The +10 is what makes you sit and ask whether you actually know what you're holding.

The scoring floor drops by 2 with the new deck, so +10 is fractionally harsher than before. Not enough to matter. ✅ *Staying at 10.*

### Nothing else moves
Sweep, Sting, Bolt, Shed, Charge, Long Neck, the Tab, the settlement, the turn structure, Cabo and its +10 penalty — all unchanged. The engine's shape is right; only the cards inside it change.

---

## 3. What the cards look like

**Drawn as SVG, generated in code.** Not images, not Unicode playing-card glyphs (🂡 — they render differently in every font and are unusable at small sizes), not a sprite sheet. SVG means crisp at any size, themeable, no assets to host, and nothing to load.

Two pieces of work:

**Pip layouts.** Classic arrangements — the 5 is a quincunx, the 8 is 4+4 with a centred pair, the 10 has two column-of-four plus two centred, and the bottom half of every layout is rotated 180°, the way real cards are. Ten hand-tuned layouts, then A/J/Q/K get a large corner-weighted treatment instead.

**Face cards.** Not illustrated courts — a bad line drawing of a jack at 64px is worse than nothing. Instead: a large suit symbol with the letter set over it, styled to feel deliberate.

**Kings show nothing.** ✅ *Decided — and this is the sharpest rule in the redesign.*

A king looks like the worst card in the deck. Most of the time it is: thirteen points, the thing you dump first. But a red one is minus one, the best card there is, and **nothing on the card says so.**

So a player who spies a king and doesn't register the suit will cheerfully swap it away, or refuse to take it off the discard because "it's a king". The trap is entirely self-inflicted and entirely fair — the information was right there on the face, they just didn't look properly.

That makes **suit** the thing you have to notice and remember, not just rank. It doubles what your memory is carrying without adding a single rule, and it is the reason a real deck beats 0–13 outright.

**Colour.** The felt-and-brass table stays. Card faces go to a warm off-white with a proper card red — not the chili red already used for danger, since a red heart and a "you did something wrong" button must not read as the same colour. The honeycomb back is unchanged and still the thing you stare at most.

---

## 4. Animation — and the one thing that has to change first

You want the best animations possible. There's an architectural prerequisite, and it's worth understanding before the list of pretty things.

### The prerequisite
Right now the client throws away the old view and renders the new one. Nothing knows a card *moved* — only that the screen looks different. You cannot animate a difference you never computed.

So: **the client keeps the previous view and diffs it against the new one.** Every card already has a stable `id` (I kept those deliberately), so a diff can say precisely "card `c31` went from Sahil's slot 2 to the discard pile" — and that sentence is what an animation is.

The technique is FLIP — measure where things are, apply the new state, measure again, invert the difference as a transform, then play it forward. It's how you animate elements between two DOM positions without hand-writing coordinates, and it survives layout changes and different screen sizes for free.

### Tier 1 — the ones that carry the game

- **Flip.** A real 3D rotation on the Y axis, back to face. Everything else is decoration; this one *is* the game. Used on the opening peek, every reveal, and the round-end table flip.
- **Deal.** Round start: cards arc out of the deck to each player in turn, staggered by about 60ms. It's the moment that says a round has begun.
- **Draw and place.** The drawn card lifts out of the deck to its holding position; placing it swaps positions with the slot it replaces, both cards moving at once, and the old one continues on to the discard.
- **Discard.** An arc onto the pile with a small random rotation, so the pile builds up crookedly like a real one instead of a perfect stack.

### Tier 2 — the ones with personality

- **Sweep.** The whole discard pile scatters and blows off the table. This is his signature move and it should feel disproportionate — the biggest animation in the game for the move that gains you the least.
- **Sting.** Two cards fly between two *other* players and cross mid-air. You watch it happen and learn nothing, which is the joke.
- **Shed.** Your four cards lift, shuffle positions, and settle. Only you ever see it.
- **Slap.** Cards slam down hard and fast. On a wrong slap the penalty card drops in with a thud and the hand visibly gets wider.
- **Cabo.** A pulse across the whole table.

### Tier 3 — the small stuff that makes it feel finished
Hover and press states on cards, the countdown ring on reveals (already there), a settle wobble when a card lands, the turn indicator moving between players.

### Rules for all of it
Every animation is interruptible and has a fixed maximum duration — nothing blocks a move. `prefers-reduced-motion` collapses everything to instant. And crucially: **animations are cosmetic only.** The server has already decided what happened; the animation is a replay. If a frame drops, the game is still correct.

---

## 4b. The match recap

*New, from your note about the dashboard showing what happened.*

The Tab already records every hostile act with an actor and victims, append-only, in the `moves` table. That's most of a recap already sitting there unused. So when a match ends, before the Tab settles, show a short account of what actually happened:

- **Most swept** — who wiped the pile most, and how many cards died
- **Most stung / spied on** — who spent the match being interfered with
- **Cleanest Cabo** — who called and was right; and who called and ate the +10
- **The red king count** — who ended up holding one at scoring time, since that is now the prize
- **Longest gap** — who took the most hours to play a turn, because it is always the same person
- **One line quoted straight from the Tab** — the single most obnoxious thing anybody did

All of it is a query over `moves`. No new storage, no new writes, nothing to keep in sync — same reason the briefing works. It also gives the end of a match something to *read* rather than just a table of numbers, and it's the bit people will screenshot into the group chat.

Build it after the animations. It's cheap and it's the natural home for the "funny and irritating things" you wanted surfaced.

---

## 5. Code impact

Smaller than you'd think, because the engine never cared what a card *was* — only that it had a value.

| File | Change |
|---|---|
| `lib/engine.js` | `makeDeck()` builds 52 rank+suit cards. New `valueOf(card)`. `sum()` uses it. `powerOf()` takes a rank. Match-discard compares rank. **Everything else untouched.** |
| `lib/redact.js` | Hide `rank` and `suit` as well as `v`. The leak test's card-shaped-object detector needs to know about the new shape. |
| `lib/service.js` | The four Listen questions get rewritten. |
| `public/cards.js` | **New.** SVG card face generation — pip layouts, face cards, backs. |
| `public/anim.js` | **New.** The FLIP helper and the animation catalogue. |
| `public/index.html` | Keeps the previous view for diffing; renders SVG faces instead of a number. |
| `schema.sql` | No change. State is JSON; it doesn't care. |
| tests | All four suites need their card assumptions updated. See below. |

---

## 6. Migration

Any game currently mid-round has 0–13 cards in its stored state and the new code would misread them.

Given five people and no games anyone is precious about: add a `deckVersion` to the state, and refuse to load a round that doesn't match, with an honest message — *"this game was started with the old deck; start a new house."* Cleaner than a converter nobody will ever run twice, and it can't silently corrupt a live game.

---

## 7. Tests

The existing suites are the reason this change is safe to make, and they need updating rather than replacing:

- **`engine.fuzz.js`** — the invariant "every card value is 0–13" becomes "−1 to 13", and a new one: exactly 52 cards, exactly 2 red kings, 13 ranks × 4 suits with no duplicates.
- **`redact.test.js`** — the leak detector currently looks for objects carrying `v`. It must also catch `rank` and `suit`, or a card could leak its identity without leaking its number. **This is the most important edit in the whole plan.** I'll re-run the deliberate-sabotage check afterwards to prove the test still fails when it should.
- **`service.test.js`** — Listen question indices change.
- **New: `cards.test.js`** — every one of the 52 faces renders, no two SVGs identical, all ten pip layouts produce the right pip count.

---

## 8. Build order

1. Engine: deck, values, rank-based matching, powers — with the fuzz suite green
2. Redaction: hide rank and suit, extend the leak test, re-run the sabotage check
3. Listen questions
4. `cards.js` — SVG faces, tested standalone by rendering all 52 to a sheet and looking at it
5. Client renders the new faces (no animation yet — confirm correctness first)
6. `anim.js` — the view diff and FLIP helper
7. Tier 1 animations
8. Tier 2 animations
9. Redeploy

Steps 1–3 are a day's care. Step 4 is the fiddly one. Steps 6–8 are where the time goes and where it's worth spending it.

---

## 9. Decisions — all locked

1. **Jokers?** ✅ **No.** Standard Cabo has none, and a second special card would dilute the red kings.
2. **Red kings −1 or 0?** ✅ **−1.**
3. **Show the −1 on the face?** ✅ **No** — and this became the best idea in the plan. See §3.
4. **Cabo penalty?** ✅ **Stays at +10.** See §2.
5. **Existing games?** ✅ Hard-stop rounds started on the old deck with an honest message. Nothing is lost that anybody minds; a converter nobody runs twice is the worse option.

Nothing outstanding. Ready to build on your word.

---

## 10. What I'll do, in order

1. Engine — 52 cards, red kings at −1, rank-based matching, powers by rank. Fuzz suite green.
2. Redaction — hide `rank` and `suit` as well as `v`, extend the leak detector, **re-run the deliberate-sabotage check** to prove the test still fails when it should.
3. The four Listen questions.
4. `cards.js` — all 52 SVG faces, rendered to a contact sheet and eyeballed.
5. Client renders real faces. No animation yet — correctness first.
6. `anim.js` — previous-view diffing and the FLIP helper.
7. Tier 1 animations: flip, deal, draw/place, discard.
8. Tier 2: sweep, sting, shed, slap, Cabo.
9. The match recap.
10. Redeploy.

Steps 1–3 are careful but quick. Step 4 is fiddly. Steps 6–8 are where the time goes, and where it should.
