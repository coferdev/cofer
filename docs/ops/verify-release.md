# cofer-ops verify-release

Checks that what the server serves is byte for byte a fresh build of a public release.

```bash
cofer-ops verify-release update-07 --site https://<signer site> --dashboard https://<dashboard site>
```

It clones the public tag into a throwaway folder, installs and builds it, and compares SHA-256 hashes of:

- `/assets/signer.js`, and `/assets/wallet.js` when Connect wallet is on;
- every file of the dashboard site (when `--dashboard` or `DASHBOARD_URL` is given).

Exit code 0 when every file matches, 1 when any differs (each one is named). Read-only.

## Check it yourself, without the server's tools

`GET /v1/status` lists the served scripts' hashes in `bundles` (`signerJs`, `walletJs`). Clone the release tag, then
in `services/`:

```bash
bun install --frozen-lockfile
bun -e 'const s = await import("./src/api/server.ts"); console.log(new Bun.CryptoHasher("sha256").update(await s.buildSignerBundle()).digest("hex"))'
```

The printed hash must equal `bundles.signerJs`.
