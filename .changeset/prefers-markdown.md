---
"@ngrok/app-server": patch
---

Add `prefersMarkdown(request)`. It tells if a request asks for markdown before HTML, per acceptmarkdown.com. Use it in a `rewrite`, a plugin, `entry.server`, or a route, so each place answers one request the same way.

Only an explicit `text/markdown` range selects markdown, and its `q` must be equal to or more than the `q` of HTML. A wildcard never selects markdown. The README shows how to serve a markdown twin for a prerendered page and for a rendered page, with `Vary: Accept`.
