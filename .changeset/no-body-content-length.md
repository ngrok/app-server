---
"@ngrok/app-server": patch
---

On Node.js and Vercel, a response with no body now goes out with `Content-Length: 0`, such as each 308 of `trailingSlash` and `redirects`. Before, it went out with `Transfer-Encoding: chunked` and an empty chunk. That is 14 bytes less for each such response: the 308 of `GET /page/` is 340 bytes before and 326 bytes now, read from a raw socket. A HEAD response, a 204, and a 304 stay as they are. Bun and Deno already send `Content-Length: 0`.
