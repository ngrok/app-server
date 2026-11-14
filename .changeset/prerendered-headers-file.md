---
"@ngrok/app-server": patch
---

`prerendered({ headers })` also gets `file`, the URL path of the served file, such as `/about/index.html`. It is the path that `cacheControl` gets. `path` keeps its value: the path that names the file, such as `/about`. So a callback can now match each HTML page by its file:

```ts
prerendered({
	headers: ({ file }) => (file.endsWith(".html") ? { "CDN-Cache-Control": "max-age=300" } : undefined),
});
```

The docs of `headers`, `skip`, and `cacheControl` now say which path each one gets.
