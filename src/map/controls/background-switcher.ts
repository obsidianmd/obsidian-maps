import { setIcon, Menu } from 'obsidian';
import { IControl } from 'maplibre-gl';
import { TileSet } from '../../settings';

export class BackgroundSwitcherControl implements IControl {
	private containerEl: HTMLElement;
	private tileSets: TileSet[];
	private onSwitch: (tileSetId: string) => void;
	private currentTileSetId: string;

	constructor(
		tileSets: TileSet[],
		currentTileSetId: string,
		onSwitch: (tileSetId: string) => void
	) {
		this.tileSets = tileSets;
		this.currentTileSetId = currentTileSetId;
		this.onSwitch = onSwitch;
		this.containerEl = createDiv('maplibregl-ctrl maplibregl-ctrl-group canvas-control-group mod-raised');
	}

	onAdd(): HTMLElement {
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
		this.containerEl.detach();
	}
}

