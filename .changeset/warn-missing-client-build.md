---
"@ngrok/app-server": patch
---

A production server whose client build is not there now says so. At startup, it writes one warn line, `client build not found`, with the directory as `app_server.client_directory`. Before, the server started with only `listening`, and each asset got a 404, such as in a Docker image that copied only the server build. The server still starts, because an app can keep its client build on a CDN. A directory with no files gives no line.
