import { renderToReadableStream } from "react-dom/server";
import { ServerRouter } from "react-router";

// Why an own entry: React Router installs `isbot` for its default entry.
export default async function handleRequest(request, status, headers, routerContext) {
	const body = await renderToReadableStream(
		<ServerRouter context={routerContext} url={request.url} />,
	);
	if (routerContext.isSpaMode || request.headers.get("X-Prerender") != null) {
		await body.allReady;
	}
	headers.set("Content-Type", "text/html; charset=utf-8");
	return new Response(body, { status, headers });
}
