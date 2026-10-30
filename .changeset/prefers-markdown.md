---
"@ngrok/app-server": patch
---

Add `prefersMarkdown(request)`. It tells if a request asks for markdown before HTML, per acceptmarkdown.com. Only an explicit `text/markdown` range selects markdown, and its `q` must be equal to or more than the `q` of HTML. A wildcard never selects markdown. Use it in a plugin, `entry.server`, or a route, so each place answers one request the same way.

Add the `markdownTwins` option of `prerendered()`. A request that prefers markdown gets the page's prerendered twin, such as `/docs/button.md` for `/docs/button`. Each answer for a page with a twin gets `Vary: Accept`, and a page with no twin gets none. `twinOf` changes the mapping.
