// arcade.js runs the way it ships: evaluated in a bare vm context, with a fake
// host on the other end of postMessage. No test framework, no dependencies.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const SOURCE = readFileSync(new URL('../arcade.js', import.meta.url), 'utf8');
const ORIGIN = 'https://aimade.games';

const INIT = {
  protocol: 1,
  host: 'aimade.games',
  origin: ORIGIN,
  player: { id: 'p1', username: 'maker', displayName: 'Maker', avatarUrl: null, isGuest: false },
  capabilities: {
    features: { identity: true, saves: true, scores: true, matches: true, achievements: true, writes: true },
    methods: ['matches.create', 'matches.join'],
    limits: {},
  },
};

/** Load the SDK with a host that answers the handshake and any scripted routes. */
function online(init, routes = {}) {
  const listeners = [];
  const seen = [];
  const answer = (id, body) =>
    queueMicrotask(() => {
      for (const fn of listeners) fn({ data: { arcade: 1, t: 'res', id, ...body }, origin: ORIGIN });
    });

  const win = {
    addEventListener: (type, fn) => type === 'message' && listeners.push(fn),
    removeEventListener() {},
    location: { pathname: '/game.html', origin: 'https://games.test' },
    localStorage: { length: 0, key: () => null, getItem: () => null, setItem() {}, removeItem() {} },
    parent: {
      postMessage(message) {
        seen.push(message);
        if (message.method === 'system.hello') answer(message.id, { ok: true, result: init });
        else answer(message.id, routes[message.method]?.(message.payload) ?? { ok: true, result: {} });
      },
    },
  };
  win.window = win;

  const context = vm.createContext({
    window: win,
    document: { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} },
    TextEncoder,
    console,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
  });
  vm.runInContext(SOURCE, context);
  return { Arcade: win.Arcade, seen };
}

const created = (seen) => seen.find((m) => m.method === 'matches.create').payload;

test('matches.create forwards a mode', async () => {
  const { Arcade, seen } = online(INIT);
  const arcade = await Arcade.ready();
  await arcade.matches.create({ maxPlayers: 2, mode: 'simultaneous' });
  assert.equal(created(seen).mode, 'simultaneous');
});

test('matches.create omits mode when the game names none, so the match stays alternating', async () => {
  const { Arcade, seen } = online(INIT);
  const arcade = await Arcade.ready();
  await arcade.matches.create({ maxPlayers: 2 });
  assert.equal('mode' in created(seen), false);
});

test('matches.pendingCode carries the invite code from the handshake', async () => {
  const { Arcade } = online({ ...INIT, pendingJoinCode: 'K7Q2M8XR' });
  const arcade = await Arcade.ready();
  assert.equal(arcade.matches.pendingCode, 'K7Q2M8XR');
});

test('matches.pendingCode is null when the host sends no code', async () => {
  const { Arcade } = online(INIT);
  const arcade = await Arcade.ready();
  assert.equal(arcade.matches.pendingCode, null);
});

test('matches.pendingCode ignores a code that is not a string', async () => {
  const { Arcade } = online({ ...INIT, pendingJoinCode: 42 });
  const arcade = await Arcade.ready();
  assert.equal(arcade.matches.pendingCode, null);
});
