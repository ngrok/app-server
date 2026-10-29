---
"@ngrok/app-server": patch
---

Rename the CLI commands. `app-server dev` is now `app-server start`. `app-server start` is now `app-server serve`. Update the scripts in `package.json`:

```json
{
	"scripts": {
		"start": "app-server start",
		"serve": "app-server serve"
	}
}
```
