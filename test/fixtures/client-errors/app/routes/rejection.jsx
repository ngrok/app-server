import { useEffect } from "react";

export default function Rejection() {
	useEffect(() => {
		// A rejection with no handler.
		void Promise.reject(new Error("rejection failed"));
	}, []);
	return <h1>Rejection</h1>;
}
