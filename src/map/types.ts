import { BasesEntry, TFile } from 'obsidian';

export interface MapMarker {
	entry: BasesEntry;
	coordinates: [number, number];
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