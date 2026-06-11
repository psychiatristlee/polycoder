// Bundles the three extension entry points (service worker + side panel + options)
// into dist/. The shared "routing brain" lives in ../src and is bundled in — all of
// it is fetch-based and browser-safe (no node deps reach these entry points).
import { build } from "esbuild";

await build({
  entryPoints: {
    background: "src/background.ts",
    sidepanel: "src/sidepanel.ts",
    options: "src/options.ts",
  },
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2021",
  logLevel: "info",
});

console.log("built chrome-extension/dist/{background,sidepanel,options}.js");
