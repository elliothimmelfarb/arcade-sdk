/**
 * Type definitions for the Arcade SDK 1.0.0 (protocol 1).
 *
 * The SDK itself is hand-written ES2019 with no build step; these types are a
 * companion, not a source of truth. They describe the surface `window.Arcade`
 * exposes once `ready()` resolves.
 *
 * Two shapes run through everything:
 *
 *   - **Nothing throws.** Every async method resolves to `{ ok: true, ... }` or
 *     `{ ok: false, reason, message }`. Bad arguments resolve `INVALID`.
 *   - **Nothing hangs.** If no host answers the handshake the SDK enters local
 *     mode: `online === false`, saves fall back to `localStorage`, and every
 *     other call resolves `{ ok: false }`.
 */

declare global {
  interface Window {
    Arcade: ArcadeGlobal;
  }

  const Arcade: ArcadeGlobal;
}

/** The object the script tag installs on `window`. */
export interface ArcadeGlobal {
  readonly version: string;
  readonly protocol: number;
  /** Idempotent. Always resolves, never rejects. Same object every time. */
  ready(): Promise<Arcade>;
}

/* -------------------------------------------------------------------------- */
/*  Results                                                                    */
/* -------------------------------------------------------------------------- */

/** Why a call did not succeed. Treat an unknown reason as a soft failure. */
export type ArcadeFailureReason =
  /** A guest tried a server write. Nudge them to sign in and carry on locally. */
  | 'SIGNED_OUT'
  /** A banned account, or a match you do not hold a seat in. */
  | 'FORBIDDEN'
  /** No such game, save, match or achievement slug. An undefined slug lands here. */
  | 'NOT_FOUND'
  /** The payload failed validation, or you passed a bad argument. */
  | 'INVALID'
  /** A size cap, counted in bytes after `JSON.stringify`. */
  | 'TOO_LARGE'
  /** Not your turn, a stale turn number, a full match, or the ninth save slot. */
  | 'CONFLICT'
  /** Slow down. Carries `retryAfterMs`. */
  | 'RATE_LIMITED'
  /** This host does not know that method — you are newer than it is. */
  | 'UNSUPPORTED_METHOD'
  /** Local mode, the arcade kill switch, or an upstream failure. */
  | 'UNAVAILABLE'
  /** No answer in time. Sent by the SDK, never by the host. */
  | 'TIMEOUT';

export interface ArcadeFailure {
  ok: false;
  reason: ArcadeFailureReason;
  message: string;
  /** Present on `RATE_LIMITED`. */
  retryAfterMs?: number;
  /** Present when the SDK handled the call locally instead of on the server. */
  local?: boolean;
  [extra: string]: unknown;
}

/** Every async method resolves to a success shape or to `ArcadeFailure`. */
export type ArcadeResult<T> = (T & { ok: true }) | ArcadeFailure;

/* -------------------------------------------------------------------------- */
/*  Identity                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The player, as a **persona** — a public byline, never an account id.
 * Display data, never a credential: a hostile embedder could lie about it, so
 * no game rule should depend on it being honest.
 */
export interface ArcadePlayer {
  /** Persona id, or `null` for a guest. */
  id: string | null;
  username: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  isGuest: boolean;
}

export interface ArcadeCapabilities {
  features: {
    identity: boolean;
    saves: boolean;
    scores: boolean;
    matches: boolean;
    achievements: boolean;
    /** False for guests and banned accounts. */
    writes: boolean;
  };
  /** Method names this host understands, e.g. `"scores.submit"`. */
  methods: string[];
  limits: ArcadeLimits;
}

export interface ArcadeLimits {
  /** 65536 */
  saveBytes: number;
  /** 8 */
  saveSlots: number;
  /** 2048 */
  scoreMetaBytes: number;
  /** 32768 */
  matchStateBytes: number;
  /** 8192 */
  matchMoveBytes: number;
  /** 8 */
  matchMaxPlayers: number;
  /** 100 */
  achievementsPerGame: number;
}

/* -------------------------------------------------------------------------- */
/*  Saves                                                                      */
/* -------------------------------------------------------------------------- */

