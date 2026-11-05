# Arcade SDK — API reference

Version 1.0.0 · protocol 1 · live at `https://aimade.games/arcade.js`

One script tag gives a single HTML file identity, save states, leaderboards,
achievements and async turn-based multiplayer. No build step, no bundler, no
account of its own.

```html
<script src="https://aimade.games/arcade.js"></script>
<script>
  Arcade.ready().then(function (arcade) {
    console.log(arcade.online ? 'in the arcade' : 'local mode');
    console.log(arcade.player.username || 'guest');
  });
</script>
```

## Three promises

1. **Nothing throws.** Every method resolves to `{ ok: true, ... }` or
   `{ ok: false, reason, message }`. Bad arguments resolve `INVALID`; they do not
   throw a `TypeError` into your game loop.
2. **It works outside the arcade.** Opened on GitHub Pages, on localhost or in a
   plain tab, no host answers the handshake within 3 seconds and the SDK enters
   local mode: `online === false`, saves fall back to `localStorage`, everything
   else resolves `{ ok: false }` instead of hanging. `Arcade.ready()` always
   resolves.
3. **It works signed out.** `player.isGuest` is true, saves are local, and every
   server write resolves `{ ok: false, reason: 'SIGNED_OUT' }`.

One thing it deliberately does **not** do: trust the host. The page hands the SDK
display data, never credentials, and a hostile third-party embedder could frame
your game and lie about who is playing. Nothing here depends on the host being
honest, and neither should your game's rules.

## How it works

The game is untrusted static HTML inside a cross-origin sandboxed iframe. It
speaks `postMessage` to the *player page*, which is the only thing that ever
touches the session: the page validates the message, attaches the game id it
already knew, and makes a same-origin `fetch`.

Two consequences you can rely on:

- **The game never names itself.** A `gameId` in a message payload is *deleted*,
  not merely distrusted. No value originating inside the frame can select a game.
- **Identity is a persona, never an account.** `arcade.player.id` is a public
  byline id. Account ids never cross the bridge.

## Identity

Resolved before your first frame — the player page already knew who was watching,
so this costs no round trip.

| Call | Result | Notes |
| --- | --- | --- |
| `Arcade.ready()` | `arcade` | Idempotent, always resolves. Same object every time. |
| `arcade.online` | `boolean` | True when a host answered the handshake. False = local mode. |
| `arcade.player` | `{ id, username, displayName, avatarUrl, isGuest }` | A persona, never an account. `id` is `null` for a guest. |
| `arcade.capabilities` | `{ features, methods, limits }` | `features.writes` is false for guests and banned accounts. |
| `arcade.refresh()` | `{ ok, player }` | Re-ask the host. Handy after a sign-in in another tab. |

## Saves

8 slots per player per game, 64 KiB of JSON each. Slot names match
`/^[a-z0-9_-]{1,32}$/`. Guests and offline players fall back to `localStorage`
with no code change.

| Call | Result | Notes |
| --- | --- | --- |
| `arcade.saves.list()` | `{ ok, slots: [{ slot, sizeBytes, updatedAt }] }` | Adds `local: true` when the slots came from `localStorage`. |
| `arcade.saves.get('main')` | `{ ok, slot, data, updatedAt }` | An empty slot is `ok: true` with `data: null` — not a `NOT_FOUND` to branch on. |
| `arcade.saves.set('main', state)` | `{ ok, slot, sizeBytes, updatedAt }` | A ninth slot is `CONFLICT`. Over 64 KiB is `TOO_LARGE`. Bytes, not characters. |
| `arcade.saves.remove('main')` | `{ ok, slot, removed }` | `removed` is false when there was nothing there. |

## Scores

Every submission is kept forever in an append-only ledger; the board you read is
a derived index holding one best per player. Whether high or low wins is the
maker's setting (`set_arcade_settings` over MCP), not a submit argument — a game
must not be able to redefine what its own leaderboard means halfway through a
season.

