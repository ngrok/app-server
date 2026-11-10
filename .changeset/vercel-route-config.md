---
"@ngrok/app-server": patch
---

The README and the JSDoc of `vercel({ maxDuration })` say that a route module's `config` export, such as `export const config = { maxDuration: 60 }`, does nothing on the `vercel` host. One function serves each route, so `regions`, `memory`, and `maxDuration` apply to each request.
