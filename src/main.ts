import { Plugin } from 'obsidian';
import { MapView } from './map-view';

export default class ObsidianMapsPlugin extends Plugin {
	async onload() {
		this.registerBasesView('map', {
			name: 'Map',
			icon: 'lucide-map',
			factory: (controller, containerEl) => new MapView(controller, containerEl),
			options: MapView.getViewOptions,
		});
	}

	onunload() {
	}
}