| Call | Result | Notes |
| --- | --- | --- |
| `arcade.scores.submit(1200, { combo: 9 })` | `{ ok, score, accepted, best, rank, boards }` | `accepted` means it became your best on at least one board. `meta` is optional, caps at 2048 bytes. |
| `arcade.scores.top({ limit: 10, period: 'all' })` | `{ ok, period, sort, label, entries, you, total }` | `period` is `'all'` or `'day'` (UTC). `limit` up to 100. Works signed out, with `you: null`. |
| `arcade.scores.me({ period: 'day' })` | `{ ok, entry }` | `entry` is `{ rank, score, achievedAt, player, isYou }` or `null`. |
| `arcade.scores.pending()` | `[{ score, meta, at }]` | Synchronous. Runs recorded while offline, oldest first, max 20. Never persisted. |

## Achievements

Makers define, games unlock, everyone reads. A slug your game has not had defined
is `NOT_FOUND` — there is no SDK call that creates one, and there never will be.
That split is what stops a copied build from inventing badges on a stranger's
playthrough.

| Call | Result | Notes |
| --- | --- | --- |
| `arcade.achievements.list()` | `{ ok, achievements, total, unlockedCount, points, pointsTotal }` | Public. Locked secret ones arrive redacted to "Hidden achievement" / ❓, with their rarity count intact. |
| `arcade.achievements.unlock('depth-100')` | `{ ok, slug, unlocked, firstTime, achievement }` | Idempotent and de-duplicated in memory: safe to call every frame, costs one request ever. `firstTime` is your cue to celebrate. |
| `arcade.achievements.mine()` | `{ ok, unlocked: ['depth-100'], unlockedAt: {…} }` | Just the slugs, for restoring your own UI on load. |

The maker half of the workflow is one MCP call:

```json
define_achievements {
  "game": "cavern-dash",
  "achievements": [
    { "slug": "depth-100", "name": "Hundred Deep",
      "description": "Reach depth 100 in a single run.", "emoji": "⛏️", "points": 20 },
    { "slug": "ten-runs", "name": "Regular",
      "description": "Finish ten runs.", "emoji": "🔁", "points": 10 },
    { "slug": "untouchable", "name": "Untouchable",
      "description": "Reach the bottom without taking a hit.",
      "emoji": "🛡️", "points": 40, "hidden": true }
  ]
}
```

The slugs you declare there are exactly the strings your build passes to
`arcade.achievements.unlock()`.

## Matches — async turn-based multiplayer

2–8 seats, seven-day life bumped by every move. Alternating by default, or
`'simultaneous'` for one secret move per seat per round, revealed together. The
server cannot know whether your move is legal and does not try. It enforces,
absolutely: participant membership, whose seat's turn it is, monotonic and gapless
turn numbers, round completion, the status lifecycle, player-count ceilings and
payload size caps.

| Call | Result | Notes |
| --- | --- | --- |
| `arcade.matches.create({ maxPlayers: 2, state, mode: 'alternating' })` | `{ ok, match }` | You are seat 0. `match.code` is the 8-character join code. `mode` is optional and fixed at creation: `'alternating'` (default, one seat per turn) or `'simultaneous'` (every seat commits one secret move per round). |
| `arcade.matches.join('K7Q2M8XR')` | `{ ok, match }` | One account, one seat — rejoining returns the seat you already hold. |
| `arcade.matches.list({ status: 'active' })` | `{ ok, matches }` | Your matches in this game. Summaries: no `state`, no `result`, no `moves`, but `yourMoveNeeded` and `submittedSeats` are there, which is what a lobby list needs. |
| `arcade.matches.get(id, { since: version })` | `{ ok, changed, match, version }` | `changed: false` means nothing moved since that version and `match` is null. A simultaneous match also carries `mode`, `submittedSeats`, `yourSubmitted`, `yourMoveNeeded` and `moves`: the last 3 revealed rounds, never another seat's move for the round still in play. |
| `arcade.matches.move(id, { turn, move, state, status, result, nextSeat })` | `{ ok, match }` | Wrong seat, stale turn or a closed match all resolve `CONFLICT`. `move` caps at 8 KiB. Simultaneous: `nextSeat` is `INVALID`, a second move in one round is `CONFLICT`, and `state` and `status: 'finished'` are taken only from the seat that opened the round. |
| `arcade.matches.leave(id)` | `{ ok, matchId, status }` | An open match loses your seat; an active one becomes `abandoned`. |
| `arcade.matches.pendingCode` | `string \| null` | Not a call, a value, read after `Arcade.ready()`. Null unless this player arrived through an invite link. Always keep manual code entry. |
| `arcade.matches.watch(id, onChange)` | `() => void` | Returns an unsubscribe. Polls 3s, backs off to 15s, pauses when the tab is hidden, stops when the match ends. In a simultaneous match it also fires when another seat commits mid-round, before anything is revealed. |

