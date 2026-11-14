---
"@ngrok/app-server": patch
---

Fix the auth example of the README section "Protect pages". The plugin compared the path with `startsWith("/app")`, and React Router and TanStack Router match a path in any letter case. So `/APP/settings` passed the check, and the framework rendered the page for a visitor with no session.

If your app has a copy of the example, compare the lowercase path. Also keep a session check in each loader that reads private data, because the plugin protects only the paths that it names.

```ts
// Before
if (!c.req.path.startsWith("/app")) {
// After
if (!c.req.path.toLowerCase().startsWith("/app")) {
```
