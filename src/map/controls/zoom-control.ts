import { setIcon } from 'obsidian';
import { Map } from 'maplibre-gl';

export class CustomZoomControl {
	private containerEl: HTMLElement;

	constructor() {
		this.containerEl = createDiv('maplibregl-ctrl maplibregl-ctrl-group canvas-control-group mod-raised');
	}

	onAdd(map: Map): HTMLElement {
		const zoomInButton = this.containerEl.createEl('div', {
			cls: 'maplibregl-ctrl-zoom-in canvas-control-item',
			attr: { 'aria-label': 'Zoom in' }
		});
		setIcon(zoomInButton, 'plus');

		zoomInButton.addEventListener('click', () => {
			map.zoomIn();
		});

		const zoomOutButton = this.containerEl.createEl('div', {
			cls: 'maplibregl-ctrl-zoom-out canvas-control-item',
			attr: { 'aria-label': 'Zoom out' }
		});
		setIcon(zoomOutButton, 'minus');

		zoomOutButton.addEventListener('click', () => {
			map.zoomOut();
		});

		return this.containerEl;
	}

	onRemove(): void {
		if (this.containerEl && this.containerEl.parentNode) {
			this.containerEl.detach();
		}
	}
}

