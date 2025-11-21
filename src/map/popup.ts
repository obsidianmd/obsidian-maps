import { App, BasesEntry, BasesPropertyId, ListValue, Value } from 'obsidian';
import { Popup, Map } from 'maplibre-gl';

export class PopupManager {
	private map: Map | null = null;
	private sharedPopup: Popup | null = null;
	private popupHideTimeout: number | null = null;
	private popupHideTimeoutWin: Window | null = null;
	private containerEl: HTMLElement;
	private app: App;

	constructor(containerEl: HTMLElement, app: App) {
		this.containerEl = containerEl;
		this.app = app;
	}

	setMap(map: Map | null): void {
		this.map = map;
	}

	showPopup(
		entry: BasesEntry,
		coordinates: [number, number],
		properties: BasesPropertyId[],
		coordinatesProp: BasesPropertyId | null,
		markerIconProp: BasesPropertyId | null,
		markerColorProp: BasesPropertyId | null,
		getDisplayName: (prop: BasesPropertyId) => string
	): void {
		if (!this.map) return;

		// Only show popup if there are properties to display
		if (!properties || properties.length === 0 || !this.hasAnyPropertyValues(entry, properties, coordinatesProp, markerIconProp, markerColorProp)) {
			return;
		}

		this.clearPopupHideTimeout();

		// Create shared popup if it doesn't exist
		if (!this.sharedPopup) {
			const sharedPopup = this.sharedPopup = new Popup({
				closeButton: false,
				closeOnClick: false,
				offset: 25
			});

			// Add hover handlers to the popup itself
			sharedPopup.on('open', () => {
				const popupEl = sharedPopup.getElement();
				if (popupEl) {
					popupEl.addEventListener('mouseenter', () => {
						this.clearPopupHideTimeout();
					});
					popupEl.addEventListener('mouseleave', () => {
						this.hidePopup();
					});
				}
			});
		}

		// Update popup content and position
		const [lat, lng] = coordinates;
		const popupContent = this.createPopupContent(entry, properties, coordinatesProp, markerIconProp, markerColorProp, getDisplayName);
		this.sharedPopup
			.setDOMContent(popupContent)
			.setLngLat([lng, lat])
			.addTo(this.map);
	}

	hidePopup(): void {
		this.clearPopupHideTimeout();

		const win = this.popupHideTimeoutWin = this.containerEl.win;
		this.popupHideTimeout = win.setTimeout(() => {
			if (this.sharedPopup) {
				this.sharedPopup.remove();
			}
			this.popupHideTimeout = null;
			this.popupHideTimeoutWin = null;
		}, 150); // Small delay to allow moving to popup
	}

	clearPopupHideTimeout(): void {
		if (this.popupHideTimeout) {
			const win = this.popupHideTimeoutWin || this.containerEl.win;
			win.clearTimeout(this.popupHideTimeout);
		}

		this.popupHideTimeoutWin = null;
		this.popupHideTimeout = null;
	}

	destroy(): void {
		this.clearPopupHideTimeout();
		if (this.sharedPopup) {
			this.sharedPopup.remove();
			this.sharedPopup = null;
		}
	}

	private createPopupContent(
		entry: BasesEntry,
		properties: BasesPropertyId[],
		coordinatesProp: BasesPropertyId | null,
		markerIconProp: BasesPropertyId | null,
		markerColorProp: BasesPropertyId | null,
		getDisplayName: (prop: BasesPropertyId) => string
	): HTMLElement {
		const containerEl = createDiv('bases-map-popup');

		// Get properties that have values
		const propertiesSlice = properties.slice(0, 20); // Max 20 properties
		const propertiesWithValues = [];

		for (const prop of propertiesSlice) {
			if (prop === coordinatesProp || prop === markerIconProp || prop === markerColorProp) continue; // Skip coordinates, marker icon, and marker color properties

			try {
				const value = entry.getValue(prop);
				if (value && this.hasNonEmptyValue(value)) {
					propertiesWithValues.push({ prop, value });
				}
			}
			catch {
				// Skip properties that can't be rendered
			}
		}

		// Use first property as title (still acts as a link to the file)
		if (propertiesWithValues.length > 0) {
			const firstProperty = propertiesWithValues[0];
			const titleEl = containerEl.createDiv('bases-map-popup-title');

			// Create a clickable link that opens the file
			const titleLinkEl = titleEl.createEl('a', {
				href: entry.file.path,
				cls: 'internal-link'
			});

			// Render the first property value inside the link
			firstProperty.value.renderTo(titleLinkEl, this.app.renderContext);

			// Show remaining properties (excluding the first one used as title)
			const remainingProperties = propertiesWithValues.slice(1);
			if (remainingProperties.length > 0) {
				const propContainerEl = containerEl.createDiv('bases-map-popup-properties');
				for (const { prop, value } of remainingProperties) {
					const propEl = propContainerEl.createDiv('bases-map-popup-property');
					const labelEl = propEl.createDiv('bases-map-popup-property-label');
					labelEl.textContent = getDisplayName(prop);
					const valueEl = propEl.createDiv('bases-map-popup-property-value');
					value.renderTo(valueEl, this.app.renderContext);
				}
			}
		}

		return containerEl;
	}

	private hasNonEmptyValue(value: Value): boolean {
		if (!value || !value.isTruthy()) return false;

		// Handle ListValue - check if it has any non-empty items
		if (value instanceof ListValue) {
			for (let i = 0; i < value.length(); i++) {
				const item = value.get(i);
				if (item && this.hasNonEmptyValue(item)) {
					return true;
				}
			}
			return false;
		}

		return true;
	}

	private hasAnyPropertyValues(
		entry: BasesEntry,
		properties: BasesPropertyId[],
		coordinatesProp: BasesPropertyId | null,
		markerIconProp: BasesPropertyId | null,
		markerColorProp: BasesPropertyId | null
	): boolean {
		const propertiesSlice = properties.slice(0, 20); // Max 20 properties

		for (const prop of propertiesSlice) {
			if (prop === coordinatesProp || prop === markerIconProp || prop === markerColorProp) continue; // Skip coordinates, marker icon, and marker color properties

			try {
				const value = entry.getValue(prop);
				if (value && this.hasNonEmptyValue(value)) {
					return true;
				}
			}
			catch {
				// Skip properties that can't be rendered
			}
		}

		return false;
	}
}

