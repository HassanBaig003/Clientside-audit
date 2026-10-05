import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

/** Static, read-only preview build: every import of ./api resolves to the embedded-data stand-in. */
const swapApi = (): Plugin => ({
  name: 'swap-api-for-preview',
  enforce: 'pre',
  async resolveId(source, importer) {
    if (!importer || !/^\.{1,2}\/api$/.test(source) || importer.endsWith('demoApi.ts')) return null;
    return path.resolve(__dirname, 'src/demoApi.ts');
  },
});

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [swapApi(), react()],
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir: path.resolve(__dirname, '../dist/preview'),
    emptyOutDir: true,
    cssCodeSplit: false,
    lib: { entry: path.resolve(__dirname, 'src/demo/main.tsx'), formats: ['iife'], name: 'WellowsAuditPreview', fileName: () => 'preview.js' },
  },
});