export interface ArcadeSaveSlotSummary {
  slot: string;
  sizeBytes: number;
  updatedAt: string | null;
}

export interface ArcadeSaves {
  /** `local: true` when the slots came from `localStorage`. */
  list(): Promise<ArcadeResult<{ slots: ArcadeSaveSlotSummary[]; local?: boolean }>>;
  /** An empty slot is `{ ok: true, data: null }` — not a `NOT_FOUND` to branch on. */
  get<T = unknown>(
    slot: string,
  ): Promise<ArcadeResult<{ slot: string; data: T | null; updatedAt: string | null; local?: boolean }>>;
  /** A ninth slot is `CONFLICT`; over 64 KiB is `TOO_LARGE`. Bytes, not characters. */
  set(
    slot: string,
    data: unknown,
  ): Promise<ArcadeResult<{ slot: string; sizeBytes: number; updatedAt: string | null; local?: boolean }>>;
  /** `removed` is false when there was nothing there. */
  remove(slot: string): Promise<ArcadeResult<{ slot: string; removed: boolean; local?: boolean }>>;
}

/* -------------------------------------------------------------------------- */
/*  Scores                                                                     */
/* -------------------------------------------------------------------------- */

export type ArcadeScorePeriod = 'all' | 'day';
export type ArcadeScoreSort = 'desc' | 'asc';

export interface ArcadeLeaderboardEntry {
  rank: number;
  score: number;
  achievedAt: string;
  player: ArcadePlayer;
  isYou: boolean;
}

export interface ArcadePendingScore {
  score: number;
  meta: Record<string, unknown> | null;
  at: number;
}

export interface ArcadeScores {
  /**
   * `accepted` means it became your best on at least one board. `meta` is
   * optional and caps at 2048 bytes.
   */
  submit(
    score: number,
    meta?: Record<string, unknown>,
  ): Promise<
    ArcadeResult<{
      score: number;
      accepted: boolean;
      best: number;
      rank: number | null;
      boards: string[];
    }>
  >;
  /**
   * Public — works signed out, with `you: null`. Whether high or low wins is
   * the maker's `scoreSort` setting, not a submit argument.
   */
  top(options?: {
    limit?: number;
    period?: ArcadeScorePeriod;
  }): Promise<
    ArcadeResult<{
      period: ArcadeScorePeriod;
      sort: ArcadeScoreSort;
      label: string;
      entries: ArcadeLeaderboardEntry[];
      you: ArcadeLeaderboardEntry | null;
      total: number;
    }>
  >;
  me(options?: {
    period?: ArcadeScorePeriod;
  }): Promise<ArcadeResult<{ entry: ArcadeLeaderboardEntry | null }>>;
  /**
   * Synchronous. Runs recorded while offline, oldest first, max 20.
   * Never persisted — they are gone when the tab closes.
   */
  pending(): ArcadePendingScore[];
}

/* -------------------------------------------------------------------------- */
/*  Achievements                                                               */
/* -------------------------------------------------------------------------- */

export interface ArcadeAchievement {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  iconUrl: string | null;
  hidden: boolean;
  points: number;
  unlockCount: number;
  unlocked: boolean;
  unlockedAt: string | null;
}

export interface ArcadeAchievements {
  /**
   * Public. A locked secret badge arrives redacted to "Hidden achievement" / ❓
   * with its rarity count intact.
   */
  list(): Promise<
    ArcadeResult<{
      achievements: ArcadeAchievement[];
      total: number;
      unlockedCount: number;
      points: number;
      pointsTotal: number;
    }>
  >;
  /**
   * Idempotent and de-duplicated in memory: safe to call every frame, costs one
   * request ever. `firstTime` is your cue to celebrate.
   *
   * The slug must already exist — makers define achievements over MCP
   * (`define_achievements`); a game can never mint one.
   */
  unlock(
    slug: string,
  ): Promise<
    ArcadeResult<{
      slug: string;
      unlocked: boolean;
      firstTime: boolean;
      achievement?: ArcadeAchievement;
    }>
  >;
  /** Just the slugs, for restoring your own UI on load. */
  mine(): Promise<
    ArcadeResult<{
      unlocked: string[];
      unlockedAt: Record<string, string>;
      local?: boolean;
    }>
  >;
}

