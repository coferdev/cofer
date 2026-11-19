/**
 * The real $COFR token (Robinhood Chain mainnet, chain 4663), checked on-chain on 2026-11-19: symbol "COFR",
 * name "Cofer", 18 decimals. Several tokens with the same ticker appeared on launch day, so every place that names
 * the token says plainly that only this address is ours. Used in /start, /help, the README and the website.
 */
export const COFR_CA = "0x2edd2762ec5a928f749380309eca0e33941b3e3e";

export const COFR_LINE = `$COFR contract address (Robinhood Chain): ${COFR_CA}. Only this address is ours; any other token with the same ticker is not Cofer.`;
