---
"@ngrok/app-server": minor
---

**Breaking:** four public functions take named arguments: one object, or a subject and then one options object.

- `withHeaderHook({ context, next, hook })` takes one object. The new type `HeaderHookOptions` names it.
- A host adapter's `files(...).open(path, { range })` takes `range` in an options object.
- `ResponseEdge.useHeaders({ base, headers })` takes one object.
- `AppServerEntry.fetchDev(request, { bindings, devServer })` takes an options object, and `bindings` is optional. The entry protocol is now 3, so the CLI refuses a build from an earlier version. Install the same version of `@ngrok/app-server` that the build uses.

Before:

```ts
const frameOptions: Plugin = {
	name: "frame-options",
	middleware: async (c, next) =>
		withHeaderHook(c, next, (headers) => {
			headers.set("X-Frame-Options", "DENY");
		}),
};

const files: StaticFiles = {
	stat,
	open: async (path, range) => read(path, range),
};
```

After:

```ts
const frameOptions: Plugin = {
	name: "frame-options",
	middleware: async (c, next) =>
		withHeaderHook({
			context: c,
			next,
			hook: (headers) => {
				headers.set("X-Frame-Options", "DENY");
			},
		}),
};

const files: StaticFiles = {
	stat,
	open: async (path, options) => read(path, options?.range),
};
```
