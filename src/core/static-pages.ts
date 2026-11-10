import { servedFile } from "./plugins/static.js";

/** What a content delivery network (CDN) sends for a prerendered path that it can serve with no server. */
export type CdnPage = {
	/** The URL path of the client build's file that the answer comes from, such as `/about/index.html`. */
	file: string;
	/** The body that the pipeline sent. It can differ from the file, such as with `runtimeEnv` values. */
	body: Uint8Array;
	/**
	 * The response headers for each case of the presence headers. `present`
	 * lists the headers that the request has. With no presence headers, there
	 * is one case.
	 */
	answers: { present: readonly string[]; headers: Readonly<Record<string, string>> }[];
	/**
	 * The path of the page's markdown twin. A request whose `Accept` names
	 * `text/markdown` must reach the server, which negotiates the answer.
	 */
	twin?: string;
};

/** A prerendered path, with its CDN answer, or with the reason that the server must answer it. */
export type StaticPage = { path: string } & ({ cdn: CdnPage } | { reason: string });

/** Sends a request through the pipeline as a client at `remoteAddress`. */
export type PipelineFetch = (request: Request, remoteAddress: string) => Promise<Response>;

/** The headers that change with each request, such as the request ID. A CDN answer drops them. */
const PER_REQUEST = new Set(["x-request-id", "date"]);

/** The headers that the CDN sets for each file itself. */
const CDN_OWN = new Set([
	"content-length",
	"etag",
	"last-modified",
	"accept-ranges",
	"transfer-encoding",
	"connection",
	"keep-alive",
]);

/** A browser's `Accept`. A browser never names `text/markdown`, so it gets the HTML. */
const BROWSER_ACCEPT = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";

/**
 * A URL path that a CDN route matches as it is. Why only these characters: a
 * CDN can match a path before or after it decodes it, and these two forms
 * are the same.
 */
const PLAIN_PATH = /^\/(?:[\w.~-]+\/?)*$/u;

/** The most presence headers. Why: each one doubles the requests and the CDN routes. */
const MAX_PRESENCE_HEADERS = 3;

/** One answer of the pipeline. */
type Answer = {
	status: number;
	headers: Headers;
	body: Uint8Array;
	file: string | undefined;
};

/** The two clients of each check. The second differs in each value that a CDN route cannot see. */
const CLIENTS = [
	{ origin: "https://localhost", query: "", userAgent: "app-server-build", address: "203.0.113.1" },
	{
		origin: "https://app-server-check.example",
		query: "?app-server-check=1",
		userAgent: "app-server-build-check",
		address: "198.51.100.2",
	},
] as const;

async function answer(
	fetch: PipelineFetch,
	path: string,
	{ client, present }: { client: (typeof CLIENTS)[number]; present: readonly string[] },
): Promise<Answer> {
	const request = new Request(`${client.origin}${path}${client.query}`, {
		headers: [
			["Accept", BROWSER_ACCEPT],
			["User-Agent", client.userAgent],
			...present.map((name): [string, string] => [name, "1"]),
		],
	});
	const response = await fetch(request, client.address);
	return {
		status: response.status,
		headers: response.headers,
		body: new Uint8Array(await response.arrayBuffer()),
		file: servedFile(request),
	};
}

function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
	return first.length === second.length && first.every((byte, index) => byte === second[index]);
}

/** The headers of `headers` that a CDN answer keeps, sorted by name. */
function keptHeaders(headers: Headers): [string, string][] {
	return [...headers]
		.filter(([name]) => !PER_REQUEST.has(name) && !CDN_OWN.has(name))
		.toSorted(([first], [second]) => (first < second ? -1 : 1));
}

/** The path of the markdown twin in a `Link` header, if any. */
function twinIn(link: string | null): string | undefined {
	return /<(?<path>[^>]+)>;\s*rel="alternate";\s*type="text\/markdown"/u.exec(link ?? "")?.groups
		?.path;
}

/** Why a CDN cannot keep `first`, or `undefined` when it can. */
function uncacheable(first: Answer, allowedVary: ReadonlySet<string>): string | undefined {
	if (first.status !== 200) {
		return `the status is ${first.status}`;
	}
	if (first.file == null) {
		return "the answer does not come from a prerendered file";
	}
	if (!PLAIN_PATH.test(first.file)) {
		return "the file path has a character that a CDN route can match two ways";
	}
	if (first.headers.has("set-cookie")) {
		return "the answer sets a cookie";
	}
	const cacheControl = first.headers.get("cache-control") ?? "";
	const blocked = /\b(?:private|no-store|no-cache)\b/u.exec(cacheControl);
	if (blocked != null) {
		return `Cache-Control has ${blocked[0]}`;
	}
	if (first.headers.has("content-encoding")) {
		return "the answer has a Content-Encoding";
	}
	const vary = (first.headers.get("vary") ?? "")
		.split(",")
		.map((name) => name.trim().toLowerCase())
		.find((name) => name !== "" && !allowedVary.has(name));
	return vary == null ? undefined : `the answer varies on ${vary}`;
}

