import { useLoaderData } from "react-router";

// A larger page that renders on each request, for `test/bench.ts`: 35 KB to 40 KB of HTML that the
// renderer queues at once, as a page of an app does.
export function loader() {
	return {
		rows: Array.from({ length: 200 }, (_, index) => ({
			id: index,
			name: `Item ${index}`,
			status: ["active", "pending", "disabled"][index % 3],
		})),
	};
}

export default function Table() {
	const { rows } = useLoaderData();
	return (
		<main>
			<h1>Rendered on each request</h1>
			<table>
				<tbody>
					{rows.map((row) => (
						<tr key={row.id} className="row">
							<td>{row.name}</td>
							<td>
								<a href={`/items/${row.id}`}>Details</a>
							</td>
							<td className={`status-${row.status}`}>{row.status}</td>
						</tr>
					))}
				</tbody>
			</table>
		</main>
	);
}
