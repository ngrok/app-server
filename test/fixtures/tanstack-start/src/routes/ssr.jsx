import { createFileRoute } from "@tanstack/react-router";

// A page that renders on each request, for `test/bench.ts`: loader data and a list.
export const Route = createFileRoute("/ssr")({
	loader: () => ({
		items: Array.from({ length: 50 }, (_, index) => ({ id: index, name: `Item ${index}` })),
	}),
	component: function Ssr() {
		const { items } = Route.useLoaderData();
		return (
			<main>
				<h1>Rendered on each request</h1>
				<ul>
					{items.map((item) => (
						<li key={item.id}>{item.name}</li>
					))}
				</ul>
			</main>
		);
	},
});
