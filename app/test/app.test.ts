import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { COFR_CA, COFR_LINE } from '../src/cofr';
import { routeFromHash, ROUTES } from '../src/routes';

describe('app scaffold', () => {
  test('the $COFR line is the same as the bot and README use', () => {
    const services = readFileSync(join(import.meta.dir, '../../services/src/core/cofr.ts'), 'utf8');
    expect(services).toContain(`"${COFR_CA}"`);
    expect(COFR_LINE).toBe(`$COFR contract address (Robinhood Chain): ${COFR_CA}. Only this address is ours; any other token with the same ticker is not Cofer.`);
  });
  test('routes: known hashes open their screen, anything else opens Home', () => {
    expect(ROUTES.map((r) => r.path)).toEqual(['home', 'arena', 'boards', 'profile']);
    expect(routeFromHash('#/arena')).toBe('arena');
    expect(routeFromHash('#/boards?x=1')).toBe('boards');
    expect(routeFromHash('')).toBe('home');
    expect(routeFromHash('#/nope')).toBe('home');
  });
  test('the build is served under /app/ with hashed asset names', () => {
    const cfg = readFileSync(join(import.meta.dir, '../vite.config.ts'), 'utf8');
    expect(cfg).toContain("base: '/app/'");
    expect(cfg).toContain('[name]-[hash]');
  });
});

import { screenFromHash } from '../src/routes';
import { nextNonce, units } from '../src/arena/order';
import { chips, left, price } from '../src/arena/format';

describe('arena screens: routes, order amounts, display', () => {
  test('the bot link and a game open their screens', () => {
    expect(screenFromHash('#/login?t=abc.def')).toEqual({ name: 'login', token: 'abc.def' });
    expect(screenFromHash('#/live/app-20261120T214314-643d3a9e')).toEqual({ name: 'live', game: 'app-20261120T214314-643d3a9e' });
    expect(screenFromHash('#/live/<script>')).toEqual({ name: 'home' });
    expect(screenFromHash('#/arena')).toEqual({ name: 'arena' });
  });
  test('typed amounts become exact integers, never floats; junk is refused', () => {
    expect(units('0.1', 8)).toBe(10_000_000n);
    expect(units('2,000', 6)).toBe(2_000_000_000n);
    expect(units('59213.6', 8)).toBe(5_921_360_000_000n);
    for (const bad of ['', '0', '-1', '1e3', '0.123456789', 'abc', '1.']) expect(units(bad, 8)).toBeNull();
  });
  test('nonces only go up, even for two orders in the same millisecond', () => {
    const a = nextNonce(1_000);
    const b = nextNonce(1_000);
    const c = nextNonce(999);
    expect(b > a && c > b).toBe(true);
  });
  test('display: chips at 1e6, prices at 1e8, time left', () => {
    expect(chips('10000000000')).toBe('10,000.00');
    expect(chips('-1500000')).toBe('-1.50');
    expect(price('5921360000000')).toBe('59,213.60');
    expect(left(61_000)).toBe('1:01');
    expect(left(3_723_000)).toBe('1:02:03');
  });
});
