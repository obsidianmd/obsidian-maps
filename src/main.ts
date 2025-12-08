import { Plugin, Notice } from 'obsidian';
import { MapView } from './map-view';
import { MapSettings, DEFAULT_SETTINGS, MapSettingTab } from './settings';

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

		this.addCommand({
			id: 'copy-current-location',
			name: 'Copy current location to clipboard',
			callback: () => {
				this.getCurrentLocationAndCopy();
			}
		});

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
			new Notice('Geolocation is not supported by your browser');
			return;
		}

		new Notice('Getting your location...');

		navigator.geolocation.getCurrentPosition(
			(position) => {
				const lat = Math.round(position.coords.latitude * 100000) / 100000;
				const lng = Math.round(position.coords.longitude * 100000) / 100000;
				const coordString = `[${lat}, ${lng}]`;
				
				navigator.clipboard.writeText(coordString).then(() => {
					new Notice(`Location copied: ${coordString}`);
				}).catch((error) => {
					console.error('Failed to copy to clipboard:', error);
					new Notice('Failed to copy to clipboard');
				});
			},
			(error) => {
				console.error('Geolocation error:', error);
				let errorMessage = 'Failed to get location';
				
				switch (error.code) {
					case error.PERMISSION_DENIED:
						errorMessage = 'Location permission denied';
						break;
					case error.POSITION_UNAVAILABLE:
						errorMessage = 'Location information unavailable';
						break;
					case error.TIMEOUT:
						errorMessage = 'Location request timed out';
						break;
				}
				
				new Notice(errorMessage);
			},
			{
				enableHighAccuracy: true,
				timeout: 10000,
				maximumAge: 0
			}
		);
	}

	onunload() {
	}
}
