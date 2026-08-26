/*!
 * Arcade SDK 1.0.0 — https://aimade.games/docs/arcade
 *
 * Drop this in a game and you get identity, save states, leaderboards,
 * async multiplayer and achievements:
 *
 *   <script src="https://aimade.games/arcade.js"></script>
 *   <script>
 *     Arcade.ready().then(function (arcade) {
 *       console.log(arcade.player.username || 'guest');
 *     });
 *   </script>
 *
 * Three promises this file keeps, because a game cannot ship without them:
 *
 *  1. **Nothing throws.** Every method resolves to `{ ok: true, ... }` or
 *     `{ ok: false, reason, message }`. Bad arguments resolve `INVALID`; they
 *     do not throw a TypeError into your game loop.
 *  2. **It works outside the arcade.** Opened on GitHub Pages, on localhost or
 *     in a plain tab, no parent answers the handshake within 3 seconds and the
 *     SDK enters local mode: `online === false`, saves fall back to
 *     `localStorage`, everything else resolves `{ ok: false }` instead of
 *     hanging. `Arcade.ready()` always resolves.
 *  3. **It works signed out.** `player.isGuest` is true, saves are local, and
 *     every server write resolves `{ ok: false, reason: 'SIGNED_OUT' }`.
 *
 * One thing it deliberately does NOT do: trust the parent. The host page hands
 * this SDK display data, never credentials, and a hostile third-party embedder
 * could frame your game and lie about who is playing. Nothing here depends on
 * the parent being honest, and neither should your game's rules.
 */
