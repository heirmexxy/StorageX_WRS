// Builds the server, the CLI and the tests (TS/TSX -> ESM). Dependencies stay external (installed with npm).
import { build } from 'esbuild';

await build({
  entryPoints: { server: 'src/server.ts', cli: 'src/cli.ts', tests: 'tests/run.ts' },
  outdir: 'dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  jsx: 'automatic',
  packages: 'external',
  sourcemap: true,
  logLevel: 'warning',
  // CommonJS vendored code (QR encoder) needs require() inside an ES module.
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
console.log('Build complete');
