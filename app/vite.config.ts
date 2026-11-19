// The App build: served at /app on the passkey RP host (sign.getcofer.com on mainnet, test.getcofer.com on
// testnet), because existing passkeys are bound to that host (spec §6.2). Writes only app/dist/.
// Asset names carry a content hash, so every version lives at its own immutable path.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: '/app/',
  plugins: [react(), tailwindcss()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: { output: { entryFileNames: 'assets/[name]-[hash].js', chunkFileNames: 'assets/[name]-[hash].js', assetFileNames: 'assets/[name]-[hash][extname]' } },
  },
});
