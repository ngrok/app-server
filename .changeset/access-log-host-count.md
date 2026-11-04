---
"@ngrok/app-server": patch
---

The access log costs less on Node.js and Vercel. The listener counts the body bytes as it gives them to the socket, so the access log no longer puts a second stream around each body or copies the response. On Bun and Deno, the access log counts the bytes in the pipeline as before.

The line changes in four ways:

- `duration` ends when the response closes, after the last bytes go to the socket. For a slow client, it now includes the time to send the body.
- `http.client_aborted` is also set when the client leaves before Node.js sends the last bytes.
- A response that an earlier plugin puts in place of the logged one now gets its line, with the status and bytes that the client got.
- A log sink that throws no longer changes the response. Before, such a sink turned a HEAD request into a 500.
