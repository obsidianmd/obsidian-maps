import { BasesEntry } from 'obsidian';

export interface MapMarker {
	entry: BasesEntry;
	coordinates: [number, number];
	zoom?: number;
}

export interface MapMarkerProperties {
	entryIndex: number;
	icon: string; // Composite image key combining icon and color
}

