import { Value, NumberValue, StringValue, ListValue, TFile, App } from 'obsidian';

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
		return [lat, lng];
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

export function parseGPX(xmlText: string): Array<Array<[number, number]>> {
    try {
        const parser = new DOMParser();
        const doc = parser.parseFromString(xmlText, 'application/xml');
        const tracks = [] as Array<Array<[number, number]>>;

        // Stops coordinate jumps across the antimeridian by unwrapping longitudes
		const unwrapCoordinates = (pts: [number, number][]) => {
            for (let i = 1; i < pts.length; i++) {
                const prevLon = pts[i - 1][0];
                let currentLon = pts[i][0];

                // If the jump is greater than 180 degrees, it crossed the antimeridian
                if (currentLon - prevLon > 180) {
                    currentLon -= 360;
                } else if (currentLon - prevLon < -180) {
                    currentLon += 360;
                }
                
                pts[i][0] = currentLon;
            }
        };

        const trkpts = doc.querySelectorAll('trkseg');
        if (trkpts && trkpts.length > 0) {
            trkpts.forEach((seg) => {
                const pts: [number, number][] = [];
                const nodes = seg.querySelectorAll('trkpt');
                nodes.forEach((n) => {
                    const lat = parseFloat(n.getAttribute('lat') || 'NaN');
                    const lon = parseFloat(n.getAttribute('lon') || 'NaN');
                    if (!Number.isNaN(lat) && !Number.isNaN(lon)) pts.push([lon, lat]);
                });
                if (pts.length) {
                    unwrapCoordinates(pts); // Fix any crazy longitude jumps
                    tracks.push(pts);
                }
            });
        } else {
            // Fallback: look for any trkpt in document
            const pts: [number, number][] = [];
            const nodes = doc.querySelectorAll('trkpt');
            nodes.forEach((n) => {
                const lat = parseFloat(n.getAttribute('lat') || 'NaN');
                const lon = parseFloat(n.getAttribute('lon') || 'NaN');
                if (!Number.isNaN(lat) && !Number.isNaN(lon)) pts.push([lon, lat]);
            });
            if (pts.length) {
                unwrapCoordinates(pts); // Fix any crazy longitude jumps
                tracks.push(pts);
            }
        }
        return tracks;
    } catch (err) {
        console.warn('Failed to parse GPX XML', err);
        return [];
    }
}