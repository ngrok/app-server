---
"@ngrok/app-server": patch
---

Serve a protocol endpoint and a page at one URL, and send a request to the app's own routes in the same process.

- `protocolRoute({ path, handle, cors })` sends each page request at `path` to the framework, and each other request to `handle`, with the CORS headers of `cors`. A page request is a `GET` or a `HEAD` that does not accept `text/event-stream`. A `GET` and a `HEAD` at `path` get `Vary: Accept`, and a prerendered page at `path` stays off the CDN pages. Put it in `beforeStatic`. For example, `/mcp` answers Model Context Protocol (MCP) clients, and a browser at `/mcp` gets the page.
- `appFetch(request)` sends a request through the framework in the same process and gives the response. It skips each plugin, so the request gets no access log line and no compression. Use it in a plugin, a route, or a loader.
