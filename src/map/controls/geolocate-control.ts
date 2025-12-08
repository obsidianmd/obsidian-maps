import { setIcon } from 'obsidian';
import { Map, GeolocateControl as MapLibreGeolocateControl } from 'maplibre-gl';

export class CustomGeolocateControl {
	private containerEl: HTMLElement;
	private geolocateControl: MapLibreGeolocateControl;
	private map: Map | null = null;

	constructor() {
		this.containerEl = createDiv('maplibregl-ctrl maplibregl-ctrl-group canvas-control-group mod-raised');

		this.geolocateControl = new MapLibreGeolocateControl({
			positionOptions: {
				enableHighAccuracy: true
			},
			trackUserLocation: true
		});
	}

	onAdd(map: Map): HTMLElement {
		this.map = map;

		const locateButton = this.containerEl.createEl('div', {
			cls: 'maplibregl-ctrl-geolocate canvas-control-item',
			attr: { 'aria-label': 'Locate user' }
		});
		setIcon(locateButton, 'locate-fixed');

		map.addControl(this.geolocateControl, 'top-right');
		
		// Hide the default geolocate control UI
		const defaultControl = map.getContainer().querySelector('.maplibregl-ctrl-geolocate');
		if (defaultControl && defaultControl.parentElement) {
			defaultControl.parentElement.style.display = 'none';
		}

		locateButton.addEventListener('click', () => {
			this.geolocateControl.trigger();
		});

		// Update button appearance based on geolocation state
		this.geolocateControl.on('geolocate', () => {
			locateButton.addClass('is-active');
		});

		this.geolocateControl.on('trackuserlocationend', () => {
			locateButton.removeClass('is-active');
		});

		this.geolocateControl.on('error', (error) => {
			console.warn('Geolocation error:', error);
			locateButton.removeClass('is-active');
		});

		return this.containerEl;
	}

	onRemove(): void {
		if (this.map) {
			this.map.removeControl(this.geolocateControl);
		}
		if (this.containerEl && this.containerEl.parentNode) {
			this.containerEl.detach();
		}
	}
}
