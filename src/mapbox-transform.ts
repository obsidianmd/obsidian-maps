import { StyleSpecification } from 'maplibre-gl';

/**
 * Checks if a URL uses the mapbox:// protocol
 */
export function isMapboxURL(url: string): boolean {
	return url.indexOf('mapbox:') === 0;
}

/**
 * Transforms a Mapbox style to work with MapLibre GL JS
 */
export function transformMapboxStyle(style: StyleSpecification, accessToken: string): StyleSpecification {
	// Remove unsupported projection.name property
	if (style.projection && 'name' in style.projection) {
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		delete (style.projection as any).name;
	}

	// Transform sources
	if (style.sources) {
		for (const sourceId in style.sources) {
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const source = style.sources[sourceId] as any;
			if (source.url && isMapboxURL(source.url)) {
				const transformed = transformMapboxUrl(source.url, 'Source', accessToken);
				if (transformed) {
					source.url = transformed.url;
				}
			}
		}
	}

	// Transform sprite URLs
	if (style.sprite && typeof style.sprite === 'string' && isMapboxURL(style.sprite)) {
		const transformed = transformMapboxUrl(style.sprite, 'Sprite', accessToken);
		if (transformed) {
			style.sprite = transformed.url;
		}
	}

	// Transform glyphs URLs
	if (style.glyphs && isMapboxURL(style.glyphs)) {
		const transformed = transformMapboxUrl(style.glyphs, 'Glyphs', accessToken);
		if (transformed) {
			style.glyphs = transformed.url;
		}
	}

	return style;
}

/**
 * Transforms a Mapbox URL to an HTTPS URL
 */
function transformMapboxUrl(url: string, resourceType: string, accessToken: string): { url: string } | undefined {
	if (url.indexOf('/styles/') > -1 && url.indexOf('/sprite') === -1) {
		return { url: normalizeStyleURL(url, accessToken) };
	}
	if (url.indexOf('/sprites/') > -1) {
		return { url: normalizeSpriteURL(url, '', '.json', accessToken) };
	}
	if (url.indexOf('/fonts/') > -1) {
		return { url: normalizeGlyphsURL(url, accessToken) };
	}
	if (url.indexOf('/v4/') > -1) {
		return { url: normalizeSourceURL(url, accessToken) };
	}
	if (resourceType && resourceType === 'Source') {
		return { url: normalizeSourceURL(url, accessToken) };
	}
	return undefined;
}

/**
 * Parses a mapbox:// URL into its components
 */
function parseUrl(url: string): { protocol: string; authority: string; path: string; params: string[] } {
	const urlRe = /^(\w+):\/\/([^/?]*)(\/[^?]+)?\??(.+)?/;
	const parts = url.match(urlRe);
	if (!parts) {
		throw new Error('Unable to parse URL object');
	}
	return {
		protocol: parts[1],
		authority: parts[2],
		path: parts[3] || '/',
		params: parts[4] ? parts[4].split('&') : []
	};
}

/**
 * Formats a URL object with the Mapbox API endpoint and access token
 */
function formatUrl(urlObject: { protocol: string; authority: string; path: string; params: string[] }, accessToken: string): string {
	const apiUrlObject = parseUrl("https://api.mapbox.com");
	urlObject.protocol = apiUrlObject.protocol;
	urlObject.authority = apiUrlObject.authority;
	urlObject.params.push(`access_token=${accessToken}`);
	const params = urlObject.params.length ? `?${urlObject.params.join('&')}` : '';
	return `${urlObject.protocol}://${urlObject.authority}${urlObject.path}${params}`;
}

/**
 * Normalizes a Mapbox style URL
 */
function normalizeStyleURL(url: string, accessToken: string): string {
	const urlObject = parseUrl(url);
	urlObject.path = `/styles/v1${urlObject.path}`;
	return formatUrl(urlObject, accessToken);
}

/**
 * Normalizes a Mapbox glyphs/fonts URL
 */
function normalizeGlyphsURL(url: string, accessToken: string): string {
	const urlObject = parseUrl(url);
	urlObject.path = `/fonts/v1${urlObject.path}`;
	return formatUrl(urlObject, accessToken);
}

/**
 * Normalizes a Mapbox source/tileset URL
 */
function normalizeSourceURL(url: string, accessToken: string): string {
	const urlObject = parseUrl(url);
	urlObject.path = `/v4/${urlObject.authority}.json`;
	urlObject.params.push('secure');
	return formatUrl(urlObject, accessToken);
}

/**
 * Normalizes a Mapbox sprite URL
 * Handles retina (@2x) sprites
 */
function normalizeSpriteURL(url: string, _format: string, _extension: string, accessToken: string): string {
	const urlObject = parseUrl(url);
	const path = urlObject.path.split('.');
	let properPath = path[0];
	const extension = path[1] || 'json';
	let format = '';

	if (properPath.indexOf('@2x') > -1) {
		properPath = properPath.split('@2x')[0];
		format = '@2x';
	}
	urlObject.path = `/styles/v1${properPath}/sprite${format}.${extension}`;
	return formatUrl(urlObject, accessToken);
}

