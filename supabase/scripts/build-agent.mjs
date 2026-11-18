// Builds the `agent` edge function for deployment.
//
// Why: the function's source (agent/*.ts + _shared/*.ts, ~300 KB) is too large to send through the
// deploy tool in one go, and the deploy bundler refuses imports from the project's own storage host.
// So the code is bundled here into one plain script, uploaded to the public `fn-src` storage bucket
// under its SHA-256, and the deployed entry (`dist/agent-entry.ts`) is a small loader that imports
// the SDKs, fetches that exact file at cold start, checks its SHA-256 against the value baked into
// the entry, and only then runs it. A changed or swapped file is refused.
//
// Run: node supabase/scripts/build-agent.mjs <path-to-esbuild> [function, default agent]
//   → supabase/dist/<fn>.js (upload to fn-src/<fn>/<sha16>.js) and supabase/dist/<fn>-entry.ts (deploy as <fn>/index.ts)
// The same method serves the `gdrive` function (its shared module is also too large for one deploy call).
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = process.argv[2] || "esbuild";
const fn = process.argv[3] || "agent";
if (!/^[a-z][a-z0-9-]*$/.test(fn)) throw new Error("bad function name");
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const raw = join(dist, `${fn}.esm.js`);
execFileSync(esbuild, [
  join(root, `functions/${fn}/index.ts`), "--bundle", "--format=esm", "--platform=neutral", "--target=es2022",
  "--external:npm:*", "--external:jsr:*", "--legal-comments=none", "--log-level=error", `--outfile=${raw}`,
]);

// The only external imports: the Anthropic SDK and supabase-js. They come from the loader instead.
const DEPS = {
  "npm:@anthropic-ai/sdk@0": "Anthropic",
  "jsr:@supabase/supabase-js@2": "Supabase",
};
let code = readFileSync(raw, "utf8");
const used = new Set();
code = code.replace(/^import\s+(.+?)\s+from\s+"([^"]+)";\s*$/gm, (line, what, spec) => {
  const dep = DEPS[spec];
  if (!dep) throw new Error(`unexpected import ${spec}`);
  used.add(dep);
  if (/^\{/.test(what)) return `const ${what.replace(/\s+as\s+/g, ": ")} = __deps.${dep};`;
  return `const ${what} = __deps.${dep}.default;`;
});
if (/^\s*(import|export)\s/m.test(code) || /import\.meta/.test(code)) throw new Error("bundle still has module syntax");
code = `"use strict";\n${code}`;
writeFileSync(join(dist, `${fn}.js`), code);
const sha = createHash("sha256").update(code).digest("hex");
const name = `${sha.slice(0, 16)}.js`;

// Exact versions the loader imports (the source keeps its usual specifiers for deno check).
const PINNED = { Anthropic: "npm:@anthropic-ai/sdk@0.137.0", Supabase: "jsr:@supabase/supabase-js@2.119.0" };
const deps = [...used].sort();

const entry = `// ${fn} edge function: a loader. The code is supabase/functions/${fn}/index.ts and what it imports,
// bundled by supabase/scripts/build-agent.mjs and stored in the public fn-src bucket under its
// SHA-256. It runs only if the fetched file matches the hash below.
${deps.map((d) => `import * as ${d} from "${PINNED[d]}";`).join("\n")}

const SHA256 = "${sha}";
const URL_ = "https://adfgtlhryyyrqbbgbfmx.supabase.co/storage/v1/object/public/fn-src/${fn}/${name}";

const res = await fetch(URL_);
if (!res.ok) throw new Error(\`${fn} code not found (\${res.status})\`);
const code = await res.text();
const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))))
  .map((b) => b.toString(16).padStart(2, "0")).join("");
if (digest !== SHA256) throw new Error("${fn} code hash mismatch: refusing to run");
new Function("__deps", code)({ ${deps.join(", ")} });
`;
writeFileSync(join(dist, `${fn}-entry.ts`), entry);
console.log(JSON.stringify({ fn, sha, name, bytes: code.length }));
