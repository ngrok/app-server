---
"@ngrok/app-server": patch
---

Add `staleBuildNavigation()` from the new `@ngrok/app-server/client` entry. After a deploy, it moves an open tab to the new build at the next navigation, and the page that the visitor reads never reloads.

- When the router's data response comes from a new build and a navigation started that request, the browser loads the target URL as a document. A navigation is a link click, a history step, or a history update to a new page. The old code never renders the new data.
- After that, each `history.pushState` and `history.replaceState` to a new page loads its target as a document.
- The app's click handlers and the router's blockers still run first, so they can cancel a navigation.
- A build in a response from another origin does not count.
- A prefetch, such as a `<Link prefetch="intent">` hover, can show the new build before the click.
- `onNewBuild(served)` runs once when the tab first sees another build, for the app's RUM tool.

It sends no request of its own, so a client navigation makes the same requests as before. Call it in the client entry before the router starts, and keep `buildId()` in the server's pipeline. `buildId()` now also sends the build as `Server-Timing: build;desc="<value>"` on each document and data response, so the client can read the build with no request.

Add the `paths` option of `buildId()`. The responses of those request paths, such as the app's API proxy routes, also carry the build in `Server-Timing`. Each query and mutation through them then tells an open tab about a new deploy, with no extra request. A response that a cache can use again without the server gets no build. The build replaces a `build` metric from the upstream API.
