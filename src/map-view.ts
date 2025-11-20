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
import { LngLatBounds, LngLatLike, Map, Popup, StyleSpecification, MapLayerMouseEvent, GeoJSONSource } from 'maplibre-gl';
import { transformMapboxStyle } from './mapbox-transform';
import type ObsidianMapsPlugin from './main';

export const MapViewType = 'map';

const DEFAULT_MAP_HEIGHT = 400;
const DEFAULT_MAP_CENTER: [number, number] = [0, 0];
const DEFAULT_MAP_ZOOM = 4;

interface MapMarker {
	entry: BasesEntry;
	coordinates: [number, number];
}

interface MapMarkerProperties {
	entryIndex: number;
	icon: string; // Composite image key combining icon and color
}

class CustomZoomControl {
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

class BackgroundSwitcherControl {
	private containerEl: HTMLElement;
	private tileSets: Array<{ id: string; name: string; lightTiles: string; darkTiles: string }>;
	private onSwitch: (tileSetId: string) => void;
	private currentTileSetId: string;

	constructor(
		tileSets: Array<{ id: string; name: string; lightTiles: string; darkTiles: string }>,
		currentTileSetId: string,
		onSwitch: (tileSetId: string) => void
	) {
		this.tileSets = tileSets;
		this.currentTileSetId = currentTileSetId;
		this.onSwitch = onSwitch;
		this.containerEl = createDiv('maplibregl-ctrl maplibregl-ctrl-group canvas-control-group mod-raised');
	}

