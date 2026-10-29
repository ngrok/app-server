import type { Plugin } from "../types.js";

// The Standard Schema interface (https://standardschema.dev), copied as its spec asks, so that
// zod, valibot, and arktype schemas all work with no dependency on any of them.
type StandardIssue = {
	readonly message: string;
	readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined;
};
type StandardResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: ReadonlyArray<StandardIssue> };

/** A schema that follows the Standard Schema interface, such as a zod object. */
export type StandardSchemaV1<Input = unknown, Output = Input> = {
	readonly "~standard": {
		readonly version: 1;
		readonly vendor: string;
		readonly validate: (value: unknown) => StandardResult<Output> | Promise<StandardResult<Output>>;
		readonly types?: { readonly input: Input; readonly output: Output } | undefined;
	};
};

/** The parsed type of a Standard Schema. */
export type InferOutput<Schema extends StandardSchemaV1> = NonNullable<
	Schema["~standard"]["types"]
>["output"];

/** The `id` of the JSON `<script>` that carries the public values into each HTML document. */
export const PUBLIC_ENV_SCRIPT_ID = "app-server-public-env";

/** Stops the search for `</head>` after this many characters, so a page with none still streams. */
const HEAD_SEARCH_LIMIT = 1_048_576;

/** Options for {@link runtimeEnv}. */
export type RuntimeEnvOptions = {
	/** @default process.env */
	source?: Readonly<Record<string, string | undefined>>;
	/**
	 * Values whose names start with this prefix reach the browser.
	 * @default "PUBLIC_"
	 */
	publicPrefix?: string;
};

/** The plugin that {@link runtimeEnv} returns, with the parsed values. */
export type RuntimeEnv<Values> = Plugin & {
	/** The parsed values. The first read parses, and a bad value throws. */
	readonly values: Values;
	/** The parsed values whose names start with the public prefix. */
	readonly publicValues: Readonly<Record<string, unknown>>;
};

function formatIssue(issue: StandardIssue): string {
	const path = (issue.path ?? [])
		.map((segment) => String(typeof segment === "object" ? segment.key : segment))
		.join(".");
	return `  ${path === "" ? "(root)" : path}: ${issue.message}`;
}

/** A JSON data block. Escaping `<` keeps a value from closing the `<script>`. */
function publicEnvScript(values: Readonly<Record<string, unknown>>): string {
	const json = JSON.stringify(values).replaceAll("<", "\\u003c");
	return `<script id="${PUBLIC_ENV_SCRIPT_ID}" type="application/json">${json}</script>`;
}

/** Inserts `html` before the first `</head>` of a streamed document. The rest streams as is. */
function injectBeforeHeadEnd(
	body: ReadableStream<Uint8Array>,
	html: string,
): ReadableStream<Uint8Array> {
	// Why decode every chunk: a chunk can end inside a multi-byte character.
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let pending: string | undefined = "";
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				const text = decoder.decode(chunk, { stream: true });
				if (pending == null) {
					controller.enqueue(encoder.encode(text));
					return;
				}
				pending += text;
				const index = pending.search(/<\/head>/i);
				if (index !== -1) {
					controller.enqueue(
						encoder.encode(`${pending.slice(0, index)}${html}${pending.slice(index)}`),
					);
					pending = undefined;
				} else if (pending.length > HEAD_SEARCH_LIMIT) {
					controller.enqueue(encoder.encode(pending));
					pending = undefined;
				}
			},
			flush(controller) {
				const rest = `${pending ?? ""}${decoder.decode()}`;
				if (rest !== "") {
					controller.enqueue(encoder.encode(rest));
				}
			},
		}),
	);
}

/**
 * Validates the environment once, at startup, against a schema. A missing or
 * bad value stops the server with a message that names it. The typed values
 * are on `.values`.
 *
 * The values whose names start with `PUBLIC_` go into each HTML document,
 * prerendered or rendered, as a JSON `<script id="app-server-public-env">`.
 * So one image serves every environment, and a prerendered page never keeps
 * the values of the build. Put this plugin before the static stages, so it
 * sees the prerendered pages.
 *
 * @example
 * export const env = runtimeEnv(
 * 	z.object({ PUBLIC_API_URL: z.url(), SESSION_KEY: z.string().min(32) }),
 * );
 * env.values.SESSION_KEY; // => string
 *
 * // In the browser:
 * const publicEnv = JSON.parse(document.getElementById("app-server-public-env")?.textContent ?? "{}");
 */
export function runtimeEnv<Schema extends StandardSchemaV1>(
	schema: Schema,
	{ source = process.env, publicPrefix = "PUBLIC_" }: RuntimeEnvOptions = {},
): RuntimeEnv<InferOutput<Schema>> {
	let parsed:
		| {
				values: InferOutput<Schema>;
				publicValues: Readonly<Record<string, unknown>>;
				script: string | undefined;
		  }
		| undefined;

	const parse = () => {
		if (parsed != null) {
			return parsed;
		}
		const result = schema["~standard"].validate({ ...source });
		if (result instanceof Promise) {
			throw new TypeError("runtimeEnv needs a schema that validates synchronously.");
		}
		if (result.issues != null) {
			throw new Error(
				`The environment is not valid:\n${result.issues.map(formatIssue).join("\n")}`,
			);
		}
		const values: InferOutput<Schema> = result.value;
		const publicValues =
			typeof values === "object" && values != null
				? Object.fromEntries(
						Object.entries(values).filter(([name]) => name.startsWith(publicPrefix)),
					)
				: {};
		parsed = {
			values,
			publicValues,
			script: Object.keys(publicValues).length > 0 ? publicEnvScript(publicValues) : undefined,
		};
		return parsed;
	};

	return {
		name: "runtime-env",
		get values() {
			return parse().values;
		},
		get publicValues() {
			return parse().publicValues;
		},
		setup: () => {
			parse();
		},
		middleware: async (context, next) => {
			await next();
			const { script } = parse();
			const response = context.res;
			if (
				script == null ||
				response.body == null ||
				response.headers.has("Content-Encoding") ||
				!(response.headers.get("Content-Type")?.startsWith("text/html") ?? false)
			) {
				return;
			}
			context.res = new Response(injectBeforeHeadEnd(response.body, script), response);
			context.res.headers.delete("Content-Length");
			// Why: the file's ETag does not change when the values do, so a 304 would keep the old values.
			context.res.headers.delete("ETag");
		},
	};
}
