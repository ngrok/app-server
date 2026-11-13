---
"@ngrok/app-server": patch
---

`redirects()` costs less for a request that matches no rule, and its cost no longer grows with each pattern rule. Before, each GET parsed its URL and tested each rule with `:name` or `*` in turn. Now a request tests only the patterns that start with its first path segment, and the patterns whose first segment is `:name` or `*`. It parses its URL only when a rule can match. The rule order and each match rule are the same.

On Node.js v26.13, the stage for a page that matches no rule went from 305 ns to 148 ns with 200 exact rules, from 1,053 ns to 221 ns with 50 more pattern rules, and from 3,915 ns to 218 ns with 200 more. With 200 rules, a rendered page through the default plugins with no compression costs about 22% less CPU time in the pipeline. A request with a percent-escape in its path still parses its URL. With a table of exact rules only, that request costs about 30 ns more than before. The numbers come from 15 to 21 rounds that take turns between the build before and this one.

One answer changes: a GET or HEAD request whose URL does not parse, such as one with a `Host: 1.2.3.4.5` header, got a 500 from this stage. When its path matches no rule, it now goes on to the next stage.
