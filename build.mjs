#!/usr/bin/env node
/**
 * Bundle the editor app. Deps are real npm packages, but they're bundled into
 * one file served same-origin by server.mjs — so `npx baz-for-claude` still
 * needs no build step and no CDN (the Claude pane blocks third-party loads).
 *
 *   node build.mjs          one-shot build
 *   node build.mjs --watch  rebuild on change during development
 */
import esbuild from 'esbuild';

const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: ['src/editor/main.tsx'],
  outfile: 'dist/editor.js',
  bundle: true,
  format: 'iife',      // plain <script src>; dynamic import(blobUrl) is syntax, survives iife
  target: 'es2022',
  jsx: 'automatic',
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  define: { 'process.env.NODE_ENV': watch ? '"development"' : '"production"' },
  logLevel: 'info',
};

if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
  console.log('watching src/editor/ …');
} else {
  await esbuild.build(opts);
}
