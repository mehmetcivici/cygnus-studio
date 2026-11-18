import { defineConfig, type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// `--mode demo` produces one self-contained HTML file (fonts and scripts inlined)
// that can be emailed or opened from disk for investor demos.
export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
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
    server: { strictPort: false },
  };
});
