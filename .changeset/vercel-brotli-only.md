---
"@ngrok/app-server": patch
---

On the `vercel` host, the function now keeps only the `.br` copy of a client-build file that has one. Before, it kept the file, its `.gz` copy, and its `.br` copy, and each one counted toward Vercel's 250 MB function limit. For a blog with 265 prerendered pages, that makes the function about 50 MB smaller. A client that accepts brotli gets the copy, as before. For any other client, the function decompresses the copy, and Vercel's CDN compresses the response.
