/** The App's screens (spec §6.5). Hash routes, so the App works from any static host path. */
export const ROUTES = [
  { path: 'home', label: 'Home' },
  { path: 'arena', label: 'Arena' },
  { path: 'boards', label: 'Boards' },
  { path: 'profile', label: 'Profile' },
] as const;
export type RoutePath = (typeof ROUTES)[number]['path'];

export function routeFromHash(hash: string): RoutePath {
  const p = hash.replace(/^#\/?/, '').split(/[/?]/)[0] ?? '';
  return (ROUTES.find((r) => r.path === p)?.path ?? 'home') as RoutePath;
}

/** Screens that are not in the bottom bar: the sign-in link (#/login?t=…) and a game (#/live/<game id>). */
export type Screen = { name: RoutePath } | { name: 'login'; token: string } | { name: 'live'; game: string };

export function screenFromHash(hash: string): Screen {
  const h = hash.replace(/^#\/?/, '');
  const [path = '', query = ''] = h.split('?');
  const parts = path.split('/');
  if (parts[0] === 'login') return { name: 'login', token: new URLSearchParams(query).get('t') ?? '' };
  if (parts[0] === 'live' && parts[1] && /^[A-Za-z0-9-]{1,64}$/.test(parts[1])) return { name: 'live', game: parts[1] };
  return { name: routeFromHash(hash) };
}
