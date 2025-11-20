import { App, Modal, PluginSettingTab, Setting, setIcon, setTooltip } from 'obsidian';
import ObsidianMapsPlugin from './main';

export interface TileSet {
	id: string;
	name: string;
	lightTiles: string;
	darkTiles: string;
}

export interface MapSettings {
	tileSets: TileSet[];
}

export const DEFAULT_SETTINGS: MapSettings = {
	tileSets: [],
};

class TileSetModal extends Modal {
	tileSet: TileSet;
	onSave: (tileSet: TileSet) => void;
	isNew: boolean;

	constructor(app: App, tileSet: TileSet | null, onSave: (tileSet: TileSet) => void) {
		super(app);
		this.isNew = !tileSet;
		this.tileSet = tileSet || {
			id: Date.now().toString(),
			name: '',
			lightTiles: '',
			darkTiles: ''
		};
		this.onSave = onSave;
	}

	onOpen() {
		const { contentEl, modalEl } = this;
		
		this.setTitle(this.isNew ? 'Add background set' : 'Edit background set');

		// Name
		new Setting(contentEl)
			.setName('Name')
			.addText(text => text
				.setPlaceholder('e.g. Terrain, Satellite')
				.setValue(this.tileSet.name)
				.onChange(value => {
					this.tileSet.name = value;
				})
			);

		// Light mode
		new Setting(contentEl)
			.setName('Light mode')
			.addText(text => text
				.setPlaceholder('https://tiles.openfreemap.org/styles/bright')
				.setValue(this.tileSet.lightTiles)
				.onChange(value => {
					this.tileSet.lightTiles = value;
				})
			);

		// Dark mode
		new Setting(contentEl)
			.setName('Dark mode (optional)')
			.addText(text => text
				.setPlaceholder('https://tiles.openfreemap.org/styles/dark')
				.setValue(this.tileSet.darkTiles)
				.onChange(value => {
					this.tileSet.darkTiles = value;
				})
			);

		// Button container
		const buttonContainerEl = modalEl.createDiv('modal-button-container');
		
		buttonContainerEl.createEl('button', { cls: 'mod-cta', text: 'Save' })
			.addEventListener('click', () => {
				this.onSave(this.tileSet);
				this.close();
			});
		
		buttonContainerEl.createEl('button', { text: 'Cancel' })
			.addEventListener('click', () => {
				this.close();
			});
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

export class MapSettingTab extends PluginSettingTab {
	plugin: ObsidianMapsPlugin;

	constructor(app: App, plugin: ObsidianMapsPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'Backgrounds' });

		containerEl.createEl('p', { 
			text: 'Configure background tile sets for all maps. The first tile set is used as the default.',
			cls: 'setting-item-description'
		});

		// Add background set button
		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('+ Add background set')
				.setCta()
				.onClick(() => {
					new TileSetModal(this.app, null, async (tileSet) => {
						this.plugin.settings.tileSets.push(tileSet);
						await this.plugin.saveSettings();
						this.display();
					}).open();
				})
			);

		// Display existing tile sets as a list
		const listContainer = containerEl.createDiv('map-tileset-list');
		
		this.plugin.settings.tileSets.forEach((tileSet, index) => {
			this.displayTileSetItem(listContainer, tileSet, index);
		});

		if (this.plugin.settings.tileSets.length === 0) {
			listContainer.createDiv({
				cls: 'mobile-option-setting-item',
				text: 'No background sets configured. The default OpenFreeMap tiles will be used.'
			});
		}

		// Add link to documentation
		const helpEl = containerEl.createDiv({ cls: 'setting-item-description' });
		helpEl.createEl('p').innerHTML = 'For more information and examples, see the <a href="https://help.obsidian.md/bases/views/map">Map view documentation</a>.';
	}

	private displayTileSetItem(containerEl: HTMLElement, tileSet: TileSet, index: number): void {
		const itemEl = containerEl.createDiv('mobile-option-setting-item');
		
		// Name and description
		itemEl.createSpan({ cls: 'mobile-option-setting-item-name', text: tileSet.name || 'Untitled' });
		
		if (tileSet.lightTiles) {
			itemEl.createDiv('mobile-option-setting-item-description', el => {
				el.setText(tileSet.lightTiles);
			});
		}

		// Edit button
		itemEl.createDiv('clickable-icon', el => {
			setIcon(el, 'pencil');
			setTooltip(el, 'Edit');
			el.addEventListener('click', () => {
				new TileSetModal(this.app, { ...tileSet }, async (updatedTileSet) => {
					this.plugin.settings.tileSets[index] = updatedTileSet;
					await this.plugin.saveSettings();
					this.display();
				}).open();
			});
		});

		// Delete button
		itemEl.createDiv('clickable-icon', el => {
			setIcon(el, 'trash-2');
			setTooltip(el, 'Delete');
			el.addEventListener('click', async () => {
				this.plugin.settings.tileSets.splice(index, 1);
				await this.plugin.saveSettings();
				this.display();
			});
		});

		// Drag handle
		itemEl.createDiv('clickable-icon mobile-option-setting-drag-icon', el => {
			setIcon(el, 'grip-vertical');
			setTooltip(el, 'Drag to rearrange');
			this.attachReorderHandler(el, itemEl, containerEl, index);
		});
	}

	private attachReorderHandler(handleEl: HTMLElement, itemEl: HTMLElement, containerEl: HTMLElement, currentIndex: number): void {
		let dragStartY = 0;
		let dragCurrentY = 0;
		let isDragging = false;

		handleEl.addEventListener('mousedown', (e: MouseEvent) => {
			e.preventDefault();
			isDragging = true;
			dragStartY = e.clientY;
			itemEl.addClass('is-dragging');
			document.body.addClass('is-dragging-tileset');

			const onMouseMove = (e: MouseEvent) => {
				if (!isDragging) return;
				dragCurrentY = e.clientY - dragStartY;
				itemEl.style.transform = `translateY(${dragCurrentY}px)`;

				// Check if we should swap with another item
				const items = Array.from(containerEl.children) as HTMLElement[];
				const currentRect = itemEl.getBoundingClientRect();
				const currentCenterY = currentRect.top + currentRect.height / 2;

				for (let i = 0; i < items.length; i++) {
					if (items[i] === itemEl) continue;
					const rect = items[i].getBoundingClientRect();

					if (currentCenterY > rect.top && currentCenterY < rect.bottom) {
						const newIndex = i;
						if (newIndex !== currentIndex) {
							// Reorder in settings
							const tileSets = this.plugin.settings.tileSets;
							const [removed] = tileSets.splice(currentIndex, 1);
							tileSets.splice(newIndex, 0, removed);
							void this.plugin.saveSettings();
							this.display();
							return;
						}
					}
				}
			};

			const onMouseUp = () => {
				isDragging = false;
				itemEl.removeClass('is-dragging');
				itemEl.style.transform = '';
				document.body.removeClass('is-dragging-tileset');
				document.removeEventListener('mousemove', onMouseMove);
				document.removeEventListener('mouseup', onMouseUp);
			};

			document.addEventListener('mousemove', onMouseMove);
			document.addEventListener('mouseup', onMouseUp);
		});
	}
}

