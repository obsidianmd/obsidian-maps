import {
	BasesEntry,
	BasesPropertyId,
	BasesView,
	Keymap,
	ListValue,
	Menu,
	NumberValue,
	QueryController,
	StringValue,
	ViewOption,
	isDelegatedMouseover,
	setIcon,
} from 'obsidian';
import * as maplibregl from 'maplibre-gl';

export const MapViewType = 'map';

const DEFAULT_MAP_HEIGHT = 400;
const DEFAULT_MAP_CENTER: [number, number] = [0, 0];
const DEFAULT_MAP_ZOOM = 4;

interface MapMarker {
	entry: BasesEntry;
	marker: maplibregl.Marker;
	coordinates: [number, number];
}

class CustomZoomControl {
	private container: HTMLElement;
	private map: maplibregl.Map;

	onAdd(map: maplibregl.Map): HTMLElement {
		this.map = map;
		this.container = createDiv('maplibregl-ctrl maplibregl-ctrl-group');

		const zoomInButton = this.container.createEl('button', {
			type: 'button',
			cls: 'maplibregl-ctrl-zoom-in',
			attr: { 'aria-label': 'Zoom in' }
		});
		setIcon(zoomInButton, 'lucide-plus');

		zoomInButton.addEventListener('click', () => {
			this.map.zoomIn();
		});

		const zoomOutButton = this.container.createEl('button', {
			type: 'button',
			cls: 'maplibregl-ctrl-zoom-out',
			attr: { 'aria-label': 'Zoom out' }
		});
		setIcon(zoomOutButton, 'lucide-minus');

		zoomOutButton.addEventListener('click', () => {
			this.map.zoomOut();
		});

		return this.container;
	}

	onRemove(): void {
		if (this.container && this.container.parentNode) {
			this.container.parentNode.removeChild(this.container);
		}
		this.map = undefined;
	}
}

export class MapView extends BasesView {
	type = MapViewType;
	scrollEl: HTMLElement;
	containerEl: HTMLElement;
	mapEl: HTMLElement;

	// Internal rendering data
	private map: maplibregl.Map | null = null;
	private markers: MapMarker[] = [];
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
	private pendingMapState: { center: any, zoom: number } | null = null;
	private sharedPopup: maplibregl.Popup | null = null;
	private popupHideTimeout: number | null = null;

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

	onResize(): void {
		if (this.map) {
			this.map.resize();
		}
	}

	public focus(): void {
		this.containerEl.focus({ preventScroll: true });
	}

	private onThemeChange = (): void => {
		if (this.map && (this.mapTiles.length > 0 || this.mapTilesDark.length > 0)) {
			// Update map style when theme changes
			const newStyle = this.getMapStyle();
			this.map.setStyle(newStyle as any);
		}
	};

	private initializeMap(): void {
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

		// Initialize MapLibre GL JS map with configured tiles or default style
		this.map = new maplibregl.Map({
			container: this.mapEl,
			style: this.getMapStyle() as any,
			center: [this.center[1], this.center[0]], // MapLibre uses [lng, lat]
			zoom: this.defaultZoom,
			minZoom: this.minZoom,
			maxZoom: this.maxZoom,
		});

		this.map.addControl(new CustomZoomControl(), 'top-right');

		// Ensure the center is set after map loads (in case the style loading overrides it)
		this.map.on('load', () => {
			// Only set center if we have non-default coordinates
			if (this.center[0] !== 0 || this.center[1] !== 0) {
				this.map.setCenter([this.center[1], this.center[0]]); // MapLibre uses [lng, lat]
			}
		});

		// Remove aria-label from the map element, otherwise it shows a tooltip
		const mapCanvas = this.mapEl.querySelector('canvas');
		if (mapCanvas) {
			mapCanvas.removeAttribute('aria-label');
		}

		// Add context menu to map
		this.mapEl.addEventListener('contextmenu', (evt) => {
			evt.preventDefault();
			this.showMapContextMenu(evt);
		});

		if (this.data) {
			this.updateMarkers();
		}
	}

