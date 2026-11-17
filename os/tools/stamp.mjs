// Version-stamps every asset the hub loads so a deploy is never served half-old.
//
// The site sits behind a CDN that caches .js and .css for hours. Without a
// version on each URL, a visitor can get the new stylesheet with an old script
// (or one new module importing an old one). Run this before every release:
//
//   node os/tools/stamp.mjs            # stamps with today's date + time
//   node os/tools/stamp.mjs 2026-11-18a
//
// It rewrites the ?v= on index.html's stylesheet/script links and on every
// relative import inside os/js. Every import of a module must carry the
// same stamp, otherwise the browser loads that module twice.
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const stamp = process.argv[2] || new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
if (!/^[\w.-]+$/.test(stamp)) throw new Error('stamp must be letters, digits, dot, dash or underscore');

const walk = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? walk(p) : p.endsWith('.js') ? [p] : [];
});

let files = 0;
for (const file of walk(join(root, 'js'))) {
  const src = readFileSync(file, 'utf8');
  // static `from './x.js'`, bare `import './x.js'`, and dynamic `import('./x.js')`
  const out = src.replace(/((?:from|import)\s*\(?\s*)(['"])(\.{1,2}\/[^'"?]+\.js)(?:\?v=[^'"]*)?\2/g,
    (_, lead, q, path) => `${lead}${q}${path}?v=${stamp}${q}`);
  if (out !== src) { writeFileSync(file, out); files++; }
}

const htmlPath = join(root, 'index.html');
const html = readFileSync(htmlPath, 'utf8');
const stamped = html.replace(/((?:href|src)=")((?:os(?:-[a-z]+)?\.css|js\/app\.js))(?:\?v=[^"]*)?"/g,
  (_, attr, path) => `${attr}${path}?v=${stamp}"`);
writeFileSync(htmlPath, stamped);

console.log(`stamped ${files} module files and index.html with v=${stamp}`);
