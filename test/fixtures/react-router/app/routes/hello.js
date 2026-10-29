// A prerendered resource route. The server replays these headers from the build.
export function loader() {
	return new Response("hello", {
		headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "max-age=60" },
	});
}
