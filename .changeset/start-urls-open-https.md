---
"@ngrok/app-server": patch
---

`app-server start` now does three more things as `vite dev` does:

- **`server.resolvedUrls`:** a Vite plugin now reads the URLs of the server from `server.resolvedUrls`, from the `listening` event of `server.httpServer` on, and after a Vite restart. Before, the value was `null`.
- **`server.open`:** `start` now opens the browser when Vite's `server.open` is `true` or a path. `BROWSER` and `BROWSER_ARGS` apply, and `BROWSER=none` opens nothing. On Deno, give `--allow-run`. Before, `start` ignored the option.
- **`server.https`:** `start` serves HTTP only. It now writes a warning when `server.https` has a value that turns HTTPS on in `vite dev`, also when a plugin such as `@vitejs/plugin-basic-ssl` sets it. `server.https: false` gets no warning. Before, `start` served HTTP with no message.

With `server.https` set, Vite also turned off its check of the `Host` header. A plain HTTP server needs that check against a DNS rebinding attack, so `start` now keeps it on. If you open `start` through a tunnel or a proxy with another host name, and your config sets `server.https`, Vite now answers 403 for that host. Add the host to `server.allowedHosts`, as an app with no `server.https` does.
