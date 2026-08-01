import { App, BasesEntry, BasesPropertyId, Keymap, Menu, setIcon, TFile } from 'obsidian';
import { Map, LngLatBounds, MapLayerMouseEvent } from 'maplibre-gl';
import { MapElement } from './types';
import { coordinateFromValue, fileFromPath, parseGPX, coordinatesFromValue } from './utils';
import { Feature } from 'geojson';
import { PopupManager } from './popup';

export class GeoJSONManager {
	private map: Map | null = null;
	private app: App;
	private mapEl: HTMLElement;
	private bounds: LngLatBounds | null = null;
	private popupManager: PopupManager;
	private baseEntries: MapElement[] = [];
	// Marker specific attribute
	private loadedIcons: Set<string> = new Set();
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
		this.bounds = null;
		this.baseEntries = [];
	}
	// Setter and getter functions
	setMap(map: Map) {
		this.map = map;
	}
	getBounds(): LngLatBounds | null {
		return this.bounds;
	}
	getMapElements(): MapElement[] {
		return this.baseEntries;
	}
	clearLoadedIcons(): void {
		this.loadedIcons.clear();
	}
	async updateElements(data: { data: BasesEntry[] }): Promise<void> {
		const mapConfig = this.getMapConfig();
		if (!this.map || !mapConfig || !data) return;

		const Markers: MapElement[] = [];
		const Lines: MapElement[] = [];
		const Polygons: MapElement[] = [];
		const coordinatesProp = mapConfig.coordinatesProp;
		const iconProp = mapConfig.markerIconProp;
		const colorProp = mapConfig.markerColorProp;
		const gpxProp = mapConfig.gpxProp;
		const lineProp = mapConfig.lineProp;
		const polygonProp = mapConfig.polygonProp;
		for (const entry of data.data) {
			if (!entry) continue;
			if (coordinatesProp && entry.getValue(coordinatesProp)) {
				const coords = coordinateFromValue(entry.getValue(coordinatesProp));
				if (coords){
					const element: MapElement = {
						type: 'Point',
						entry,
						point: coords,
						points: null,
						lines: null,
						polygons: null
					}
					Markers.push(element);
				} else { 
					console.error(`Error extracting coordinates for ${entry.file.name}`);
				}
			}
			// GPX
			if (gpxProp && entry.getValue(gpxProp)) {
				const gpxFilePath = entry.getValue(gpxProp);
				if (!gpxFilePath) continue;
				const gpxFile = fileFromPath(gpxFilePath, this.app);
				if (!gpxFile) {
					console.error(`GPX file path not found for ${entry.file.name}`);
					continue;
				}
				if (gpxFile instanceof TFile) {
					const [multiLineString, points] = await parseGPX(await this.app.vault.read(gpxFile));
					
					if (multiLineString) {
						const element: MapElement = {
							type: 'MultiLineString',
							entry,
							point: null,
							points: null,
							lines: multiLineString,
							polygons: null
						}
						Lines.push(element);
					}
					if (points) {
						
						for (const point of points) {
							const element: MapElement = {
								type: 'Point',
								entry,
								point: point,
								points: null,
								lines: null,
								polygons: null
							}
						}
						
					}
					
				} else {
					console.error(`Error extracting GPX file for ${entry.file.name}`);
				}
			}
			if (lineProp && entry.getValue(lineProp)) {
				const lineCoords = coordinatesFromValue(entry.getValue(lineProp));
				if (lineCoords) {
					const element: MapElement = {
						type: 'MultiLineString',
						entry,
						point: null,
						points: null,
						lines: {
							type: "MultiLineString", 
							coordinates: [lineCoords]},
						polygons: null,
					}
					Lines.push(element);
				} else {
					console.error(`Error extracting line coordinates for ${entry.file.name}`);
				}
			}
			if (polygonProp && entry.getValue(polygonProp)) {
				const polygonCoords = coordinatesFromValue(entry.getValue(polygonProp));
				if (polygonCoords) {
					const element: MapElement = {
						type: 'MultiPolygon',
						entry,
						point: null,
						points: null,
						lines: null,
						polygons: {
							type: "MultiPolygon", 
							coordinates: [[polygonCoords]]},
					}
					Polygons.push(element);
				}
			}
		}
		this.baseEntries = [...Markers, ...Lines, ...Polygons];

		//Convert to map libre
		const bounds = new LngLatBounds();
		const mapLibreElements: Feature[] = []

		await this.loadCustomIcons(Markers);

		for (const element of this.baseEntries) {
			if (element.type === 'Point' && element.point) {
				mapLibreElements.push({
					type: 'Feature',
					geometry: {
						type: 'Point',
						coordinates: element.point,
					},
					properties: {
						entryIndex: this.baseEntries.indexOf(element),
						icon: element.entry.getValue(mapConfig.markerIconProp as BasesPropertyId)?.toString() || 'marker',
						color: element.entry.getValue(mapConfig.markerColorProp as BasesPropertyId)?.toString() || '#ff0000',
					}
				})
				bounds.extend([element.point[0], element.point[1]]);
				//TODO: Add custom icons
			}
			if (element.type === 'MultiPoint' && element.points) {
				mapLibreElements.push({
					type: 'Feature',
					geometry: {
						type: 'MultiPoint',
						coordinates: element.points,
					},
					properties: {
						entryIndex: this.baseEntries.indexOf(element),
						icon: element.entry.getValue(mapConfig.markerIconProp as BasesPropertyId)?.toString() || 'marker',
						color: element.entry.getValue(mapConfig.markerColorProp as BasesPropertyId)?.toString() || '#ff0000',
					}
				})
				for (const point of element.points) {
					bounds.extend([point[0], point[1]]);
				}
			} else if (element.type === 'MultiLineString' && element.lines) {
				mapLibreElements.push({
					type: 'Feature',
					geometry: {
						type: 'MultiLineString',
						coordinates: element.lines.coordinates,
					},
					properties: {
						entryIndex: this.baseEntries.indexOf(element),
						color: element.entry.getValue(mapConfig.lineColorProp as BasesPropertyId)?.toString() || '#ff0000',
					}
				})
				for (const line of element.lines.coordinates) {
					for (const point of line) {
						bounds.extend([point[0], point[1]]);
					}
				}
			} else if (element.type === 'MultiPolygon' && element.polygons) {
				mapLibreElements.push({
					type: 'Feature',
					geometry: {
						type: 'MultiPolygon',
						coordinates: element.polygons.coordinates,
					},
					properties: {
						entryIndex: this.baseEntries.indexOf(element),
						color: element.entry.getValue(mapConfig.polygonColorProp as BasesPropertyId)?.toString() || '#ff0000',
						fillColor: element.entry.getValue(mapConfig.polygonFillColorProp as BasesPropertyId)?.toString() || '#ff0000',
						fillOpacity: element.entry.getValue(mapConfig.polygonFillOpacityProp as BasesPropertyId) ? parseFloat(element.entry.getValue(mapConfig.polygonFillOpacityProp as BasesPropertyId)?.toString() || '0') : 0.5,
						strokeWidth: element.entry.getValue(mapConfig.polygonStrokeWidthProp as BasesPropertyId) ? parseFloat(element.entry.getValue(mapConfig.polygonStrokeWidthProp as BasesPropertyId)?.toString() || '1') : 1,
						strokeOpacity: element.entry.getValue(mapConfig.polygonStrokeOpacityProp as BasesPropertyId) ? parseFloat(element.entry.getValue(mapConfig.polygonStrokeOpacityProp as BasesPropertyId)?.toString() || '0') : 1,
						fillPattern: element.entry.getValue(mapConfig.polygonFillPatternProp as BasesPropertyId)?.toString() || null,
						strokePattern: element.entry.getValue(mapConfig.polygonStrokePatternProp as BasesPropertyId)?.toString() || null,
						// Add more properties as needed
					}
				})
				for (const polygon of element.polygons.coordinates) {
					for (const line of polygon) {
						bounds.extend([line[0][0], line[0][1]]);
					}
				}
			}
		}
		this.bounds = bounds;


		this.SetupPointerInteractions();
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
	private async loadCustomIcons(markers: MapElement[]): Promise<void> {
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
	private getCompositeImageKey(icon: string | null, color: string): string {
		return `marker-${icon || 'dot'}-${color.replace(/[^a-zA-Z0-9]/g, '')}`;
	}
	private SetupPointerInteractions(): void {
		if (!this.map) return;
		for (const layerId of ['markers', 'lines', 'polygons']) {
			this.map.on('mouseenter', layerId, () => {
				if (this.map) this.map.getCanvas().style.cursor = 'pointer';
			});
			this.map.on('mouseleave', layerId, () => {
				if (this.map) this.map.getCanvas().style.cursor = '';
			});
			this.map.on('mouseenter', layerId, (e: MapLayerMouseEvent) => {
				if (!e.features || e.features.length === 0) return;
				const feature = e.features[0];
				const entryIndex = feature.properties?.entryIndex;
				if (entryIndex !== undefined && this.baseEntries[entryIndex]) {
					const baseEntry = this.baseEntries[entryIndex];
					const data = this.getData();
					const mapConfig = this.getMapConfig();
					const geometry = feature.geometry;
					var coordinate: [number, number] | null = null;
					if (layerId === 'markers' && baseEntry.type === 'Point') {
						coordinate = baseEntry.point;
					} else if (layerId === 'lines' || layerId === 'polygons') {
						coordinate = e.lngLat ? [e.lngLat.lng, e.lngLat.lat] : null;
					}
					if (!coordinate) return;
					if (data && data.properties && mapConfig) {
						this.popupManager.showPopup(
							baseEntry.entry,
							coordinate,
							data.properties,
							mapConfig.coordinatesProp,
							mapConfig.markerIconProp,
							mapConfig.markerColorProp,
							mapConfig.gpxProp,
							mapConfig.gpxColorProp,
							this.getDisplayName
					)};
				}
			})
			this.map.on('mouseleave', layerId, () => {
				if (this.map) this.popupManager.hidePopup();
			});
			this.map.on('mouseover', layerId, (e: MapLayerMouseEvent) => {
				if (!e.features || e.features.length === 0) return;
				const feature = e.features[0];
				const entryIndex = feature.properties?.entryIndex;
				if (entryIndex !== undefined && this.baseEntries[entryIndex]) {
					const baseEntry = this.baseEntries[entryIndex];
					this.app.workspace.trigger('hover-link', {
						event: e.originalEvent,
						source: 'bases',
						hoverParent: this.app.renderContext,
						targetEl: this.mapEl,
						linktext: baseEntry.entry.file.path,
					})
				}
			})
			this.map.on('click', layerId, (e: MapLayerMouseEvent) => {
				if (!e.features || e.features.length === 0) return;
				const feature = e.features[0];
				const entryIndex = feature.properties?.entryIndex;
				if (entryIndex !== undefined && this.baseEntries[entryIndex]) {
					const baseEntry = this.baseEntries[entryIndex];
					const newLeaf = e.originalEvent ? Boolean(Keymap.isModEvent(e.originalEvent)) : false;
					this.onOpenFile(baseEntry.entry.file.path, newLeaf);
				}
			})	
			this.map.on('contextmenu', layerId, (e: MapLayerMouseEvent) => {
				e.preventDefault();
				if (!e.features || e.features.length === 0) return;

				const feature = e.features[0];
				const entryIndex = feature.properties?.entryIndex;
				if (entryIndex !== undefined && this.baseEntries[entryIndex]) {
					const baseEntry = this.baseEntries[entryIndex];
					let lat, lng
					if (baseEntry.type === 'Point'){
						 [lng, lat] = baseEntry.point ? baseEntry.point : [e.lngLat.lng, e.lngLat.lat];
					} else {
						 [lng, lat] = e.lngLat ? [e.lngLat.lng, e.lngLat.lat] : [null, null];
					}

					const file = baseEntry.entry.file;
					
					const menu = Menu.forEvent(e.originalEvent);
					this.app.workspace.handleLinkContextMenu(menu, file.path, '');

					// Adds copy coordinates option
					menu.addItem(item => item
						.setSection('action')
						.setTitle('Copy Coordinates')
						.setIcon('map-pin')
						.onClick(() => {
							const coordString = `${lat}, ${lng}`;
							void navigator.clipboard.writeText(coordString);
						})
					);

					menu.addItem(item => item
						.setSection('danger')
						.setTitle('Delete file')
						.setIcon('trash-2')
						.setWarning(true)
						.onClick(() => this.app.fileManager.promptForDeletion(file)));			
				}
			})
		};

	}

}