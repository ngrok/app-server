---
"@ngrok/app-server": patch
---

The server build now works with a package that reads a file next to its own module, such as `@vercel/og` with `resvg.wasm`. Such a package stays external, and the build copies it. The build also copies each package that the app's code gives to `require.resolve()` or `import.meta.resolve()` as a string. Before, the app had to add each of these packages to `ssr.external`, else the server failed when it read the file.
