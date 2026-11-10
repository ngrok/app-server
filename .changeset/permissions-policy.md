---
"@ngrok/app-server": patch
---

`securityHeaders()` takes `Permissions-Policy`, with no default. A response that has its own `Permissions-Policy` keeps it:

```ts
defaultPlugins({
	securityHeaders: { headers: { "Permissions-Policy": "camera=(), microphone=(), geolocation=()" } },
});
```
