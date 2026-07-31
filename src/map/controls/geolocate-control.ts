import { setIcon, Notice } from 'obsidian';
import { FlyToOptions, IControl, Map, MapLibreEvent, Marker } from 'maplibre-gl';
import { GEOLOCATION_OPTIONS, geolocationErrorMessage } from '../utils';

const TRACKING_ZOOM = 15;

type MoveStartEvent = MapLibreEvent<MouseEvent | TouchEvent | WheelEvent | undefined>;

export class CustomGeolocateControl implements IControl {
	private containerEl: HTMLElement;
	private locateButton: HTMLElement | null = null;
	private map: Map | null = null;
	private userMarker: Marker | null = null;
	private watchId: number | null = null;
	private isTracking = false;
	// While locked, new positions recenter the map. Panning or zooming by hand
	// releases the lock so tracking doesn't fight with manual navigation.
	private isLocked = false;
	private zoomOnNextRecenter = false;
	private lastPosition: [number, number] | null = null;
	private lastErrorCode: number | null = null;

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

		this.locateButton.addEventListener('click', () => {
			if (!this.isTracking) {
				this.startTracking();
			} else if (!this.isLocked) {
				// Tracking but panned away, so recenter rather than stopping
				this.lock();
				this.recenter();
			} else {
				this.stopTracking();
			}
		});

		map.on('movestart', this.onMoveStart);

		return this.containerEl;
	}

	private startTracking(): void {
		if (!navigator.geolocation) {
			new Notice('Location services are not available');
			return;
		}

		if (!this.map || !this.locateButton) return;

		this.isTracking = true;
		this.lastErrorCode = null;
		this.locateButton.addClass('is-active');
		this.lock();

		// watchPosition reports the current position immediately, so there is no
		// need for a separate getCurrentPosition call to seed the first fix
		this.watchId = navigator.geolocation.watchPosition(
			(position) => {
				this.updatePosition(position.coords.latitude, position.coords.longitude);
			},
			(error) => {
				this.handleError(error);
			},
			GEOLOCATION_OPTIONS
		);
	}

	private stopTracking(): void {
		if (this.watchId !== null) {
			navigator.geolocation.clearWatch(this.watchId);
			this.watchId = null;
		}

		this.isTracking = false;
		this.isLocked = false;
		this.lastPosition = null;
		this.lastErrorCode = null;

		if (this.locateButton) {
			this.locateButton.removeClass('is-active');
			setIcon(this.locateButton, 'locate-fixed');
		}

		if (this.userMarker) {
			this.userMarker.remove();
			this.userMarker = null;
		}
	}

	private lock(): void {
		this.isLocked = true;
		this.zoomOnNextRecenter = true;

		if (this.locateButton) {
			setIcon(this.locateButton, 'locate-fixed');
		}
	}

	private onMoveStart = (event: MoveStartEvent): void => {
		// Programmatic movement carries no originalEvent, so only genuine user
		// interaction releases the lock. Pane resizes shouldn't count either.
		if (!this.isLocked || !event.originalEvent) return;
		if (event.originalEvent.type === 'resize') return;

		this.isLocked = false;

		if (this.locateButton) {
			setIcon(this.locateButton, 'locate');
		}
	};

	private updatePosition(lat: number, lng: number): void {
		if (!this.map) return;

		this.lastPosition = [lat, lng];
		this.lastErrorCode = null;

		// Create or update user marker
		if (!this.userMarker) {
			const el = createDiv('user-location-marker');
			const svgEl = el.createSvg('svg', {
				attr: { width: '20', height: '20', viewBox: '0 0 20 20' }
			});
			svgEl.createSvg('circle', {
				attr: { cx: '10', cy: '10', r: '6' }
			});

			this.userMarker = new Marker({ element: el })
				.setLngLat([lng, lat])
				.addTo(this.map);
		} else {
			this.userMarker.setLngLat([lng, lat]);
		}

		if (this.isLocked) {
			this.recenter();
		}
	}

	private recenter(): void {
		if (!this.map || !this.lastPosition) return;

		const [lat, lng] = this.lastPosition;
		const options: FlyToOptions = {
			center: [lng, lat],
			duration: 1000
		};

		// Only zoom in when the lock is first acquired, otherwise leave the
		// zoom level the user has chosen alone
		if (this.zoomOnNextRecenter) {
			options.zoom = Math.max(this.map.getZoom(), TRACKING_ZOOM);
			this.zoomOnNextRecenter = false;
		}

		this.map.flyTo(options);
	}

	private handleError(error: GeolocationPositionError): void {
		// A watch can repeat the same transient failure, so only notify once per kind
		if (this.lastErrorCode !== error.code) {
			this.lastErrorCode = error.code;
			new Notice(geolocationErrorMessage(error));
			console.warn('Geolocation error:', error);
		}

		// Only a denied permission is unrecoverable. Transient failures such as a
		// lost fix indoors shouldn't tear down the watch.
		if (error.code === error.PERMISSION_DENIED) {
			this.stopTracking();
		}
	}

	onRemove(): void {
		this.stopTracking();

		if (this.map) {
			this.map.off('movestart', this.onMoveStart);
		}

		this.containerEl.detach();

		this.map = null;
		this.locateButton = null;
	}
}
