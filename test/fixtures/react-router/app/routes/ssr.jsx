import { useLoaderData } from "react-router";

// A page that renders on each request, for `test/bench.ts`: loader data and a list.
export function loader() {
	return {
		items: Array.from({ length: 50 }, (_, index) => ({ id: index, name: `Item ${index}` })),
	};
}

export default function Ssr() {
	const { items } = useLoaderData();
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
}
