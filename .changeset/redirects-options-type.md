---
"@ngrok/app-server": patch
---

The package now exports the `RedirectsOptions` type, the options of `redirects()`, as it exports the options type of each other plugin. The type documents `trailingSlash` and its default, `"preserve"`. The README now says how a `redirects()` in your own plugin list takes the mode.
