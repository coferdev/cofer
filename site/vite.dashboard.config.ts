// The dashboard build (dashboard.getcofer.com and testdashboard.getcofer.com): `npm run build:dashboard`.
// It writes only site/dashboard-dist/ and never touches site/dist/ (getcofer.com). The output holds no
// network settings: each server puts its own config.json next to it (site/dashboard/config.*.json).
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const out = here('./dashboard-dist');

/** The logo the pages use, copied from the site's existing asset (no second copy in the repo). */
function copyMark(): Plugin {
  return {
    name: 'cofer-copy-mark',
    closeBundle() {
      mkdirSync(`${out}/assets`, { recursive: true });
      copyFileSync(here('./dist/assets/cofer-mark.png'), `${out}/assets/cofer-mark.png`);
      if (existsSync(`${out}/config.json`)) throw new Error('dashboard-dist must not contain a config.json: it belongs to each server');
    },
  };
}

export default defineConfig({
  root: here('./dashboard'),
  publicDir: false,
  plugins: [react(), tailwindcss(), copyMark()],
  // links.ts (the getcofer.com bot link) is swapped for an empty stand-in: the bot comes from config.json
  resolve: {
    alias: [
      { find: /^@\/lib\/links$/, replacement: here('./dashboard/no-links.ts') },
      { find: '@', replacement: here('./src') },
    ],
  },
  build: {
    outDir: out,
    emptyOutDir: true,
    cssCodeSplit: false,
    rollupOptions: {
      input: {
        index: here('./dashboard/index.html'),
        dashboard: here('./dashboard/dashboard.html'),
        'dashboard-overview': here('./dashboard/dashboard-overview.html'),
        'dashboard-metrics': here('./dashboard/dashboard-metrics.html'),
        'how-it-works': here('./dashboard/how-it-works.html'),
      },
      output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
});
