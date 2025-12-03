import { BasesEntry } from 'obsidian';

export interface MapMarker {
	entry: BasesEntry;
	coordinates: [number, number];
}

export interface MapMarkerProperties {
	entryIndex: number;
	imageKey: string; // Cache key for the marker image (composite or custom SVG)
	fixedSize: boolean; // SVGs with explicit dimensions are fixed; others scale with zoom
	svgError?: string; // Error message if SVG parsing/rendering failed
}

