import { Position, MultiLineString, MultiPolygon } from 'geojson';

import { BasesEntry, TFile } from 'obsidian';

export interface MapElement {
	type: 'Point' | 'MultiPoint' | 'MultiLineString' | 'MultiPolygon';
	entry: BasesEntry;
	// Must be formatted as [lng, lat] for GeoJSON compatibility
	point: Position | null; // For single point (marker)
	points: Position[] | null; // For multiple points (markers/multiple points)
	lines: MultiLineString | null; // For multiple lines (lines/gpx)
	polygons: MultiPolygon | null; // For multiple polygons (polygons)
}


export interface MapMarkerProperties {
	entryIndex: number;
	icon: string; // Composite image key combining icon and color
}

export interface MapGPX  {
	entry: BasesEntry; // The entry associated with this GPX track
	gpxData: TFile; // TFile object representing the GPX file
	color: string | null; // Optional color for the GPX track
}