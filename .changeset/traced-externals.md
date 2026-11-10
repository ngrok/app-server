---
"@ngrok/app-server": patch
---

The server build now copies only the files of an external package that the build can load. Before, it copied each external package whole, with each of its installed dependencies. The build traces the server build with `@vercel/nft`, and removes each other copied file, such as a source map or a dependency that the package bundled into its own file. For `@vercel/og` 1.0.1, the copy goes from 42.9 MB to 23.6 MB.

Some packages still keep each file: a native package and each package that it depends on, a package in `ssr.external`, and a package that the app gives to `require.resolve()` or `import.meta.resolve()`. Two new `appServer` options change the copy:

- `externals.whole`: packages that keep each file, for a package that reads a file whose path the trace cannot find.
- `externals.omit`: packages that the build does not copy, such as an optional dependency that a package loads in a `try`. With `appServer({ externals: { omit: ["sharp"] } })`, the copy for `@vercel/og` is 3.0 MB, and `@vercel/og` uses `resvg.wasm`.
