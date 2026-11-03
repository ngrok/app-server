---
"@ngrok/app-server": minor
---

`markdownTwins` in development now gives only a twin that the build will prerender, when the framework knows those paths. React Router knows them from its `prerender` config. TanStack Start does not, so each twin route that answers markdown still counts.

Breaking: `SetupInfo.prerenderedPaths` moves into each `mode` member of the union. In development, it is `undefined` when the framework finds the paths only during the build. A plugin that reads it checks `mode` first.
