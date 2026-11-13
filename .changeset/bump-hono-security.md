---
"@ngrok/app-server": patch
---

The package now needs `hono` 4.13.16 or later, and it pins `@hono/node-server` 2.1.6, to get their security fixes:

- An `ECONNRESET` during a WebSocket upgrade no longer stops the Node process.
- A backslash in the request path is no longer a path separator, so a path rule at a reverse proxy applies.
- `hono` fixes `csrf()`, `validator('form')`, `mount()`, wildcard middleware in `RegExpRouter`, and HTML escapes in the `css` helper.
