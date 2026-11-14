---
"@ngrok/app-server": minor
---

With `markdownTwins`, `prerendered()` now adds `Vary: Accept` and the `Link` to the twin in a header hook. Before, it copied each response for a path with a twin to set the two headers. The client gets the same headers.

Breaking change for a plugin: a stage before `prerendered()` no longer sees the two headers on `c.res` after its `await next()`, as with each header that a hook sets. Read them in a header hook.

```ts
// Before
middleware: async (c, next) => {
	await next();
	const link = c.res.headers.get("Link");
},

// After
middleware: async (c, next) =>
	withHeaderHook({
		context: c,
		next,
		hook: (headers) => {
			const link = headers.get("Link");
		},
	}),
```

The hook also adds the two headers to a response that an earlier stage puts in place of the answer after its `next()`, such as a 401 for a path with a twin. Before, that response had neither.

In process, with the default plugins and `markdownTwins: true`, and a `ResponseEdge` as the node listener calls the server (5 processes, each with 9 rounds of 3,000 requests, the build before and this change in turn; Node.js 26.13, Apple M3 Max, with other load on the machine): a prerendered page with a twin takes 0.90 of its time before (19.0 µs to 17.2 µs), the twin for an agent 0.92, and a rendered page with a twin 0.94. Each ratio is the middle of 3 runs. A path with no twin takes the same time (0.987 and 1.008 in 9 processes).