(function () {
  'use strict';

  var VERSION = '1.0.0';
  var PROTOCOL = 1;

  var HANDSHAKE_TIMEOUT_MS = 3000;
  var HELLO_INTERVAL_MS = 150;
  var REQUEST_TIMEOUT_MS = 10000;
  var SLOW_REQUEST_TIMEOUT_MS = 15000;
  var SLOW_METHODS = { 'matches.move': 1, 'matches.create': 1 };

  var WATCH_INTERVAL_MS = 3000;
  var WATCH_MAX_INTERVAL_MS = 15000;
  var WATCH_BACKOFF = 1.5;
  var WATCH_UNCHANGED_BEFORE_BACKOFF = 10;

  var PENDING_SCORES_MAX = 20;
  var SAVE_PREFIX = 'arcade.save.';
  var UNLOCK_KEY = 'arcade.unlocked.';

  /* ---------------------------------------------------------------------- */
  /*  Shapes                                                                 */
  /* ---------------------------------------------------------------------- */

  var GUEST = {
    id: null,
    username: null,
    displayName: null,
    avatarUrl: null,
    isGuest: true,
  };

  var LOCAL_CAPABILITIES = {
    features: {
      identity: true,
      saves: false,
      scores: false,
      matches: false,
      achievements: false,
      writes: false,
    },
    methods: [],
    limits: {
      saveBytes: 65536,
      saveSlots: 8,
      scoreMetaBytes: 2048,
      matchStateBytes: 32768,
      matchMoveBytes: 8192,
      matchMaxPlayers: 8,
      achievementsPerGame: 100,
    },
  };

  function ok(extra) {
    var out = { ok: true };
    if (extra) for (var k in extra) if (has(extra, k)) out[k] = extra[k];
    return out;
  }

  function fail(reason, message, extra) {
    var out = { ok: false, reason: reason, message: message || reason };
    if (extra) for (var k in extra) if (has(extra, k)) out[k] = extra[k];
    return out;
  }

  function has(o, k) {
    return Object.prototype.hasOwnProperty.call(o, k);
  }

  function isObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  function resolved(value) {
    return new Promise(function (r) {
      r(value);
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  Local storage — the fallback that makes a game work anywhere           */
  /* ---------------------------------------------------------------------- */

  var localUnlocked = {};
  var pendingScores = [];

  function storage() {
    try {
      var s = window.localStorage;
      // Safari in private mode hands you an object that throws on write.
      s.setItem('arcade.probe', '1');
      s.removeItem('arcade.probe');
      return s;
    } catch {
      return null;
    }
  }

  function saveKey(slot) {
    var path = '/';
    try {
      path = window.location.pathname || '/';
    } catch {
      /* about:srcdoc and friends */
    }
    return SAVE_PREFIX + path + '.' + slot;
  }

  function byteLength(s) {
    try {
      return new TextEncoder().encode(s).length;
    } catch {
      return s.length;
    }
  }

  function localSaveList() {
    var store = storage();
    var slots = [];
    if (!store) return slots;
    var prefix = saveKey('');
    for (var i = 0; i < store.length; i++) {
      var key = store.key(i);
      if (!key || key.indexOf(prefix) !== 0) continue;
      var raw = store.getItem(key);
      var parsed = null;
      try {
        parsed = JSON.parse(raw);
      } catch {
        continue;
      }
      if (!isObject(parsed)) continue;
      slots.push({
        slot: key.slice(prefix.length),
        sizeBytes: byteLength(JSON.stringify(parsed.data)),
        updatedAt: parsed.updatedAt || null,
      });
    }
    return slots;
  }

  function localSaveGet(slot) {
    var store = storage();
    if (!store) return { slot: slot, data: null, updatedAt: null };
    var raw = store.getItem(saveKey(slot));
    if (!raw) return { slot: slot, data: null, updatedAt: null };
    try {
      var parsed = JSON.parse(raw);
      return {
        slot: slot,
        data: isObject(parsed) ? parsed.data : null,
        updatedAt: isObject(parsed) ? parsed.updatedAt || null : null,
      };
    } catch {
      return { slot: slot, data: null, updatedAt: null };
    }
  }

  function localSaveSet(slot, data) {
    var store = storage();
    var updatedAt = new Date().toISOString();
    var body = JSON.stringify({ data: data === undefined ? null : data, updatedAt: updatedAt });
    if (store) {
      try {
        store.setItem(saveKey(slot), body);
      } catch {
        return fail('TOO_LARGE', 'This browser refused to store that save.');
      }
    }
    // The size a game is told is the size of its own data, exactly as the
    // server counts it — the envelope this file wraps it in is our business.
    return ok({
      slot: slot,
      sizeBytes: byteLength(JSON.stringify(data === undefined ? null : data)),
      updatedAt: updatedAt,
      local: true,
    });
  }

  function localSaveRemove(slot) {
    var store = storage();
    var existed = false;
    if (store) {
      existed = store.getItem(saveKey(slot)) !== null;
      try {
        store.removeItem(saveKey(slot));
      } catch {
        /* nothing to do */
      }
    }
    return ok({ slot: slot, removed: existed, local: true });
  }

  function localUnlockKey() {
    var path = '/';
    try {
      path = window.location.pathname || '/';
    } catch {
      /* ignore */
    }
    return UNLOCK_KEY + path;
  }

  function loadLocalUnlocks() {
    var store = storage();
    if (!store) return;
    try {
      var parsed = JSON.parse(store.getItem(localUnlockKey()) || '{}');
      if (isObject(parsed)) localUnlocked = parsed;
    } catch {
      localUnlocked = {};
    }
  }

  function rememberLocalUnlock(slug) {
    if (has(localUnlocked, slug)) return false;
    localUnlocked[slug] = new Date().toISOString();
    var store = storage();
    if (store) {
      try {
        store.setItem(localUnlockKey(), JSON.stringify(localUnlocked));
      } catch {
        /* a full quota is not worth failing an unlock over */
      }
    }
    return true;
  }

  /* ---------------------------------------------------------------------- */
  /*  Transport                                                              */
  /* ---------------------------------------------------------------------- */

  var pending = {};
  var seq = 0;
  var parentOrigin = null;
  var online = false;
  var player = GUEST;
  var capabilities = LOCAL_CAPABILITIES;

  function onMessage(event) {
    var data = event && event.data;
    if (!isObject(data)) return;
    if (data.arcade !== PROTOCOL) return;
    // Unknown `t` values are ignored on purpose so a future host can add
    // pushed events without breaking a game built against v1.
    if (data.t !== 'res') return;
    if (parentOrigin && event.origin !== parentOrigin) return;
    var entry = pending[data.id];
    if (!entry) return;
    delete pending[data.id];
    entry(data, event.origin);
  }

  function post(message, origin) {
    try {
      window.parent.postMessage(message, origin);
      return true;
    } catch {
      return false;
    }
  }

  /** One request. Resolves — never rejects, never hangs past its timeout. */
  function rpc(method, payload) {
    return new Promise(function (resolve) {
      seq += 1;
      var id = 'a' + seq + '-' + Math.random().toString(36).slice(2, 8);
      var budget = SLOW_METHODS[method]
        ? SLOW_REQUEST_TIMEOUT_MS
        : REQUEST_TIMEOUT_MS;

      var timer = setTimeout(function () {
        delete pending[id];
        resolve(fail('TIMEOUT', 'The arcade did not answer in time.'));
      }, budget);

      pending[id] = function (response) {
        clearTimeout(timer);
        if (response.ok === true) {
          resolve({ ok: true, result: response.result });
          return;
        }
        var error = isObject(response.error) ? response.error : {};
        resolve(
          fail(
            error.code || 'UNAVAILABLE',
            error.message,
            error.retryAfterMs ? { retryAfterMs: error.retryAfterMs } : null,
          ),
        );
      };

      var sent = post(
        {
          arcade: PROTOCOL,
          t: 'req',
          id: id,
          method: method,
          payload: payload === undefined ? {} : payload,
        },
        parentOrigin || '*',
      );
      if (!sent) {
        clearTimeout(timer);
        delete pending[id];
        resolve(fail('UNAVAILABLE', 'The arcade could not be reached.'));
      }
    });
  }

  /**
   * Send, unless there is a reason not to.
   *
   * Local mode and unsupported methods are answered here without a round trip:
   * `capabilities.methods` is the discovery mechanism that lets a newer SDK run
   * against an older host and get a clean `UNSUPPORTED_METHOD` instead of a
   * silent hang.
   */
  function call(method, payload) {
    if (!online) {
      return resolved(fail('UNAVAILABLE', 'This game is not running in the arcade.'));
    }
    if (capabilities.methods.indexOf(method) === -1) {
      return resolved(
        fail('UNSUPPORTED_METHOD', 'This player does not support ' + method + '.'),
      );
    }
    return rpc(method, payload);
  }

  /* ---------------------------------------------------------------------- */
  /*  Handshake                                                              */
  /* ---------------------------------------------------------------------- */

  var readyPromise = null;

  function handshake() {
    return new Promise(function (resolve) {
      var settled = false;
      var ticker = null;

      function finish() {
        if (settled) return;
        settled = true;
        if (ticker) clearInterval(ticker);
        clearTimeout(deadline);
        delete pending.hello;
        resolve();
      }

      pending.hello = function (response, origin) {
        if (response.ok === true && isObject(response.result)) {
          // The origin is pinned from the *event*, not from the body field:
          // a body can claim anything, an origin cannot be forged.
          parentOrigin = origin;
          online = true;
          var init = response.result;
          if (isObject(init.player)) player = init.player;
          if (isObject(init.capabilities)) capabilities = init.capabilities;
        }
        finish();
      };

      var deadline = setTimeout(function () {
        // Nobody answered: the game was opened outside the arcade. Local mode.
        finish();
      }, HANDSHAKE_TIMEOUT_MS);

      function hello() {
        post(
          {
            arcade: PROTOCOL,
            t: 'req',
            id: 'hello',
            method: 'system.hello',
            payload: { sdk: VERSION },
          },
          '*',
        );
      }

      // Assign the ticker before the first hello: a host that answers
      // synchronously would otherwise reach finish() while ticker is still
      // null, leaving the interval to fire forever.
      ticker = setInterval(hello, HELLO_INTERVAL_MS);
      hello();
    });
  }

  /* ---------------------------------------------------------------------- */
  /*  API                                                                    */
  /* ---------------------------------------------------------------------- */

  function badArg(message) {
    return resolved(fail('INVALID', message));
  }

  function slotOk(slot) {
    return typeof slot === 'string' && /^[a-z0-9_-]{1,32}$/.test(slot);
  }

  /** Saves are local whenever there is no account behind them. */
  function savesAreLocal() {
    return !online || player.isGuest === true;
  }

  var saves = {
    list: function () {
      if (savesAreLocal()) return resolved(ok({ slots: localSaveList(), local: true }));
      return call('saves.list').then(function (res) {
        if (!res.ok) return res;
        return ok({ slots: (res.result && res.result.slots) || [] });
      });
    },

    get: function (slot) {
      if (!slotOk(slot)) return badArg('Slot names are 1-32 chars of a-z, 0-9, _ or -.');
      if (savesAreLocal()) return resolved(ok(localSaveGet(slot)));
      return call('saves.get', { slot: slot }).then(function (res) {
        // An empty slot is not an error a game should have to branch on.
        if (!res.ok && res.reason === 'NOT_FOUND') {
          return ok({ slot: slot, data: null, updatedAt: null });
        }
        if (!res.ok) return res;
        return ok(res.result);
      });
    },

    set: function (slot, data) {
      if (!slotOk(slot)) return badArg('Slot names are 1-32 chars of a-z, 0-9, _ or -.');
      if (savesAreLocal()) return resolved(localSaveSet(slot, data));
      return call('saves.set', { slot: slot, data: data === undefined ? null : data }).then(
        function (res) {
          return res.ok ? ok(res.result) : res;
        },
      );
    },

    remove: function (slot) {
      if (!slotOk(slot)) return badArg('Slot names are 1-32 chars of a-z, 0-9, _ or -.');
      if (savesAreLocal()) return resolved(localSaveRemove(slot));
      return call('saves.remove', { slot: slot }).then(function (res) {
        return res.ok ? ok(res.result) : res;
      });
    },
  };

  var scores = {
    submit: function (score, meta) {
      if (typeof score !== 'number' || !isFinite(score) || Math.floor(score) !== score) {
        return badArg('A score must be a whole number.');
      }
      if (!online) {
        pendingScores.push({ score: score, meta: meta || null, at: new Date().toISOString() });
        if (pendingScores.length > PENDING_SCORES_MAX) {
          pendingScores.splice(0, pendingScores.length - PENDING_SCORES_MAX);
        }
        return resolved(
          fail('UNAVAILABLE', 'Scores are recorded locally until you play in the arcade.', {
            local: true,
          }),
        );
      }
      return call('scores.submit', { score: score, meta: meta === undefined ? null : meta }).then(
        function (res) {
          return res.ok ? ok(res.result) : res;
        },
      );
    },

    top: function (options) {
      var o = isObject(options) ? options : {};
      var payload = {};
      if (typeof o.limit === 'number') payload.limit = o.limit;
      if (typeof o.period === 'string') payload.period = o.period;
      return call('scores.top', payload).then(function (res) {
        return res.ok ? ok(res.result) : res;
      });
    },

    me: function (options) {
      var o = isObject(options) ? options : {};
      var payload = {};
      if (typeof o.period === 'string') payload.period = o.period;
      return call('scores.me', payload).then(function (res) {
        return res.ok ? ok(res.result) : res;
      });
    },

    /** Runs recorded while offline, oldest first. Bounded, never persisted. */
    pending: function () {
      return pendingScores.slice();
    },
  };

  function matchResult(res) {
    return res.ok ? ok({ match: res.result }) : res;
  }

  var matches = {
    create: function (options) {
      var o = isObject(options) ? options : {};
      if (typeof o.maxPlayers !== 'number') {
        return badArg('maxPlayers is required and must be a number.');
      }
      return call('matches.create', {
        maxPlayers: o.maxPlayers,
        state: o.state === undefined ? {} : o.state,
      }).then(matchResult);
    },

    join: function (code) {
      if (typeof code !== 'string' || !code) return badArg('A join code is required.');
      return call('matches.join', { code: code }).then(matchResult);
    },

    list: function (options) {
      var o = isObject(options) ? options : {};
      var payload = {};
      if (typeof o.status === 'string') payload.status = o.status;
      return call('matches.list', payload).then(function (res) {
        return res.ok ? ok({ matches: (res.result && res.result.matches) || [] }) : res;
      });
    },

    get: function (matchId, options) {
      if (typeof matchId !== 'string' || !matchId) return badArg('A match id is required.');
      var o = isObject(options) ? options : {};
      var payload = { matchId: matchId };
      if (typeof o.since === 'number') payload.since = o.since;
      return call('matches.get', payload).then(function (res) {
        if (!res.ok) return res;
        var body = res.result;
        if (isObject(body) && body.changed === false) {
          return ok({ changed: false, version: body.version, match: null });
        }
        return ok({ changed: true, match: body });
      });
    },

    move: function (matchId, move) {
      if (typeof matchId !== 'string' || !matchId) return badArg('A match id is required.');
      var m = isObject(move) ? move : {};
      if (typeof m.turn !== 'number') return badArg('A move needs the turn it is playing.');
      var payload = {
        matchId: matchId,
        turn: m.turn,
        move: m.move === undefined ? null : m.move,
        state: m.state === undefined ? {} : m.state,
        status: typeof m.status === 'string' ? m.status : 'active',
      };
      if (typeof m.nextSeat === 'number') payload.nextSeat = m.nextSeat;
      if (m.result !== undefined) payload.result = m.result;
      return call('matches.move', payload).then(matchResult);
    },

    leave: function (matchId) {
      if (typeof matchId !== 'string' || !matchId) return badArg('A match id is required.');
      return call('matches.leave', { matchId: matchId }).then(function (res) {
        return res.ok ? ok(res.result) : res;
      });
    },

    /**
     * Poll a match and call back whenever it moves. Returns an unsubscribe.
     *
     * Deliberately modest: 3s while it is somebody else's turn, backing off to
     * 15s once nothing has happened for ten polls, paused entirely while the
     * tab is hidden, and stopped for good once the match finishes. There is no
     * socket in v1 — and when there is one, this is the callback it fills, so a
     * game written against this upgrades for free.
     */
    watch: function (matchId, onChange) {
      var stopped = false;
      var timer = null;
      var version = -1;
      var unchanged = 0;
      var interval = WATCH_INTERVAL_MS;

      if (typeof matchId !== 'string' || !matchId || typeof onChange !== 'function') {
        return function () {};
      }

      function schedule() {
        if (stopped) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(tick, interval);
      }

      function hidden() {
        try {
          return document.visibilityState === 'hidden';
        } catch {
          return false;
        }
      }

      function tick() {
        if (stopped || hidden()) return;
        if (!online) {
          // Nothing to poll outside the arcade; polling anyway would just burn
          // a timer forever in a game that is working perfectly well offline.
          stopped = true;
          return;
        }
        matches.get(matchId, version >= 0 ? { since: version } : undefined).then(function (res) {
          if (stopped) return;
          if (res.ok && res.changed && isObject(res.match)) {
            version = typeof res.match.version === 'number' ? res.match.version : version;
            unchanged = 0;
            interval = WATCH_INTERVAL_MS;
            try {
              onChange(res.match);
            } catch {
              /* a game's callback throwing is a game's business */
            }
            if (res.match.status === 'finished' || res.match.status === 'abandoned') {
              stopped = true;
              return;
            }
          } else {
            unchanged += 1;
            if (unchanged >= WATCH_UNCHANGED_BEFORE_BACKOFF) {
              interval = Math.min(WATCH_MAX_INTERVAL_MS, interval * WATCH_BACKOFF);
            }
          }
          schedule();
        });
      }

      function onVisible() {
        if (stopped || hidden()) return;
        // Coming back to the tab should feel instant, not "in three seconds".
        tick();
      }

      try {
        document.addEventListener('visibilitychange', onVisible);
      } catch {
        /* no document: nothing to pause for */
      }

      tick();

      return function () {
        stopped = true;
        if (timer) clearTimeout(timer);
        try {
          document.removeEventListener('visibilitychange', onVisible);
        } catch {
          /* ignore */
        }
      };
    },
  };

  var sessionUnlocked = {};

  var achievements = {
    list: function () {
      if (!online) return resolved(ok({ achievements: [], total: 0, unlockedCount: 0, points: 0, pointsTotal: 0 }));
      return call('achievements.list').then(function (res) {
        if (!res.ok) return res;
        var body = isObject(res.result) ? res.result : {};
        return ok({
          achievements: body.achievements || [],
          total: body.total || 0,
          unlockedCount: body.unlockedCount || 0,
          points: body.points || 0,
          pointsTotal: body.pointsTotal || 0,
        });
      });
    },

    /**
     * Fire-and-forget safe. A slug already unlocked in this session resolves
     * immediately and sends nothing, so calling this every frame costs exactly
     * one request, ever.
     */
    unlock: function (slug) {
      if (typeof slug !== 'string' || !slug) return badArg('An achievement slug is required.');
      if (has(sessionUnlocked, slug)) {
        return resolved(ok({ slug: slug, unlocked: true, firstTime: false }));
      }
      if (!online) {
        var isNew = rememberLocalUnlock(slug);
        return resolved(
          fail('UNAVAILABLE', 'Unlocks are kept locally outside the arcade.', {
            local: true,
            slug: slug,
            firstTime: isNew,
          }),
        );
      }
      return call('achievements.unlock', { slug: slug }).then(function (res) {
        if (res.ok) {
          sessionUnlocked[slug] = true;
          return ok(res.result);
        }
        return res;
      });
    },

    mine: function () {
      if (!online) {
        var slugs = [];
        for (var slug in localUnlocked) if (has(localUnlocked, slug)) slugs.push(slug);
        return resolved(ok({ unlocked: slugs, unlockedAt: localUnlocked, local: true }));
      }
      return call('achievements.mine').then(function (res) {
        if (!res.ok) return res;
        var body = isObject(res.result) ? res.result : {};
        return ok({ unlocked: body.unlocked || [], unlockedAt: body.unlockedAt || {} });
      });
    },
  };

  /* ---------------------------------------------------------------------- */
  /*  Bootstrap                                                              */
  /* ---------------------------------------------------------------------- */

  var api = {
    version: VERSION,
    protocol: PROTOCOL,
    online: false,
    player: GUEST,
    capabilities: LOCAL_CAPABILITIES,
    saves: saves,
    scores: scores,
    matches: matches,
    achievements: achievements,
    /** Ask the host again — handy after a sign-in in another tab. */
    refresh: function () {
      return call('player.get').then(function (res) {
        if (res.ok && isObject(res.result)) {
          player = res.result;
          api.player = player;
        }
        return res.ok ? ok({ player: api.player }) : res;
      });
    },
  };

  /** Idempotent: the same object, every time, and the handshake runs once. */
  function ready() {
    if (readyPromise) return readyPromise;
    loadLocalUnlocks();
    try {
      window.addEventListener('message', onMessage);
    } catch {
      /* no window: nothing will answer, and local mode is the answer */
    }
    readyPromise = handshake().then(function () {
      api.online = online;
      api.player = player;
      api.capabilities = capabilities;
      return api;
    });
    return readyPromise;
  }

  window.Arcade = {
    version: VERSION,
    protocol: PROTOCOL,
    ready: ready,
  };
})();
