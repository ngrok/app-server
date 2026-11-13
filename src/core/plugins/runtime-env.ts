import { replaceResponse, writableHeaders } from "../header-hook.js";
import { optionPlugin } from "../plugin-options.js";
import { rewritesHtmlWithEtagPart } from "../static-files.js";
import type { Plugin } from "../types.js";

// The Standard Schema interface (https://standardschema.dev), copied as its spec asks, so that
// zod, valibot, and arktype schemas all work with no dependency on any of them.
type StandardIssue = {
	readonly message: string;
	readonly path?: readonly (PropertyKey | { readonly key: PropertyKey })[] | undefined;
};
type StandardResult<Output> =
	| { readonly value: Output; readonly issues?: undefined }
	| { readonly issues: readonly StandardIssue[] };

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

/** The search for `</head>` stops after this many bytes, so the rest of a long body costs no search. */
const HEAD_SEARCH_LIMIT = 1_048_576;

const encoder = new TextEncoder();

/** `</head>` in lowercase and in uppercase. Why both: HTML reads a tag name in each letter case. */
const HEAD_END = encoder.encode("</head>");
const HEAD_END_UPPER = encoder.encode("</HEAD>");

const NO_BYTES = new Uint8Array(0);

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
	const json = JSON.stringify(values).replaceAll("<", String.raw`\u003c`);
	return `<script id="${PUBLIC_ENV_SCRIPT_ID}" type="application/json">${json}</script>`;
}

/** A 32-bit word with 1 in each of its four bytes. */
const EACH_BYTE = 0x01_01_01_01;

/**
 * Whether one of the four bytes of `word` is `<`, which is byte 60. Why bit
 * operations: with two of these tests for each 8 bytes, the search of a head
 * with 30 KB of inline CSS takes 5.5 µs. A loop that tests each byte takes
 * 26 µs (Node.js 26, Apple M3 Max).
 */
function hasLessThan(word: number): boolean {
	// oxlint-disable-next-line no-bitwise -- the XOR makes each `<` byte zero.
	const zeroed = word ^ (60 * EACH_BYTE);
	// oxlint-disable-next-line no-bitwise -- this is not zero only for a word with a zero byte.
	return ((zeroed - EACH_BYTE) & ~zeroed & (128 * EACH_BYTE)) !== 0;
}

/**
 * Whether `</head>` starts at `start` in `bytes`. It is also `true` when
 * `bytes` ends inside the tag, because the next chunk can have the rest.
 */
function startsHeadEnd(bytes: Uint8Array, start: number): boolean {
	const length = Math.min(HEAD_END.length, bytes.length - start);
	for (let offset = 0; offset < length; offset += 1) {
		const byte = bytes[start + offset];
		if (byte !== HEAD_END[offset] && byte !== HEAD_END_UPPER[offset]) {
			return false;
		}
	}
	return true;
}

/**
 * The index of the first `</head>` in `bytes`. With none, it gives the index
 * of a `</head>` that the end of `bytes` cuts, else `bytes.length`.
 */
function headEndIndex(bytes: Uint8Array): number {
	const { length } = bytes;
	const words = new DataView(bytes.buffer, bytes.byteOffset, length);
	const lastStep = length - 8;
	let index = 0;
	while (index < length) {
		while (
			index <= lastStep &&
			!hasLessThan(words.getUint32(index)) &&
			!hasLessThan(words.getUint32(index + 4))
		) {
			index += 8;
		}
		for (const end = Math.min(index + 8, length); index < end; index += 1) {
			if (startsHeadEnd(bytes, index)) {
				return index;
			}
		}
	}
	return length;
}

/** The bytes of `parts` in one new array. */
function joined(...parts: Uint8Array[]): Uint8Array {
	let size = 0;
	for (const part of parts) {
		size += part.length;
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.length;
	}
	return bytes;
}

/**
 * `chunk` as a `Uint8Array` of the same bytes. Why: Bun also takes a body
 * chunk that is an `ArrayBuffer` or another view of one, and the search
 * reads the bytes of a `Uint8Array`.
 */
function asBytes(chunk: unknown): Uint8Array {
	if (chunk instanceof Uint8Array) {
		return chunk;
	}
	if (ArrayBuffer.isView(chunk)) {
		return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
	}
	if (chunk instanceof ArrayBuffer) {
		return new Uint8Array(chunk);
	}
	throw new TypeError("A response body gave a chunk that is not bytes.");
}

/**
 * `body` with `html` before its first `</head>`, in any letter case. It
 * changes no other byte, so a document that is not UTF-8 stays whole. It
 * holds only the end of a chunk that can start `</head>`, 6 bytes at most,
 * so each chunk goes out when it comes.
 */
