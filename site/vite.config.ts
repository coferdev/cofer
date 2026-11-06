import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({ plugins:[react(),tailwindcss()], resolve:{alias:{'@':fileURLToPath(new URL('./src',import.meta.url))}}, build:{outDir:'dist/assets/ui',emptyOutDir:true,cssCodeSplit:false,rollupOptions:{input:{dashboard:'src/dashboard.tsx',shared:'src/shared.tsx'},output:{entryFileNames:'[name].js',chunkFileNames:'[name]-[hash].js',assetFileNames:'[name][extname]'}}} });
