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
