import { setIcon, Notice } from 'obsidian';
import { Map, Marker } from 'maplibre-gl';

export class CustomGeolocateControl {
	private containerEl: HTMLElement;
	private locateButton: HTMLElement | null = null;
	private map: Map | null = null;
	private userMarker: Marker | null = null;
	private watchId: number | null = null;
	private isTracking = false;

	constructor() {
		this.containerEl = createDiv('maplibregl-ctrl maplibregl-ctrl-group canvas-control-group mod-raised');
	}

	onAdd(map: Map): HTMLElement {
		this.map = map;
		
		// Create the locate button
		this.locateButton = this.containerEl.createEl('div', {
			cls: 'maplibregl-ctrl-geolocate canvas-control-item',
			attr: { 'aria-label': 'Locate user' }
		});
		setIcon(this.locateButton, 'locate-fixed');

		// Trigger geolocation when button is clicked
		this.locateButton.addEventListener('click', () => {
			if (this.isTracking) {
				this.stopTracking();
			} else {
				this.startTracking();
			}
		});

		return this.containerEl;
	}

	private startTracking(): void {
		if (!navigator.geolocation) {
			new Notice('Geolocation is not supported by your browser');
			return;
		}

		if (!this.map || !this.locateButton) return;

		this.isTracking = true;
		this.locateButton.addClass('is-active');

		// Get initial position and fly to it
		navigator.geolocation.getCurrentPosition(
			(position) => {
				this.updatePosition(position.coords.latitude, position.coords.longitude);
			},
			(error) => {
				this.handleError(error);
			},
			{
				enableHighAccuracy: true,
				timeout: 10000,
				maximumAge: 0
			}
		);

		// Watch for position changes
		this.watchId = navigator.geolocation.watchPosition(
			(position) => {
				this.updatePosition(position.coords.latitude, position.coords.longitude);
			},
			(error) => {
				this.handleError(error);
			},
			{
				enableHighAccuracy: true,
				maximumAge: 0
			}
		);
	}

	private stopTracking(): void {
		if (this.watchId !== null) {
			navigator.geolocation.clearWatch(this.watchId);
			this.watchId = null;
		}

		this.isTracking = false;
		
		if (this.locateButton) {
			this.locateButton.removeClass('is-active');
		}

		if (this.userMarker) {
			this.userMarker.remove();
			this.userMarker = null;
		}
	}

	private updatePosition(lat: number, lng: number): void {
		if (!this.map) return;

		// Create or update user marker
		if (!this.userMarker) {
			const el = createDiv('user-location-marker');
			el.innerHTML = `
				<svg width="20" height="20" viewBox="0 0 20 20" xmlns="http://www.w3.org/2000/svg">
					<circle cx="10" cy="10" r="6" fill="var(--interactive-accent)" stroke="white" stroke-width="2"/>
				</svg>
			`;
			this.userMarker = new Marker({ element: el })
				.setLngLat([lng, lat])
				.addTo(this.map);
		} else {
			this.userMarker.setLngLat([lng, lat]);
		}

		// Fly to user location
		this.map.flyTo({
			center: [lng, lat],
			zoom: Math.max(this.map.getZoom(), 15),
			duration: 1000
		});
	}

	private handleError(error: GeolocationPositionError): void {
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
		console.warn('Geolocation error:', error);
		this.stopTracking();
	}

	onRemove(): void {
		this.stopTracking();
		
		if (this.containerEl && this.containerEl.parentNode) {
			this.containerEl.detach();
		}
		
		this.map = null;
		this.locateButton = null;
	}
}
