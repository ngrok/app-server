---
"@ngrok/app-server": minor
---

The options of the plugins get one name for each job, and a bad value or a bad plugin list now stops startup. Each breaking change has a before and an after.

Breaking change: the option that names the build header is now `headerName` in `buildId()`, `staleBuildReactRouter()`, and `staleBuildTanStack()`, as in `requestId()`. Before, it was `header`. JavaScript ignores the old name with no error, and the server then sends `X-Build-Id` again.

```ts
// Before
defaultPlugins({ buildId: { header: "X-App-Build" } });
staleBuildReactRouter({ header: "X-App-Build" });
staleBuildTanStack(router, { header: "X-App-Build" });

// After
defaultPlugins({ buildId: { headerName: "X-App-Build" } });
staleBuildReactRouter({ headerName: "X-App-Build" });
staleBuildTanStack(router, { headerName: "X-App-Build" });
```

Breaking change, for a listener that writes each response itself: `ResponseEdge.close` now takes one object, so the call says what each value is. Before, it took three positional values. JavaScript gives no error for the old call: the access log line then has no status.

```ts
// Before
edge.close(status, aborted, head);

// After
edge.close({ status, aborted, head });
```

The object costs about 60 bytes of heap for each response on Node.js and Vercel, and no time that the benchmark shows. Measured on Node.js 26.13 on an Apple M3 Max, with the built `ResponseEdge` of one build and only the `close` line changed: one edge for one response (`new`, `claim`, `useHeaders`, `onSent`, `close`) takes 36.2 ns before and 35.5 ns after, and 956 bytes of heap before against 1,015 bytes after. Each number is the median of 5 runs in turn, and each run is the median of 9 rounds of 3,000,000 edges. Three sets of runs gave a cost from 56 to 64 bytes. For scale, one `/ping` request through `defaultPlugins()` allocates about 38,700 bytes.

Breaking change: `health()` now stops startup for a `livePath` or a `readyPath` that does not start with `/`, and for one path for both probes. Before, a path with no `/` never answered. One path for both probes always answered 200, so `ready` never ran, and the path did not answer 503 at shutdown. The check also finds one option that has the default of the other, such as `readyPath: "/livez"`. For a platform with one health URL, set only `readyPath`.

```ts
// Before
defaultPlugins({ health: { livePath: "/healthz", readyPath: "/healthz", ready } });

// After
defaultPlugins({ health: { readyPath: "/healthz", ready } });
```

The error names the option, the value, and the fix:

```
health needs a livePath and a readyPath that differ. Both are "/healthz", so the readiness check would never run. For one health URL, set only readyPath.
```

Breaking change: a header name or a header value in an option that no header can hold now stops startup. Before, the server started, and each response that got the header was a 500, while `/livez` and `/readyz` answered 200. The log line did not name the option. The checks cover `headerName` of `requestId()` and `buildId()`, `value` of `buildId()`, `unlessHeader` of `noindex()`, and each value of `securityHeaders({ headers })`. A value can hold a tab and each character from U+0020 to U+00FF except U+007F, so a value such as `café` still works.

```ts
// Before: the server started, and each page answered 500.
defaultPlugins({ buildId: { value: "v42\n" } });
defaultPlugins({ securityHeaders: { headers: { "Content-Security-Policy": "frame-ancestors ‘none’" } } });

// After: remove the line break, and use the ASCII quote.
defaultPlugins({ buildId: { value: "v42" } });
defaultPlugins({ securityHeaders: { headers: { "Content-Security-Policy": "frame-ancestors 'none'" } } });
```

An empty `unlessHeader` also stops startup now. Before, `noindex({ unlessHeader: "" })` started and set no `X-Robots-Tag` on any response, so a search engine could index a preview deploy. Give the header a name, or use `noindex: true`.

```ts
// Before
defaultPlugins({ noindex: { unlessHeader: process.env.EDGE_HEADER ?? "" } });

// After
defaultPlugins({ noindex: process.env.EDGE_HEADER ? { unlessHeader: process.env.EDGE_HEADER } : true });
```

The error names the option, the value, and the fix:

```
The value of buildId must be a value that a header can hold, not "v42\n". Remove each control character, such as a line break, and each character above U+00FF.
```

Breaking change: a second plugin of the options `requestId`, `accessLog`, `securityHeaders`, `bodyLimit`, `trailingSlash`, or `prerendered` of `defaultPlugins()` now stops startup, as a second `health`, `noindex`, `buildId`, `contentSecurityPolicy`, or `env` plugin already did. Before, the server started, and the two copies did not act as one. For example, a second `bodyLimit()` with a higher limit changed nothing, a second `trailingSlash()` in another mode sent each page into a redirect loop, and a second `accessLog()` wrote two lines for each request. A second `redirects()` still starts, because a second table is valid. Use the option:

```ts
// Before
createServer({ plugins: [...defaultPlugins(), bodyLimit({ maxBytes: 52_428_800 })] });

// After
createServer({ plugins: defaultPlugins({ bodyLimit: 52_428_800 }) });
```

Two lists that worked before now also stop startup. A second `bodyLimit()` with a lower limit: set the `bodyLimit` option to the lower limit. A second `prerendered()` for the paths that the first one skips: use one `prerendered`, whose `skip`, `rewrite`, `headers`, and `cacheControl` decide by path. To put your own copy of a plugin at another place, turn the option off with `false`, or filter the default out of the list:

```ts
createServer({
	plugins: [...defaultPlugins().filter((plugin) => plugin.name !== "access-log"), accessLog()],
});
```

Breaking change: a plugin of the options `securityHeaders`, `noindex`, `buildId`, `contentSecurityPolicy`, or `env` that comes after `prerendered()` in the plugin list now stops startup. Before, the server started, and each prerendered page went out with no CSP, no `X-Robots-Tag`, no build ID, or no public `runtimeEnv` values, while each rendered page had them. Development serves no prerendered page, so only production showed the failure. The check does not read the build, so such a list also stops startup for an app with no prerendered page. Use the option, or put the plugin before `prerendered()`, such as in `beforeStatic`:

```ts
// Before
createServer({ plugins: [...defaultPlugins(), contentSecurityPolicy({ policy }), noindex(), env] });

// After
createServer({
	plugins: defaultPlugins({ contentSecurityPolicy: { policy }, noindex: true, env }),
});
```

The error names the plugin, the option, and the other way out:

```
The noindex plugin comes after prerendered(), so the prerendered pages do not get it. Set the "noindex" option of defaultPlugins(), or put the plugin before prerendered().
```

Breaking change: when `prerendered({ cacheControl })` gives `undefined` for a file, the file now gets the default `Cache-Control`. Before, it got none, so a function that set a value for some files took the default off each other file, and each CDN then used its own rules for them. The example of the option did that:

```ts
prerendered({
	cacheControl: (file) => (file.startsWith("/images/") ? "public, max-age=86400" : undefined),
});
// Before: `/about`, `/about.data`, and `/llms.txt` had no `Cache-Control`.
// After: `/about` and `/about.data` have `public, max-age=0, must-revalidate`, and `/llms.txt` has
// `public, max-age=3600, stale-while-revalidate=86400`.
```

`cacheControl: () => undefined` no longer removes the header. To send no `Cache-Control`, delete it in a header hook of a plugin before the static stages. A prerendered file behind an auth check still needs `Cache-Control: private` from the auth plugin.

```ts
// Before
defaultPlugins({ prerendered: { cacheControl: () => undefined } });

// After
const noCacheControl: Plugin = {
	name: "no-cache-control",
	middleware: async (c, next) =>
		withHeaderHook(c, next, (response) => {
			if (isClientBuildFile(c.req.path)) {
				response.delete("Cache-Control");
			}
		}),
};
defaultPlugins({ beforeStatic: [noCacheControl] });
```

`isClientBuildFile` stands for the app's own test of the path. Without it, the hook also removes the header of each rendered page.

Breaking change: `redirects` now stops startup for a `from` that no request path can equal: one with a query, a fragment, a dot segment, or a character that is not percent-encoded, such as a space or `é`. It also stops startup for a segment of `from` that starts with `:` or has `*` and is not `:name` or `*`, such as `:id?`, `:slug*`, `(.*)`, and `*.html`. Before, each of these rules started, and its old URL got the framework's 404. A rule matches the path only, so a rule cannot select one query.

```ts
// Before: each rule started and never matched.
redirects([
	{ from: "/café", to: "/cafe" },
	{ from: "/old?page=1", to: "/new" },
	{ from: "/blog/:slug*", to: "/articles/:slug" },
]);

// After
redirects([
	{ from: "/caf%C3%A9", to: "/cafe" },
	{ from: "/old", to: "/new" },
	{ from: "/blog/*", to: "/articles/*" },
]);
```

A literal segment that starts with `:` or has `*`, such as `/files/:1` or `/a*b`, did redirect before. It also stops startup now, and it has no form in a rule. Answer such a path with a route of the app.

The error names the rule and the fix:

```
The redirect from /café can never match. A rule matches the path only. Write it percent-encoded, with no query and no fragment: /caf%C3%A9.
```

Breaking change: `runtimeEnv(schema, { publicPrefix: "" })` now throws. Before, an empty prefix made each value public, so the server wrote each value, secrets included, into each HTML document. Set a prefix of one character or more, and give each public value a name with that prefix.

```ts
// Before: `SESSION_KEY` went into each HTML document.
runtimeEnv(z.object({ API_URL: z.url(), SESSION_KEY: z.string() }), { publicPrefix: "" });

// After
runtimeEnv(z.object({ PUBLIC_API_URL: z.url(), SESSION_KEY: z.string() }));
```
