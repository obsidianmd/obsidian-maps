import { Value, NumberValue, StringValue, ListValue, TFile, App } from 'obsidian';
import { LineString, MultiLineString, Point, Position } from 'geojson';
/**
 * Converts a Value to coordinate tuple [lat, lng]
 */
export function coordinateFromValue(value: Value | null): [number, number] | null {
	let lat: number | null = null;
	let lng: number | null = null;

	// Handle list values (e.g., ["34.1395597", "-118.3870991"] or [34.1395597, -118.3870991])
	if (value instanceof ListValue) {
		if (value.length() >= 2) {
			lat = parseCoordinate(value.get(0));
			lng = parseCoordinate(value.get(1));
		}
	}
	// Handle string values (e.g., "34.1395597,-118.3870991" or "34.1395597, -118.3870991")
	else if (value instanceof StringValue) {
		// Split by comma and handle various spacing
		const parts = value.toString().trim().split(',');
		if (parts.length >= 2) {
			lat = parseCoordinate(parts[0].trim());
			lng = parseCoordinate(parts[1].trim());
		}
	}

	if (lat && lng && verifyLatLng(lat, lng)) {
		return [lng, lat]; // Return as [lng, lat] for GeoJSON compatibility
	}

	return null;
}
export function coordinatesFromValue(value: Value | null): Position[] | null {
	const coords: Position[] = [];
	if (value instanceof ListValue) {
		for (let i = 0; i < value.length(); i++) {
			const coordValue = value.get(i);
			const coord = coordinateFromValue(coordValue);
			if (coord) {
				coords.push([coord[1], coord[0]]); // [lng, lat]
			}
		}
		return coords.length > 0 ? coords : null;
	} else if (value instanceof StringValue) {
		const parts = value.toString().trim().split(';');
		for (const part of parts) {
			const coord = coordinateFromValue(new StringValue(part));
			if (coord) {
				coords.push([coord[1], coord[0]]); // [lng, lat]
			}
		}
		return coords.length > 0 ? coords : null;
	}
	return null;
}

/**
 * Verifies that lat/lng values are within valid ranges
 */
export function verifyLatLng(lat: number, lng: number): boolean {
	return !isNaN(lat) && !isNaN(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

/**
 * Parses a coordinate value from various formats
 */
export function parseCoordinate(value: unknown): number | null {
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

/**
 * Wrapper for Object.hasOwn which performs type narrowing
 */
export function hasOwnProperty<K extends PropertyKey>(o: unknown, v: K): o is Record<K, unknown> {
	return o != null && typeof o === 'object' && Object.hasOwn(o, v);
}

export function fileFromPath(path: Value| null, app: App): TFile | null {
	if (!path) return null;
	let filePath: string;
	try { 
		filePath = path.toString().trim();
	} catch (err) {
		return null;
	}
	while (filePath.startsWith('[')) {
		filePath = filePath.slice(1);
	}
	while (filePath.endsWith(']')) {
		filePath = filePath.slice(0, filePath.length - 1);
	}
	if (filePath.contains("/")){
		const file = app.vault.getAbstractFileByPath(filePath);
		return file instanceof TFile ? file : null;
	} else {
		const file = app.metadataCache.getFirstLinkpathDest(filePath, '');
		return file instanceof TFile ? file : null;
	}

	
}

function unwrapCoordinates(coords: Position[]): void {
	for (let i = 1; i < coords.length; i++) {
		const prevLon = coords[i - 1][0];
		let currentLon = coords[i][0];
		
		// If the jump is greater than 180 degrees, it crossed the antimeridian
		if (currentLon - prevLon > 180) {
			currentLon -= 360;
		}
		if (currentLon - prevLon < -180) {
			currentLon += 360;
		}
		coords[i][0] = currentLon;
	}
}

export function parseGPX(xmlText: string): [MultiLineString | null, Position[] | null] {
	// Extract waypoints
	const parser = new DOMParser();
	const doc = parser.parseFromString(xmlText, 'application/xml');

	// Extract waypoints
	const wptNodes = doc.querySelectorAll('wpt');
	const waypoints: Position[] = [];
	try {
		for (const wptNode of wptNodes) {
			const lat = parseFloat(wptNode.getAttribute('lat') || 'NaN');
			const lon = parseFloat(wptNode.getAttribute('lon') || 'NaN');
			if (!isNaN(lat) && !isNaN(lon)) {
				waypoints.push(
					[lon, lat]
				);
			}
		}
	} catch (err) {
		console.warn('Failed to parse GPX waypoints', err);
	}
	
	const parseTrack  = (element: Element): Position[] | null => {
		const segNodes = element.querySelectorAll('trkseg');
		const lineCoords: Position[] = [];
		try {
			for (const segNode of segNodes) {
				const trkptNodes = segNode.querySelectorAll('trkpt');
				for (const trkptNode of trkptNodes) {
					const lat = parseFloat(trkptNode.getAttribute('lat') || 'NaN');
					const lon = parseFloat(trkptNode.getAttribute('lon') || 'NaN');
					if (!isNaN(lat) && !isNaN(lon)) {
						lineCoords.push([lon, lat]);
					}
				}
			}
		} catch (err) {
			console.warn('Failed to parse GPX track segments', err);
			return null
		}
		if (lineCoords.length === 0) return null;
		unwrapCoordinates(lineCoords);
		return lineCoords;
	}; 

	const routeNodes = doc.querySelectorAll('rte');
	const lineStrings: MultiLineString = {type: 'MultiLineString', coordinates: []};
	try {
		for (const rteNode of routeNodes) {
			const lineString = parseTrack(rteNode);
			if (lineString) {
				lineStrings.coordinates.push(lineString);
			}
		}
	} catch (err) {
		console.warn('Failed to parse GPX routes', err);
	}
	if (lineStrings.coordinates.length === 0) {
		const trkNodes = doc.querySelectorAll('trk');
		try {
			for (const trkNode of trkNodes) {
				const lineString = parseTrack(trkNode);
				if (lineString) {
					lineStrings.coordinates.push(lineString);
				}
			}
		} catch (err) {
			console.warn('Failed to parse GPX tracks', err);
		}
	}
	const multiLineString: MultiLineString | null = lineStrings.coordinates.length > 0 ? lineStrings : null;
	const points: Position[] | null = waypoints.length > 0 ? waypoints : null;
	return [multiLineString, points];
}
