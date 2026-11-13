---
"@ngrok/app-server": patch
---

`@ngrok/app-server/node` exports `requestListener`, the `node:http` request listener of the node host. A host adapter or a `Listener` of your own on `node:http`, such as one for HTTPS or a Unix socket, can now use it: `http.createServer(requestListener(entry.fetch))`. It gives each request the `edge` binding on Node.js, so the server copies no response, and the access log has the head and the bytes that went out. The README section "Adapters" also says how a serverless host gets the log lines of a request to stdout before the platform freezes it.
