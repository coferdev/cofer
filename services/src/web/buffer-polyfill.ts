/**
 * Browsers have no Node `Buffer`, but @zerodev/webauthn-key's toWebAuthnKey calls Buffer.from()
 * after passkey creation. Imported first in client.ts so it is set before any other bundle code runs.
 */
// Trailing slash: resolve the pinned npm package, not Bun's built-in node:buffer fallback.
import { Buffer } from "buffer/";

const g = globalThis as { Buffer?: unknown };
if (typeof g.Buffer === "undefined") g.Buffer = Buffer;
