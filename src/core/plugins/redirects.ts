import { isSafeLocalPath } from "../safe-local-path.js";
import type { Plugin } from "../types.js";
import { trimTrailingSlashes } from "./trailing-slash.js";

/** One redirect of a {@link redirects} table. */
export type RedirectRule = {
	/**
	 * The old URL path. A `:name` segment matches one path segment, and a `*`
	 * last segment matches the rest of the path. A trailing slash does not
	 * change the match. Write the path as it is in the URL, percent-encoded.
	 */
	from: string;
	/**
	 * The new URL: a local path, or an absolute `http` or `https` URL. It can
	 * use each `:name` and the `*` of `from`.
	 */
	to: string;
	/** @default 301 */
	status?: 301 | 308;
};

/** A rule, compiled at startup. */
type CompiledRule = {
	/** The `from` path with no trailing slash. */
	key: string;
	pattern: RegExp | undefined;
	to: string;
	status: 301 | 308;
	/** The origin of an absolute `to`, else `undefined`. */
	origin: string | undefined;
	/** The position of the rule in the table. */
	index: number;
};

const PARAM = /^:(?<name>[A-Za-z_]\w*)$/u;
const TARGET_TOKEN = /:(?<name>[A-Za-z_]\w*)|\*/gu;

/** `path` with no trailing slashes, and `/` for the root. */
function matchKey(path: string): string {
	return trimTrailingSlashes(path) || "/";
}

/** The pattern of `from`, with a named group for each `:name` and for `*`, or `undefined` for an exact path. */
function compilePattern(from: string): { pattern: RegExp | undefined; names: Set<string> } {
	const segments = matchKey(from).split("/").slice(1);
	const names = new Set<string>();
	const parts = segments.map((segment, index) => {
		const name = PARAM.exec(segment)?.groups?.name;
		if (name != null) {
			if (names.has(name)) {
				throw new Error(`The redirect from ${from} uses :${name} twice.`);
			}
			names.add(name);
			return `(?<${name}>[^/]+)`;
		}
		if (segment === "*") {
			if (index !== segments.length - 1) {
				throw new Error(`The redirect from ${from} has a * that is not the last segment.`);
			}
			names.add("*");
			// Why `$`: a `:name` cannot have it, so the group name is free.
			return "(?<$splat>.+)";
		}
		return segment.replaceAll(/[$()*+.?[\\\]^{|}]/gu, String.raw`\$&`);
	});
	return {
		pattern: names.size === 0 ? undefined : new RegExp(`^/${parts.join("/")}$`, "u"),
		names,
	};
}

/** Compiles a rule, and throws for a rule that is not valid, so a bad table stops startup. */
function compileRule({ from, to, status = 301 }: RedirectRule, index: number): CompiledRule {
	if (!from.startsWith("/")) {
		throw new Error(`A redirect must be from a path that starts with "/", not ${from}.`);
	}
	const { pattern, names } = compilePattern(from);
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
		return { key: matchKey(from), pattern, to, status, origin: undefined, index };
	}
	const url = URL.parse(to);
	if (url == null || (url.protocol !== "https:" && url.protocol !== "http:")) {
		throw new Error(`A redirect must go to a local path or an http(s) URL, not ${to}.`);
	}
	return { key: matchKey(from), pattern, to, status, origin: url.origin, index };
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
 * map lookup. A rule with `:name` or `*` is a pattern.
 *
 * The rules compile at startup, and a rule that is not valid stops startup.
 * A local target must be a safe local path. An absolute target must keep the
 * origin that its rule names. A request whose values break either check goes
 * on to the next stage, and so does a request that is already at its
 * target. It applies to GET and HEAD only.
 *
 * Put it before `trailingSlash`, so `/old/` gets one redirect to the final
 * URL. `defaultPlugins({ redirects })` does that.
 *
 * @example
 * redirects([
 * 	{ from: "/blog/:slug", to: "/articles/:slug" },
 * 	{ from: "/docs/*", to: "https://docs.example.com/*", status: 308 },
 * ]);
 */
export function redirects(rules: readonly RedirectRule[]): Plugin {
	const compiled = rules.map((rule, index) => compileRule(rule, index));
	const exact = new Map<string, CompiledRule>();
	for (const rule of compiled.toReversed()) {
		// Why reversed: the first rule for a path wins.
		if (rule.pattern == null) {
			exact.set(rule.key, rule);
		}
	}
	const patterns = compiled.filter((rule) => rule.pattern != null);
	const find = (path: string): { rule: CompiledRule; target: string } | undefined => {
		const exactRule = exact.get(path);
		for (const rule of patterns) {
			if (exactRule != null && rule.index > exactRule.index) {
				break;
			}
			const groups = rule.pattern?.exec(path)?.groups;
			if (groups != null) {
				return { rule, target: fill(rule.to, groups) };
			}
		}
		return exactRule == null ? undefined : { rule: exactRule, target: exactRule.to };
	};
	return {
		name: "redirects",
		middleware: async (context, next) => {
			const { method } = context.req;
			if (method !== "GET" && method !== "HEAD") {
				return next();
			}
			// Why the raw URL: Hono decodes `path`, but a `Location` must keep the percent-encoding.
			const url = new URL(context.req.url);
			const found = find(matchKey(url.pathname));
			if (found == null) {
				return next();
			}
			const location = withQuery(found.target, url.search);
			// Why: a rule such as `/tags/:tag` to `/tags/:tag/` also matches its own target.
			if (new URL(location, url).href === url.href) {
				return next();
			}
			const safe =
				found.rule.origin == null
					? isSafeLocalPath(location)
					: URL.parse(location)?.origin === found.rule.origin;
			return safe ? context.redirect(location, found.rule.status) : next();
		},
	};
}
