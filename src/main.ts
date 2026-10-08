import { Plugin, Notice, Platform } from 'obsidian';
import { MapView } from './map-view';
import { MapSettings, DEFAULT_SETTINGS, MapSettingTab } from './settings';
import { GEOLOCATION_OPTIONS, geolocationErrorMessage } from './map/utils';
import { ClusterNotesView, CLUSTER_NOTES_VIEW_TYPE, ClusterNote, ClusterSelection } from './map/cluster-notes-view';

export default class ObsidianMapsPlugin extends Plugin {
	settings: MapSettings;
	private clusterSelection: ClusterSelection | null = null;

	async onload() {
		await this.loadSettings();

		this.registerView(CLUSTER_NOTES_VIEW_TYPE, (leaf) => new ClusterNotesView(leaf, this));

		this.registerBasesView('map', {
			name: 'Map',
			icon: 'lucide-map',
			factory: (controller, containerEl) => new MapView(controller, containerEl, this),
			options: () => MapView.getViewOptions(),
		});

		// Only registered on mobile, since desktop has no location provider
		if (Platform.isMobileApp) {
			this.addCommand({
				id: 'copy-current-location',
				name: 'Copy current location to clipboard',
				callback: () => {
					this.getCurrentLocationAndCopy();
				}
			});
		}

		this.addSettingTab(new MapSettingTab(this.app, this));
	}

	getClusterSelection(): ClusterSelection | null {
		return this.clusterSelection;
	}

	async showClusterNotes(notes: ClusterNote[], coordinates: [number, number]): Promise<void> {
		this.clusterSelection = { notes, coordinates };

		let leaf = this.app.workspace.getLeavesOfType(CLUSTER_NOTES_VIEW_TYPE)[0];
		if (!leaf) {
			const rightLeaf = this.app.workspace.getRightLeaf(false);
			if (!rightLeaf) return;
			leaf = rightLeaf;
			await leaf.setViewState({ type: CLUSTER_NOTES_VIEW_TYPE, active: true });
		}

		await this.app.workspace.revealLeaf(leaf);
		if (leaf.view instanceof ClusterNotesView) {
			leaf.view.renderSelection(this.clusterSelection);
		}
	}

	async loadSettings() {
		const data = await this.loadData() as Partial<MapSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	async saveSettings() {
		await this.saveData(this.settings);
	}

	private getCurrentLocationAndCopy(): void {
		if (!navigator.geolocation) {
			new Notice('Location services are not available');
			return;
		}

		// A duration of 0 keeps the notice up until the request resolves, which
		// can take longer than the default notice timeout
		const progressNotice = new Notice('Getting your location…', 0);

		navigator.geolocation.getCurrentPosition(
			(position) => {
				progressNotice.hide();

				// Five decimal places is roughly one metre of precision
				const lat = Number(position.coords.latitude.toFixed(5));
				const lng = Number(position.coords.longitude.toFixed(5));

				void this.copyToClipboard(`[${lat}, ${lng}]`);
			},
			(error) => {
				progressNotice.hide();
				console.warn('Geolocation error:', error);
				new Notice(geolocationErrorMessage(error));
			},
			GEOLOCATION_OPTIONS
		);
	}

	private async copyToClipboard(coordString: string): Promise<void> {
		try {
			await navigator.clipboard.writeText(coordString);
			new Notice(`Location copied: ${coordString}`);
		} catch (error) {
			console.error('Failed to copy to clipboard:', error);
			new Notice('Failed to copy to clipboard');
		}
	}
}
