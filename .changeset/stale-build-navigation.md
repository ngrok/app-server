---
"@ngrok/app-server": patch
---

Add `staleBuildNavigation()` from the new `@ngrok/app-server/client` entry. After a deploy, it moves an open tab to the new build at the next navigation, and the page that the visitor reads never reloads.

- When the router's data response comes from a new build and the visitor clicked a link or stepped in history, the browser loads the target URL as a document. The old code never renders the new data.
- After that, each link click, history step, and `history.pushState` loads its target as a document.
- A prefetch, such as a `<Link prefetch="intent">` hover, can show the new build before the click.
- `onNewBuild(served)` runs once when the tab first sees another build, for the app's RUM tool.

It sends no request of its own, so a client navigation makes the same requests as before. Call it in the client entry before the router starts, and keep `buildId()` in the server's pipeline. `buildId()` now also sends the build as `Server-Timing: build;desc="<value>"` on each document and data response, so the client can read the build with no request.
