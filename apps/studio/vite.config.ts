import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// `--mode demo` produces one self-contained HTML file (fonts and scripts inlined)
// that can be emailed or opened from disk for investor demos.
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  // The Tauri CLI sets TAURI_ENV_PLATFORM for beforeDevCommand/beforeBuildCommand; plain `vite` keeps its defaults.
  const tauri = process.env.TAURI_ENV_PLATFORM !== undefined;
  const tauriHost = process.env.TAURI_DEV_HOST;
  // The workspace root hoists a newer vite (pulled in by vitest) that the plugins type against;
  // the runtime contract is identical, so bridge the duplicate type declarations here.
  const plugins = [react(), demo && viteSingleFile()] as unknown as PluginOption[];
  return {
    plugins,
    base: './',
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    build: {
      outDir: demo ? 'dist-demo' : 'dist',
      emptyOutDir: true,
      target: 'es2022',
      chunkSizeWarningLimit: 2000,
    },
    clearScreen: !tauri,
    server: tauri
      ? { port: 1420, strictPort: true, host: tauriHost || false, hmr: tauriHost ? { protocol: 'ws', host: tauriHost, port: 1421 } : undefined }
      : { strictPort: false },
  };
});
