import { Await, createFileRoute } from "@tanstack/react-router";
import { Suspense } from "react";

// A page whose slow part streams after the shell.
export const Route = createFileRoute("/stream")({
	loader: () => ({
		slow: new Promise((resolve) => {
			setTimeout(() => resolve("streamed late"), 1_000);
		}),
	}),
	component: function Stream() {
		const { slow } = Route.useLoaderData();
		return (
			<main>
				<h1>shell</h1>
				<Suspense fallback={<p>waiting</p>}>
					<Await promise={slow}>{(value) => <p>{value}</p>}</Await>
				</Suspense>
			</main>
		);
	},
});
