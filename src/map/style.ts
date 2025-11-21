import { App } from 'obsidian';
import { StyleSpecification } from 'maplibre-gl';
import { transformMapboxStyle } from '../mapbox-transform';

export class StyleManager {
	private app: App;

	constructor(app: App) {
		this.app = app;
	}

	async getMapStyle(mapTiles: string[], mapTilesDark: string[]): Promise<string | StyleSpecification> {
		const isDark = this.app.isDarkMode();
		const tileUrls = isDark && mapTilesDark.length > 0 ? mapTilesDark : mapTiles;

		// Determine style URL: use custom if provided, otherwise use default style
		let styleUrl: string;
		if (tileUrls.length === 0) {
			// No custom tiles configured, use default
			styleUrl = isDark ? 'https://tiles.openfreemap.org/styles/dark' : 'https://tiles.openfreemap.org/styles/bright';
		} else if (tileUrls.length === 1 && !this.isTileTemplateUrl(tileUrls[0])) {
			// Single URL that's not a tile template, treat as style URL
			styleUrl = tileUrls[0];
		} else {
			// Multiple URLs or tile template URLs - create custom raster style (skip to bottom)
			styleUrl = '';
		}

		// Fetch style JSON for any style URL (default or custom) to avoid CORS issues
		if (styleUrl) {
			try {
				const response = await fetch(styleUrl);
				if (response.ok) {
					const styleJson = await response.json();
					// Extract access token from URL for Mapbox styles
					const accessTokenMatch = styleUrl.match(/access_token=([^&]+)/);
					const accessToken = accessTokenMatch ? accessTokenMatch[1] : '';
					// Transform mapbox:// protocol URLs to HTTPS URLs if needed
					const transformedStyle = accessToken
						? transformMapboxStyle(styleJson, accessToken)
						: styleJson;
					return transformedStyle as StyleSpecification;
				}
			} catch (error) {
				console.warn('Failed to fetch style JSON, falling back to URL:', error);
			}
			// If fetch fails, fall back to returning the URL directly
			return styleUrl;
		}

		// Create a custom style with the configured tile sources (raster tiles)
		const spec: StyleSpecification = {
			version: 8,
			sources: {},
			layers: [],
		}
		tileUrls.forEach((tileUrl, index) => {
			const sourceId = `custom-tiles-${index}`;
			spec.sources[sourceId] = {
				type: 'raster',
				tiles: [tileUrl],
				tileSize: 256
			};

			spec.layers.push({
				id: `custom-layer-${index}`,
				type: 'raster',
				source: sourceId
			});
		});
		return spec;
	}

	private isTileTemplateUrl(url: string): boolean {
		// Check if the URL contains tile template placeholders
		return url.includes('{z}') || url.includes('{x}') || url.includes('{y}');
	}
}

