// Bundles src/extension.ts (and the engine's mask modules) into dist/extension.cjs,
// then fails if the bundle imports anything but `vscode` and Node built-ins.
import { build } from "esbuild";
import { builtinModules } from "node:module";

const result = await build({
  entryPoints: ["src/extension.ts"],
  outfile: "dist/extension.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20", // VS Code 1.93 runs Node 20
  external: ["vscode"],
  metafile: true,
  sourcemap: false,
  logLevel: "info",
});

const allowed = new Set(["vscode", ...builtinModules]);
const bad = [];
for (const out of Object.values(result.metafile.outputs)) {
  for (const imp of out.imports) {
    const name = imp.path.replace(/^node:/, "");
    if (!imp.external) continue;
    if (!allowed.has(imp.path) && !allowed.has(name)) bad.push(imp.path);
  }
}
// Everything else must be bundled in: no node_modules inputs at runtime.
const nm = Object.keys(result.metafile.inputs).filter((p) => p.includes("node_modules"));
if (bad.length || nm.length) {
  console.error("Bundle check failed. Unexpected imports:", [...bad, ...nm]);
  process.exit(1);
}
console.log("Bundle check ok: only vscode and Node built-ins are imported.");
