import { Value, NumberValue, StringValue, ListValue } from 'obsidian';
import { OpenLocationCode } from 'open-location-code';

const olc = new OpenLocationCode();

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
	// Handle string values
	// may be string coordinates  (e.g., "34.1395597,-118.3870991" or "34.1395597, -118.3870991")
	// or Plus Code (e.g. "9C3XGVHC+XW")
	else if (value instanceof StringValue) {
		const str = value.toString().trim();

		// Check for full Plus Code (e.g., "9C3XGVHC+XW")
		if (olc.isFull(str)) {
			const area = olc.decode(str);
			lat = area.latitudeCenter;
			lng = area.longitudeCenter;
		}
		// Fall back to comma-separated coordinates (e.g., "34.1395597, -118.3870991")
		else {
			const parts = str.split(',');
			if (parts.length >= 2) {
				lat = parseCoordinate(parts[0].trim());
				lng = parseCoordinate(parts[1].trim());
			}
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
 * Options shared by every geolocation request. `maximumAge` lets a recent cached
 * fix satisfy a request, which keeps continuous tracking from pinning the GPS.
 */
export const GEOLOCATION_OPTIONS: PositionOptions = {
	enableHighAccuracy: true,
	timeout: 10000,
	maximumAge: 5000
};

/**
 * Converts a geolocation failure into a user-facing message
 */
export function geolocationErrorMessage(error: GeolocationPositionError): string {
	switch (error.code) {
		case error.PERMISSION_DENIED:
			return 'Location permission denied';
		case error.POSITION_UNAVAILABLE:
			return 'Location information unavailable';
		case error.TIMEOUT:
			return 'Location request timed out';
		default:
			return 'Failed to get location';
	}
}

/**
 * Wrapper for Object.hasOwn which performs type narrowing
 */
export function hasOwnProperty<K extends PropertyKey>(o: unknown, v: K): o is Record<K, unknown> {
	return o != null && typeof o === 'object' && Object.hasOwn(o, v);
}