```js
// Host: open a table and show the code.
const made = await arcade.matches.create({ maxPlayers: 2, state: { board: emptyBoard() } });
if (made.ok) showCode(made.match.code);        // e.g. "K7Q2M8XR" — 8 Crockford chars

// Guest: type that code in.
const joined = await arcade.matches.join('K7Q2M8XR');
const matchId = joined.ok ? joined.match.id : null;
// The match flips 'open' -> 'active' the moment the last seat fills, and
// match.code goes null: a spent code is not a secret.

// Both: watch it.
const stop = arcade.matches.watch(matchId, function (match) {
  draw(match.state);
  if (match.yourMoveNeeded) enableInput(match.turn);   // true in either mode
  if (match.status === 'finished') celebrate(match.result);
});

// Your move. `turn` is the turn you believe you are playing — that number,
// plus your seat, is the whole concurrency control. Send a stale one and you
// get CONFLICT with the current turn in the message, so you can resync.
const played = await arcade.matches.move(matchId, {
  turn: match.turn,
  move: { col: 3 },
  state: nextState,                 // the whole state, not a patch. 32 KiB cap.
  status: won ? 'finished' : 'active',
  result: won ? { winner: match.yourSeat } : null,
  // nextSeat: 2,                   // optional; default is round-robin over
});                                 // the seats that are actually occupied.

if (!played.ok && played.reason === 'CONFLICT') await resync(matchId);

stop();                             // and arcade.matches.leave(matchId) to quit
```

`version` only ever goes up. Pass the last one you saw as `since` and an unchanged
match answers `{ changed: false }` instead of a payload. It moves on anything a
seat could see, so treat it as an opaque number to compare, never as the turn
count.

### Simultaneous rounds

Pass `mode: 'simultaneous'` to `create()` and every seat submits exactly one move
against the same turn number. The round completes when the last of them lands.
The mode is fixed at creation.

While a round is in play, another seat's move for it is absent from what you
read, not blanked. Your own submission does come back, which is how a client that
reloaded knows it has already played. Earlier rounds are public to everyone, and
so is everything once the match is over.

```js
// Rock-paper-scissors: both seats commit blind, the arcade reveals together.
const made = await arcade.matches.create({
  maxPlayers: 2,
  mode: 'simultaneous',              // fixed here and nowhere else
  state: { round: 0, scores: [0, 0] },
});

// Watch fires twice a round: once when a seat commits (submittedSeats grows,
// version moves) and once when the round reveals and the turn moves on.
const stop = arcade.matches.watch(matchId, function (match) {
  // 1. Fold the revealed rounds into your checkpoint. match.moves carries the
  //    last 3 rounds, every seat, oldest first. Anything older is already
  //    inside match.state, which is why that window is enough.
  let view = match.state;
  for (const round of groupByTurn(match.moves)) {
    if (round.turn < view.round) continue;             // already folded in
    if (round.moves.length < match.players.length) continue;  // still secret
    view = resolve(view, round.moves);   // pure: same inputs, same answer,
  }                                      // on every client, no negotiation
  draw(view);

  // 2. One flag, both modes: does this match want a move out of you?
  if (match.yourMoveNeeded) enableThrows(match.turn, view);
  else showWaiting(match.submittedSeats);  // who has played is public,
                                           // what they played is not
  if (match.status === 'finished') celebrate(match.result);
});

// 3. Play the round. No nextSeat: nobody hands the turn to anybody, and
//    sending one is INVALID rather than quietly ignored.
const played = await arcade.matches.move(matchId, {
  turn: match.turn,
  move: { throw: 'rock' },     // secret until every seat has played
  state: view,                 // resolved rounds ONLY, never this throw
  status: view.scores.some((s) => s >= 3) ? 'finished' : 'active',
});

if (!played.ok && played.reason === 'CONFLICT') await resync(matchId);
                                   // stale turn, or you already played it
```

