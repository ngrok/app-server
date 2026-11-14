---
"@ngrok/app-server": minor
---

One breaking change to the contract of a host adapter. An app with no host adapter of its own needs no change.

**`FileInfo` is a union on `kind`, and a directory has no `size` and no `mtimeMs`.** No code reads a size or a time of a directory, and the node host made up `size: 0` to fit the type. A `stat` of a host adapter of your own now gives only `{ kind: "directory" }` for a directory. Code that reads `size` or `mtimeMs` must check `kind === "file"` first. TypeScript reports each place.

```ts
// Before
const files: StaticFiles = {
	stat: async (path) =>
		isDirectory(path)
			? { kind: "directory", size: 0, mtimeMs: 0 }
			: { kind: "file", size: sizeOf(path), mtimeMs: timeOf(path) },
	open,
};
const info = await files.stat("/docs");
const size = info?.size;

// After
const files: StaticFiles = {
	stat: async (path) =>
		isDirectory(path)
			? { kind: "directory" }
			: { kind: "file", size: sizeOf(path), mtimeMs: timeOf(path) },
	open,
};
const info = await files.stat("/docs");
const size = info?.kind === "file" ? info.size : undefined;
```

`nodeFiles(...).stat(path)` and the `stat` of its snapshot give `{ kind: "directory" }` for a directory, with no `size: 0` and no `mtimeMs`. No response changes. In JavaScript, a host that still gives the two fields for a directory works as before.
