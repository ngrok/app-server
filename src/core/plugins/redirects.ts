import type { MiddlewareHandler } from "hono";
import { isSafeLocalPath } from "../safe-local-path.js";
import type { AppServerEnv, Plugin } from "../types.js";
import { trimTrailingSlashes } from "./trailing-slash.js";
import type { TrailingSlash } from "./trailing-slash.js";

/** One redirect of a {@link redirects} table. */
export type RedirectRule = {
	/**
	 * The old URL path. A `:name` segment matches one path segment, and a `*`
	 * last segment matches the rest of the path, or nothing: `/docs/*` also
	 * matches `/docs`. A trailing slash does not change the match. Write the
	 * path as it is in the URL, percent-encoded. A rule matches the path only,
	 * so a query, a fragment, or a character that is not percent-encoded stops
	 * startup. So does a segment that starts with `:` or has `*` and is not
	 * `:name` or `*`, such as `:slug*` or `*.html`.
	 */
	from: string;
	/**
	 * The new URL: a local path, or an absolute `http` or `https` URL. It can
	 * use each `:name` and the `*` of `from`. An absolute URL is
	 * percent-encoded as UTF-8.
	 */
	to: string;
	/** @default 301 */
	status?: 301 | 308;
};

/** Options for {@link redirects}. */
export type RedirectsOptions = {
	/**
	 * The mode of the `trailingSlash` plugin that runs after this plugin. In
	 * the `never` mode, a local target loses its trailing slash. Each other
	 * mode sends the target as the rule has it. `defaultPlugins()` gives its
	 * own mode, which is `never` by default.
	 * @default "preserve"
	 */
	trailingSlash?: TrailingSlash;
};

/** A rule, compiled at startup. */
type CompiledRule = {
	/** The `from` path with no trailing slash. */
	key: string;
	pattern: RegExp | undefined;
	/** The first segment of `key`, or `undefined` when it is `:name` or `*`, which match each first segment. */
	first: string | undefined;
	to: string;
	status: 301 | 308;
	/** The origin of an absolute `to`, else `undefined`. */
	origin: string | undefined;
	/** The position of the rule in the table. */
	index: number;
};

const PARAM = /^:(?<name>[A-Za-z_]\w*)$/u;
const TARGET_TOKEN = /:(?<name>[A-Za-z_]\w*)|\*/gu;
const NO_RULES: readonly CompiledRule[] = [];

/**
 * A part of a URL path that a URL parse changes: a character that the parse
 * encodes or removes, a `\`, or a dot segment.
 */
const PARSE_CHANGES = /[^!$&-;=@-[\]_a-z|~]|\/\.\.?(?:\/|$)/u;

/**
 * Whether `path`, the path that Hono gives for the URL `href`, is the
 * `pathname` of that URL. Why not always: Hono decodes each escape of the
 * path, and Deno gives the URL as the client sent it, with no parse.
 */
function isPathname(path: string, href: string): boolean {
	const escape = href.indexOf("%");
	// Why not an escape after a `?`: it is in the query, and Hono decodes only the path.
	const isDecoded = escape !== -1 && href.lastIndexOf("?", escape) === -1;
	return !isDecoded && !PARSE_CHANGES.test(path);
}

/** `path` with no trailing slashes, and `/` for the root. */
function matchKey(path: string): string {
	return trimTrailingSlashes(path) || "/";
}

/** The first segment of `path`, a path with no trailing slash: `docs` for `/docs/a`, and an empty string for `/`. */
function firstSegment(path: string): string {
	const end = path.indexOf("/", 1);
	return end === -1 ? path.slice(1) : path.slice(1, end);
}

