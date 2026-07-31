import { Plugin, Notice, Platform } from 'obsidian';
import { MapView } from './map-view';
import { MapSettings, DEFAULT_SETTINGS, MapSettingTab } from './settings';
import { GEOLOCATION_OPTIONS, geolocationErrorMessage } from './map/utils';

export default class ObsidianMapsPlugin extends Plugin {
	settings: MapSettings;

	async onload() {
		await this.loadSettings();

		this.registerBasesView('map', {
			name: 'Map',
			icon: 'lucide-map',
			factory: (controller, containerEl) => new MapView(controller, containerEl, this),
			options: MapView.getViewOptions,
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

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
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
			async (position) => {
				progressNotice.hide();

				// Five decimal places is roughly one metre of precision
				const lat = Number(position.coords.latitude.toFixed(5));
				const lng = Number(position.coords.longitude.toFixed(5));
				const coordString = `[${lat}, ${lng}]`;

				try {
					await navigator.clipboard.writeText(coordString);
					new Notice(`Location copied: ${coordString}`);
				} catch (error) {
					console.error('Failed to copy to clipboard:', error);
					new Notice('Failed to copy to clipboard');
				}
			},
			(error) => {
				progressNotice.hide();
				console.warn('Geolocation error:', error);
				new Notice(geolocationErrorMessage(error));
			},
			GEOLOCATION_OPTIONS
		);
	}
}