	private destroyMap(): void {
		if (this.popupHideTimeout) {
			clearTimeout(this.popupHideTimeout);
			this.popupHideTimeout = null;
		}
		if (this.sharedPopup) {
			this.sharedPopup.remove();
			this.sharedPopup = null;
		}
		if (this.map) {
			this.map.remove();
			this.map = null;
		}
		this.markers = [];
	}

	public onDataUpdated(): void {
		this.containerEl.removeClass('is-loading');
		this.loadConfig();
		this.initializeMap();
		this.display();
	}

	private display() {
		if (this.map) {
			this.updateMarkers();
		}
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

		// Apply configurations to existing map
		this.applyConfigToMap();
	}

	private getNumericConfig(key: string, defaultValue: number, min?: number, max?: number): number {
		const value = this.config.get(key);
		if (!value || !Number.isNumber(value)) return defaultValue;

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
		const centerConfig = this.config.get('center');
		if (!centerConfig || !String.isString(centerConfig)) {
			return DEFAULT_MAP_CENTER;
		}

		const parts = centerConfig.trim().split(',');
		if (parts.length >= 2) {
			const lat = parseFloat(parts[0].trim());
			const lng = parseFloat(parts[1].trim());
			if (!isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180) {
				return [lat, lng];
			}
		}
		return DEFAULT_MAP_CENTER;
	}

