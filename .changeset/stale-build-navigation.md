---
"@ngrok/app-server": patch
---

Add `staleBuildFetch()` and `staleBuildNavigation()` from the new `@ngrok/app-server/client` entry. After a deploy, they move an open tab to the new build at the next navigation, and the page that the visitor reads never reloads.

- React Router: give `staleBuildFetch()` to `HydratedRouter` as `unstable_fetch`.
- TanStack Start: call `staleBuildNavigation(router)` in `getRouter()`, on the client only.
- The router tells the module when a navigation starts, after its blockers. A canceled link, `navigate()`, a form, and a history step each act as the router acts.
- If a data request of a navigation gets a response from a new build, the browser loads the target URL as a document. The old code never renders the new data.
- If the tab already knows of a new build, the next navigation loads its target as a document.
- A revalidation, a fetcher, an action, and a request outside a navigation get their response, and only mark the tab.
- A build in a response from another origin does not count, also after a redirect.
- A prefetch, such as a `<Link prefetch="intent">` hover, can show the new build before the click.
- `onNewBuild(served)` runs once when the tab first sees another build, for the app's RUM tool.

They send no request of their own and add no wait, so a client navigation makes the same requests as before. Keep `buildId()` in the server's pipeline. `buildId()` now also sends the build as `Server-Timing: build;desc="<value>"` on each document and data response, so the client can read the build with no request.

Add the `paths` option of `buildId()`. The responses of those request paths, such as the app's API proxy routes, also carry the build in `Server-Timing`. Each query and mutation through them then tells an open tab about a new deploy, with no extra request. A response that a cache can use again without the server gets no build. `buildId()` removes the build header and the `build` metric of an upstream API from each response, so the client reads only this app's build.

A header hook can now `delete` a header, with `response.delete(name)`.
