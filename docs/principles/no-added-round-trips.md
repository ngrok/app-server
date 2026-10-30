# Add no round trips to a client navigation

A client-side navigation makes the requests that the router makes, and no more. Never add a request to the server for each navigation: no probe, no poll, no version check, and no wait on the server before the router starts.

**Why:** A client-side navigation must feel instant. Assets come from a cache near the visitor, but loaders and actions run on the app's servers, which can be far from the visitor. Each request to those servers adds its full network latency to the navigation, and the visitor sees the wait. A navigation that needs no data must reach the server zero times. A navigation that needs data must reach it once.

**Applies to:** code.

**Signs you missed it:**

- Client code that sends a request before, after, or next to the router's data request, such as a version check or a "is my build current" probe.
- A timer that polls the server, or a check on each focus or visibility change.
- A server response that sends the client back to the server for its data, such as a redirect for each data request.
- A feature that needs a value from the server that the router's own responses could carry as a header.

**In this repo:**

- `buildId()` puts the build on the document, on the data responses that the router already fetches, and on the responses of the app's proxy routes in `paths`.
- `staleBuildNavigation()` reads that header from those responses. It sends no request. After a deploy, one navigation also loads its target as a document: one more request, once for each deploy.
- The document's build travels in `Server-Timing`, so the client reads it with no request.

**Enforced by:** the `staleBuildNavigation()` tests, which count the requests of each navigation; review for the rest.