	private applyConfigToMap(): void {
		if (!this.map) return;

		// Update map constraints
		this.map.setMinZoom(this.minZoom);
		this.map.setMaxZoom(this.maxZoom);

		// Update map style if tiles configuration changed
		const newStyle = this.getMapStyle();
		const currentStyle = this.map.getStyle();
		if (JSON.stringify(newStyle) !== JSON.stringify(currentStyle)) {
			this.map.setStyle(newStyle as any);
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


	private getMapStyle(): string | object {
		const isDark = this.app.customCss.isDarkMode();
		const tileUrls = isDark && this.mapTilesDark.length > 0 ? this.mapTilesDark : this.mapTiles;

		// If no custom tiles are configured, use default OpenFreeMap style
		if (tileUrls.length === 0) {
			return 'https://tiles.openfreemap.org/styles/bright';
		}

		// Create a custom style with the configured tile sources
		return this.createCustomMapStyle(tileUrls);
	}

	private createCustomMapStyle(tileUrls: string[]): object {
		const sources: any = {};
		const layers: any[] = [];

		tileUrls.forEach((tileUrl, index) => {
			const sourceId = `custom-tiles-${index}`;
			sources[sourceId] = {
				type: 'raster',
				tiles: [tileUrl],
				tileSize: 256
			};

			layers.push({
				id: `custom-layer-${index}`,
				type: 'raster',
				source: sourceId
			});
		});

		return {
			version: 8,
			sources,
			layers
		};
	}

	private showMapContextMenu(evt: MouseEvent): void {
		if (!this.map) return;

		const currentZoom = Math.round(this.map.getZoom() * 10) / 10; // Round to 1 decimal place

		// Get coordinates from the location of the right-click event, not the map center
		const clickPoint: [number, number] = [evt.offsetX, evt.offsetY];
		const clickedCoords = this.map.unproject(clickPoint);
		const currentLat = Math.round(clickedCoords.lat * 100000) / 100000;
		const currentLng = Math.round(clickedCoords.lng * 100000) / 100000;

		const menu = Menu.forEvent(evt).addSections([
			'action',
		]);

		menu.addItem(item => item
			.setTitle('Copy coordinates')
			.setSection('action')
			.setIcon('lucide-copy')
			.onClick(() => {
				const coordString = `${currentLat}, ${currentLng}`;
				void navigator.clipboard.writeText(coordString);
			})
		);

		menu.addItem(item => item
			.setTitle('Set default center point')
			.setSection('action')
			.setIcon('lucide-map-pin')
			.onClick(() => {
				// Set the current center as the default coordinates
				const coordString = `${currentLat}, ${currentLng}`;

				// 1. Update the component's internal state immediately.
				// This ensures that if a re-render is triggered, its logic will use the
				// new coordinates and prevent the map from recentering on markers.
				this.center = [currentLat, currentLng];

				// 2. Set the config value, which will be saved.
				this.config.set('center', coordString);

				// 3. Immediately move the map for instant user feedback.
				this.map.setCenter([currentLng, currentLat]); // MapLibre uses [lng, lat]
			})
		);

		menu.addItem(item => item
			.setTitle(`Set default zoom (${currentZoom})`)
			.setSection('action')
			.setIcon('lucide-crosshair')
			.onClick(() => {
				this.config.set('defaultZoom', currentZoom);
			})
		);
	}

	private updateMarkers(): void {
		if (!this.map || !this.data || !this.coordinatesProp) {
			this.clearMarkers();
			return;
		}

		// Clear existing markers
		this.clearMarkers();

		// Create markers for entries with valid coordinates
		this.createMarkersFromData();

		// Update map view based on markers
		this.updateMapView();

		// Apply pending map state if available
		this.applyPendingMapState();
	}

	private createMarkersFromData(): void {
		const validMarkers: MapMarker[] = [];

		for (const entry of this.data.data) {
			const coordinates = this.extractCoordinates(entry);
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

		this.markers = validMarkers;
	}

	private updateMapView(): void {
		if (!this.map) return;

		const hasConfiguredCenter = this.center[0] !== 0 || this.center[1] !== 0;
		const hasConfiguredZoom = this.config.get('defaultZoom') && Number.isNumber(this.config.get('defaultZoom'));

		if (this.markers.length === 0) {
			// No markers - use configured defaults
			this.map.setCenter([this.center[1], this.center[0]]); // MapLibre uses [lng, lat]
			this.map.setZoom(this.defaultZoom);
			return;
		}

		// Calculate bounds for all markers
		const bounds = new maplibregl.LngLatBounds();
		this.markers.forEach(markerData => {
			const [lat, lng] = markerData.coordinates;
			bounds.extend([lng, lat]);
		});

		// Set center based on configuration
		if (hasConfiguredCenter) {
			this.map.setCenter([this.center[1], this.center[0]]); // Use configured center
		}
		else {
			this.map.setCenter(bounds.getCenter()); // Center on markers
		}

		// Set zoom based on configuration
		if (hasConfiguredZoom) {
			this.map.setZoom(this.defaultZoom); // Use configured zoom
		}
		else {
			this.map.fitBounds(bounds, { padding: 20 }); // Fit all markers
		}
	}

	private applyPendingMapState(): void {
		if (this.pendingMapState && this.map) {
			const { center, zoom } = this.pendingMapState;
			if (center) {
				this.map.setCenter(center);
			}
			if (typeof zoom === 'number') {
				this.map.setZoom(zoom);
			}
			this.pendingMapState = null;
		}
	}

	private extractCoordinates(entry: BasesEntry): [number, number] | null {
		if (!this.coordinatesProp) return null;

		try {
			const value = entry.getValue(this.coordinatesProp);

			if (!value) return null;

			// Handle list values (e.g., ["34.1395597", "-118.3870991"])
			if (value instanceof ListValue) {
				if (value.length() >= 2) {
					const lat = this.parseCoordinate(value.get(0));
					const lng = this.parseCoordinate(value.get(1));
					if (lat !== null && lng !== null) {
						return [lat, lng];
					}
				}
			}
			// Handle string values (e.g., "34.1395597,-118.3870991")
			else if (value instanceof StringValue) {
				const stringData = value.toString();
				const parts = stringData.split(',');
				if (parts.length >= 2) {
					const lat = this.parseCoordinate(parts[0].trim());
					const lng = this.parseCoordinate(parts[1].trim());
					if (lat !== null && lng !== null) {
						return [lat, lng];
					}
				}
			}
		}
		catch (error) {
			console.error(`Error extracting coordinates for ${entry.file.name}:`, error);
		}

		return null;
	}

	private parseCoordinate(value: any): number | null {
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
			if (!value) return null;

			// Extract the color value from the property
			const colorString = value.toString().trim();

			// Handle null/empty/invalid cases - return null to use default CSS variable
			if (!colorString || colorString.length === 0 || colorString === 'null' || colorString === 'undefined') {
				return null;
			}

			// Return the color as-is, let CSS handle validation
			// Supports: hex (#ff0000), rgb/rgba, hsl/hsla, CSS color names, and CSS custom properties (var(--color-name))
			return colorString;
		}
		catch (error) {
			console.error(`Error extracting color for ${entry.file.name}:`, error);
			return null;
		}
	}

	private createMarker(entry: BasesEntry, coordinates: [number, number]): maplibregl.Marker | null {
		if (!this.map) return null;

		const [lat, lng] = coordinates;

		// Get custom icon and color if configured
		const customIcon = this.getCustomIcon(entry);
		const customColor = this.getCustomColor(entry);

		let marker: maplibregl.Marker;

		const markerContainer = createDiv('bases-map-custom-marker');

		const shadowDiv = createDiv('bases-map-marker-shadow');
		markerContainer.appendChild(shadowDiv);

		const pinDiv = createDiv('bases-map-marker-pin');
		markerContainer.appendChild(pinDiv);

		const pinOutlineDiv = createDiv('bases-map-marker-pin-outline');
		markerContainer.appendChild(pinOutlineDiv);

		if (customColor) {
			pinDiv.style.setProperty('--marker-color', customColor);
		}

		if (this.markerIconProp && customIcon) {
			const iconElement = createDiv('bases-map-marker-icon');
			setIcon(iconElement, customIcon as any);
			markerContainer.appendChild(iconElement);
		}
		else {
			const dotElement = createDiv('bases-map-marker-dot');
			markerContainer.appendChild(dotElement);
		}

		marker = new maplibregl.Marker({
			element: markerContainer
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
			// Don't block external links
			const target = evt.target as Element;
			if (target?.closest && target.closest('a')) return;

			void this.app.workspace.openLinkText(entry.file.path, '', Keymap.isModEvent(evt));
		});


		markerEl.addEventListener('contextmenu', (evt) => {
			const file = entry.file;
			const menu = Menu.forEvent(evt).addSections([
				'title',
				'open',
				'action-primary',
				'action',
				'info',
				'view',
				'system',
				'',
				'danger'
			]);

			this.app.workspace.handleLinkContextMenu(menu, file.path, '');

			// Add copy coordinates option
			menu.addItem(item => item
				.setSection('action')
				.setTitle('Copy coordinates')
				.setIcon('lucide-map-pin')
				.onClick(() => {
					const coordString = `${lat}, ${lng}`;
					void navigator.clipboard.writeText(coordString);
				}));

			menu.addItem(item => item
				.setSection('danger')
				.setTitle('Delete file')
				.setIcon('lucide-trash-2')
				.setWarning(true)
				.onClick(() => this.app.fileManager.promptForFileDeletion(file)));
		});

		// Handle hover for link preview - similar to cards view
		markerEl.addEventListener('mouseover', (evt) => {
			if (!isDelegatedMouseover(evt, markerEl)) return;
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
		const container = createDiv('bases-map-popup');

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
			const title = container.createDiv('bases-map-popup-title');

			// Create a clickable link that opens the file
			const titleLink = title.createEl('a', {
				href: '#',
				cls: 'internal-link'
			});

			// Render the first property value inside the link
			firstProperty.value.renderTo(titleLink, this.app.renderContext);

			// Handle click to open file
			titleLink.addEventListener('click', (evt) => {
				evt.preventDefault();
				void this.app.workspace.openLinkText(entry.file.path, '', Keymap.isModEvent(evt));
			});

			// Show remaining properties (excluding the first one used as title)
			const remainingProperties = propertiesWithValues.slice(1);
			if (remainingProperties.length > 0) {
				const propContainer = container.createDiv('bases-map-popup-properties');
				for (const { prop, value } of remainingProperties) {
					const propEl = propContainer.createDiv('bases-map-popup-property');
					const labelEl = propEl.createDiv('bases-map-popup-property-label');
					labelEl.textContent = this.config.getDisplayName(prop);
					const valueEl = propEl.createDiv('bases-map-popup-property-value');
					value.renderTo(valueEl, this.app.renderContext);
				}
			}
		}

		return container;
	}

	private hasNonEmptyValue(value: any): boolean {
		if (!value) return false;

		const stringValue = value.toString().trim();
		if (!stringValue) return false;

		// Check for common empty values
		if (stringValue === '[]' || stringValue === '{}' || stringValue === 'null' || stringValue === 'undefined') {
			return false;
		}

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

	private clearMarkers(): void {
		for (const markerData of this.markers) {
			markerData.marker.remove();
		}
		this.markers = [];
	}

	private showPopup(entry: BasesEntry, coordinates: [number, number]): void {
		if (!this.map) return;

		// Clear any pending hide timeout
		if (this.popupHideTimeout) {
			clearTimeout(this.popupHideTimeout);
			this.popupHideTimeout = null;
		}

		// Create shared popup if it doesn't exist
		if (!this.sharedPopup) {
			this.sharedPopup = new maplibregl.Popup({
				closeButton: false,
				closeOnClick: false,
				offset: 25
			});

			// Add hover handlers to the popup itself
			this.sharedPopup.on('open', () => {
				const popupEl = this.sharedPopup.getElement();
				if (popupEl) {
					popupEl.addEventListener('mouseenter', () => {
						if (this.popupHideTimeout) {
							clearTimeout(this.popupHideTimeout);
							this.popupHideTimeout = null;
						}
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
		if (this.popupHideTimeout) {
			clearTimeout(this.popupHideTimeout);
		}

		this.popupHideTimeout = window.setTimeout(() => {
			if (this.sharedPopup) {
				this.sharedPopup.remove();
			}
			this.popupHideTimeout = null;
		}, 150); // Small delay to allow moving to popup
	}

	public setEphemeralState(state: any): void {
		// Handle pending map state like table handles pendingScroll
		if (state.mapView && typeof state.mapView === 'object') {
			this.pendingMapState = state.mapView;
		}
	}

	public getEphemeralState(): unknown {
		if (!this.map) return {};

		return {
			mapView: {
				center: this.map.getCenter(),
				zoom: this.map.getZoom(),
			}
		};
	}

	static getViewOptions(): ViewOption[] {
		return [
			{
				displayName: i18nMap.labelMapHeight(),
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
						displayName: i18nMap.labelCenter(),
						type: 'text',
						key: 'center',
						placeholder: '37.75904, -119.02042',
					},
					{
						displayName: i18nMap.labelDefaultZoom(),
						type: 'slider',
						key: 'defaultZoom',
						min: 1,
						max: 18,
						step: 1,
						default: DEFAULT_MAP_ZOOM,
					},
					{
						displayName: i18nMap.labelMinZoom(),
						type: 'slider',
						key: 'minZoom',
						min: 0,
						max: 24,
						step: 1,
						default: 0,
					},
					{
						displayName: i18nMap.labelMaxZoom(),
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
						displayName: i18nMap.labelCoordinatesProperty(),
						type: 'property',
						key: 'coordinates',
						filter: prop => !prop.startsWith('file.'),
						placeholder: i18n.plugins.bases.labelPropertyKey(),
					},
					{
						displayName: i18nMap.labelIconProperty(),
						type: 'property',
						key: 'markerIcon',
						filter: prop => !prop.startsWith('file.'),
						placeholder: i18n.plugins.bases.labelPropertyKey(),
					},
					{
						displayName: i18nMap.labelColorProperty(),
						type: 'property',
						key: 'markerColor',
						filter: prop => !prop.startsWith('file.'),
						placeholder: i18n.plugins.bases.labelPropertyKey(),
					},
				]
			},
			{
				displayName: 'Background',
				type: 'group',
				items: [
					{
						displayName: i18nMap.labelMapTiles(),
						type: 'text',
						key: 'mapTiles',
						placeholder: 'https://',
					},
					{
						displayName: i18nMap.labelMapTilesDark(),
						type: 'text',
						key: 'mapTilesDark',
						placeholder: 'https://',
					},
				]
			},
		];
	}
}
