---
"@ngrok/app-server": patch
---

The access log costs less on Node.js and Vercel. The listener counts the body bytes as it gives them to the socket, so the access log no longer puts a second stream around each body or copies the response. On Bun and Deno, the server counts the bytes with one stream around the body, as before.

The line changes in these ways:

- The line is for the response that leaves the server, after each stage. A response that an earlier plugin puts in place of the logged one now gets its line, with the status and bytes that the client got. Before, such a response got no line.
- `http.status_code` is the status that went out, such as the 500 for a response that could not go out.
- On Node.js and Vercel, `duration` ends when the response closes, after the last bytes go to the socket. For a slow client, it now includes the time to send the body.
- On Node.js and Vercel, `http.client_aborted` is also set when the client leaves before Node.js sends the last bytes, and when a body fails or ends before its `Content-Length` after the head.
- A log sink that throws no longer changes the response. Before, such a sink turned a HEAD request into a 500.
