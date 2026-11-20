// A route chunk that throws while the browser loads it. React Router imports the route chunks
// before the client entry, so the entry does not run on this page.
if (typeof document !== "undefined") {
	throw new Error("chunk failed");
}

export default function Chunk() {
	return <h1>Chunk</h1>;
}
