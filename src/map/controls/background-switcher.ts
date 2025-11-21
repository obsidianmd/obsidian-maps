import { setIcon, Menu } from 'obsidian';
import { Map } from 'maplibre-gl';

export class BackgroundSwitcherControl {
	private containerEl: HTMLElement;
	private tileSets: Array<{ id: string; name: string; lightTiles: string; darkTiles: string }>;
	private onSwitch: (tileSetId: string) => void;
	private currentTileSetId: string;

	constructor(
		tileSets: Array<{ id: string; name: string; lightTiles: string; darkTiles: string }>,
		currentTileSetId: string,
		onSwitch: (tileSetId: string) => void
	) {
		this.tileSets = tileSets;
		this.currentTileSetId = currentTileSetId;
		this.onSwitch = onSwitch;
		this.containerEl = createDiv('maplibregl-ctrl maplibregl-ctrl-group canvas-control-group mod-raised');
	}

	onAdd(map: Map): HTMLElement {
		const button = this.containerEl.createEl('div', {
			cls: 'canvas-control-item',
			attr: { 'aria-label': 'Switch background' }
		});
		setIcon(button, 'layers');

		button.addEventListener('click', (evt) => {
			evt.stopPropagation();
			const menu = new Menu();

			for (const tileSet of this.tileSets) {
				menu.addItem((item) => {
					item
						.setTitle(tileSet.name)
						.setChecked(this.currentTileSetId === tileSet.id)
						.onClick(() => {
							this.currentTileSetId = tileSet.id;
							this.onSwitch(tileSet.id);
						});
				});
			}

			menu.showAtMouseEvent(evt);
		});

		return this.containerEl;
	}

	onRemove(): void {
		if (this.containerEl && this.containerEl.parentNode) {
			this.containerEl.detach();
		}
	}
}