/* -------------------------------------------------------------------------- */
/*  Matches — async turn-based multiplayer                                     */
/* -------------------------------------------------------------------------- */

export type ArcadeMatchStatus = 'open' | 'active' | 'finished' | 'abandoned';

export interface ArcadeMatchPlayer {
  seat: number;
  player: ArcadePlayer;
  isYou: boolean;
}

export interface ArcadeMatch<TState = unknown, TResult = unknown> {
  id: string;
  /** The 8-character Crockford base32 join code. Goes `null` once spent. */
  code: string | null;
  status: ArcadeMatchStatus;
  maxPlayers: number;
  seatCount: number;
  currentSeat: number;
  turn: number;
  version: number;
  yourSeat: number | null;
  yourTurn: boolean;
  players: ArcadeMatchPlayer[];
  state: TState | null;
  result: TResult | null;
  createdAt: string;
  expiresAt: string;
  finishedAt: string | null;
}

/** A list entry: no `state`, no `result`. */
export type ArcadeMatchSummary = Omit<ArcadeMatch, 'state' | 'result'>;

export interface ArcadeMatchMove<TState = unknown, TResult = unknown> {
  /** The turn you believe you are playing. This plus your seat is the whole CC. */
  turn: number;
  move: unknown;
  /** The whole state, not a patch. 32 KiB cap. */
  state: TState;
  status?: ArcadeMatchStatus;
  result?: TResult | null;
  /** Optional; the default is round-robin over the occupied seats. */
  nextSeat?: number;
}

export interface ArcadeMatches {
  /** You are seat 0. `match.code` is the join code to show. */
  create<TState = unknown>(options?: {
    maxPlayers?: number;
    state?: TState;
  }): Promise<ArcadeResult<{ match: ArcadeMatch<TState> }>>;
  /** One account, one seat — rejoining returns the seat you already hold. */
  join<TState = unknown>(code: string): Promise<ArcadeResult<{ match: ArcadeMatch<TState> }>>;
  /** Your matches in this game, as summaries. */
  list(options?: {
    status?: ArcadeMatchStatus;
  }): Promise<ArcadeResult<{ matches: ArcadeMatchSummary[] }>>;
  /** `changed: false` means nothing moved since that version and `match` is null. */
  get<TState = unknown>(
    matchId: string,
    options?: { since?: number },
  ): Promise<ArcadeResult<{ changed: boolean; match: ArcadeMatch<TState> | null; version: number }>>;
  /** Wrong seat, stale turn or a closed match all resolve `CONFLICT`. */
  move<TState = unknown>(
    matchId: string,
    move: ArcadeMatchMove<TState>,
  ): Promise<ArcadeResult<{ match: ArcadeMatch<TState> }>>;
  /** An open match loses your seat; an active one becomes `abandoned`. */
  leave(
    matchId: string,
  ): Promise<ArcadeResult<{ matchId: string; status: ArcadeMatchStatus }>>;
  /**
   * Polls every 3s, backs off to 15s once nothing has happened for ten polls,
   * pauses while the tab is hidden, and stops for good when the match ends.
   * Returns an unsubscribe function.
   */
  watch<TState = unknown>(
    matchId: string,
    onChange: (match: ArcadeMatch<TState>) => void,
  ): () => void;
}

/* -------------------------------------------------------------------------- */
/*  The arcade object                                                          */
/* -------------------------------------------------------------------------- */

export interface Arcade {
  readonly version: string;
  readonly protocol: number;
  /** True when a host answered the handshake. False means local mode. */
  readonly online: boolean;
  readonly player: ArcadePlayer;
  readonly capabilities: ArcadeCapabilities;
  readonly saves: ArcadeSaves;
  readonly scores: ArcadeScores;
  readonly matches: ArcadeMatches;
  readonly achievements: ArcadeAchievements;
  /** Re-ask the host who is playing. Handy after a sign-in in another tab. */
  refresh(): Promise<ArcadeResult<{ player: ArcadePlayer }>>;
}

export {};
