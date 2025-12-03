import { App, BasesEntry, BasesPropertyId, Keymap, Menu, setIcon } from 'obsidian';
import { Map as MapLibreMap, LngLatBounds, GeoJSONSource, MapLayerMouseEvent } from 'maplibre-gl';
import { MapMarker, MapMarkerProperties } from './types';
import { coordinateFromValue } from './utils';
import { PopupManager } from './popup';
import {SVG_MARKER_REFERENCE_SIZE, SVG_MARKER_RENDER_SCALE} from "./constants";

export class MarkerManager {
	private map: MapLibreMap | null = null;
	private app: App;
	private mapEl: HTMLElement;
	private markers: MapMarker[] = [];
	private bounds: LngLatBounds | null = null;
	private loadedMarkerImages: Map<string, { fixedSize: boolean; svgError?: string }> = new Map();
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

	setMap(map: MapLibreMap | null): void {
		this.map = map;
	}

	getMarkers(): MapMarker[] {
		return this.markers;
	}

	getBounds(): LngLatBounds | null {
		return this.bounds;
	}

	clearLoadedMarkerImages(): void {
		this.loadedMarkerImages.clear();
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

		// Load all marker images and create GeoJSON features
		await this.loadMarkerImages(validMarkers);
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
			if (!value || !value.isTruthy()) return null;

			// Extract the icon name from the value
			const iconString = value.toString().trim();

			// Handle null/empty/invalid cases - return null to show default marker
			if (!iconString || iconString.length === 0 || iconString === 'null' || iconString === 'undefined') {
				return null;
			}

			return iconString;
		}
		catch (error) {
			// Log as warning instead of error - this is not critical
			console.warn(`Could not extract icon for ${entry.file.name}. The marker icon property should be a simple text value (e.g., "map", "star").`, error);
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
			// Log as warning instead of error - this is not critical
			console.warn(`Could not extract color for ${entry.file.name}. The marker color property should be a simple text value (e.g., "#ff0000", "red", "var(--color-accent)").`);
			return null;
		}
	}

	private getCustomSvg(entry: BasesEntry): string | null {
		const mapConfig = this.getMapConfig();
		if (!mapConfig || !mapConfig.markerSvgProp) return null;

		try {
			const value = entry.getValue(mapConfig.markerSvgProp);
			if (!value || !value.isTruthy()) return null;
			return value.toString().trim() || null;
		}
		catch {
			return null;
		}
	}

	private async loadMarkerImages(markers: MapMarker[]): Promise<void> {
		if (!this.map) return;

		// Collect all unique marker image combinations that need to be loaded
		const markerImagesToLoad: Array<{ icon: string | null; color: string; svgString: string | null; imageKey: string }> = [];

		for (const markerData of markers) {
			const icon = this.getCustomIcon(markerData.entry);
			const color = this.getCustomColor(markerData.entry) || 'var(--bases-map-marker-background)';
			const svgString = this.getCustomSvg(markerData.entry);
			const imageKey = this.getMarkerImageKey(icon, color, svgString);

			if (!this.loadedMarkerImages.has(imageKey)) {
				// Check if we already queued this key in current batch
				if (!markerImagesToLoad.some(item => item.imageKey === imageKey)) {
					markerImagesToLoad.push({ icon, color, svgString, imageKey });
				}
			}
		}

		// Create images for each unique combination
		for (const { icon, color, svgString, imageKey } of markerImagesToLoad) {
			try {
				// Use custom SVG rendering when svgString is provided, otherwise use composite marker
				const { img, fixedSize, svgError } = svgString
					? await this.createSvgMarkerImage(svgString)
					: { img: await this.createCompositeMarkerImage(icon, color), fixedSize: false, svgError: undefined };

				if (this.map) {
					// Force update of the image on theme change
					if (this.map.hasImage(imageKey)) {
						this.map.removeImage(imageKey);
					}
					this.map.addImage(imageKey, img);
					this.loadedMarkerImages.set(imageKey, { fixedSize, svgError });
				}
			} catch (error) {
				console.warn(`Failed to create marker image for icon ${icon}:`, error);
			}
		}
	}

	private hashSvg(str: string): string {
		let hash = 0;
		for (let i = 0; i < str.length; i++) {
			hash = ((hash << 5) - hash) + str.charCodeAt(i);
			hash |= 0;
		}
		return Math.abs(hash).toString(36);
	}

	private getMarkerImageKey(icon: string | null, color: string, svgString: string | null): string {
		if (svgString) {
			return `marker-svg-${this.hashSvg(svgString)}-${svgString.length}`;
		}
		const colorKey = color.replace(/[^a-zA-Z0-9]/g, '');
		return `marker-${icon || 'dot'}-${colorKey}`;
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
				img.onload = () => {
					resolve(img);
					URL.revokeObjectURL(img.src);
				};
				img.onerror = reject;
				img.src = URL.createObjectURL(blob);
			});
		});
	}

	private createInvalidSvgFallbackImage() {
		return this.createCompositeMarkerImage('help-circle', 'var(--bases-map-marker-background)');
	}

	private getSvgDimensions(svgEl: Element): { width: number; height: number; fixedSize: boolean } | null {
		const width = this.parseNumericSvgValue(svgEl.getAttribute('width'));
		const height = this.parseNumericSvgValue(svgEl.getAttribute('height'));

		// Fixed size: both width AND height explicitly specified
		if (width !== null && height !== null) {
			return { width, height, fixedSize: true };
		}

		const viewBox = svgEl.getAttribute('viewBox');
		if (viewBox) {
			const parts = viewBox.split(/[\s,]+/).map(Number);
			if (parts.length === 4 && parts.every(n => !isNaN(n))) {
				const [, , vbWidth, vbHeight] = parts;
				// Partial dimensions + viewBox: derive missing dimension, treat as fixed
				if (width !== null) return { width, height: width * (vbHeight / vbWidth), fixedSize: true };
				if (height !== null) return { width: height * (vbWidth / vbHeight), height, fixedSize: true };
				// Only viewBox: scalable like default markers
				return { width: vbWidth, height: vbHeight, fixedSize: false };
			}
		}

		// Partial dimensions without viewBox: can't determine aspect ratio reliably
		// Fall back to scalable behavior with a warning
		if (width !== null) {
			console.warn('SVG marker has width but no viewBox. Add viewBox for correct aspect ratio.');
			return { width, height: width, fixedSize: false };
		}
		if (height !== null) {
			console.warn('SVG marker has height but no viewBox. Add viewBox for correct aspect ratio.');
			return { width: height, height, fixedSize: false };
		}

		// No usable dimensions - signal to use fallback marker
		console.warn('SVG marker missing viewBox and dimensions. Add viewBox for correct rendering.');
		return null;
	}

	private parseNumericSvgValue(value: string | null): number | null {
		if (!value) return null;
		// Accept plain numbers or px values, reject %, em, etc.
		const match = value.match(/^(\d+(?:\.\d+)?)(px)?$/);
		return match ? parseFloat(match[1]) : null;
	}

	private async createSvgMarkerImage(svgString: string): Promise<{ img: HTMLImageElement; fixedSize: boolean; svgError?: string }> {
		// Parse SVG
		const parser = new DOMParser();
		const svgDoc = parser.parseFromString(svgString, 'image/svg+xml');
		const svgEl = svgDoc.documentElement;

		// Check for parse errors
		const parserError = svgDoc.querySelector('parsererror');
		if (parserError) {
			const errorMsg = `${parserError.textContent || 'Parse error'}`;
			console.warn(errorMsg);
			const fallbackImg = await this.createInvalidSvgFallbackImage();
			return { img: fallbackImg, fixedSize: false, svgError: errorMsg };
		}

		// Verify it's actually an SVG element
		if (svgEl.tagName.toLowerCase() !== 'svg') {
			const errorMsg = 'Expected <svg> element';
			console.warn(errorMsg);
			const fallbackImg = await this.createInvalidSvgFallbackImage();
			return { img: fallbackImg, fixedSize: false, svgError: errorMsg };
		}

		// Get dimensions
		const dimensions = this.getSvgDimensions(svgEl);
		if (!dimensions) {
			const errorMsg = 'Custom SVG marker needs a viewBox and/or explicit width and height for correct rendering.';
			const fallbackImg = await this.createInvalidSvgFallbackImage();
			return { img: fallbackImg, fixedSize: false, svgError: errorMsg };
		}

		const { width, height, fixedSize } = dimensions;

		let finalWidth: number;
		let finalHeight: number;

		if (fixedSize) {
			// Use specified dimensions
			finalWidth = width;
			finalHeight = height;
		} else {
			// Normalize to reference size (like composite markers), preserving aspect ratio
			const maxDim = Math.max(width, height);
			const scale = SVG_MARKER_REFERENCE_SIZE / maxDim;
			finalWidth = width * scale;
			finalHeight = height * scale;
		}

		// Ensure xmlns is set (required for data URL serialization)
		if (!svgEl.getAttribute('xmlns')) {
			svgEl.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
		}

		// Create viewBox from explicit dimensions if not present
		if (!svgEl.getAttribute('viewBox') && fixedSize) {
			svgEl.setAttribute('viewBox', `0 0 ${width} ${height}`);
		}

		svgEl.setAttribute('width', String(finalWidth * SVG_MARKER_RENDER_SCALE));
		svgEl.setAttribute('height', String(finalHeight * SVG_MARKER_RENDER_SCALE));

		const img = new Image();
		img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
			new XMLSerializer().serializeToString(svgEl)
		);

		return new Promise((resolve, reject) => {
			img.onload = () => resolve({ img, fixedSize });
			img.onerror = () => reject(new Error('Failed to load SVG'));
		});
	}

	private createGeoJSONFeatures(markers: MapMarker[]): GeoJSON.Feature[] {
		return markers.map((markerData, index) => {
			const [lat, lng] = markerData.coordinates;
			const icon = this.getCustomIcon(markerData.entry);
			const color = this.getCustomColor(markerData.entry) || 'var(--bases-map-marker-background)';
			const svgString = this.getCustomSvg(markerData.entry);
			const imageKey = this.getMarkerImageKey(icon, color, svgString);

			const cachedImage = this.loadedMarkerImages.get(imageKey);
			const fixedSize = cachedImage?.fixedSize ?? false;
			const svgError = cachedImage?.svgError;

			const properties: MapMarkerProperties = {
				entryIndex: index,
				imageKey,
				fixedSize,
				...(svgError && { svgError }),
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

		const svgFixedSize = 1 / SVG_MARKER_RENDER_SCALE;

		// Add a single symbol layer for marker images
		this.map.addLayer({
			id: 'marker-pins',
			type: 'symbol',
			source: 'markers',
			layout: {
				'icon-image': ['get', 'imageKey'],
				'icon-size': [
					'interpolate',
					['linear'],
					['zoom'],
					0, ['case', ['get', 'fixedSize'], svgFixedSize, 0.12],
					4, ['case', ['get', 'fixedSize'], svgFixedSize, 0.18],
					14, ['case', ['get', 'fixedSize'], svgFixedSize, 0.22],
					18, ['case', ['get', 'fixedSize'], svgFixedSize, 0.24]
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
					const svgError = feature.properties?.svgError;
					this.popupManager.showPopup(
						markerData.entry,
						markerData.coordinates,
						data.properties,
						mapConfig.coordinatesProp,
						mapConfig.markerIconProp,
						mapConfig.markerColorProp,
						mapConfig.markerSvgProp,
						this.getDisplayName,
						svgError
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

