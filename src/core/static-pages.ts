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

/**
 * Sends a request through the pipeline as a client at `remoteAddress`. The
 * pipeline calls `onServedFile` with the URL path of the client build's file
 * that `prerendered()` sends, if it sends one.
 */
export type PipelineFetch = (
	request: Request,
	bindings: { remoteAddress: string; onServedFile: (path: string) => void },
) => Promise<Response>;

/** The headers that the CDN sets for each file itself. */
const CDN_OWN = new Set([
	"date",
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
 * are the same. Why a slash after each segment but the last: the match then
 * takes linear time.
 */
const PLAIN_PATH = /^\/(?:[\w.~-]+\/)*[\w.~-]*$/u;

/** The most presence headers. Why: each one doubles the requests and the CDN routes. */
const MAX_PRESENCE_HEADERS = 3;

/** The header names that the app's plugins marked, in lowercase. */
type MarkedHeaders = {
	/** The request headers whose presence alone changes the answer. See `presenceHeaders`. */
	presence: readonly string[];
	/**
	 * The response headers that get a new value for each request, such as the
	 * request ID. A CDN answer drops them. See `perRequestHeaders`.
	 */
	perRequest: readonly string[];
};

/** One answer of the pipeline. */
type Answer = {
	status: number;
	headers: Headers;
	body: Uint8Array;
	file: string | undefined;
};

/**
 * The two clients of each check. The first is an anonymous browser. The
 * second differs in each value that a CDN route does not match on: the host,
 * the address, the query, the value of a presence header, and the request
 * headers that a plugin reads most often to choose an answer. Why a cookie
 * and `Authorization`: a plugin that sends a signed-in visitor to another
 * page must keep its pages on the server. Why the geo headers: Vercel adds
 * them, and a plugin can redirect by country.
 */
const CLIENTS = [
	{
		origin: "https://localhost",
		query: "",
		address: "203.0.113.1",
		presentValue: "1",
		headers: { Accept: BROWSER_ACCEPT, "User-Agent": "app-server-build" },
	},
	{
		origin: "https://app-server-check.example",
		query: "?app-server-check=1",
		address: "198.51.100.2",
		presentValue: "2",
		headers: {
			Accept: "application/json",
			"Accept-Language": "de-DE",
			Authorization: "Bearer app-server-check",
			Cookie: "session=app-server-check",
			Referer: "https://app-server-check.example/",
			"User-Agent": "app-server-build-check",
			"X-Vercel-IP-City": "Berlin",
			"X-Vercel-IP-Country": "DE",
			"X-Vercel-IP-Country-Region": "BE",
		},
	},
] as const;

/**
 * The answer of the pipeline for `path`. The request has each of `presence`
 * that is in `present`, and no other of `presence`.
 */
async function answer(
	fetch: PipelineFetch,
	path: string,
	{
		client,
		presence,
		present,
	}: {
		client: (typeof CLIENTS)[number];
		presence: readonly string[];
		present: readonly string[];
	},
): Promise<Answer> {
	// Why `Host`: a listener gives it to each request, and a plugin can read it.
	const headers = new Headers({ ...client.headers, Host: new URL(client.origin).host });
	for (const name of presence) {
		if (present.includes(name)) {
			headers.set(name, client.presentValue);
		} else {
			headers.delete(name);
		}
	}
	const request = new Request(`${client.origin}${path}${client.query}`, { headers });
	let file: string | undefined;
	const response = await fetch(request, {
		remoteAddress: client.address,
		onServedFile: (served) => {
			file = served;
		},
	});
	if (file == null) {
		// Why cancel: only the answer of a file can go on a CDN, and another body can stream with no end.
		await response.body?.cancel();
	}
	return {
		status: response.status,
		headers: response.headers,
		body: file == null ? new Uint8Array() : new Uint8Array(await response.arrayBuffer()),
		file,
	};
}

/** Why a loop: `every` calls a function for each byte of each page. */
function sameBytes(first: Uint8Array, second: Uint8Array): boolean {
	if (first.length !== second.length) {
		return false;
	}
	for (let index = 0; index < first.length; index += 1) {
		if (first[index] !== second[index]) {
			return false;
		}
	}
	return true;
}

/**
 * The headers of `headers` that a CDN answer keeps, sorted by name. `perRequest`
 * names the headers that a plugin gives a new value for each request.
 */
function keptHeaders(headers: Headers, perRequest: readonly string[]): [string, string][] {
	return [...headers]
		.filter(([name]) => !perRequest.includes(name) && !CDN_OWN.has(name))
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
	// Why each `CDN-Cache-Control` field: a CDN obeys it before `Cache-Control` (RFC 9213).
	for (const [name, value] of first.headers) {
		// Why `i`: cache directives are case-insensitive.
		const blocked = /\b(?:private|no-store|no-cache)\b/iu.exec(value);
		if (blocked != null && (name === "cache-control" || name.endsWith("cdn-cache-control"))) {
			return `the ${name} header has ${blocked[0]}`;
		}
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
function difference(
	first: Answer,
	second: Answer,
	perRequest: readonly string[],
): string | undefined {
	if (first.status !== second.status || first.file !== second.file) {
		return "the status or the file changes with the request";
	}
	const names = new Set(
		[...keptHeaders(first.headers, perRequest), ...keptHeaders(second.headers, perRequest)].map(
			([name]) => name,
		),
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
	marked: MarkedHeaders,
): Promise<StaticPage> {
	const { presence, perRequest } = marked;
	if (!PLAIN_PATH.test(path)) {
		return { path, reason: "the path has a character that a CDN route can match two ways" };
	}
	// Why: the build records a path with no trailing slash, and `trailingSlash: "always"` sends it on.
	const probe = await answer(fetch, path, { client: CLIENTS[0], presence, present: [] });
	if (probe.status === 308 && probe.headers.get("location") === `${path}/`) {
		return staticPage(fetch, `${path}/`, marked);
	}
	if (presence.length > MAX_PRESENCE_HEADERS) {
		return { path, reason: `more than ${MAX_PRESENCE_HEADERS} presence headers` };
	}
	// Why reuse the probe: it is the first client's answer with no presence header.
	const firstAnswer = async (present: readonly string[]): Promise<Answer> =>
		present.length === 0 ? probe : answer(fetch, path, { client: CLIENTS[0], presence, present });
	const answers: CdnPage["answers"] = [];
	let base: Answer | undefined;
	let twin: string | undefined;
	for (const present of subsets(presence)) {
		const [first, second] = [
			await firstAnswer(present),
			await answer(fetch, path, { client: CLIENTS[1], presence, present }),
		];
		const caseTwin = twinIn(first.headers.get("link"));
		const allowedVary = new Set([
			"accept-encoding",
			...presence,
			...(caseTwin == null ? [] : ["accept"]),
		]);
		const reason = uncacheable(first, allowedVary) ?? difference(first, second, perRequest);
		if (reason != null) {
			return { path, reason };
		}
		if (base != null && (base.file !== first.file || !sameBytes(base.body, first.body))) {
			return { path, reason: "the body changes with a presence header" };
		}
		// Why: the CDN routes send each markdown request of a page to the server, or none.
		if (base != null && caseTwin !== twin) {
			return { path, reason: "the markdown twin changes with a presence header" };
		}
		base ??= first;
		twin = caseTwin;
		answers.push({ present, headers: Object.fromEntries(keptHeaders(first.headers, perRequest)) });
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
 * - is the same, except for the `perRequest` headers, for a second client
 *   with another host, client address, query, and value of each presence
 *   header, and with a cookie, `Authorization`, `Accept-Language`, and geo
 *   headers. Why: a CDN route matches only the path, a markdown `Accept`, and
 *   the presence of each presence header.
 * - varies only on `Accept-Encoding`, on `Accept` for a markdown twin, and on
 *   the presence headers. Each case of the presence headers gets its own
 *   headers, and all cases must send the same body.
 *
 * An auth check that refuses an anonymous request keeps its pages on the
 * server. Why: the first client sends no cookie and no `Authorization`.
 *
 * @yields Each path with its CDN answer, or with the reason that the server must answer it, in the order of `paths`.
 * @example
 * const marked = { presence: ["x-ngrok-edge"], perRequest: ["x-request-id"] };
 * for await (const page of staticPages(fetch, ["/", "/about"], marked)) {
 * 	console.log(page.path, "cdn" in page ? "CDN" : page.reason);
 * }
 */
export async function* staticPages(
	fetch: PipelineFetch,
	paths: readonly string[],
	marked: MarkedHeaders,
): AsyncGenerator<StaticPage> {
	for (const path of paths) {
		yield await staticPage(fetch, path, marked);
	}
}
