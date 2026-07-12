import { defineConfig } from "vite-plus";

export default defineConfig({
  // `vp pack` reads tsdown settings from this block (tsdown.config.ts is
  // ignored by vp). fixedExtension keeps emitted files matching the exports
  // map (`.js` for ESM in this "type": "module" package, `.cjs` for CJS).
  pack: {
    entry: ["src/index.ts", "src/claude-code/index.ts"],
    format: ["cjs", "esm"],
    dts: false,
    unbundle: true,
    sourcemap: true,
    fixedExtension: false,
    publint: false,
  },
});
