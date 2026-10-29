import { createFileRoute } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";

// Why the URL in the page: the runtime check calls the server function over HTTP.
const greet = createServerFn({ method: "GET" }).handler(async () => "hello from a server function");

export const Route = createFileRoute("/")({
	loader: async () => ({ greeting: await greet(), url: greet.url }),
	component: function Home() {
		const { greeting, url } = Route.useLoaderData();
		return (
			<main>
				<h1>TanStack Start home</h1>
				<p>{greeting}</p>
				<a id="server-fn" href={url}>
					server function
				</a>
			</main>
		);
	},
});
