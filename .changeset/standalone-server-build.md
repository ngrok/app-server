---
"@ngrok/app-server": minor
---

A build with the `appServer` Vite plugin now runs with no install. Copy the build directory alone, and run `node build/server/app-server.js` (`dist/server/app-server.js` for TanStack Start), or the same file with `bun` or `deno run`. The README section "Deploy" has a Dockerfile.

- The plugin bundles each dependency into the server build. For the build, it sets `ssr.noExternal: true`, unless the app sets its own `ssr.noExternal` or sets `ssr.external: true`.
- Each package in `ssr.external` or in the bundler's `external` option, each peer dependency of a package that the app keeps external, and each native package stay external. A package is native when a `.node` file is in it, or in a package of its `dependencies` or `optionalDependencies`, such as `oxc-parser`. The build copies each external package, whole, with its installed dependencies, into `node_modules` in the server build.
- The build writes a `package.json` with `"type": "module"` into the server build.
- When a runtime runs `app-server.js` as its main module, the file starts the server, as `app-server serve` does. It sets `NODE_ENV` to `production` when `NODE_ENV` has no value. `app-server serve` works as before.
- If the build finds two copies of one external package, such as two versions, the build fails.

Breaking change: the server build is larger, and it no longer reads its dependencies from the app's `node_modules`. Run the build on the platform of the server, because the copy holds only the native addon of the build machine. To keep a package out of the bundle, add it to `ssr.external`. Before, a Dockerfile installed `@ngrok/app-server` in the image and ran `node node_modules/@ngrok/app-server/dist/cli.js serve build/server/app-server.js`. After, it copies `build` and runs `node build/server/app-server.js`.
