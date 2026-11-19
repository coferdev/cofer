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
