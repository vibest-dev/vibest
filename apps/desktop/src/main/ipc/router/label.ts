import { implement } from "@orpc/server";
import { labelContract } from "../../../shared/contract/label";
import { generateLabelId, type Label } from "../../../shared/types";
import type { AppContext } from "../../app";

const os = implement(labelContract).$context<AppContext>();

// List labels for repository
export const list = os.list.handler(async ({ input, context: { app } }) => {
	const { repositoryId } = input;
	return app.store.getLabels(repositoryId);
});

// Create label
export const create = os.create.handler(async ({ input, context: { app } }) => {
	const { repositoryId, name, color, description } = input;

	// Check for duplicate name
	const existing = app.store.getLabels(repositoryId);
	if (existing.some((l) => l.name.toLowerCase() === name.toLowerCase())) {
		throw new Error(`Label with name "${name}" already exists`);
	}

	const label: Label = {
		id: generateLabelId(),
		name,
		color,
		description,
	};

	app.store.addLabel(repositoryId, label);
	return label;
});

// Update label
export const update = os.update.handler(async ({ input, context: { app } }) => {
	const { repositoryId, labelId, ...updates } = input;

	// Check if renaming to an existing name
	if (updates.name) {
		const existing = app.store.getLabels(repositoryId);
		const duplicate = existing.find(
			(l) =>
				l.id !== labelId &&
				l.name.toLowerCase() === updates.name!.toLowerCase(),
		);
		if (duplicate) {
			throw new Error(`Label with name "${updates.name}" already exists`);
		}
	}

	app.store.updateLabel(repositoryId, labelId, updates);

	const label = app.store.getLabels(repositoryId).find((l) => l.id === labelId);
	if (!label) {
		throw new Error(`Label not found: ${labelId}`);
	}
	return label;
});

// Delete label
export const deleteLabel = os.delete.handler(
	async ({ input, context: { app } }) => {
		const { repositoryId, labelId, force } = input;
		const deletedFromTasks = app.store.removeLabel(repositoryId, labelId, {
			force,
		});
		return { deletedFromTasks };
	},
);

export const labelRouter = os.router({
	list,
	create,
	update,
	delete: deleteLabel,
});
