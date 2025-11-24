import {
	BasesView,
	BasesPropertyId,
	debounce,
	Menu,
	QueryController,
	Value,
	StringValue,
	NullValue,
	ViewOption,
} from 'obsidian';
import { LngLatLike, Map, setRTLTextPlugin } from 'maplibre-gl';
import type ObsidianMapsPlugin from './main';
import { DEFAULT_MAP_HEIGHT, DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM } from './map/constants';
import { CustomZoomControl } from './map/controls/zoom-control';
import { BackgroundSwitcherControl } from './map/controls/background-switcher';
import { StyleManager } from './map/style';
import { PopupManager } from './map/popup';
import { MarkerManager } from './map/markers';
import { hasOwnProperty, coordinateFromValue } from './map/utils';
import { rtlPluginCode } from './map/rtl-plugin-code';

interface MapConfig {
	coordinatesProp: BasesPropertyId | null;
	markerIconProp: BasesPropertyId | null;
	markerColorProp: BasesPropertyId | null;
	mapHeight: number;
	defaultZoom: number;
	center: [number, number];
	maxZoom: number;
	minZoom: number;
	mapTiles: string[];
	mapTilesDark: string[];
	currentTileSetId: string | null;
}

export const MapViewType = 'map';

export class MapView extends BasesView {
	type = MapViewType;
	scrollEl: HTMLElement;
	containerEl: HTMLElement;
	mapEl: HTMLElement;
	plugin: ObsidianMapsPlugin;

	// Internal rendering data
	private map: Map | null = null;
	private mapConfig: MapConfig | null = null;
	private pendingMapState: { center?: LngLatLike, zoom?: number } | null = null;
	private isFirstLoad = true;
	private lastConfigSnapshot: string | null = null;
	private lastEvaluatedCenter: [number, number] = DEFAULT_MAP_CENTER;

	// Managers
	private styleManager: StyleManager;
	private popupManager: PopupManager;
	private markerManager: MarkerManager;

	// Static flag to track RTL plugin initialization
	private static rtlPluginInitialized = false;

	constructor(controller: QueryController, scrollEl: HTMLElement, plugin: ObsidianMapsPlugin) {
		super(controller);
		this.scrollEl = scrollEl;
		this.plugin = plugin;
		this.containerEl = scrollEl.createDiv({ cls: 'bases-map-container is-loading', attr: { tabIndex: 0 } });
		this.mapEl = this.containerEl.createDiv('bases-map');

		// Initialize managers
		this.styleManager = new StyleManager(this.app);
		this.popupManager = new PopupManager(this.containerEl, this.app);
		this.markerManager = new MarkerManager(
			this.app,
			this.mapEl,
			this.popupManager,
			(path, newLeaf) => void this.app.workspace.openLinkText(path, '', newLeaf),
			() => this.data,
			() => this.mapConfig,
			(prop) => this.config.getDisplayName(prop)
		);
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
		if (!this.map || !this.mapConfig) return;
		const newStyle = await this.styleManager.getMapStyle(this.mapConfig.mapTiles, this.mapConfig.mapTilesDark);
		this.map.setStyle(newStyle);
		this.markerManager.clearLoadedIcons();

		// Re-add markers after style change since setStyle removes all runtime layers
		this.map.once('styledata', () => {
			void this.markerManager.updateMarkers(this.data);
		});
	}

	private async switchToTileSet(tileSetId: string): Promise<void> {
		const tileSet = this.plugin.settings.tileSets.find(ts => ts.id === tileSetId);
		if (!tileSet || !this.mapConfig) return;

		this.mapConfig.currentTileSetId = tileSetId;

		// Update the current tiles
		this.mapConfig.mapTiles = tileSet.lightTiles ? [tileSet.lightTiles] : [];
		this.mapConfig.mapTilesDark = tileSet.darkTiles
			? [tileSet.darkTiles]
			: (tileSet.lightTiles ? [tileSet.lightTiles] : []);

		// Update the map style
		await this.updateMapStyle();
	}

