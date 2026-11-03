---
"@ngrok/app-server": minor
---

`appServer()` needs no options. It finds the framework from the React Router or TanStack Start plugin in the Vite config, uses the node host, and uses `server.ts`, else `server.js`, in the Vite root as the app. If the config has neither framework plugin or both, Vite stops with an error that says to pass `framework`. An option that you set replaces its default, so a third-party adapter works as before.

Before:

```ts
plugins: [
	reactRouter(),
	appServer({ framework: reactRouterAdapter(), host: node(), app: "./server.ts" }),
];
```

After:

```ts
plugins: [reactRouter(), appServer()];
```

Breaking change: if the app sets no `app` and has a `server.ts` or `server.js` in the Vite root, the server build now uses that file as the app. Before, the server used the default app. To keep the default app, move or rename the file.
