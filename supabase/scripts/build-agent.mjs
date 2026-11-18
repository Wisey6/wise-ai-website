// Builds the `agent` edge function for deployment.
//
// Why: the function's source (agent/*.ts + _shared/*.ts, ~300 KB) is too large to send through the
// deploy tool in one go, and the deploy bundler refuses imports from the project's own storage host.
// So the code is bundled here into one plain script, uploaded to the public `fn-src` storage bucket
// under its SHA-256, and the deployed entry (`dist/agent-entry.ts`) is a small loader that imports
// the SDKs, fetches that exact file at cold start, checks its SHA-256 against the value baked into
// the entry, and only then runs it. A changed or swapped file is refused.
//
// Run: node supabase/scripts/build-agent.mjs <path-to-esbuild>
//   → supabase/dist/agent.js (upload to fn-src/agent/<sha>.js) and supabase/dist/agent-entry.ts (deploy as agent/index.ts)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const esbuild = process.argv[2] || "esbuild";
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });
const raw = join(dist, "agent.esm.js");
execFileSync(esbuild, [
  join(root, "functions/agent/index.ts"), "--bundle", "--format=esm", "--platform=neutral", "--target=es2022",
  "--external:npm:*", "--external:jsr:*", "--legal-comments=none", "--log-level=error", `--outfile=${raw}`,
]);

// The only external imports: the Anthropic SDK and supabase-js. They come from the loader instead.
const DEPS = {
  "npm:@anthropic-ai/sdk@0": "Anthropic",
  "jsr:@supabase/supabase-js@2": "Supabase",
};
let code = readFileSync(raw, "utf8");
code = code.replace(/^import\s+(.+?)\s+from\s+"([^"]+)";\s*$/gm, (line, what, spec) => {
  const dep = DEPS[spec];
  if (!dep) throw new Error(`unexpected import ${spec}`);
  if (/^\{/.test(what)) return `const ${what.replace(/\s+as\s+/g, ": ")} = __deps.${dep};`;
  return `const ${what} = __deps.${dep}.default;`;
});
if (/^\s*(import|export)\s/m.test(code) || /import\.meta/.test(code)) throw new Error("bundle still has module syntax");
code = `"use strict";\n${code}`;
writeFileSync(join(dist, "agent.js"), code);
const sha = createHash("sha256").update(code).digest("hex");
const name = `${sha.slice(0, 16)}.js`;

const entry = `// agent edge function: a loader. The code is supabase/functions/agent/index.ts and what it imports,
// bundled by supabase/scripts/build-agent.mjs and stored in the public fn-src bucket under its
// SHA-256. It runs only if the fetched file matches the hash below.
import * as Anthropic from "npm:@anthropic-ai/sdk@0";
import * as Supabase from "jsr:@supabase/supabase-js@2";

const SHA256 = "${sha}";
const URL_ = "https://adfgtlhryyyrqbbgbfmx.supabase.co/storage/v1/object/public/fn-src/agent/${name}";

const res = await fetch(URL_);
if (!res.ok) throw new Error(\`agent code not found (\${res.status})\`);
const code = await res.text();
const digest = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code))))
  .map((b) => b.toString(16).padStart(2, "0")).join("");
if (digest !== SHA256) throw new Error("agent code hash mismatch: refusing to run");
new Function("__deps", code)({ Anthropic, Supabase });
`;
writeFileSync(join(dist, "agent-entry.ts"), entry);
console.log(JSON.stringify({ sha, name, bytes: code.length }));
