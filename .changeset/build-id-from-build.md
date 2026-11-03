---
"@ngrok/app-server": patch
---

`buildId()` needs no `value` now. After the client build, the `appServer` Vite plugin hashes the name and the content of each file of the client bundle. It writes the hash as `buildId` in `.app-server.json`. With no `value`, `buildId()` sends that ID.

- The ID changes when the code that an open tab runs changes. A deploy that changes only the server, a `public/` file, or a prerendered page keeps it, so an open tab does not move for nothing.
- An explicit `value`, such as the image tag, wins. With an unset variable, such as `value: process.env.IMAGE_TAG`, the plugin sends the build's ID.
- In development, `buildId()` with no `value` sends no build, because Vite's HMR updates an open tab after each edit.

Build the app again, so `.app-server.json` has the build ID.
