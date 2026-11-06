# Cofer website

The landing page uses the user's Ordoo Framer components. Most navigation links scroll to landing-page sections; How it works opens a separate page. The dashboard has distinct Overview, Accounts, Metrics, and Leaderboard pages. The supplied 3D box loader, interactive hover button, draggable widget grid, and Ink Orbit diagrams are adapted to Cofer's monochrome palette.

## Development

The project is configured for React, TypeScript, Tailwind CSS v4 and shadcn-compatible components. Install and build with:

```sh
npm ci --ignore-scripts
npm run typecheck
npm run build:ui
python3 -m http.server 4173 --directory dist
```

Open `http://localhost:4173/`. Source components live in `src/components/ui`, styles in `src/styles`, and the `@/components/ui` alias resolves to that component directory. Keeping shared UI components there makes shadcn imports and future registry additions consistent. `components.json` already configures the shadcn aliases and Tailwind stylesheet; for a new project, `npx shadcn@latest init` can create an equivalent setup. Tailwind, TypeScript, Framer Motion, lucide-react, and border-beam are declared in `package.json`. This project uses Tailwind v4, so theme tokens are defined in `src/styles/ui.css` rather than the legacy Tailwind v3 configuration plugin. The supplied navigation and border components live in `src/components/ui`.

## Serving

The site is served at https://getcofer.com from `dist/` (static files only; `src/` and `node_modules/` are never served). Every call to action opens the bot, https://t.me/coferappbot.

What builds what:
- `npm run build:ui` rebuilds only `dist/assets/ui/` (the dashboard and How it works pages, and the landing-page header) from `src/`.
- The landing page body is a Framer export edited in place: `dist/index.html`, `dist/assets/ordoo/` and `dist/assets/cofer-overlay.js` (which points links at their destinations by label).

The dashboard pages (`dashboard*.html`) show placeholder data until they are wired to the indexer. They are not linked from anywhere and are marked `noindex`. To link them again, set `DASHBOARD_LIVE` in `src/lib/links.ts` to `true`, rebuild, and add the links back in the landing page.

## Dashboard data

The deployed output is in `dist/`. Account state, proposals and widget order are stored in the browser. The interface is not connected to accounts, wallets, Telegram, live prices, contracts, passkeys or transactions; input prices are manually supplied and no oracle, issuer, liquidity or signature validation is performed. The supplied PDFs remain source material and are not published on the site.