function injectBeforeHeadEnd(
	body: ReadableStream<Uint8Array>,
	html: Uint8Array,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	let searching = true;
	let searched = 0;
	/** The end of the chunks so far, when the next chunk can complete a `</head>` that starts there. */
	let held: Uint8Array = NO_BYTES;
	/** The bytes to send for `chunk` while the search goes on. */
	const search = (chunk: Uint8Array): Uint8Array => {
		const bytes = held.length === 0 ? chunk : joined(held, chunk);
		const index = headEndIndex(bytes);
		searched += chunk.length;
		if (index + HEAD_END.length <= bytes.length) {
			searching = false;
			held = NO_BYTES;
			// Why one chunk: a body of one chunk stays one, which the server sends with its length.
			return joined(bytes.subarray(0, index), html, bytes.subarray(index));
		}
		searching = searched <= HEAD_SEARCH_LIMIT;
		// Why a copy: the reader of the chunk can change or move its bytes. Why not `slice`: on a
		// Node.js `Buffer`, it gives a view of the same bytes.
		held = searching ? joined(bytes.subarray(index)) : NO_BYTES;
		return bytes.subarray(0, bytes.length - held.length);
	};
	// Why not `pipeThrough`: a pipe reads the source before the client reads. On Node.js 26, a
	// static file that a later stage drops then holds an open `FileHandle` until garbage collection.
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				// Why a loop: a pull that enqueues nothing is not called again.
				for (;;) {
					// oxlint-disable-next-line no-await-in-loop -- each read depends on the one before it.
					const { done, value } = await reader.read();
					if (done) {
						if (held.length > 0) {
							controller.enqueue(held);
						}
						controller.close();
						return;
					}
					const chunk = asBytes(value);
					if (!searching) {
						controller.enqueue(chunk);
						return;
					}
					const bytes = search(chunk);
					if (bytes.length > 0) {
						controller.enqueue(bytes);
						return;
					}
				}
			},
			cancel: async (reason) => reader.cancel(reason),
		},
		// Why 0: the stream reads its source only when the client reads.
		{ highWaterMark: 0 },
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
 * the values of the build. Give it to the `env` option of `defaultPlugins()`,
 * which puts it before the static stages, so it sees the prerendered pages.
 *
 * @example
 * export const env = runtimeEnv(
 * 	z.object({ PUBLIC_API_URL: z.url(), SESSION_KEY: z.string().min(32) }),
 * );
 * env.values.SESSION_KEY; // => string
 * createServer({ plugins: defaultPlugins({ env }) });
 *
 * // In the browser:
 * const publicEnv = JSON.parse(document.getElementById("app-server-public-env")?.textContent ?? "{}");
 */
export function runtimeEnv<Schema extends StandardSchemaV1>(
	schema: Schema,
	{ source = process.env, publicPrefix = "PUBLIC_" }: RuntimeEnvOptions = {},
): RuntimeEnv<InferOutput<Schema>> {
	// Why: each name starts with `""`, so each value, such as a secret, would go into each HTML document.
	if (publicPrefix === "") {
		throw new RangeError(
			'runtimeEnv needs a publicPrefix of one character or more, not "". With "", each value, such as a secret, goes into each HTML document.',
		);
	}
	let parsed:
		| {
				values: InferOutput<Schema>;
				publicValues: Readonly<Record<string, unknown>>;
				/** The script with the public values, and its bytes, which go into each document. */
				script: { html: string; bytes: Uint8Array } | undefined;
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
		const html = Object.keys(publicValues).length > 0 ? publicEnvScript(publicValues) : undefined;
		parsed = {
			values,
			publicValues,
			script: html == null ? undefined : { html, bytes: encoder.encode(html) },
		};
		return parsed;
	};

	return optionPlugin("env", {
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
		etagPart: () => parse().script?.html,
		middleware: async (context, next) => {
			const { script } = parse();
			// Why for each request, not an option: the static stages send the HTML file, not its compressed
			// copy, only to a request that gets the script. An app with no public values keeps the copies.
			// Why not `rewritesHtml`: the script is this plugin's `etagPart`, so a page can keep its ETag.
			if (script != null) {
				rewritesHtmlWithEtagPart(context);
			}
			await next();
			if (script == null) {
				return;
			}
			const response = context.res;
			// Why the type first: most responses are not HTML, and they then need one header read.
			if (
				!(response.headers.get("Content-Type")?.startsWith("text/html") ?? false) ||
				response.headers.has("Content-Encoding") ||
				// Why: the script changes the bytes, so a `Content-Range` would no longer match them.
				response.headers.has("Content-Range")
			) {
				return;
			}
			if (response.body != null) {
				replaceResponse(
					context,
					new Response(injectBeforeHeadEnd(response.body, script.bytes), response),
				);
			}
			// Why for HEAD too: it gets the headers that GET gets. The script changes the length.
			const headers = writableHeaders(context);
			headers.delete("Content-Length");
			// Why not for a file of the static stages: its ETag has the values, from `etagPart`. The ETag
			// of a rendered document does not have them, so a 304 could keep old ones.
			if (context.get("staticDocument") == null) {
				headers.delete("ETag");
			}
		},
	});
}
