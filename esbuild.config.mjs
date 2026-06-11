// Bundles src/index.ts -> dist/cli.js.
// We inline our own source files but keep all node_modules external (packages: 'external'),
// so we never have to wrestle with third-party ESM/CJS interop or native bindings.
import { build } from "esbuild";

// node:sqlite is stable enough for us but emits an ExperimentalWarning on load.
// Imports hoist above any banner statement, so we silence it at the engine level
// via the shebang instead (only the experimental warning, other warnings remain).
const banner = "#!/usr/bin/env -S node --disable-warning=ExperimentalWarning";

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/cli.js",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  packages: "external",
  jsx: "automatic",
  banner: { js: banner },
  logLevel: "info",
  sourcemap: false,
});

console.log("built dist/cli.js");
