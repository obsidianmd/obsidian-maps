import {
	BasesEntry,
	BasesPropertyId,
	BasesView,
	debounce,
	Keymap,
	ListValue,
	Menu,
	NumberValue,
	QueryController,
	StringValue,
	ViewOption,
	setIcon,
	Value,
	NullValue,
} from 'obsidian';
import { LngLatBounds, LngLatLike, Map, Marker, Popup, StyleSpecification } from 'maplibre-gl';
import { transformMapboxStyle } from './mapbox-transform';

export const MapViewType = 'map';

const DEFAULT_MAP_HEIGHT = 400;
const DEFAULT_MAP_CENTER: [number, number] = [0, 0];
const DEFAULT_MAP_ZOOM = 4;

interface MapMarker {
	entry: BasesEntry;
	marker: Marker;
	coordinates: [number, number];
}

class CustomZoomControl {
	private containerEl: HTMLElement;

	constructor() {
		this.containerEl = createDiv('maplibregl-ctrl maplibregl-ctrl-group');
	}

	onAdd(map: Map): HTMLElement {
		const zoomInButton = this.containerEl.createEl('button', {
			type: 'button',
			cls: 'maplibregl-ctrl-zoom-in',
			attr: { 'aria-label': 'Zoom in' }
		});
		setIcon(zoomInButton, 'plus');

		zoomInButton.addEventListener('click', () => {
			map.zoomIn();
		});

		const zoomOutButton = this.containerEl.createEl('button', {
			type: 'button',
			cls: 'maplibregl-ctrl-zoom-out',
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

export class MapView extends BasesView {
	type = MapViewType;
	scrollEl: HTMLElement;
	containerEl: HTMLElement;
	mapEl: HTMLElement;

	// Internal rendering data
	private map: Map | null = null;
	private markers: MapMarker[] = [];
	private bounds: LngLatBounds | null = null;
	private coordinatesProp: BasesPropertyId | null = null;
	private markerIconProp: BasesPropertyId | null = null;
	private markerColorProp: BasesPropertyId | null = null;
	private mapHeight: number = DEFAULT_MAP_HEIGHT;
	private defaultZoom: number = DEFAULT_MAP_ZOOM;
	private center: [number, number] = DEFAULT_MAP_CENTER;
	private maxZoom = 18; // MapLibre default
	private minZoom = 0;  // MapLibre default
	private mapTiles: string[] = []; // Custom tile URLs for light mode
	private mapTilesDark: string[] = []; // Custom tile URLs for dark mode
	private pendingMapState: { center?: LngLatLike, zoom?: number } | null = null;
	private sharedPopup: Popup | null = null;
	private isFirstLoad = true;
	private lastConfigSnapshot: string | null = null;

	private popupHideTimeout: number | null = null;
	private popupHideTimeoutWin: Window | null = null;

	constructor(controller: QueryController, scrollEl: HTMLElement) {
		super(controller);
		this.scrollEl = scrollEl;
		this.containerEl = scrollEl.createDiv({ cls: 'bases-map-container is-loading', attr: { tabIndex: 0 } });
		this.mapEl = this.containerEl.createDiv('bases-map');
	}

	onload(): void {
		// Listen for theme changes to update map tiles
		this.registerEvent(this.app.workspace.on('css-change', this.onThemeChange, this));
	}

	onunload() {
		this.destroyMap();
	}

	/** Reduce flashing due to map re-rendering by debouncing while resizes are still ocurring. */
	private onResizeDebounce = debounce(
		() => { if (this.map) this.map.resize() },
		100,
		true);

	onResize(): void {
		this.onResizeDebounce();
	}

	public focus(): void {
		this.containerEl.focus({ preventScroll: true });
	}

	private onThemeChange = (): void => {
		if (this.map) {
			void this.updateMapStyle();
		}
	};

	private async updateMapStyle(): Promise<void> {
		if (!this.map) return;
		const newStyle = await this.getMapStyle();
		this.map.setStyle(newStyle);
	}

	private async initializeMap(): Promise<void> {
		if (this.map) return;

		// Set initial map height based on context
		const isEmbedded = this.isEmbedded();
		if (isEmbedded) {
			this.mapEl.style.height = this.mapHeight + 'px';
		}
		else {
			// Let CSS handle the height for direct base file views
			this.mapEl.style.height = '';
		}

		// Get the map style (may involve fetching remote style JSON)
		const mapStyle = await this.getMapStyle();

		// Initialize MapLibre GL JS map with configured tiles or default style
		this.map = new Map({
			container: this.mapEl,
			style: mapStyle,
			center: [this.center[1], this.center[0]], // MapLibre uses [lng, lat]
			zoom: this.defaultZoom,
			minZoom: this.minZoom,
			maxZoom: this.maxZoom,
		});

		this.map.addControl(new CustomZoomControl(), 'top-right');

		this.map.on('error', (e) => {
			console.warn('Map error:', e);
		});

		// Ensure the center and zoom are set after map loads (in case the style loading overrides it)
		this.map.on('load', () => {
			if (!this.map) return;

			const hasConfiguredCenter = this.center[0] !== 0 || this.center[1] !== 0;
			const hasConfiguredZoom = this.config.get('defaultZoom') && Number.isNumber(this.config.get('defaultZoom'));

			// Set center based on configuration
			if (hasConfiguredCenter) {
				this.map.setCenter([this.center[1], this.center[0]]); // MapLibre uses [lng, lat]
			}
			else if (this.bounds) {
				this.map.setCenter(this.bounds.getCenter()); // Center on markers
			}

			// Set zoom based on configuration
			if (hasConfiguredZoom) {
				this.map.setZoom(this.defaultZoom); // Use configured zoom
			}
			else if (this.bounds) {
				this.map.fitBounds(this.bounds, { padding: 20 }); // Fit all markers
			}
		});

		// Hide tooltip on the map element.
		this.mapEl.querySelector('canvas')?.style
			.setProperty('--no-tooltip', 'true');

		// Add context menu to map
		this.mapEl.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			this.showMapContextMenu(evt);
		});
	}

	private destroyMap(): void {
		this.clearPopupHideTimeout();
		if (this.sharedPopup) {
			this.sharedPopup.remove();
			this.sharedPopup = null;
		}
		if (this.map) {
			this.map.remove();
			this.map = null;
		}
		this.markers = [];
		this.bounds = null;
	}

	public onDataUpdated(): void {
		this.containerEl.removeClass('is-loading');
		
		const configSnapshot = this.getConfigSnapshot();
		const configChanged = this.lastConfigSnapshot !== configSnapshot;
		
		this.loadConfig();
		void this.initializeMap().then(() => {
			if (this.map && this.data) {
				this.updateMarkers();
			}
			// Apply config to map on first load or when config changes
			if (configChanged) {
				void this.applyConfigToMap();
				this.lastConfigSnapshot = configSnapshot;
				this.isFirstLoad = false;
			}
		});
	}

	private getConfigSnapshot(): string {
		// Create a snapshot of config values that affect map display
		return JSON.stringify({
			center: this.config.get('center'),
			defaultZoom: this.config.get('defaultZoom'),
			minZoom: this.config.get('minZoom'),
			maxZoom: this.config.get('maxZoom'),
			mapHeight: this.config.get('mapHeight'),
			mapTiles: this.config.get('mapTiles'),
			mapTilesDark: this.config.get('mapTilesDark'),
		});
	}

	private loadConfig(): void {
		// Load property configurations
		this.coordinatesProp = this.config.getAsPropertyId('coordinates');
		this.markerIconProp = this.config.getAsPropertyId('markerIcon');
		this.markerColorProp = this.config.getAsPropertyId('markerColor');

		// Load numeric configurations with validation
		this.minZoom = this.getNumericConfig('minZoom', 0, 0, 24);
		this.maxZoom = this.getNumericConfig('maxZoom', 18, 0, 24);
		this.defaultZoom = this.getNumericConfig('defaultZoom', DEFAULT_MAP_ZOOM, this.minZoom, this.maxZoom);

		// Load center coordinates
		this.center = this.getCenterFromConfig();

		// Load map height for embedded views
		this.mapHeight = this.isEmbedded()
			? this.getNumericConfig('mapHeight', DEFAULT_MAP_HEIGHT, 100, 2000)
			: DEFAULT_MAP_HEIGHT;

		// Load map tiles configurations
		this.mapTiles = this.getArrayConfig('mapTiles');
		this.mapTilesDark = this.getArrayConfig('mapTilesDark');
	}

	private getNumericConfig(key: string, defaultValue: number, min?: number, max?: number): number {
		const value = this.config.get(key);
		if (value == null || typeof value !== 'number') return defaultValue;

		let result = value;
		if (min !== undefined) result = Math.max(min, result);
		if (max !== undefined) result = Math.min(max, result);
		return result;
	}

	private getArrayConfig(key: string): string[] {
		const value = this.config.get(key);
		if (!value) return [];

		// Handle array values
		if (Array.isArray(value)) {
			return value.filter(item => typeof item === 'string' && item.trim().length > 0);
		}

		// Handle single string value
		if (typeof value === 'string' && value.trim().length > 0) {
			return [value.trim()];
		}

		return [];
	}

	private getCenterFromConfig(): [number, number] {
		let centerConfig = this.config.getEvaluatedFormula(this, 'center');

		// Support for legacy string format.
		if (Value.equals(centerConfig, NullValue.value)) {
			const centerConfigStr = this.config.get('center');
			if (String.isString(centerConfigStr)) {
				centerConfig = new StringValue(centerConfigStr);
			}
			else {
				return DEFAULT_MAP_CENTER;
			}
		}
		return this.coordinateFromValue(centerConfig) || DEFAULT_MAP_CENTER;
	}

	private async applyConfigToMap(): Promise<void> {
		if (!this.map) return;

		// Update map constraints
		this.map.setMinZoom(this.minZoom);
		this.map.setMaxZoom(this.maxZoom);

		// Clamp current zoom to new min/max bounds
		const currentZoom = this.map.getZoom();
		if (currentZoom < this.minZoom) {
			this.map.setZoom(this.minZoom);
		} else if (currentZoom > this.maxZoom) {
			this.map.setZoom(this.maxZoom);
		}

		// Update zoom if defaultZoom config is set
		const hasConfiguredZoom = this.config.get('defaultZoom') != null;
		if (hasConfiguredZoom) {
			this.map.setZoom(this.defaultZoom);
		}

		// Update center if center config is set
		const hasConfiguredCenter = this.center[0] !== 0 || this.center[1] !== 0;
		if (hasConfiguredCenter) {
			this.map.setCenter([this.center[1], this.center[0]]); // MapLibre uses [lng, lat]
		}

		// Update map style if tiles configuration changed
		const newStyle = await this.getMapStyle();
		const currentStyle = this.map.getStyle();
		if (JSON.stringify(newStyle) !== JSON.stringify(currentStyle)) {
			this.map.setStyle(newStyle);
		}

		// Update map height for embedded views
		if (this.isEmbedded()) {
			this.mapEl.style.height = this.mapHeight + 'px';
		}
		else {
			this.mapEl.style.height = '';
		}

		// Resize map after height changes
		this.map.resize();
	}

	private isEmbedded(): boolean {
		// Check if this map view is embedded in a markdown file rather than opened directly
		// If the scrollEl has a parent with 'bases-embed' class, it's embedded
		let element = this.scrollEl.parentElement;
		while (element) {
			if (element.hasClass('bases-embed') || element.hasClass('block-language-base')) {
				return true;
			}
			element = element.parentElement;
		}
		return false;
	}


	private async getMapStyle(): Promise<string | StyleSpecification> {
		const isDark = this.app.isDarkMode();
		const tileUrls = isDark && this.mapTilesDark.length > 0 ? this.mapTilesDark : this.mapTiles;

		// Determine style URL: use custom if provided, otherwise use default style
		let styleUrl: string;
		if (tileUrls.length === 0) {
			// No custom tiles configured, use default
			styleUrl = isDark ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/bright';
		} else if (tileUrls.length === 1 && !this.isTileTemplateUrl(tileUrls[0])) {
			// Single URL that's not a tile template, treat as style URL
			styleUrl = tileUrls[0];
		} else {
			// Multiple URLs or tile template URLs - create custom raster style (skip to bottom)
			styleUrl = '';
		}

		// Fetch style JSON for any style URL (default or custom) to avoid CORS issues
		if (styleUrl) {
			try {
				const response = await fetch(styleUrl);
				if (response.ok) {
					const styleJson = await response.json();
					// Extract access token from URL for Mapbox styles
					const accessTokenMatch = styleUrl.match(/access_token=([^&]+)/);
					const accessToken = accessTokenMatch ? accessTokenMatch[1] : '';
					// Transform mapbox:// protocol URLs to HTTPS URLs if needed
					const transformedStyle = accessToken
						? transformMapboxStyle(styleJson, accessToken)
						: styleJson;
					return transformedStyle as StyleSpecification;
				}
			} catch (error) {
				console.warn('Failed to fetch style JSON, falling back to URL:', error);
			}
			// If fetch fails, fall back to returning the URL directly
			return styleUrl;
		}

		// Create a custom style with the configured tile sources (raster tiles)
		const spec: StyleSpecification = {
			version: 8,
			sources: {},
			layers: [],
		}
		tileUrls.forEach((tileUrl, index) => {
			const sourceId = `custom-tiles-${index}`;
			spec.sources[sourceId] = {
				type: 'raster',
				tiles: [tileUrl],
				tileSize: 256
			};

			spec.layers.push({
				id: `custom-layer-${index}`,
				type: 'raster',
				source: sourceId
			});
		});
		return spec;
	}

	private isTileTemplateUrl(url: string): boolean {
		// Check if the URL contains tile template placeholders
		return url.includes('{z}') || url.includes('{x}') || url.includes('{y}');
	}

	private showMapContextMenu(evt: MouseEvent): void {
		if (!this.map) return;

		const currentZoom = Math.round(this.map.getZoom() * 10) / 10; // Round to 1 decimal place

		// Get coordinates from the location of the right-click event, not the map center
		const clickPoint: [number, number] = [evt.offsetX, evt.offsetY];
		const clickedCoords = this.map.unproject(clickPoint);
		const currentLat = Math.round(clickedCoords.lat * 100000) / 100000;
		const currentLng = Math.round(clickedCoords.lng * 100000) / 100000;

		const menu = Menu.forEvent(evt);
		menu.addItem(item => item
			.setTitle('New note')
			.setSection('action')
			.setIcon('square-pen')
			.onClick(() => {
				void this.createFileForView('', (frontmatter) => {
					// Pre-fill coordinates if a coordinates property is configured
					if (this.coordinatesProp) {
						// Remove 'note.' prefix if present
						const propertyKey = this.coordinatesProp.startsWith('note.') 
							? this.coordinatesProp.slice(5) 
							: this.coordinatesProp;
							frontmatter[propertyKey] = [currentLat.toString(), currentLng.toString()];
					}
				});
			})
		);

		menu.addItem(item => item
			.setTitle('Copy coordinates')
			.setSection('action')
			.setIcon('copy')
			.onClick(() => {
				const coordString = `${currentLat}, ${currentLng}`;
				void navigator.clipboard.writeText(coordString);
			})
		);

		menu.addItem(item => item
			.setTitle('Set default center point')
			.setSection('action')
			.setIcon('map-pin')
			.onClick(() => {
				// Set the current center as the default coordinates
				const coordListStr = `[${currentLat}, ${currentLng}]`;

				// 1. Update the component's internal state immediately.
				// This ensures that if a re-render is triggered, its logic will use the
				// new coordinates and prevent the map from recentering on markers.
				this.center = [currentLat, currentLng];

				// 2. Set the config value, which will be saved.
				this.config.set('center', coordListStr);

				// 3. Immediately move the map for instant user feedback.
				this.map?.setCenter([currentLng, currentLat]); // MapLibre uses [lng, lat]
			})
		);

		menu.addItem(item => item
			.setTitle(`Set default zoom (${currentZoom})`)
			.setSection('action')
			.setIcon('crosshair')
			.onClick(() => {
				this.config.set('defaultZoom', currentZoom);
			})
		);
	}

	private updateMarkers(): void {
		// Clear existing markers
		for (const markerData of this.markers) {
			markerData.marker.remove();
		}

		if (!this.map || !this.data || !this.coordinatesProp) {
			return;
		}

		// Create markers for entries with valid coordinates
		const validMarkers: MapMarker[] = this.markers = [];
		for (const entry of this.data.data) {
			if (!entry) continue;

			let coordinates: [number, number] | null = null;
			try {
				const value = entry.getValue(this.coordinatesProp);
				coordinates = this.coordinateFromValue(value);
			}
			catch (error) {
				console.error(`Error extracting coordinates for ${entry.file.name}:`, error);
			}

			if (coordinates) {
				const marker = this.createMarker(entry, coordinates);
				if (marker) {
					validMarkers.push({
						entry,
						marker,
						coordinates,
					});
				}
			}
		}

		// Calculate bounds for all markers
		const bounds = this.bounds = new LngLatBounds();
		validMarkers.forEach(markerData => {
			const [lat, lng] = markerData.coordinates;
			bounds.extend([lng, lat]);
		});

		// Apply pending map state if available (for restoring ephemeral state)
		if (this.pendingMapState && this.map) {
			const { center, zoom } = this.pendingMapState;
			if (center) {
				this.map.setCenter(center);
			}
			if (zoom !== null && zoom !== undefined) {
				this.map.setZoom(zoom);
			}
			this.pendingMapState = null;
		}
	}

	private coordinateFromValue(value: Value | null): [number, number] | null {
		let lat: number | null = null;
		let lng: number | null = null;

		// Handle list values (e.g., ["34.1395597", "-118.3870991"] or [34.1395597, -118.3870991])
		if (value instanceof ListValue) {
			if (value.length() >= 2) {
				lat = this.parseCoordinate(value.get(0));
				lng = this.parseCoordinate(value.get(1));
			}
		}
		// Handle string values (e.g., "34.1395597,-118.3870991" or "34.1395597, -118.3870991")
		else if (value instanceof StringValue) {
			// Split by comma and handle various spacing
			const parts = value.toString().trim().split(',');
			if (parts.length >= 2) {
				lat = this.parseCoordinate(parts[0].trim());
				lng = this.parseCoordinate(parts[1].trim());
			}
		}

		if (lat && lng && this.verifyLatLng(lat, lng)) {
			return [lat, lng];
		}

		return null;
	}

	private verifyLatLng(lat: number, lng: number): boolean {
		return !isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
	}

	private parseCoordinate(value: unknown): number | null {
		if (value instanceof NumberValue) {
			const numData = Number(value.toString());
			return isNaN(numData) ? null : numData;
		}
		if (value instanceof StringValue) {
			const num = parseFloat(value.toString());
			return isNaN(num) ? null : num;
		}
		if (typeof value === 'string') {
			const num = parseFloat(value);
			return isNaN(num) ? null : num;
		}
		if (typeof value === 'number') {
			return isNaN(value) ? null : value;
		}
		return null;
	}

	private getCustomIcon(entry: BasesEntry): string | null {
		if (!this.markerIconProp) return null;

		try {
			const value = entry.getValue(this.markerIconProp);
			if (!value) return null;

			// Extract the icon name from the value
			const iconString = value.toString().trim();

			// Handle null/empty/invalid cases - return null to show default marker
			if (!iconString || iconString.length === 0 || iconString === 'null' || iconString === 'undefined') {
				return null;
			}

			return iconString;
		}
		catch (error) {
			console.error(`Error extracting icon for ${entry.file.name}:`, error);
			return null;
		}
	}

	private getCustomColor(entry: BasesEntry): string | null {
		if (!this.markerColorProp) return null;

		try {
			const value = entry.getValue(this.markerColorProp);
			if (!value || !value.isTruthy()) return null;

			// Extract the color value from the property
			const colorString = value.toString().trim();

			// Return the color as-is, let CSS handle validation
			// Supports: hex (#ff0000), rgb/rgba, hsl/hsla, CSS color names, and CSS custom properties (var(--color-name))
			return colorString;
		}
		catch (error) {
			console.error(`Error extracting color for ${entry.file.name}:`, error);
			return null;
		}
	}

	private createMarker(entry: BasesEntry, coordinates: [number, number]): Marker | null {
		if (!this.map) return null;

		const [lat, lng] = coordinates;

		// Get custom icon and color if configured
		const customIcon = this.getCustomIcon(entry);
		const customColor = this.getCustomColor(entry);

		const markerContainerEl = createDiv('bases-map-custom-marker');

		markerContainerEl.createDiv('bases-map-marker-shadow');
		const pinEl = markerContainerEl.createDiv('bases-map-marker-pin');
		markerContainerEl.createDiv('bases-map-marker-pin-outline');

		if (customColor) {
			pinEl.style.setProperty('--marker-color', customColor);
		}

		if (this.markerIconProp && customIcon) {
			const iconElement = markerContainerEl.createDiv('bases-map-marker-icon');
			setIcon(iconElement, customIcon);
		}
		else {
			markerContainerEl.createDiv('bases-map-marker-dot');
		}

		const marker = new Marker({
			element: markerContainerEl
		})
			.setLngLat([lng, lat])
			.addTo(this.map);

		marker.addClassName('bases-map-marker');

		const markerEl = marker.getElement();

		// Set aria-label to file basename if no properties are configured, otherwise remove it
		if (!this.data.properties || this.data.properties.length === 0) {
			markerEl.setAttribute('aria-label', entry.file.basename);
		}
		else {
			markerEl.removeAttribute('aria-label');
		}

		// Only create popup if there are properties configured and at least one has a value
		if (this.data.properties && this.data.properties.length > 0 && this.hasAnyPropertyValues(entry)) {
			// Handle hover to show popup
			markerEl.addEventListener('mouseenter', () => {
				this.showPopup(entry, coordinates);
			});

			// Handle mouse leave to hide popup
			markerEl.addEventListener('mouseleave', () => {
				this.hidePopup();
			});
		}

		// Handle click events - similar to cards view
		markerEl.addEventListener('click', (evt) => {
			if (evt.defaultPrevented) return;

			// Don't block external links
			const target = evt.target as Element;
			if (target?.closest && target.closest('a')) return;

			void this.app.workspace.openLinkText(entry.file.path, '', Keymap.isModEvent(evt));
		});


		markerEl.addEventListener('contextmenu', (evt) => {
			evt.stopPropagation();
			
			const file = entry.file;
			const menu = Menu.forEvent(evt);

			this.app.workspace.handleLinkContextMenu(menu, file.path, '');

			// Add copy coordinates option
			menu.addItem(item => item
				.setSection('action')
				.setTitle('Copy coordinates')
				.setIcon('map-pin')
				.onClick(() => {
					const coordString = `${lat}, ${lng}`;
					void navigator.clipboard.writeText(coordString);
				}));

			menu.addItem(item => item
				.setSection('danger')
				.setTitle('Delete file')
				.setIcon('trash-2')
				.setWarning(true)
				.onClick(() => this.app.fileManager.promptForDeletion(file)));
		});

		// Handle hover for link preview - similar to cards view
		markerEl.addEventListener('mouseover', (evt) => {
			this.app.workspace.trigger('hover-link', {
				event: evt,
				source: 'bases',
				hoverParent: this.app.renderContext,
				targetEl: markerEl,
				linktext: entry.file.path,
			});
		});

		return marker;
	}

	private createPopupContent(entry: BasesEntry): HTMLElement {
		const containerEl = createDiv('bases-map-popup');

		// Get properties that have values
		const properties = this.data.properties.slice(0, 20); // Max 20 properties
		const propertiesWithValues = [];

		for (const prop of properties) {
			if (prop === this.coordinatesProp || prop === this.markerIconProp || prop === this.markerColorProp) continue; // Skip coordinates, marker icon, and marker color properties

			try {
				const value = entry.getValue(prop);
				if (value && this.hasNonEmptyValue(value)) {
					propertiesWithValues.push({ prop, value });
				}
			}
			catch {
				// Skip properties that can't be rendered
			}
		}

		// Use first property as title (still acts as a link to the file)
		if (propertiesWithValues.length > 0) {
			const firstProperty = propertiesWithValues[0];
			const titleEl = containerEl.createDiv('bases-map-popup-title');

			// Create a clickable link that opens the file
			const titleLinkEl = titleEl.createEl('a', {
				href: entry.file.path,
				cls: 'internal-link'
			});

			// Render the first property value inside the link
			firstProperty.value.renderTo(titleLinkEl, this.app.renderContext);

			// Show remaining properties (excluding the first one used as title)
			const remainingProperties = propertiesWithValues.slice(1);
			if (remainingProperties.length > 0) {
				const propContainerEl = containerEl.createDiv('bases-map-popup-properties');
				for (const { prop, value } of remainingProperties) {
					const propEl = propContainerEl.createDiv('bases-map-popup-property');
					const labelEl = propEl.createDiv('bases-map-popup-property-label');
					labelEl.textContent = this.config.getDisplayName(prop);
					const valueEl = propEl.createDiv('bases-map-popup-property-value');
					value.renderTo(valueEl, this.app.renderContext);
				}
			}
		}

		return containerEl;
	}

	private hasNonEmptyValue(value: Value): boolean {
		if (!value || !value.isTruthy()) return false;

		// Handle ListValue - check if it has any non-empty items
		if (value instanceof ListValue) {
			for (let i = 0; i < value.length(); i++) {
				const item = value.get(i);
				if (item && this.hasNonEmptyValue(item)) {
					return true;
				}
			}
			return false;
		}

		return true;
	}

	private hasAnyPropertyValues(entry: BasesEntry): boolean {
		const properties = this.data.properties.slice(0, 20); // Max 20 properties

		for (const prop of properties) {
			if (prop === this.coordinatesProp || prop === this.markerIconProp || prop === this.markerColorProp) continue; // Skip coordinates, marker icon, and marker color properties

			try {
				const value = entry.getValue(prop);
				if (value && this.hasNonEmptyValue(value)) {
					return true;
				}
			}
			catch {
				// Skip properties that can't be rendered
			}
		}

		return false;
	}

	private showPopup(entry: BasesEntry, coordinates: [number, number]): void {
		if (!this.map) return;

		this.clearPopupHideTimeout();

		// Create shared popup if it doesn't exist
		if (!this.sharedPopup) {
			const sharedPopup = this.sharedPopup = new Popup({
				closeButton: false,
				closeOnClick: false,
				offset: 25
			});

			// Add hover handlers to the popup itself
			sharedPopup.on('open', () => {
				const popupEl = sharedPopup.getElement();
				if (popupEl) {
					popupEl.addEventListener('mouseenter', () => {
						this.clearPopupHideTimeout();
					});
					popupEl.addEventListener('mouseleave', () => {
						this.hidePopup();
					});
				}
			});
		}

		// Update popup content and position
		const [lat, lng] = coordinates;
		const popupContent = this.createPopupContent(entry);
		this.sharedPopup
			.setDOMContent(popupContent)
			.setLngLat([lng, lat])
			.addTo(this.map);
	}

	private hidePopup(): void {
		this.clearPopupHideTimeout();

		const win = this.popupHideTimeoutWin = this.containerEl.win;
		this.popupHideTimeout = win.setTimeout(() => {
			if (this.sharedPopup) {
				this.sharedPopup.remove();
			}
			this.popupHideTimeout = null;
			this.popupHideTimeoutWin = null;
		}, 150); // Small delay to allow moving to popup
	}

	private clearPopupHideTimeout(): void {
		if (this.popupHideTimeout) {
			const win = this.popupHideTimeoutWin || this.scrollEl.win;
			win.clearTimeout(this.popupHideTimeout);
		}

		this.popupHideTimeoutWin = null;
		this.popupHideTimeout = null;
	}

	public setEphemeralState(state: unknown): void {
		if (!state) {
			this.pendingMapState = null;
			return;
		}

		this.pendingMapState = {};
		if (hasOwnProperty(state, 'center') && hasOwnProperty(state.center, 'lng') && hasOwnProperty(state.center, 'lat')) {
			const lng = state.center.lng;
			const lat = state.center.lat;

			if (typeof lng === 'number' && typeof lat === 'number') {
				this.pendingMapState.center = { lng, lat };
			}
		}
		if (hasOwnProperty(state, 'zoom') && typeof state.zoom === 'number') {
			this.pendingMapState.zoom = state.zoom;
		}
	}

	public getEphemeralState(): unknown {
		if (!this.map) return {};

		const center = this.map.getCenter();
		return {
			center: { lng: center.lng, lat: center.lat },
			zoom: this.map.getZoom(),
		};
	}

	static getViewOptions(): ViewOption[] {
		return [
			{
				displayName: 'Embedded height',
				type: 'slider',
				key: 'mapHeight',
				min: 200,
				max: 800,
				step: 20,
				default: DEFAULT_MAP_HEIGHT,
			},
			{
				displayName: 'Display',
				type: 'group',
				items: [

					{
						displayName: 'Center coordinates',
						type: 'formula',
						key: 'center',
						placeholder: '[latitude, longitude]',
					},
					{
						displayName: 'Default zoom',
						type: 'slider',
						key: 'defaultZoom',
						min: 1,
						max: 18,
						step: 1,
						default: DEFAULT_MAP_ZOOM,
					},
					{
						displayName: 'Minimum zoom',
						type: 'slider',
						key: 'minZoom',
						min: 0,
						max: 24,
						step: 1,
						default: 0,
					},
					{
						displayName: 'Maximum zoom',
						type: 'slider',
						key: 'maxZoom',
						min: 0,
						max: 24,
						step: 1,
						default: 18,
					},
				]
			},
			{
				displayName: 'Markers',
				type: 'group',
				items: [
					{
						displayName: 'Marker coordinates',
						type: 'property',
						key: 'coordinates',
						filter: prop => !prop.startsWith('file.'),
						placeholder: 'Property',
					},
					{
						displayName: 'Marker icon',
						type: 'property',
						key: 'markerIcon',
						filter: prop => !prop.startsWith('file.'),
						placeholder: 'Property',
					},
					{
						displayName: 'Marker color',
						type: 'property',
						key: 'markerColor',
						filter: prop => !prop.startsWith('file.'),
						placeholder: 'Property',
					},
				]
			},
			{
				displayName: 'Background',
				type: 'group',
				items: [
					{
						displayName: 'Map tiles',
						type: 'multitext',
						key: 'mapTiles',
					},
					{
						displayName: 'Map tiles in dark mode',
						type: 'multitext',
						key: 'mapTilesDark',
					},
				]
			},
		];
	}
}

/** Wrapper for Object.hasOwn which performs type narrowing. */
function hasOwnProperty<K extends PropertyKey>(o: unknown, v: K): o is Record<K, unknown> {
	return o != null && typeof o === 'object' && Object.hasOwn(o, v);
}
