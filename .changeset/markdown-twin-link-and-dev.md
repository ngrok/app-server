---
"@ngrok/app-server": patch
---

`markdownTwins` changes:

- The HTML answer for a page with a twin now gets `Link: </docs/button.md>; rel="alternate"; type="text/markdown"`, so an agent that does not ask for markdown can find the twin.
- `markdownTwins` now works in development. A request that prefers markdown gets the framework's answer for the twin's URL, so an edit to the twin's route shows at the next request. If that answer is an error or is not markdown, the request gets the HTML.
- `prefersMarkdown` returns at once when the `Accept` header does not name markdown. This cuts the time of a browser request for a page with a twin by about 20%.
