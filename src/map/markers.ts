import { App, BasesEntry, BasesPropertyId, Keymap, Menu, setIcon } from 'obsidian';
import { Map, LngLatBounds, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import { MapMarker, MapMarkerProperties } from './types';
import { coordinateFromValue } from './utils';
import { PopupManager } from './popup';

export class MarkerManager {
	private map: Map | null = null;
	private app: App;
	private mapEl: HTMLElement;
	private markers: MapMarker[] = [];
	private bounds: LngLatBounds | null = null;
	private loadedIcons: Set<string> = new Set();
	private popupManager: PopupManager;
	private onOpenFile: (path: string, newLeaf: boolean) => void;
	private getData: () => any;
	private getMapConfig: () => any;
	private getDisplayName: (prop: BasesPropertyId) => string;

	constructor(
		app: App,
		mapEl: HTMLElement,
		popupManager: PopupManager,
		onOpenFile: (path: string, newLeaf: boolean) => void,
		getData: () => any,
		getMapConfig: () => any,
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

	setMap(map: Map | null): void {
		this.map = map;
	}

	getMarkers(): MapMarker[] {
		return this.markers;
	}

	getBounds(): LngLatBounds | null {
		return this.bounds;
	}

	clearLoadedIcons(): void {
		this.loadedIcons.clear();
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
	}

	private getCustomIcon(entry: BasesEntry): string | null {
		const mapConfig = this.getMapConfig();
		if (!mapConfig || !mapConfig.markerIconProp) return null;

		try {
			const value = entry.getValue(mapConfig.markerIconProp);
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
		const mapConfig = this.getMapConfig();
		if (!mapConfig || !mapConfig.markerColorProp) return null;

		try {
			const value = entry.getValue(mapConfig.markerColorProp);
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
				const data = this.getData();
				const mapConfig = this.getMapConfig();
				if (data && data.properties && mapConfig) {
					this.popupManager.showPopup(
						markerData.entry,
						markerData.coordinates,
						data.properties,
						mapConfig.coordinatesProp,
						mapConfig.markerIconProp,
						mapConfig.markerColorProp,
						this.getDisplayName
					);
				}
			}
		});

		// Handle mouseleave to hide popup
		this.map.on('mouseleave', 'marker-pins', () => {
			this.popupManager.hidePopup();
		});

		// Handle click to open file
		this.map.on('click', 'marker-pins', (e: MapLayerMouseEvent) => {
			if (!e.features || e.features.length === 0) return;
			const feature = e.features[0];
			const entryIndex = feature.properties?.entryIndex;
			if (entryIndex !== undefined && this.markers[entryIndex]) {
				const markerData = this.markers[entryIndex];
				const newLeaf = e.originalEvent ? Boolean(Keymap.isModEvent(e.originalEvent)) : false;
				this.onOpenFile(markerData.entry.file.path, newLeaf);
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
}

