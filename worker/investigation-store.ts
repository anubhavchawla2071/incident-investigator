import type {
	InvestigationReport,
	InvestigationStore,
	ReportOutcome,
	StoredToolRun,
} from "./investigation";
import type { InvestigationToolRequest, InvestigationToolResult, ToolName } from "./tools";

export interface IncidentDetails {
	incident: {
		id: string;
		title: string;
		status: "open" | "investigating" | "resolved" | "failed";
		currentActivity: string | null;
		createdAt: string;
		updatedAt: string;
	};
	messages: Array<{
		id: string;
		role: "user" | "assistant";
		content: string;
		createdAt: string;
	}>;
	toolRuns: Array<StoredToolRun & { createdAt: string; completedAt: string | null }>;
	report: (InvestigationReport & { createdAt: string; updatedAt: string }) | null;
}

export class D1InvestigationStore implements InvestigationStore {
	constructor(private readonly db: D1Database) {}

	async getUserMessage(incidentId: string): Promise<string | null> {
		const row = await this.db
			.prepare(
				"SELECT content FROM messages WHERE incident_id = ? AND role = 'user' ORDER BY created_at ASC LIMIT 1",
			)
			.bind(incidentId)
			.first<{ content: string }>();
		return row?.content ?? null;
	}

	async setActivity(incidentId: string, activity: string): Promise<void> {
		await this.db
			.prepare("UPDATE incidents SET status = 'investigating', current_activity = ?, updated_at = datetime('now') WHERE id = ?")
			.bind(activity, incidentId)
			.run();
	}

	async markFailed(incidentId: string, message: string): Promise<void> {
		await this.db
			.prepare("UPDATE incidents SET status = 'failed', current_activity = ?, updated_at = datetime('now') WHERE id = ?")
			.bind(`Investigation failed: ${message}`, incidentId)
			.run();
	}

	async getToolRun(toolRunId: string): Promise<StoredToolRun | null> {
		const row = await this.db
			.prepare(
				"SELECT id, incident_id, tool_name, input_json, output_json, status FROM tool_runs WHERE id = ?",
			)
			.bind(toolRunId)
			.first<ToolRunRow>();
		return row ? toStoredToolRun(row) : null;
	}

	async createToolRun(toolRun: Omit<StoredToolRun, "status" | "output">): Promise<StoredToolRun> {
		await this.db
			.prepare(
				"INSERT OR IGNORE INTO tool_runs (id, incident_id, tool_name, input_json) VALUES (?, ?, ?, ?)",
			)
			.bind(toolRun.id, toolRun.incidentId, toolRun.toolName, JSON.stringify(toolRun.input))
			.run();

		const stored = await this.getToolRun(toolRun.id);
		if (!stored) {
			throw new Error(`Could not create tool run ${toolRun.id}.`);
		}
		return stored;
	}

	async completeToolRun(toolRunId: string, output: InvestigationToolResult): Promise<StoredToolRun> {
		await this.db
			.prepare(
				"UPDATE tool_runs SET output_json = ?, status = 'succeeded', completed_at = datetime('now') WHERE id = ?",
			)
			.bind(JSON.stringify(output), toolRunId)
			.run();

		const stored = await this.getToolRun(toolRunId);
		if (!stored) {
			throw new Error(`Could not complete tool run ${toolRunId}.`);
		}
		return stored;
	}

	async listToolRuns(incidentId: string): Promise<StoredToolRun[]> {
		const rows = await this.db
			.prepare(
				"SELECT id, incident_id, tool_name, input_json, output_json, status FROM tool_runs WHERE incident_id = ? ORDER BY created_at ASC, id ASC",
			)
			.bind(incidentId)
			.all<ToolRunRow>();
		return rows.results.map(toStoredToolRun);
	}

	async saveReport(report: InvestigationReport): Promise<void> {
		await this.db
			.prepare(
				`INSERT INTO reports (
					id, incident_id, outcome, summary, root_cause, confidence,
					suggested_next_steps_json, evidence_tool_run_ids_json, updated_at
				) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
				ON CONFLICT(incident_id) DO UPDATE SET
					outcome = excluded.outcome,
					summary = excluded.summary,
					root_cause = excluded.root_cause,
					confidence = excluded.confidence,
					suggested_next_steps_json = excluded.suggested_next_steps_json,
					evidence_tool_run_ids_json = excluded.evidence_tool_run_ids_json,
					updated_at = datetime('now')`,
			)
			.bind(
				report.id,
				report.incidentId,
				report.outcome,
				report.diagnosis,
				report.rootCause,
				report.confidence,
				JSON.stringify(report.suggestedNextSteps),
				JSON.stringify(report.evidenceToolRunIds),
			)
			.run();
	}

