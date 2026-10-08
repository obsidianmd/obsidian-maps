import { ItemView, Keymap, WorkspaceLeaf } from 'obsidian';
import type ObsidianMapsPlugin from '../main';

export const CLUSTER_NOTES_VIEW_TYPE = 'map-cluster-notes';

export interface ClusterNote {
	path: string;
	name: string;
}

export interface ClusterSelection {
	notes: ClusterNote[];
	coordinates: [number, number];
}

export class ClusterNotesView extends ItemView {
	private plugin: ObsidianMapsPlugin;

	constructor(leaf: WorkspaceLeaf, plugin: ObsidianMapsPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return CLUSTER_NOTES_VIEW_TYPE;
	}

	getDisplayText(): string {
		return 'Map locations';
	}

	getIcon(): string {
		return 'map-pin';
	}

	async onOpen(): Promise<void> {
		this.renderSelection(this.plugin.getClusterSelection());
	}

	renderSelection(selection: ClusterSelection | null): void {
		this.contentEl.empty();
		this.contentEl.addClass('bases-map-cluster-notes-view');

		if (!selection) {
			this.contentEl.createDiv({
				cls: 'bases-map-cluster-notes-empty',
				text: 'Click a map marker to see its note here.',
			});
			return;
		}

		const [lat, lng] = selection.coordinates;
		this.contentEl.createEl('h6', { text: `${selection.notes.length} notes at this location` });
		this.contentEl.createDiv({
			cls: 'bases-map-cluster-notes-coordinates',
			text: `${lat.toFixed(5)}, ${lng.toFixed(5)}`,
		});

		const list = this.contentEl.createDiv({ cls: 'bases-map-cluster-notes-list' });
		for (const note of selection.notes) {
			const link = list.createEl('a', {
				cls: 'bases-map-cluster-note',
				href: note.path,
				text: note.name,
			});
			link.addEventListener('click', (event) => {
				event.preventDefault();
				event.stopPropagation();
				const newLeaf = Keymap.isModEvent(event);
				void this.app.workspace.openLinkText(note.path, '', newLeaf);
			});
		}
	}
}