/** Why `second` differs from `first`, or `undefined` when they match. */
function difference(first: Answer, second: Answer): string | undefined {
	if (first.status !== second.status || first.file !== second.file) {
		return "the answer changes with the host, the client address, or the query";
	}
	const names = new Set(
		[...keptHeaders(first.headers), ...keptHeaders(second.headers)].map(([name]) => name),
	);
	const changed = [...names].find((name) => first.headers.get(name) !== second.headers.get(name));
	if (changed != null) {
		return `the ${changed} header changes with the request`;
	}
	return sameBytes(first.body, second.body) ? undefined : "the body changes with the request";
}

/** Each subset of `names`, the empty one first. */
function subsets(names: readonly string[]): string[][] {
	const all: string[][] = [[]];
	for (const name of names) {
		all.push(...all.map((subset) => [...subset, name]));
	}
	return all;
}

/** The CDN answer of one path, or the reason that the server must answer it. */
async function staticPage(
	fetch: PipelineFetch,
	path: string,
	presence: readonly string[],
): Promise<StaticPage> {
	if (!PLAIN_PATH.test(path)) {
		return { path, reason: "the path has a character that a CDN route can match two ways" };
	}
	// Why: the build records a path with no trailing slash, and `trailingSlash: "always"` sends it on.
	const probe = await answer(fetch, path, { client: CLIENTS[0], present: [] });
	if (probe.status === 308 && probe.headers.get("location") === `${path}/`) {
		return staticPage(fetch, `${path}/`, presence);
	}
	if (presence.length > MAX_PRESENCE_HEADERS) {
		return { path, reason: `more than ${MAX_PRESENCE_HEADERS} presence headers` };
	}
	const answers: CdnPage["answers"] = [];
	let base: Answer | undefined;
	let twin: string | undefined;
	for (const present of subsets(presence)) {
		const [first, second] = [
			await answer(fetch, path, { client: CLIENTS[0], present }),
			await answer(fetch, path, { client: CLIENTS[1], present }),
		];
		twin = twinIn(first.headers.get("link"));
		const allowedVary = new Set([
			"accept-encoding",
			...presence,
			...(twin == null ? [] : ["accept"]),
		]);
		const reason = uncacheable(first, allowedVary) ?? difference(first, second);
		if (reason != null) {
			return { path, reason };
		}
		if (base != null && (base.file !== first.file || !sameBytes(base.body, first.body))) {
			return { path, reason: "the body changes with a presence header" };
		}
		base ??= first;
		answers.push({ present, headers: Object.fromEntries(keptHeaders(first.headers)) });
	}
	if (base?.file == null) {
		return { path, reason: "the answer does not come from a prerendered file" };
	}
	if (twin != null && !PLAIN_PATH.test(twin)) {
		return { path, reason: "the twin path has a character that a CDN route can match two ways" };
	}
	return {
		path,
		cdn: { file: base.file, body: base.body, answers, ...(twin == null ? {} : { twin }) },
	};
}

/**
 * Sends each prerendered path through the pipeline, and gives the paths that
 * a CDN can serve with no server. A path qualifies when its answer:
 *
 * - is a 200 from a prerendered file, with no cookie and no `private`,
 *   `no-store`, or `no-cache`
 * - is the same, except for the request ID, for a second client with another
 *   host, client address, user agent, and query. Why: a CDN route sees only
 *   the path and the request headers.
 * - varies only on `Accept-Encoding`, on `Accept` for a markdown twin, and on
 *   the presence headers. Each case of the presence headers gets its own
 *   headers, and all cases must send the same body.
 *
 * An auth check that refuses an anonymous request keeps its pages on the
 * server, because the checks send no cookie and no `Authorization`.
 *
 * @yields Each path with its CDN answer, or with the reason that the server must answer it, in the order of `paths`.
 * @example
 * for await (const page of staticPages(fetch, ["/", "/about"], ["x-ngrok-edge"])) {
 * 	console.log(page.path, "cdn" in page ? "CDN" : page.reason);
 * }
 */
export async function* staticPages(
	fetch: PipelineFetch,
	paths: readonly string[],
	presence: readonly string[],
): AsyncGenerator<StaticPage> {
	for (const path of paths) {
		yield await staticPage(fetch, path, presence);
	}
}