	onAdd(map: Map): HTMLElement {
		const button = this.containerEl.createEl('div', {
			cls: 'canvas-control-item',
			attr: { 'aria-label': 'Switch background' }
		});
		setIcon(button, 'layers');

		button.addEventListener('click', (evt) => {
			evt.stopPropagation();
			const menu = new Menu();

			for (const tileSet of this.tileSets) {
				menu.addItem((item) => {
					item
						.setTitle(tileSet.name)
						.setChecked(this.currentTileSetId === tileSet.id)
						.onClick(() => {
							this.currentTileSetId = tileSet.id;
							this.onSwitch(tileSet.id);
						});
				});
			}

			menu.showAtMouseEvent(evt);
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
	plugin: ObsidianMapsPlugin;

	// Internal rendering data
	private map: Map | null = null;
	private markers: MapMarker[] = [];
	private bounds: LngLatBounds | null = null;
	private loadedIcons: Set<string> = new Set();
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
	private currentTileSetId: string | null = null; // Track which tile set is active
	private pendingMapState: { center?: LngLatLike, zoom?: number } | null = null;
	private sharedPopup: Popup | null = null;
	private isFirstLoad = true;
	private lastConfigSnapshot: string | null = null;
	private lastEvaluatedCenter: [number, number] = DEFAULT_MAP_CENTER;

	private popupHideTimeout: number | null = null;
	private popupHideTimeoutWin: Window | null = null;

	constructor(controller: QueryController, scrollEl: HTMLElement, plugin: ObsidianMapsPlugin) {
		super(controller);
		this.scrollEl = scrollEl;
		this.plugin = plugin;
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
		this.loadedIcons.clear();

		// Re-add markers after style change since setStyle removes all runtime layers
		this.map.once('styledata', () => {
			void this.updateMarkers();
		});
	}

	private async switchToTileSet(tileSetId: string): Promise<void> {
		const tileSet = this.plugin.settings.tileSets.find(ts => ts.id === tileSetId);
		if (!tileSet) return;

		this.currentTileSetId = tileSetId;
		
		// Update the current tiles
		this.mapTiles = tileSet.lightTiles ? [tileSet.lightTiles] : [];
		this.mapTilesDark = tileSet.darkTiles 
			? [tileSet.darkTiles]
			: (tileSet.lightTiles ? [tileSet.lightTiles] : []);

		// Update the map style
		await this.updateMapStyle();
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

		// Add background switcher if multiple tile sets are available
		if (this.plugin.settings.tileSets.length > 1) {
			const currentId = this.currentTileSetId || this.plugin.settings.tileSets[0]?.id || '';
			if (currentId) {
				this.map.addControl(
					new BackgroundSwitcherControl(
						this.plugin.settings.tileSets,
						currentId,
						(tileSetId) => this.switchToTileSet(tileSetId)
					),
					'top-right'
				);
			}
		}

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
		this.loadedIcons.clear();
		this.bounds = null;
	}

	public onDataUpdated(): void {
		this.containerEl.removeClass('is-loading');
		
		const configSnapshot = this.getConfigSnapshot();
		const configChanged = this.lastConfigSnapshot !== configSnapshot;
		
		this.loadConfig();
		
		// Check if the evaluated center coordinates have changed
		const centerChanged = this.center[0] !== this.lastEvaluatedCenter[0] || 
			this.center[1] !== this.lastEvaluatedCenter[1];
		
		void this.initializeMap().then(async () => {
			// Apply config to map on first load or when config changes
			if (configChanged) {
				await this.applyConfigToMap(this.lastConfigSnapshot, configSnapshot);
				this.lastConfigSnapshot = configSnapshot;
				this.isFirstLoad = false;
			}
			// Update center when the evaluated center coordinates change
			// (e.g., due to formula re-evaluation when active file changes)
			else if (this.map && !this.isFirstLoad && centerChanged) {
				this.updateCenter();
			}
			
			if (this.map && this.data) {
				this.updateMarkers();
			}

			// Track state for next comparison
			this.lastEvaluatedCenter = [this.center[0], this.center[1]];
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
		// Use view-specific tiles if configured, otherwise fall back to plugin defaults
		const viewSpecificTiles = this.getArrayConfig('mapTiles');
		const viewSpecificTilesDark = this.getArrayConfig('mapTilesDark');
		
		if (viewSpecificTiles.length > 0) {
			// View has specific tiles configured
			this.mapTiles = viewSpecificTiles;
			this.mapTilesDark = viewSpecificTilesDark;
			this.currentTileSetId = null;
		} else if (this.plugin.settings.tileSets.length > 0) {
			// Use first tile set from plugin settings (or previously selected one)
			const tileSet = this.currentTileSetId 
				? this.plugin.settings.tileSets.find(ts => ts.id === this.currentTileSetId)
				: null;
			const selectedTileSet = tileSet || this.plugin.settings.tileSets[0];
			
			this.currentTileSetId = selectedTileSet.id;
			this.mapTiles = selectedTileSet.lightTiles ? [selectedTileSet.lightTiles] : [];
			this.mapTilesDark = selectedTileSet.darkTiles 
				? [selectedTileSet.darkTiles]
				: (selectedTileSet.lightTiles ? [selectedTileSet.lightTiles] : []);
		} else {
			// No tiles configured, will fall back to default style
			this.mapTiles = [];
			this.mapTilesDark = [];
			this.currentTileSetId = null;
		}
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
		let centerConfig: Value;
		
		try {
			centerConfig = this.config.getEvaluatedFormula(this, 'center');
		} catch (error) {
			// Formula evaluation failed (e.g., this.file is null when no active file)
			// Fall back to raw config value
			const centerConfigStr = this.config.get('center');
			if (String.isString(centerConfigStr)) {
				centerConfig = new StringValue(centerConfigStr);
			}
			else {
				return DEFAULT_MAP_CENTER;
			}
		}

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

	private updateZoom(): void {
		if (!this.map) return;

		const hasConfiguredZoom = this.config.get('defaultZoom') != null;
		if (hasConfiguredZoom) {
			this.map.setZoom(this.defaultZoom);
		}
	}

	private updateCenter(): void {
		if (!this.map) return;

		const hasConfiguredCenter = this.center[0] !== 0 || this.center[1] !== 0;
		if (hasConfiguredCenter) {
			// Only recenter if the evaluated coordinates actually changed
			const currentCenter = this.map.getCenter();
			if (!currentCenter) return; // Map not fully initialized yet
			
			const targetCenter: [number, number] = [this.center[1], this.center[0]]; // MapLibre uses [lng, lat]
			const centerActuallyChanged = Math.abs(currentCenter.lng - targetCenter[0]) > 0.00001 || 
				Math.abs(currentCenter.lat - targetCenter[1]) > 0.00001;
			if (centerActuallyChanged) {
				this.map.setCenter(targetCenter);
			}
		}
	}

	private async applyConfigToMap(oldSnapshot: string | null, newSnapshot: string): Promise<void> {
		if (!this.map) return;

		// Parse snapshots to detect specific changes
		const oldConfig = oldSnapshot ? JSON.parse(oldSnapshot) : null;
		const newConfig = JSON.parse(newSnapshot);
		
		// Detect what changed
		const centerConfigChanged = oldConfig?.center !== newConfig.center;
		const zoomConfigChanged = oldConfig?.defaultZoom !== newConfig.defaultZoom;
		const tilesChanged = JSON.stringify(oldConfig?.mapTiles) !== JSON.stringify(newConfig.mapTiles) || 
			JSON.stringify(oldConfig?.mapTilesDark) !== JSON.stringify(newConfig.mapTilesDark);
		const heightChanged = oldConfig?.mapHeight !== newConfig.mapHeight;

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

		// Only update zoom on first load or when zoom config explicitly changed
		if (this.isFirstLoad || zoomConfigChanged) {
			this.updateZoom();
		}

		// Update center on first load or when center config changed
		if (this.isFirstLoad || centerConfigChanged) {
			this.updateCenter();
		}

		// Update map style if tiles configuration changed
		if (this.isFirstLoad || tilesChanged) {
			const newStyle = await this.getMapStyle();
			const currentStyle = this.map.getStyle();
			if (JSON.stringify(newStyle) !== JSON.stringify(currentStyle)) {
				this.map.setStyle(newStyle);
				this.loadedIcons.clear();
			}
		}

		// Update map height for embedded views if height changed
		if (this.isFirstLoad || heightChanged) {
			if (this.isEmbedded()) {
				this.mapEl.style.height = this.mapHeight + 'px';
			}
			else {
				this.mapEl.style.height = '';
			}
			// Resize map after height changes
			this.map.resize();
		}
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

	private async updateMarkers(): Promise<void> {
		if (!this.map || !this.data || !this.coordinatesProp) {
			return;
		}

		// Collect valid marker data
		const validMarkers: MapMarker[] = [];
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
				validMarkers.push({
					entry,
					coordinates,
				});
			}
		}

		this.markers = validMarkers;

		// Calculate bounds for all markers
		const bounds = this.bounds = new LngLatBounds();
		validMarkers.forEach(markerData => {
			const [lat, lng] = markerData.coordinates;
			bounds.extend([lng, lat]);
		});

		// Load all custom icons and create GeoJSON features
		await this.loadCustomIcons(validMarkers);
		const features = this.createGeoJSONFeatures(validMarkers);

		// Update or create the markers source
		const source = this.map.getSource('markers') as GeoJSONSource | undefined;
		if (source) {
			source.setData({
				type: 'FeatureCollection',
				features,
			});
		} else {
			// Add source if it doesn't exist
			this.map.addSource('markers', {
				type: 'geojson',
				data: {
					type: 'FeatureCollection',
					features,
				},
			});

			// Add layers for markers (icon + pin)
			this.addMarkerLayers();
			this.setupMarkerInteractions();
		}

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

	private async loadCustomIcons(markers: MapMarker[]): Promise<void> {
		if (!this.map) return;

		// Collect all unique icon+color combinations that need to be loaded
		const compositeImagesToLoad: Array<{ icon: string | null; color: string }> = [];
		const uniqueKeys = new Set<string>();
		
		for (const markerData of markers) {
			const icon = this.getCustomIcon(markerData.entry);
			const color = this.getCustomColor(markerData.entry) || 'var(--bases-map-marker-background)';
			const compositeKey = this.getCompositeImageKey(icon, color);
			
			if (!this.loadedIcons.has(compositeKey)) {
				if (!uniqueKeys.has(compositeKey)) {
					compositeImagesToLoad.push({ icon, color });
					uniqueKeys.add(compositeKey);
				}
			}
		}

		// Create composite images for each unique icon+color combination
		for (const { icon, color } of compositeImagesToLoad) {
			try {
				const compositeKey = this.getCompositeImageKey(icon, color);
				const img = await this.createCompositeMarkerImage(icon, color);
				
				if (this.map) {
					// Force update of the image on theme change
					if (this.map.hasImage(compositeKey)) {
						this.map.removeImage(compositeKey);
					}
					this.map.addImage(compositeKey, img);
					this.loadedIcons.add(compositeKey);
				}
			} catch (error) {
				console.warn(`Failed to create composite marker for icon ${icon}:`, error);
			}
		}
	}

	private getCompositeImageKey(icon: string | null, color: string): string {
		return `marker-${icon || 'dot'}-${color.replace(/[^a-zA-Z0-9]/g, '')}`;
	}

	private resolveColor(color: string): string {
		// Create a temporary element to resolve CSS variables
		const tempEl = document.createElement('div');
		tempEl.style.color = color;
		tempEl.style.display = 'none';
		document.body.appendChild(tempEl);

		// Get the computed color value
		const computedColor = getComputedStyle(tempEl).color;
		
		// Clean up
		tempEl.remove();

		return computedColor;
	}

	private async createCompositeMarkerImage(icon: string | null, color: string): Promise<HTMLImageElement> {
		// Resolve CSS variables to actual color values
		const resolvedColor = this.resolveColor(color);
		const resolvedIconColor = this.resolveColor('var(--bases-map-marker-icon-color)');

		// Create a high-resolution canvas for crisp rendering on retina displays
		const scale = 4; // 4x resolution for crisp display
		const size = 48 * scale; // High-res canvas
		const canvas = document.createElement('canvas');
		canvas.width = size;
		canvas.height = size;
		const ctx = canvas.getContext('2d');
		
		if (!ctx) {
			throw new Error('Failed to get canvas context');
		}

		// Enable high-quality rendering
		ctx.imageSmoothingEnabled = true;
		ctx.imageSmoothingQuality = 'high';

		// Draw the circle background (scaled up)
		const centerX = size / 2;
		const centerY = size / 2;
		const radius = 12 * scale;
		
		ctx.fillStyle = resolvedColor;
		ctx.beginPath();
		ctx.arc(centerX, centerY, radius, 0, 2 * Math.PI);
		ctx.fill();
		
		ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
		ctx.lineWidth = 1 * scale;
		ctx.stroke();
		
		// Draw the icon or dot
		if (icon) {
			// Load and draw custom icon
			const iconDiv = createDiv();
			setIcon(iconDiv, icon);
			const svgEl = iconDiv.querySelector('svg');
			
	if (svgEl) {
		svgEl.setAttribute('stroke', 'currentColor');
		svgEl.setAttribute('fill', 'none');
		svgEl.setAttribute('stroke-width', '2');
		svgEl.style.color = resolvedIconColor;
				
				const svgString = new XMLSerializer().serializeToString(svgEl);
				const iconImg = new Image();
				iconImg.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgString);
				
				await new Promise<void>((resolve, reject) => {
					iconImg.onload = () => {
						// Draw icon centered and scaled
						const iconSize = radius * 1.2;
						ctx.drawImage(
							iconImg,
							centerX - iconSize / 2,
							centerY - iconSize / 2,
							iconSize,
							iconSize
						);
						resolve();
					};
					iconImg.onerror = reject;
				});
			}
		} else {
			// Draw a dot
			const dotRadius = 4 * scale;
			ctx.fillStyle = resolvedIconColor;
			ctx.beginPath();
			ctx.arc(centerX, centerY, dotRadius, 0, 2 * Math.PI);
			ctx.fill();
		}

		// Convert canvas to image
		return new Promise((resolve, reject) => {
			canvas.toBlob((blob) => {
				if (!blob) {
					reject(new Error('Failed to create image blob'));
					return;
				}
				
				const img = new Image();
				img.onload = () => resolve(img);
				img.onerror = reject;
				img.src = URL.createObjectURL(blob);
			});
		});
	}

	private createGeoJSONFeatures(markers: MapMarker[]): GeoJSON.Feature[] {
		return markers.map((markerData, index) => {
			const [lat, lng] = markerData.coordinates;
			const icon = this.getCustomIcon(markerData.entry);
			const color = this.getCustomColor(markerData.entry) || 'var(--bases-map-marker-background)';
			const compositeKey = this.getCompositeImageKey(icon, color);

			const properties: MapMarkerProperties = {
				entryIndex: index,
				icon: compositeKey, // Use composite image key
			};

			return {
				type: 'Feature',
				geometry: {
					type: 'Point',
					coordinates: [lng, lat],
				},
				properties,
			};
		});
	}

	private addMarkerLayers(): void {
		if (!this.map) return;

		// Add a single symbol layer for composite marker images
		this.map.addLayer({
			id: 'marker-pins',
			type: 'symbol',
			source: 'markers',
			layout: {
				'icon-image': ['get', 'icon'],
				'icon-size': [
					'interpolate',
					['linear'],
					['zoom'],
					0, 0.12,   // Very small
					4, 0.18,
					14, 0.22,  // Normal size
					18, 0.24
				],
				'icon-allow-overlap': true,
				'icon-ignore-placement': true,
				'icon-padding': 0,
			},
		});
	}

	private setupMarkerInteractions(): void {
		if (!this.map) return;

		// Change cursor on hover
		this.map.on('mouseenter', 'marker-pins', () => {
			if (this.map) this.map.getCanvas().style.cursor = 'pointer';
		});

		this.map.on('mouseleave', 'marker-pins', () => {
			if (this.map) this.map.getCanvas().style.cursor = '';
		});

		// Handle hover to show popup
		this.map.on('mouseenter', 'marker-pins', (e: MapLayerMouseEvent) => {
			if (!e.features || e.features.length === 0) return;
			const feature = e.features[0];
			const entryIndex = feature.properties?.entryIndex;
			if (entryIndex !== undefined && this.markers[entryIndex]) {
				const markerData = this.markers[entryIndex];
				this.showPopup(markerData.entry, markerData.coordinates);
			}
		});

		// Handle mouseleave to hide popup
		this.map.on('mouseleave', 'marker-pins', () => {
			this.hidePopup();
		});

		// Handle click to open file
		this.map.on('click', 'marker-pins', (e: MapLayerMouseEvent) => {
			if (!e.features || e.features.length === 0) return;
			const feature = e.features[0];
			const entryIndex = feature.properties?.entryIndex;
			if (entryIndex !== undefined && this.markers[entryIndex]) {
				const markerData = this.markers[entryIndex];
				void this.app.workspace.openLinkText(
					markerData.entry.file.path,
					'',
					Keymap.isModEvent(e.originalEvent)
				);
			}
		});

		// Handle right-click context menu
		this.map.on('contextmenu', 'marker-pins', (e: MapLayerMouseEvent) => {
			e.preventDefault();
			if (!e.features || e.features.length === 0) return;
			
			const feature = e.features[0];
			const entryIndex = feature.properties?.entryIndex;
			if (entryIndex !== undefined && this.markers[entryIndex]) {
				const markerData = this.markers[entryIndex];
				const [lat, lng] = markerData.coordinates;
				const file = markerData.entry.file;
				
				const menu = Menu.forEvent(e.originalEvent);
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
			}
		});

		// Handle hover for link preview - similar to cards view
		this.map.on('mouseover', 'marker-pins', (e: MapLayerMouseEvent) => {
			if (!e.features || e.features.length === 0) return;
			const feature = e.features[0];
			const entryIndex = feature.properties?.entryIndex;
			if (entryIndex !== undefined && this.markers[entryIndex]) {
				const markerData = this.markers[entryIndex];
				this.app.workspace.trigger('hover-link', {
					event: e.originalEvent,
					source: 'bases',
					hoverParent: this.app.renderContext,
					targetEl: this.mapEl,
					linktext: markerData.entry.file.path,
				});
			}
		});
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

		// Only show popup if there are properties to display
		if (!this.data.properties || this.data.properties.length === 0 || !this.hasAnyPropertyValues(entry)) {
			return;
		}

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
