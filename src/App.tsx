const platformPieces = ["React + TypeScript", "Cloudflare Worker", "D1", "Workers AI"];

export default function App() {
	return (
		<main>
			<p className="eyebrow">Incident Investigator</p>
			<h1>Foundation ready.</h1>
			<p className="intro">
				This project is wired for an AI-powered incident investigation workflow. The
				investigation experience comes next.
			</p>
			<ul aria-label="Configured platform services">
				{platformPieces.map((piece) => (
					<li key={piece}>{piece}</li>
				))}
			</ul>
		</main>
	);
}