/** The pattern of `from`, with a named group for each `:name` and for `*`, or `undefined` for an exact path. */
function compilePattern(from: string): Pick<CompiledRule, "pattern" | "first"> & {
	names: Set<string>;
} {
	const segments = matchKey(from).split("/").slice(1);
	const names = new Set<string>();
	let first: string | undefined;
	const parts = segments.map((segment, index) => {
		const name = PARAM.exec(segment)?.groups?.name;
		if (name != null) {
			if (names.has(name)) {
				throw new Error(`The redirect from ${from} uses :${name} twice.`);
			}
			names.add(name);
			return `/(?<${name}>[^/]+)`;
		}
		if (segment === "*") {
			if (index !== segments.length - 1) {
				throw new Error(`The redirect from ${from} has a * that is not the last segment.`);
			}
			names.add("*");
			// Why `$`: a `:name` cannot have it, so the group name is free. Why optional: `/docs/*`
			// also moves `/docs`.
			return "(?:/(?<$splat>.*))?";
		}
		if (segment.startsWith(":") || segment.includes("*")) {
			throw new Error(
				`The redirect from ${from} has the segment ${segment}, which is not valid. Use :name for one whole segment, or * as the whole last segment. A literal segment cannot start with ":" or have "*".`,
			);
		}
		if (index === 0) {
			first = segment;
		}
		return `/${segment.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`)}`;
	});
	return {
		pattern: names.size === 0 ? undefined : new RegExp(`^${parts.join("")}$`, "u"),
		first,
		names,
	};
}

/** Compiles a rule, and throws for a rule that is not valid, so a bad table stops startup. */
function compileRule({ from, to, status = 301 }: RedirectRule, index: number): CompiledRule {
	if (!from.startsWith("/")) {
		throw new Error(`A redirect must be from a path that starts with "/", not ${from}.`);
	}
	const { pattern, first, names } = compilePattern(from);
	// Why: the request path comes from the URL parser, so a `from` that the parser changes can never match.
	const pathname = URL.parse(`http://localhost${from}`)?.pathname;
	if (pathname !== from) {
		throw new Error(
			`The redirect from ${from} can never match. A rule matches the path only. Write it percent-encoded, with no query and no fragment: ${pathname}.`,
		);
	}
	for (const token of to.matchAll(TARGET_TOKEN)) {
		const name = token.groups?.name ?? "*";
		if (!names.has(name)) {
			throw new Error(
				`The redirect from ${from} to ${to} uses ${token[0]}, which ${from} does not have.`,
			);
		}
	}
	if (to.startsWith("/")) {
		if (!isSafeLocalPath(to)) {
			throw new Error(`The redirect from ${from} goes to ${to}, which is not a safe local path.`);
		}
		return { key: matchKey(from), pattern, first, to, status, origin: undefined, index };
	}
	const url = URL.parse(to);
	if (url == null || (url.protocol !== "https:" && url.protocol !== "http:")) {
		throw new Error(`A redirect must go to a local path or an http(s) URL, not ${to}.`);
	}
	// Why `href`: a `Location` must be ASCII, and it percent-encodes the rest as UTF-8.
	return { key: matchKey(from), pattern, first, to: url.href, status, origin: url.origin, index };
}

/**
 * The first of `rules`, which are in table order, whose pattern matches
 * `path`, with the values that it matched. With `before`, it tests only the
 * rules before that position of the table.
 */
function firstMatch(
	rules: readonly CompiledRule[] | undefined,
	path: string,
	before = Infinity,
): { rule: CompiledRule; groups: Readonly<Record<string, string | undefined>> } | undefined {
	for (const rule of rules ?? NO_RULES) {
		if (rule.index > before) {
			break;
		}
		const groups = rule.pattern?.exec(path)?.groups;
		if (groups != null) {
			return { rule, groups };
		}
	}
	return undefined;
}

/** The target of `rule` for the values that its pattern matched. */
function fill(to: string, groups: Readonly<Record<string, string | undefined>>): string {
	const queryStart = to.indexOf("?");
	return to.replaceAll(TARGET_TOKEN, (token, name: string | undefined, offset: number) => {
		const value = name == null ? (groups.$splat ?? "") : (groups[name] ?? token);
		// Why: a path segment can have `&`, `=`, and `+`, but in a query they split or change the value.
		return queryStart !== -1 && offset > queryStart
			? value.replaceAll(/[&+=]/gu, (char) => encodeURIComponent(char))
			: value;
	});
}