	async markComplete(incidentId: string, outcome: ReportOutcome): Promise<void> {
		const activity =
			outcome === "resolved" ? "Investigation complete" : "Investigation complete: inconclusive";
		await this.db
			.prepare("UPDATE incidents SET status = 'resolved', current_activity = ?, updated_at = datetime('now') WHERE id = ?")
			.bind(activity, incidentId)
			.run();
	}

	async getIncidentDetails(incidentId: string): Promise<IncidentDetails | null> {
		const incident = await this.db
			.prepare("SELECT id, title, status, current_activity, created_at, updated_at FROM incidents WHERE id = ?")
			.bind(incidentId)
			.first<IncidentRow>();
		if (!incident) {
			return null;
		}

		const [messages, toolRuns, report] = await Promise.all([
			this.db
				.prepare("SELECT id, role, content, created_at FROM messages WHERE incident_id = ? ORDER BY created_at ASC, id ASC")
				.bind(incidentId)
				.all<MessageRow>(),
			this.db
				.prepare(
					"SELECT id, incident_id, tool_name, input_json, output_json, status, created_at, completed_at FROM tool_runs WHERE incident_id = ? ORDER BY created_at ASC, id ASC",
				)
				.bind(incidentId)
				.all<ToolRunDetailsRow>(),
			this.db
				.prepare(
					"SELECT id, incident_id, outcome, summary, root_cause, confidence, suggested_next_steps_json, evidence_tool_run_ids_json, created_at, updated_at FROM reports WHERE incident_id = ?",
				)
				.bind(incidentId)
				.first<ReportRow>(),
		]);

		return {
			incident: {
				id: incident.id,
				title: incident.title,
				status: incident.status,
				currentActivity: incident.current_activity,
				createdAt: incident.created_at,
				updatedAt: incident.updated_at,
			},
			messages: messages.results.map((message) => ({
				id: message.id,
				role: message.role,
				content: message.content,
				createdAt: message.created_at,
			})),
			toolRuns: toolRuns.results.map((toolRun) => ({
				...toStoredToolRun(toolRun),
				createdAt: toolRun.created_at,
				completedAt: toolRun.completed_at,
			})),
			report: report ? toReport(report) : null,
		};
	}
}

interface ToolRunRow {
	id: string;
	incident_id: string;
	tool_name: ToolName;
	input_json: string;
	output_json: string | null;
	status: StoredToolRun["status"];
}

interface ToolRunDetailsRow extends ToolRunRow {
	created_at: string;
	completed_at: string | null;
}

interface IncidentRow {
	id: string;
	title: string;
	status: IncidentDetails["incident"]["status"];
	current_activity: string | null;
	created_at: string;
	updated_at: string;
}

interface MessageRow {
	id: string;
	role: "user" | "assistant";
	content: string;
	created_at: string;
}

interface ReportRow {
	id: string;
	incident_id: string;
	outcome: ReportOutcome;
	summary: string;
	root_cause: string;
	confidence: number;
	suggested_next_steps_json: string;
	evidence_tool_run_ids_json: string;
	created_at: string;
	updated_at: string;
}

function toStoredToolRun(row: ToolRunRow): StoredToolRun {
	return {
		id: row.id,
		incidentId: row.incident_id,
		toolName: row.tool_name,
		input: JSON.parse(row.input_json) as InvestigationToolRequest["input"],
		output: row.output_json ? (JSON.parse(row.output_json) as InvestigationToolResult) : null,
		status: row.status,
	};
}

function toReport(row: ReportRow): InvestigationReport & { createdAt: string; updatedAt: string } {
	return {
		id: row.id,
		incidentId: row.incident_id,
		outcome: row.outcome,
		diagnosis: row.summary,
		rootCause: row.root_cause,
		confidence: row.confidence,
		suggestedNextSteps: JSON.parse(row.suggested_next_steps_json) as string[],
		evidenceToolRunIds: JSON.parse(row.evidence_tool_run_ids_json) as string[],
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}
