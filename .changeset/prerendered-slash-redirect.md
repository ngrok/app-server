---
"@ngrok/app-server": minor
---

`prerendered()` now sends a 301 from a page URL with a trailing slash to the URL with no slash. Before, `/x/` and `/x` both got a 200 with the same page. Now each page has one URL, and a cache keeps one copy. The redirect keeps the query string and the URL encoding of the path.

Behavior change: a GET or HEAD for `/x/` now gets a 301 when `/x` is a prerendered page. Other paths do not change. `/x//`, a path with no page, and a POST still go to the framework.