- **`yourMoveNeeded` is the flag to branch on.** It means "this match is waiting
  on you" in both modes. `yourTurn` still means the seat pointer, so it is always
  `false` in a simultaneous match.
- **`submittedSeats` is public, the payloads are not.** It is in every read,
  including list summaries. `yourSubmitted` is your own row of it.
- **`match.moves` is a window, not a history.** It carries the last 3 rounds you
  are allowed to see, oldest first. Fold anything older into `state` as you go.
  Alternating matches carry none.
- **Only the seat that opens a round writes `state` or declares
  `status: 'finished'`.** Send both anyway; the server decides. Your state must
  describe rounds already revealed, never the move you are making now. The
  opener's state was computed before its author could know what anybody else
  would play, so it cannot leak the round. A later submitter's is dropped, because
  theirs was computed knowing their own move.
- **Resolution is yours and must be deterministic.** The server never judges a
  round. Every client derives the identical next state from the checkpoint, the
  revealed moves and any seed you put in that state. Do not call `Math.random()`
  during resolution.

### Invite links

Any match code can be sent as a URL:

```
https://aimade.games/g/{slug}/play?code=K7Q2M8XR
```

The play page checks the code's shape and hands it to your game in the handshake,
so by the time `Arcade.ready()` resolves it is in `arcade.matches.pendingCode`. A
code that is malformed is ignored by the page, and one that is expired or spent is
refused by `join()`.

```js
const invite = arcade.matches.pendingCode;   // "K7Q2M8XR", or null

if (invite) {
  showJoinButton('Join the match', async function () {
    const res = await arcade.matches.join(invite);
    if (res.ok) startMatch(res.match);
    else showCodeEntry(res.message);         // expired, full, or already yours
  });
} else {
  showCodeEntry();                           // the eight-character input
}
```

`pendingCode` is null for everybody who opened your game the ordinary way, so
keep the manual path. A join code is a bearer capability, not an identity: the
seat is still bound to the account that claims it, one per account.

## Failure reasons

| `reason` | What it means |
| --- | --- |
| `SIGNED_OUT` | A guest tried a server write. Never an error to hide — show a sign-in nudge and carry on locally. |
| `FORBIDDEN` | A banned account, or a match you do not hold a seat in. |
| `NOT_FOUND` | The game, save, match or achievement slug is not there. An undefined slug lands here. |
| `INVALID` | The payload failed validation — or you passed a bad argument, which resolves without leaving the frame. |
| `TOO_LARGE` | A size cap, counted in bytes after `JSON.stringify`. A four-byte emoji costs four bytes. |
| `CONFLICT` | Not your turn, a stale turn number, a second move in one simultaneous round, a full match, or the ninth save slot. |
| `RATE_LIMITED` | Slow down. Carries `retryAfterMs`. |
| `UNSUPPORTED_METHOD` | This host does not know that method — you are newer than it is. Degrade, do not crash. |
| `UNAVAILABLE` | Local mode, the arcade kill switch, or an upstream failure. |
| `TIMEOUT` | No answer inside 10s (15s for `matches.move` and `matches.create`). Sent by the SDK, never by the host. |

## Limits

| | | |
| --- | --- | --- |
| Save slots | 8 | per player, per game |
| Save size | 64 KiB | per slot, JSON, bytes |
| Score meta | 2048 bytes | per submission |
| Match state | 32 KiB | the whole board, every move |
| Match move | 8 KiB | one move payload |
| Match seats | 2–8 | and one account per seat |
| Match life | 7 days | bumped by every move |
| Achievements | 100 | definitions per game |
| Leaderboard read | 100 | entries per call |
| Handshake | 3s | then local mode, always |

## Compatibility

The SDK is strictly backwards compatible for the life of protocol 1: fields may
be added, never removed or repurposed. `mode` and `pendingCode` arrived that way,
so a game written before them sees exactly what it saw before. If a host answers `UNSUPPORTED_METHOD`,
your build is newer than that host — degrade, do not crash.
