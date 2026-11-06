/**
 * The dashboard's runtime settings. One build serves testnet and mainnet: the network, explorer,
 * bot, site and API address are never compiled in. They come from /config.json, placed next to the
 * built files on each server (examples: site/dashboard/config.testnet.json and config.mainnet.json).
 */

export interface DashConfig {
  chainId: number;
  chainName: string;
  explorerUrl: string; // no trailing slash
  botUsername: string;
  siteUrl: string; // no trailing slash
  apiBase: string; // a path on this same address, e.g. /api/dashboard (no CORS, no other origin)
}

const https = (v: unknown) => typeof v === 'string' && /^https:\/\/[^\s/?#]+(\/[^\s?#]*)?$/.test(v);

/** Checks config.json; throws an Error naming every problem. */
export function parseConfig(x: unknown): DashConfig {
  const c = (x ?? {}) as Record<string, unknown>;
  const problems: string[] = [];
  if (!Number.isInteger(c.chainId) || (c.chainId as number) <= 0) problems.push('chainId must be a positive whole number');
  if (typeof c.chainName !== 'string' || !c.chainName.trim() || c.chainName.length > 60) problems.push('chainName is missing');
  if (!https(c.explorerUrl)) problems.push('explorerUrl must be an https address');
  if (typeof c.botUsername !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(c.botUsername)) problems.push('botUsername must be the bot username without @');
  if (!https(c.siteUrl)) problems.push('siteUrl must be an https address');
  if (typeof c.apiBase !== 'string' || !/^\/[A-Za-z0-9/_-]*$/.test(c.apiBase) || c.apiBase.startsWith('//')) problems.push('apiBase must be a path on this same address (see the config examples)');
  if (problems.length) throw new Error(`config.json: ${problems.join('; ')}`);
  const trim = (s: string) => s.replace(/\/+$/, '');
  return {
    chainId: c.chainId as number,
    chainName: (c.chainName as string).trim(),
    explorerUrl: trim(c.explorerUrl as string),
    botUsername: c.botUsername as string,
    siteUrl: trim(c.siteUrl as string),
    apiBase: trim(c.apiBase as string),
  };
}

export const botUrl = (c: Pick<DashConfig, 'botUsername'>) => `https://t.me/${c.botUsername}`;
export const txUrl = (c: Pick<DashConfig, 'explorerUrl'>, hash: string) => `${c.explorerUrl}/tx/${hash}`;
export const addressUrl = (c: Pick<DashConfig, 'explorerUrl'>, address: string) => `${c.explorerUrl}/address/${address}`;
