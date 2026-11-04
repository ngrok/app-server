---
"@ngrok/app-server": patch
---

`markdownTwins.twinOf` gets the request's Hono context as its second argument, the same as `rewrite` and `headers`. If `twinOf` gives `undefined`, the request gets no twin, and `rewrite` runs. Use it to keep a request off the prerendered twin, such as a request with a query that the framework renders:

```ts
prerendered({
	markdownTwins: {
		twinOf: (path, c) =>
			new URL(c.req.url).search === "" ? `${path === "/" ? "/index" : path}.md` : undefined,
	},
});
```
