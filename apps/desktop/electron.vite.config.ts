import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";
import { resolve } from "node:path";

export default defineConfig({
	main: {
		build: {
			outDir: "dist/main",
		},
	},
	preload: {
		build: {
			outDir: "dist/preload",
		},
	},
	renderer: {
		resolve: {
			alias: {
				"@renderer": resolve("src/renderer/src"),
			},
		},
		plugins: [react(), tailwindcss()],
		build: {
			outDir: "dist/renderer",
		},
	},
});
