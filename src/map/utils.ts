import { Value, NumberValue, StringValue, ListValue } from 'obsidian';

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

	if (lat != null && lng != null && verifyLatLng(lat, lng)) {
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
 * Converts a [lat, lng] coordinate to the [lng, lat] order MapLibre expects
 */
export function toLngLat([lat, lng]: [number, number]): [number, number] {
	return [lng, lat];
}

/**
 * Compares two coordinates, treating null (no coordinate) as its own value
 */
export function sameCoordinates(a: [number, number] | null, b: [number, number] | null): boolean {
	if (!a || !b) return a === b;
	return a[0] === b[0] && a[1] === b[1];
}

/**
 * Rounds a coordinate to roughly one metre of precision
 */
export function roundCoordinate(value: number): number {
	return Number(value.toFixed(5));
}

/**
 * Formats a coordinate pair for display or the clipboard. Values are used as
 * given, so callers echoing stored data keep its precision.
 */
export function formatCoordinates(lat: number, lng: number): string {
	return `${lat}, ${lng}`;
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

