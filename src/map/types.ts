import { BasesEntry, BasesPropertyId } from 'obsidian';

/** Resolved view configuration driving how the map and its markers render. */
export interface MapConfig {
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

export interface MapMarker {
	entry: BasesEntry;
	coordinates: [number, number];
	/** Lucide icon name, or null for a plain dot. */
	icon: string | null;
	color: string;
	/** Key of the composite image combining icon and color. */
	imageKey: string;
}

export interface MapMarkerProperties {
	entryIndex: number;
	icon: string; // Composite image key combining icon and color
}

