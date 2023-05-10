import * as vue from "./mod.ts"
import * as esbuild from "https://deno.land/x/esbuild@v0.17.18/mod.js"
import * as importMap from "npm:esbuild-plugin-import-map"

importMap.load(JSON.parse(await Deno.readTextFile("./import_map.json")))

await esbuild.build({
	plugins: [
		vue.vue3plugin({
			cssinline: true,
			isprod: false,
		}),
		importMap.plugin(),
	],
	minify: false,
	bundle: true,
	entryPoints: {
		"example": "example.vue",
	},
	outdir: "esbuild_out",
	splitting: true,
	format: "esm",
	platform: "browser",
	target: ["chrome113"],
	external: [
		"vue",
	],
})

esbuild.stop()
