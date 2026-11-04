---
"@ngrok/app-server": patch
---

With `markdownTwins: true`, a request that `rewrite` changes gets no twin. `rewrite` sends that request to another file or to the framework, so it gets the same answer as a browser. An app no longer repeats its `rewrite` rule in `twinOf`:

```ts
prerendered({
	rewrite: (path, c) => (path === "/" && new URL(c.req.url).search !== "" ? "/index.html" : path),
	markdownTwins: true,
});
```

`/?q=h100` gets no twin, and `/gpu/h100` gets `/gpu/h100.md`. A custom `twinOf` still decides for each request. `rewrite` now runs for each request, also for a request that gets the twin.
