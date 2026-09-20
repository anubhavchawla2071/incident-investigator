import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type ToolName = "searchLogs" | "getMetrics" | "getServiceHealth" | "getRecentDeployments" | "getTrace";

interface IncidentDetails {
	incident: {
		id: string;
		title: string;
		status: "open" | "investigating" | "resolved" | "failed";
		currentActivity: string | null;
	};
	messages: Array<{ id: string; role: "user" | "assistant"; content: string }>;
	toolRuns: Array<{
		id: string;
		toolName: ToolName;
		input: unknown;
		output: unknown;
		status: "running" | "succeeded" | "failed";
	}>;
	report: {
		outcome: "resolved" | "inconclusive";
		diagnosis: string;
		rootCause: string;
		confidence: number;
		suggestedNextSteps: string[];
		evidenceToolRunIds: string[];
	} | null;
}

interface HealthDetails {
	bindings: {
		workersAi: boolean;
	};
}

const examplePrompts = [
	"The API is returning 500 errors. Can you investigate?",
	"Orders are slow for customers in Europe.",
	"Payments are timing out during confirmation.",
];

export default function App() {
	const [message, setMessage] = useState("");
	const [details, setDetails] = useState<IncidentDetails | null>(null);
	const [health, setHealth] = useState<HealthDetails | null>(null);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const loadIncident = useCallback(async (incidentId: string) => {
		const response = await fetch(`/api/incidents/${incidentId}`);
		if (!response.ok) throw new Error("Could not load the incident.");
		setDetails((await response.json()) as IncidentDetails);
	}, []);

	useEffect(() => {
		void fetch("/api/health")
			.then((response) => response.ok ? response.json() : null)
			.then((payload) => setHealth(payload as HealthDetails | null))
			.catch(() => setHealth(null));
	}, []);

	useEffect(() => {
		if (!details || details.incident.status !== "investigating") return;
		const timer = window.setInterval(() => {
			void loadIncident(details.incident.id).catch((reason: unknown) => {
				setError(reason instanceof Error ? reason.message : "Could not refresh the incident.");
			});
		}, 700);
		return () => window.clearInterval(timer);
	}, [details, loadIncident]);

	const toolNames = useMemo(
		() => new Map(details?.toolRuns.map((run) => [run.id, run.toolName]) ?? []),
		[details],
	);

	async function submitIncident(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		if (!message.trim()) return;
		setError(null);
		setIsSubmitting(true);
		try {
			const response = await fetch("/api/incidents", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ message }),
			});
			if (!response.ok) throw new Error("Could not start the investigation.");
			const created = (await response.json()) as { incidentId: string };
			setMessage("");
			await loadIncident(created.incidentId);
		} catch (reason) {
			setError(reason instanceof Error ? reason.message : "Could not start the investigation.");
		} finally {
			setIsSubmitting(false);
		}
	}

	return (
		<main className="console-shell">
			<header className="topbar">
				<div>
					<p className="product-mark">Incident Investigator</p>
					<p className="product-subtitle">Simulated production observability console</p>
				</div>
				<span className="environment-pill"><i /> {modelModeLabel(health)}</span>
			</header>
			<div className="console-layout">
				<aside className="composer-panel">
					<div className="section-heading"><p>New incident</p><span>Describe the symptom</span></div>
					<form onSubmit={submitIncident} className="incident-form">
						<label htmlFor="incident-message">What are users seeing?</label>
						<textarea id="incident-message" value={message} onChange={(event) => setMessage(event.target.value)} rows={6} disabled={isSubmitting} placeholder="e.g. The API is returning 500 errors. Can you investigate?" />
						<button type="submit" disabled={isSubmitting || !message.trim()}>{isSubmitting ? "Starting…" : "Start investigation"}</button>
					</form>
					<div className="examples"><p>Try an example</p>{examplePrompts.map((prompt) => <button key={prompt} type="button" onClick={() => setMessage(prompt)}>{prompt}</button>)}</div>
				</aside>
				<section className="investigation-panel" aria-live="polite">
					{error && <p className="error-banner">{error}</p>}
					{details ? <IncidentView details={details} toolNames={toolNames} /> : <EmptyState />}
				</section>
			</div>
		</main>
	);
}

