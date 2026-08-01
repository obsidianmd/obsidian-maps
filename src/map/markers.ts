import { App, BasesEntry, BasesPropertyId, Keymap, Menu, setIcon } from 'obsidian';
import { Map as MapLibreMap, LngLatBounds, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import { MapConfig, MapMarker, MapMarkerProperties } from './types';
import { coordinateFromValue, formatCoordinates, toLngLat } from './utils';
import { PopupManager } from './popup';

const DEFAULT_MARKER_COLOR = 'var(--bases-map-marker-background)';

/** The Bases query results the markers are rendered from. */
interface MarkerData {
	data: BasesEntry[];
	properties?: BasesPropertyId[];
}

export class MarkerManager {
	private map: MapLibreMap | null = null;
	private app: App;
	private mapEl: HTMLElement;
	private markers: MapMarker[] = [];
	private bounds: LngLatBounds | null = null;
	private loadedIcons: Set<string> = new Set();
	// Resolved CSS colors, cleared alongside the icons when the theme changes
	private resolvedColors: Map<string, string> = new Map();
	// Interactions are layer-scoped and survive setStyle, so they bind only once
	private interactionsBound = false;
	private popupManager: PopupManager;
	private onOpenFile: (path: string, newLeaf: boolean) => void;
	private getData: () => MarkerData | null;
	private getMapConfig: () => MapConfig | null;
	private getDisplayName: (prop: BasesPropertyId) => string;

	constructor(
		app: App,
		mapEl: HTMLElement,
		popupManager: PopupManager,
		onOpenFile: (path: string, newLeaf: boolean) => void,
		getData: () => MarkerData | null,
		getMapConfig: () => MapConfig | null,
		getDisplayName: (prop: BasesPropertyId) => string
	) {
		this.app = app;
		this.mapEl = mapEl;
		this.popupManager = popupManager;
		this.onOpenFile = onOpenFile;
		this.getData = getData;
		this.getMapConfig = getMapConfig;
		this.getDisplayName = getDisplayName;
	}

	setMap(map: MapLibreMap | null): void {
		this.map = map;
		// Listeners belong to the map instance, so a new map needs its own
		this.interactionsBound = false;
	}

	getBounds(): LngLatBounds | null {
		return this.bounds;
	}

	clearLoadedIcons(): void {
		this.loadedIcons.clear();
		this.resolvedColors.clear();
	}

	async updateMarkers(data: { data: BasesEntry[] }): Promise<void> {
		const mapConfig = this.getMapConfig();
		if (!this.map || !data || !mapConfig || !mapConfig.coordinatesProp) {
			return;
		}

		// Collect valid marker data
		const validMarkers: MapMarker[] = [];
		for (const entry of data.data) {
			if (!entry) continue;

			let coordinates: [number, number] | null = null;
			try {
				const value = entry.getValue(mapConfig.coordinatesProp);
				coordinates = coordinateFromValue(value);
			}
			catch (error) {
				console.error(`Error extracting coordinates for ${entry.file.name}:`, error);
			}

			if (coordinates) {
				const icon = this.getCustomIcon(entry, mapConfig);
				const color = this.getCustomColor(entry, mapConfig) || DEFAULT_MARKER_COLOR;
				validMarkers.push({
					entry,
					coordinates,
					icon,
					color,
					imageKey: this.getCompositeImageKey(icon, color),
				});
			}
		}

		this.markers = validMarkers;

		// Calculate bounds for all markers
		const bounds = this.bounds = new LngLatBounds();
		validMarkers.forEach(markerData => bounds.extend(toLngLat(markerData.coordinates)));

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
	}

	/** Reads a property as a trimmed string, warning rather than failing when it isn't one. */
	private getStringProp(entry: BasesEntry, prop: BasesPropertyId | null, warning: string): string | null {
		if (!prop) return null;

		try {
			const value = entry.getValue(prop);
			if (!value || !value.isTruthy()) return null;

			return value.toString().trim() || null;
		}
		catch (error) {
			// Log as warning instead of error - this is not critical
			console.warn(`${warning} for ${entry.file.name}`, error);
			return null;
		}
	}

	private getCustomIcon(entry: BasesEntry, mapConfig: MapConfig): string | null {
		const iconString = this.getStringProp(
			entry,
			mapConfig?.markerIconProp ?? null,
			'Could not extract icon. The marker icon property should be a simple text value (e.g., "map", "star"),'
		);

		// Treat stringified empties as absent so the default marker is used
		if (iconString === 'null' || iconString === 'undefined') return null;

		return iconString;
	}

	// Returned as-is, let CSS handle validation. Supports hex (#ff0000), rgb/rgba,
	// hsl/hsla, CSS color names, and custom properties (var(--color-name)).
	private getCustomColor(entry: BasesEntry, mapConfig: MapConfig): string | null {
		return this.getStringProp(
			entry,
			mapConfig?.markerColorProp ?? null,
			'Could not extract color. The marker color property should be a simple text value (e.g., "#ff0000", "red", "var(--color-accent)"),'
		);
	}

	private async loadCustomIcons(markers: MapMarker[]): Promise<void> {
		if (!this.map) return;

		// Collect all unique icon+color combinations that need to be loaded
		const toLoad = new Map<string, { icon: string | null; color: string }>();
		for (const { icon, color, imageKey } of markers) {
			if (this.loadedIcons.has(imageKey) || toLoad.has(imageKey)) continue;
			toLoad.set(imageKey, { icon, color });
		}

		// Build the images concurrently; one bad icon shouldn't hold up the rest
		await Promise.all(Array.from(toLoad, async ([compositeKey, { icon, color }]) => {
			try {
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
		}));
	}

	private getCompositeImageKey(icon: string | null, color: string): string {
		return `marker-${icon || 'dot'}-${color.replace(/[^a-zA-Z0-9]/g, '')}`;
	}

	private resolveColor(color: string): string {
		// getComputedStyle forces a style recalculation, so cache per theme
		const cached = this.resolvedColors.get(color);
		if (cached !== undefined) return cached;

		// Create a temporary element to resolve CSS variables
		const tempEl = document.createElement('div');
		tempEl.style.color = color;
		tempEl.style.display = 'none';
		document.body.appendChild(tempEl);

		// Get the computed color value
		const computedColor = getComputedStyle(tempEl).color;

		// Clean up
		tempEl.remove();

		this.resolvedColors.set(color, computedColor);
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
				const url = URL.createObjectURL(blob);
				// The decoded pixels are retained by the Image, so the blob can go
				img.onload = () => {
					URL.revokeObjectURL(url);
					resolve(img);
				};
				img.onerror = (error) => {
					URL.revokeObjectURL(url);
					reject(error);
				};
				img.src = url;
			});
		});
	}

	private createGeoJSONFeatures(markers: MapMarker[]): GeoJSON.Feature[] {
		return markers.map((markerData, index) => {
			const properties: MapMarkerProperties = {
				entryIndex: index,
				icon: markerData.imageKey, // Use composite image key
			};

			return {
				type: 'Feature',
				geometry: {
					type: 'Point',
					coordinates: toLngLat(markerData.coordinates),
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

	/** Resolves the marker a layer event refers to, or null if it hit nothing known. */
	private markerFromEvent(e: MapLayerMouseEvent): MapMarker | null {
		const entryIndex = e.features?.[0]?.properties?.entryIndex;
		if (entryIndex === undefined) return null;
		return this.markers[entryIndex] ?? null;
	}

	private setupMarkerInteractions(): void {
		// Layers are recreated under the same id after a style change, but these
		// listeners are bound to the map, not the layer, so they outlive it
		if (!this.map || this.interactionsBound) return;
		this.interactionsBound = true;

		// Change cursor on hover
		this.map.on('mouseenter', 'marker-pins', () => {
			if (this.map) this.map.getCanvas().style.cursor = 'pointer';
		});

		this.map.on('mouseleave', 'marker-pins', () => {
			if (this.map) this.map.getCanvas().style.cursor = '';
		});

		// Handle hover to show popup
		this.map.on('mouseenter', 'marker-pins', (e: MapLayerMouseEvent) => {
			const markerData = this.markerFromEvent(e);
			if (!markerData) return;

			const data = this.getData();
			const mapConfig = this.getMapConfig();
			if (!data || !data.properties || !mapConfig) return;

			this.popupManager.showPopup(
				markerData.entry,
				markerData.coordinates,
				data.properties,
				this.getMarkerDrivenProps(mapConfig),
				this.getDisplayName
			);
		});

		// Handle mouseleave to hide popup
		this.map.on('mouseleave', 'marker-pins', () => {
			this.popupManager.hidePopup();
		});

		// Handle click to open file
		this.map.on('click', 'marker-pins', (e: MapLayerMouseEvent) => {
			const markerData = this.markerFromEvent(e);
			if (!markerData) return;

			const newLeaf = e.originalEvent ? Boolean(Keymap.isModEvent(e.originalEvent)) : false;
			this.onOpenFile(markerData.entry.file.path, newLeaf);
		});

		// Handle right-click context menu
		this.map.on('contextmenu', 'marker-pins', (e: MapLayerMouseEvent) => {
			e.preventDefault();

			const markerData = this.markerFromEvent(e);
			if (!markerData) return;

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
					void navigator.clipboard.writeText(formatCoordinates(lat, lng));
				}));

			menu.addItem(item => item
				.setSection('danger')
				.setTitle('Delete file')
				.setIcon('trash-2')
				.setWarning(true)
				.onClick(() => this.app.fileManager.promptForDeletion(file)));
		});

		// Handle hover for link preview - similar to cards view
		this.map.on('mouseover', 'marker-pins', (e: MapLayerMouseEvent) => {
			const markerData = this.markerFromEvent(e);
			if (!markerData) return;

			this.app.workspace.trigger('hover-link', {
				event: e.originalEvent,
				source: 'bases',
				hoverParent: this.app.renderContext,
				targetEl: this.mapEl,
				linktext: markerData.entry.file.path,
			});
		});
	}

	/** Properties already represented by the marker itself, so popups skip them. */
	private getMarkerDrivenProps(mapConfig: MapConfig): BasesPropertyId[] {
		return [mapConfig.coordinatesProp, mapConfig.markerIconProp, mapConfig.markerColorProp]
			.filter((prop): prop is BasesPropertyId => prop != null);
	}
}

