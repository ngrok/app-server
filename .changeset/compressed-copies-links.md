---
"@ngrok/app-server": patch
---

The build writes the compressed copies (`.<file>.gz` and `.<file>.br`) only inside the client build. Before, a directory link in the client build, such as `build/client/blog-assets` to `public/blog-assets`, got the copies in the link's target. A link and a file in a linked directory now get no copy. The server compresses such a file for each request, as it does for any file with no copy.