	private async initializeMap(): Promise<void> {
		if (this.map) return;

		// Initialize RTL text plugin once
		if (!MapView.rtlPluginInitialized) {
			try {
				// Create a blob URL from the bundled RTL plugin code
				// The plugin needs to run in a worker context
				const blob = new Blob([rtlPluginCode], { type: 'application/javascript' });
				const blobURL = URL.createObjectURL(blob);
				// Set lazy loading to false - plugin is initialized since code is already bundled
				setRTLTextPlugin(blobURL, false);
				MapView.rtlPluginInitialized = true;
			} catch (error) {
				console.warn('Failed to initialize RTL text plugin:', error);
			}
		}

		// Load config first
		const currentTileSetId = this.mapConfig?.currentTileSetId || null;
		this.mapConfig = this.loadConfig(currentTileSetId);

		// Set initial map height based on context
		const isEmbedded = this.isEmbedded();
		if (isEmbedded) {
			this.mapEl.style.height = this.mapConfig.mapHeight + 'px';
		}
		else {
			// Let CSS handle the height for direct base file views
			this.mapEl.style.height = '';
		}

		// Get the map style (may involve fetching remote style JSON)
		const mapStyle = await this.styleManager.getMapStyle(this.mapConfig.mapTiles, this.mapConfig.mapTilesDark);

		// Determine initial position: prefer ephemeral state if available, otherwise use config
		let initialCenter: [number, number] = [this.mapConfig.center[1], this.mapConfig.center[0]]; // MapLibre uses [lng, lat]
		let initialZoom = this.mapConfig.defaultZoom;

		// Capture if we are starting with a pending state restoration
		const isRestoringState = this.pendingMapState !== null;

		if (this.pendingMapState) {
			if (this.pendingMapState.center) {
				const c = this.pendingMapState.center;
				// Handle LngLatLike (array or object)
				if (Array.isArray(c)) {
					initialCenter = [c[0], c[1]];
				} else if (typeof c === 'object' && 'lng' in c && 'lat' in c) {
					initialCenter = [c.lng, c.lat];
				}
			}
			if (this.pendingMapState.zoom !== undefined && this.pendingMapState.zoom !== null) {
				initialZoom = this.pendingMapState.zoom;
			}
		}

		// Initialize MapLibre GL JS map with configured tiles or default style
		this.map = new Map({
			container: this.mapEl,
			style: mapStyle,
			center: initialCenter,
			zoom: initialZoom,
			minZoom: this.mapConfig.minZoom,
			maxZoom: this.mapConfig.maxZoom,
		});

		// Set map reference in managers
		this.popupManager.setMap(this.map);
		this.markerManager.setMap(this.map);

		this.map.addControl(new CustomZoomControl(), 'top-right');

		// Add background switcher if multiple tile sets are available
		if (this.plugin.settings.tileSets.length > 1) {
			const currentId = this.mapConfig.currentTileSetId || this.plugin.settings.tileSets[0]?.id || '';
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
			if (!this.map || !this.mapConfig) return;

			// If we were restoring state, do not reset to defaults
			if (isRestoringState || this.pendingMapState) return;

			const hasConfiguredCenter = this.mapConfig.center[0] !== 0 || this.mapConfig.center[1] !== 0;
			const hasConfiguredZoom = this.config.get('defaultZoom') && Number.isNumber(this.config.get('defaultZoom'));

			// Set center based on configuration
			if (hasConfiguredCenter) {
				this.map.setCenter([this.mapConfig.center[1], this.mapConfig.center[0]]); // MapLibre uses [lng, lat]
			}
			else {
				const bounds = this.markerManager.getBounds();
				if (bounds) {
					this.map.setCenter(bounds.getCenter()); // Center on markers
				}
			}

			// Set zoom based on configuration
			if (hasConfiguredZoom) {
				this.map.setZoom(this.mapConfig.defaultZoom); // Use configured zoom
			}
			else {
				const bounds = this.markerManager.getBounds();
				if (bounds) {
					this.map.fitBounds(bounds, { padding: 20 }); // Fit all markers
				}
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
		this.popupManager.destroy();
		if (this.map) {
			this.map.remove();
			this.map = null;
		}
		this.markerManager.setMap(null);
	}

	public onDataUpdated(): void {
		this.containerEl.removeClass('is-loading');

		const configSnapshot = this.getConfigSnapshot();
		const configChanged = this.lastConfigSnapshot !== configSnapshot;

		const currentTileSetId = this.mapConfig?.currentTileSetId || null;
		this.mapConfig = this.loadConfig(currentTileSetId);

		// Check if the evaluated center coordinates have changed
		const centerChanged = this.mapConfig.center[0] !== this.lastEvaluatedCenter[0] ||
			this.mapConfig.center[1] !== this.lastEvaluatedCenter[1];

		void this.initializeMap().then(async () => {
			// Apply config to map on first load or when config changes
			if (configChanged) {
				await this.applyConfigToMap(this.lastConfigSnapshot, configSnapshot);
				this.lastConfigSnapshot = configSnapshot;
				this.isFirstLoad = false;
			}
			// Update center when the evaluated center coordinates change
			// (e.g., due to formula re-evaluation when active file changes)
			// But skip if we're restoring ephemeral state
			else if (this.map && !this.isFirstLoad && centerChanged && this.pendingMapState === null) {
				this.updateCenter();
			}

			if (this.map && this.data) {
				await this.markerManager.updateMarkers(this.data);

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

			// Track state for next comparison
			if (this.mapConfig) {
				this.lastEvaluatedCenter = [this.mapConfig.center[0], this.mapConfig.center[1]];
			}
		});
	}

	private updateZoom(): void {
		if (!this.map || !this.mapConfig) return;

		const hasConfiguredZoom = this.config.get('defaultZoom') != null;
		if (hasConfiguredZoom) {
			this.map.setZoom(this.mapConfig.defaultZoom);
		}
	}

	private updateCenter(): void {
		if (!this.map || !this.mapConfig) return;

		const hasConfiguredCenter = this.mapConfig.center[0] !== 0 || this.mapConfig.center[1] !== 0;
		if (hasConfiguredCenter) {
			// Only recenter if the evaluated coordinates actually changed
			const currentCenter = this.map.getCenter();
			if (!currentCenter) return; // Map not fully initialized yet

			const targetCenter: [number, number] = [this.mapConfig.center[1], this.mapConfig.center[0]]; // MapLibre uses [lng, lat]
			const centerActuallyChanged = Math.abs(currentCenter.lng - targetCenter[0]) > 0.00001 ||
				Math.abs(currentCenter.lat - targetCenter[1]) > 0.00001;
			if (centerActuallyChanged) {
				this.map.setCenter(targetCenter);
			}
		}
	}

	private async applyConfigToMap(oldSnapshot: string | null, newSnapshot: string): Promise<void> {
		if (!this.map || !this.mapConfig) return;

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
		this.map.setMinZoom(this.mapConfig.minZoom);
		this.map.setMaxZoom(this.mapConfig.maxZoom);

		// Clamp current zoom to new min/max bounds
		const currentZoom = this.map.getZoom();
		if (currentZoom < this.mapConfig.minZoom) {
			this.map.setZoom(this.mapConfig.minZoom);
		} else if (currentZoom > this.mapConfig.maxZoom) {
			this.map.setZoom(this.mapConfig.maxZoom);
		}

		// Skip updating zoom/center if we have pending ephemeral state to restore
		// (e.g., when navigating back in history to restore the user's last pan/zoom)
		const hasEphemeralState = this.pendingMapState !== null;

		// Only update zoom on first load or when zoom config explicitly changed
		// But skip if we're restoring ephemeral state
		if (!hasEphemeralState && (this.isFirstLoad || zoomConfigChanged)) {
			this.updateZoom();
		}

		// Update center on first load or when center config changed
		// But skip if we're restoring ephemeral state
		if (!hasEphemeralState && (this.isFirstLoad || centerConfigChanged)) {
			this.updateCenter();
		}

		// Update map style if tiles configuration changed
		if (this.isFirstLoad || tilesChanged) {
			const newStyle = await this.styleManager.getMapStyle(this.mapConfig.mapTiles, this.mapConfig.mapTilesDark);
			const currentStyle = this.map.getStyle();
			if (JSON.stringify(newStyle) !== JSON.stringify(currentStyle)) {
				this.map.setStyle(newStyle);
				this.markerManager.clearLoadedIcons();
			}
		}

		// Update map height for embedded views if height changed
		if (this.isFirstLoad || heightChanged) {
			if (this.isEmbedded()) {
				this.mapEl.style.height = this.mapConfig.mapHeight + 'px';
			}
			else {
				this.mapEl.style.height = '';
			}
			// Resize map after height changes
			this.map.resize();
		}
	}

	isEmbedded(): boolean {
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

	private loadConfig(currentTileSetId: string | null): MapConfig {
		// Load property configurations
		const coordinatesProp = this.config.getAsPropertyId('coordinates');
		const markerIconProp = this.config.getAsPropertyId('markerIcon');
		const markerColorProp = this.config.getAsPropertyId('markerColor');

		// Load numeric configurations with validation
		const minZoom = this.getNumericConfig('minZoom', 0, 0, 24);
		const maxZoom = this.getNumericConfig('maxZoom', 18, 0, 24);
		const defaultZoom = this.getNumericConfig('defaultZoom', DEFAULT_MAP_ZOOM, minZoom, maxZoom);

		// Load center coordinates
		const center = this.getCenterFromConfig();

		// Load map height for embedded views
		const mapHeight = this.isEmbedded()
			? this.getNumericConfig('mapHeight', DEFAULT_MAP_HEIGHT, 100, 2000)
			: DEFAULT_MAP_HEIGHT;

		// Load map tiles configurations
		// Use view-specific tiles if configured, otherwise fall back to plugin defaults
		const viewSpecificTiles = this.getArrayConfig('mapTiles');
		const viewSpecificTilesDark = this.getArrayConfig('mapTilesDark');

		let mapTiles: string[];
		let mapTilesDark: string[];
		let selectedTileSetId: string | null;

		if (viewSpecificTiles.length > 0) {
			// View has specific tiles configured
			mapTiles = viewSpecificTiles;
			mapTilesDark = viewSpecificTilesDark;
			selectedTileSetId = null;
		} else if (this.plugin.settings.tileSets.length > 0) {
			// Use first tile set from plugin settings (or previously selected one)
			const tileSet = currentTileSetId
				? this.plugin.settings.tileSets.find(ts => ts.id === currentTileSetId)
				: null;
			const selectedTileSet = tileSet || this.plugin.settings.tileSets[0];

			selectedTileSetId = selectedTileSet.id;
			mapTiles = selectedTileSet.lightTiles ? [selectedTileSet.lightTiles] : [];
			mapTilesDark = selectedTileSet.darkTiles
				? [selectedTileSet.darkTiles]
				: (selectedTileSet.lightTiles ? [selectedTileSet.lightTiles] : []);
		} else {
			// No tiles configured, will fall back to default style
			mapTiles = [];
			mapTilesDark = [];
			selectedTileSetId = null;
		}

		return {
			coordinatesProp,
			markerIconProp,
			markerColorProp,
			mapHeight,
			defaultZoom,
			center,
			maxZoom,
			minZoom,
			mapTiles,
			mapTilesDark,
			currentTileSetId: selectedTileSetId,
		};
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
		return coordinateFromValue(centerConfig) || DEFAULT_MAP_CENTER;
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

	private showMapContextMenu(evt: MouseEvent): void {
		if (!this.map || !this.mapConfig) return;

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
					if (this.mapConfig?.coordinatesProp) {
						// Remove 'note.' prefix if present
						const propertyKey = this.mapConfig.coordinatesProp.startsWith('note.')
							? this.mapConfig.coordinatesProp.slice(5)
							: this.mapConfig.coordinatesProp;
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
				if (this.mapConfig) {
					this.mapConfig.center = [currentLat, currentLng];
				}

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
