import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import pkg from "./package.json";

export default defineConfig(({ mode }) => {
	return {
		plugins: [react(), tailwindcss()],
		resolve: {
			alias: {
				"@": fileURLToPath(new URL("./src", import.meta.url)),
				...resolveESM(
					Object.keys(pkg.dependencies) as (keyof typeof pkg.dependencies)[],
				),
			},
		},
		build: {
			minify: mode !== "development",
			lib: {
				entry: "src/client.tsx",
				fileName: "client",
				formats: ["es"],
			},
			outDir: "../vibest-devtools/dist",
		},
		experimental: {
			enableNativePlugin: true,
		},
	};
});

function resolveESM(deps: (keyof typeof pkg.dependencies)[]) {
	return deps.reduce(
		(acc, key) => {
			acc[key] = `https://esm.sh/${key}@${pkg.dependencies[key]}`;
			return acc;
		},
		{} as Record<string, string>,
	);
}