function EmptyState() {
	return <div className="empty-state"><span>⌁</span><h1>Start an investigation</h1><p>The agent will check service health, follow the evidence with tools, and save a report here.</p></div>;
}

function modelModeLabel(health: HealthDetails | null) {
	if (!health) return "Checking model mode";
	return health.bindings.workersAi ? "Workers AI mode" : "Local deterministic mode";
}

function IncidentView({ details, toolNames }: { details: IncidentDetails; toolNames: Map<string, ToolName> }) {
	const { incident, messages, toolRuns, report } = details;
	return <>
		<section className="incident-summary">
			<div><p className="section-kicker">Active incident</p><h1>{incident.title}</h1><div className="status-line"><StatusPill status={incident.status} /><span>{incident.currentActivity ?? "Waiting for activity"}</span></div></div>
			<p className="incident-id">{shortId(incident.id)}</p>
		</section>
		<section className="chat-card"><p className="section-kicker">Reported symptom</p>{messages.map((message) => <div className={`message-bubble ${message.role}`} key={message.id}><span>{message.role === "user" ? "You" : "Investigator"}</span><p>{message.content}</p></div>)}</section>
		<section className="timeline-card">
			<div className="card-title-row"><div><p className="section-kicker">Investigation timeline</p><h2>Tool activity</h2></div><span className="call-count">{toolRuns.length} / 6 calls</span></div>
			<div className="tool-timeline">{toolRuns.length ? toolRuns.map((run, index) => <ToolRunCard key={run.id} run={run} index={index} />) : <p className="muted">Waiting for the first service-health check.</p>}</div>
		</section>
		{report && <ReportCard report={report} toolNames={toolNames} />}
	</>;
}

function ToolRunCard({ run, index }: { run: IncidentDetails["toolRuns"][number]; index: number }) {
	return <article className="tool-run"><div className="timeline-marker">{index + 1}</div><div className="tool-run-content"><div className="tool-run-header"><strong>{run.toolName}</strong><StatusPill status={run.status} /></div><p>{toolDescription(run.toolName)}</p><details><summary>View tool input and result</summary><div className="tool-data"><CodeBlock label="Input" value={run.input} /><CodeBlock label="Result" value={run.output} /></div></details></div></article>;
}

function ReportCard({ report, toolNames }: { report: NonNullable<IncidentDetails["report"]>; toolNames: Map<string, ToolName> }) {
	return <section className="report-card"><div className="card-title-row"><div><p className="section-kicker">Final report</p><h2>{report.outcome === "resolved" ? "Diagnosis" : "Inconclusive"}</h2></div><StatusPill status={report.outcome} /></div><p className="diagnosis">{report.diagnosis}</p><div className="report-grid"><div><p className="report-label">Likely root cause</p><p>{report.rootCause}</p></div><div><p className="report-label">Confidence</p><p>{Math.round(report.confidence * 100)}%</p></div></div><div className="next-steps"><p className="report-label">Suggested next steps</p><ul>{report.suggestedNextSteps.map((step) => <li key={step}>{step}</li>)}</ul></div><div className="evidence-row"><p className="report-label">Cited evidence</p><div>{report.evidenceToolRunIds.map((id) => <span key={id}>{toolNames.get(id) ?? shortId(id)}</span>)}</div></div></section>;
}

function CodeBlock({ label, value }: { label: string; value: unknown }) {
	return <div><p>{label}</p><pre>{JSON.stringify(value, null, 2)}</pre></div>;
}

function StatusPill({ status }: { status: string }) {
	return <span className={`status-pill ${status}`}>{status.replace("_", " ")}</span>;
}

function toolDescription(tool: ToolName) {
	return { getServiceHealth: "Scanned the environment for degraded services and regions.", getMetrics: "Read the requested metric series around the symptom.", searchLogs: "Filtered production logs for corroborating signals.", getTrace: "Inspected a distributed trace from the failing request path.", getRecentDeployments: "Compared the evidence with recent changes." }[tool];
}

function shortId(id: string) {
	return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}
