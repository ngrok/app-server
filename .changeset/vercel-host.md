---
"@ngrok/app-server": patch
---

Add the `vercel` host. It runs the pipeline in one Node.js Vercel Function, and Vercel's CDN serves the hashed files.

```ts
// vite.config.ts
import { vercel } from "@ngrok/app-server/vercel/vite";

appServer({ host: vercel() });
```

After the build, `vercel()` writes `.vercel/output`. Deploy it with `vercel deploy --prebuilt`.

- The CDN serves the files under `/assets/` with a one-year immutable cache. The `cdnPaths` option adds more prefixes, and `cdnHeaders` adds headers to each CDN file, such as CORS headers.
- The function answers each other request, prerendered pages included, so each page gets the same headers. It carries the whole server build and the rest of the client build.
- The request scheme comes from `X-Forwarded-Proto`, and the client address comes from `X-Real-IP`, because Vercel sets both headers.
- The `regions`, `memory`, and `maxDuration` options set the function's Vercel config.

For a host adapter:

- The `appServer` export of a build has a `fetch(request, bindings)` for a serverless host. It answers one request and does not listen. The first call runs each plugin's `setup`.
- The server entry also exports `hostModule`, the host's run-side module, from the bundle.
- `HostRuntime.listeners` is optional. `start()` throws when the app and the host have no listener.
- `HostBuild` has an optional `output` that writes the host's deploy output after the build.
