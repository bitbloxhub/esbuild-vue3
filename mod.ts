// a bunch of code from https://github.com/pipe01/esbuild-plugin-vue3/
import {
	dirname,
	isAbsolute,
	join,
	relative,
} from "https://deno.land/std@0.186.0/path/posix.ts"
import * as esbuild from "https://deno.land/x/esbuild@v0.17.18/mod.js"
import * as compiler from "https://esm.sh/vue@3.2.47/compiler-sfc" // npm import caused deno lsp to break

type PluginData = {
	descriptor: compiler.SFCDescriptor
	id: string
	script?: compiler.SFCScriptBlock
}

export interface Options {
	scopeid?: string
	isprod?: boolean
	postcss?: {
		options?: any
		plugins?: any[]
	}
	cssinline?: boolean
	compileroptions?: compiler.CompilerOptions
}

function getUrlParams(search: string): Record<string, string> {
	const hashes = search.slice(search.indexOf("?") + 1).split("&")
	return hashes.reduce((params, hash) => {
		const [key, val] = hash.split("=")
		return Object.assign(params, { [key]: decodeURIComponent(val) })
	}, {})
}

function getFullPath(args: esbuild.OnResolveArgs) {
	return isAbsolute(args.path) ? args.path : join(args.resolveDir, args.path)
}

export const vue3plugin = (opts: Options = {}) =>
	<esbuild.Plugin> {
		name: "vue3",
		async setup({ initialOptions: buildOpts, ...build }) {
			build.onResolve({ filter: /\.vue/ }, async (args) => {
				const params = getUrlParams(args.path)

				return {
					path: getFullPath(args),
					namespace: params.type === "script"
						? "sfc-script"
						: params.type === "template"
						? "sfc-template"
						: params.type === "style"
						? "sfc-style"
						: "file",
					pluginData: {
						...args.pluginData,
						index: params.index,
					},
				}
			})

			build.onLoad({ filter: /\.vue$/ }, async (args) => {
				const encPath = args.path.replace(/\\/g, "\\\\")

				const source = await Deno.readTextFile(args.path)
				const filename = relative(Deno.cwd(), args.path)

				const id = crypto.getRandomValues(new BigUint64Array(1))[0].toString(16)

				const { descriptor } = compiler.parse(source, {
					filename,
				})

				const script = (descriptor.script || descriptor.scriptSetup)
					? compiler.compileScript(descriptor, { id })
					: undefined

				const dataId = "data-v-" + id
				let code = ""

				if (descriptor.script || descriptor.scriptSetup) {
					const src = (descriptor.script && !descriptor.scriptSetup &&
						descriptor.script.src) || encPath
					code += `import script from "${src}?type=script";`
				} else {
					code += "const script = {};"
				}

				for (const style in descriptor.styles) {
					code += `import "${encPath}?type=style&index=${style}";`
				}

				const renderFuncName = "render"

				code +=
					`import { ${renderFuncName} } from "${encPath}?type=template"; script.${renderFuncName} = ${renderFuncName};`

				code += `script.__file = ${JSON.stringify(filename)};`
				if (descriptor.styles.some((o) => o.scoped)) {
					code += `script.__scopeId = ${JSON.stringify(dataId)};`
				}

				code += "export default script;"

				return {
					contents: code,
					resolveDir: dirname(args.path),
					pluginData: { descriptor, id: dataId, script },
					watchFiles: [args.path],
				}
			})

			build.onLoad({ filter: /.*/, namespace: "sfc-script" }, async (args) => {
				const { script } = args.pluginData as PluginData

				if (script) {
					let code = script.content

					if (buildOpts.sourcemap && script.map) {
						const sourceMap = btoa(JSON.stringify(script.map))

						code +=
							"\n\n//@ sourceMappingURL=data:application/json;charset=utf-8;base64," +
							sourceMap
					}

					return {
						contents: code,
						loader: script.lang === "ts" ? "ts" : "js",
						resolveDir: dirname(args.path),
					}
				}
			})

			build.onLoad({ filter: /.*/, namespace: "sfc-style" }, async (args) => {
				const { descriptor, index, id } = args.pluginData as PluginData & {
					index: number
				}

				const style: compiler.SFCStyleBlock = descriptor.styles[index]
				let includedFiles: string[] = []

				const result = await compiler.compileStyleAsync({
					filename: args.path,
					id,
					source: style.content,
					postcssOptions: opts.postcss?.options,
					postcssPlugins: opts.postcss?.plugins,
					preprocessLang: style.lang as any,
					scoped: style.scoped,
				})

				if (result.errors.length > 0) {
					const errors = result
						.errors as (Error & {
							column: number
							line: number
							file: string
						})[]

					return {
						errors: errors.map((o) => ({
							text: o.message,
							location: {
								column: o.column,
								line: o.file === args.path
									? style.loc.start.line + o.line - 1
									: o.line,
								file: o.file.replace(/\?.*?$/, ""),
								namespace: "file",
							},
						})),
					}
				}

				if (opts.cssinline) {
					const csstext = result.code
					const contents = `
                {
                    const el = document.createElement("style");
                    el.textContent = ${JSON.stringify(csstext)};
                    document.head.append(el);
                }`
					return {
						contents,
						loader: "js",
						resolveDir: dirname(args.path),
						watchFiles: includedFiles,
					}
				}

				return {
					contents: result.code,
					loader: "css",
					resolveDir: dirname(args.path),
					watchFiles: includedFiles,
				}
			})

			build.onLoad(
				{ filter: /.*/, namespace: "sfc-template" },
				async (args) => {
					const { descriptor, id, script } = args.pluginData as PluginData
					if (!descriptor.template) {
						throw new Error("Missing template")
					}

					let source = descriptor.template.content

					const result = compiler.compileTemplate({
						id,
						source,
						filename: args.path,
						scoped: descriptor.styles.some((o) => o.scoped),
						slotted: descriptor.slotted,
						ssr: false,
						ssrCssVars: [],
						isProd: buildOpts.minify,
						compilerOptions: {
							inSSR: false,
							bindingMetadata: script?.bindings,
							...opts.compileroptions,
						},
					})

					if (result.errors.length > 0) {
						return {
							errors: result.errors.map<esbuild.PartialMessage>((o) =>
								typeof o === "string" ? { text: o } : {
									text: o.message,
									location: o.loc && {
										column: o.loc.start.column,
										file: descriptor.filename,
										line: o.loc.start.line +
											descriptor.template!.loc.start.line + 1,
										lineText: o.loc.source,
									},
								}
							),
						}
					}

					return {
						contents: result.code,
						warnings: result.tips.map((o) => ({ text: o })),
						loader: "ts",
						resolveDir: dirname(args.path),
					}
				},
			)
		},
	}