/** `target` with no trailing slash on its path, as the `never` mode of `trailingSlash` wants. */
function withoutTrailingSlash(target: string): string {
	const pathEnd = target.search(/[#?]/u);
	const path = pathEnd === -1 ? target : target.slice(0, pathEnd);
	const rest = pathEnd === -1 ? "" : target.slice(pathEnd);
	return `${trimTrailingSlashes(path) || "/"}${rest}`;
}

/** `target` with the query string of the request added, before the fragment of `target`. */
function withQuery(target: string, search: string): string {
	if (search === "") {
		return target;
	}
	const hashIndex = target.indexOf("#");
	const path = hashIndex === -1 ? target : target.slice(0, hashIndex);
	const hash = hashIndex === -1 ? "" : target.slice(hashIndex);
	return `${path}${path.includes("?") ? `&${search.slice(1)}` : search}${hash}`;
}

/**
 * Sends a redirect from each old URL path in `rules` to its new URL, with
 * the query string. The first rule that matches wins. An exact path is a
 * map lookup. A rule with `:name` or `*` is a pattern. A request tests only
 * the patterns that start with its first path segment, and the patterns
 * whose first segment is `:name` or `*`.
 *
 * The rules compile at startup, and a rule that is not valid stops startup.
 * A local target must be a safe local path. An absolute target must keep the
 * origin that its rule names. A request whose values break either check goes
 * on to the next stage, and so does a request that is already at its
 * target. It applies to GET and HEAD only.
 *
 * Put it before `trailingSlash`, so `/old/` gets one redirect to the final
 * URL, and give it the same `trailingSlash` mode. Its default is
 * `"preserve"`, which is not the `"never"` of `defaultPlugins()`. In `never`
 * mode, a local target loses its trailing slash, so `trailingSlash` does not
 * redirect it again. `defaultPlugins({ redirects })` does both.
 *
 * @example
 * redirects([
 * 	{ from: "/blog/:slug", to: "/articles/:slug" },
 * 	{ from: "/docs/*", to: "https://docs.example.com/*", status: 308 },
 * ]);
 */
export function redirects(
	rules: readonly RedirectRule[],
	{ trailingSlash = "preserve" }: RedirectsOptions = {},
): Plugin {
	const compiled = rules.map((rule, index) => compileRule(rule, index));
	const exact = new Map<string, CompiledRule>();
	for (const rule of compiled.toReversed()) {
		// Why reversed: the first rule for a path wins.
		if (rule.pattern == null) {
			exact.set(rule.key, rule);
		}
	}
	// Why by first segment: a pattern with a literal first segment matches only a path with that
	// segment. So a request tests the patterns of its own first segment and the patterns that take
	// each first segment, which are at the `undefined` key, and not each pattern of the table.
	const patterns = Map.groupBy(
		compiled.filter((rule) => rule.pattern != null),
		(rule) => rule.first,
	);
	/** The first pattern before the table position `before` that matches `path`. */
	const matchPattern = (path: string, before: number | undefined) => {
		const own = firstMatch(patterns.get(firstSegment(path)), path, before);
		return firstMatch(patterns.get(undefined), path, own?.rule.index ?? before) ?? own;
	};
	const find = (path: string): { rule: CompiledRule; target: string } | undefined => {
		const exactRule = exact.get(path);
		const matched = patterns.size === 0 ? undefined : matchPattern(path, exactRule?.index);
		if (matched != null) {
			return { rule: matched.rule, target: fill(matched.rule.to, matched.groups) };
		}
		return exactRule == null ? undefined : { rule: exactRule, target: exactRule.to };
	};
	const redirect: MiddlewareHandler<AppServerEnv> = async (context, next) => {
		// Why the raw URL: Hono decodes `path`, but a `Location` must keep the percent-encoding.
		const url = new URL(context.req.url);
		const found = find(matchKey(url.pathname));
		if (found == null) {
			return next();
		}
		const target =
			trailingSlash === "never" && found.rule.origin == null
				? withoutTrailingSlash(found.target)
				: found.target;
		const location = withQuery(target, url.search);
		// Why: a rule such as `/tags/:tag` to `/tags/:tag/` also matches its own target. Why
		// `URL.parse`: the values of the request can make a target that is not a URL, such as `//%2F`.
		if (URL.parse(location, url)?.href === url.href) {
			return next();
		}
		const safe =
			found.rule.origin == null
				? isSafeLocalPath(location)
				: URL.parse(location)?.origin === found.rule.origin;
		return safe ? context.redirect(location, found.rule.status) : next();
	};
	return {
		name: "redirects",
		// oxlint-disable-next-line typescript/promise-function-async -- the server awaits each stage in a `try`, and an `async` stage adds a promise to each request.
		middleware: (context, next) => {
			const { method, path } = context.req;
			// Why no parse: most requests match no rule, and `find` tells that from the path alone
			// when the path is the `pathname` of the URL.
			return (method !== "GET" && method !== "HEAD") ||
				(isPathname(path, context.req.url) && find(matchKey(path)) == null)
				? next()
				: redirect(context, next);
		},
	};
}
