import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

import { FixtureInvestigationModel } from "./fixture-investigation-model";
import { runInvestigation } from "./investigation";
import { D1InvestigationStore } from "./investigation-store";
import type { Env } from "./index";

interface InvestigationWorkflowParams {
	incidentId: string;
}

export class IncidentInvestigationWorkflow extends WorkflowEntrypoint<Env, InvestigationWorkflowParams> {
	async run(event: WorkflowEvent<InvestigationWorkflowParams>, step: WorkflowStep) {
		if (!event.payload?.incidentId) {
			throw new Error("Workflow requires an incident ID.");
		}

		return runInvestigation({
			incidentId: event.payload.incidentId,
			model: new FixtureInvestigationModel(),
			store: new D1InvestigationStore(this.env.DB),
			steps: {
				do: (name, operation) => step.do(name, operation as never) as never,
			},
		});
	}
}
