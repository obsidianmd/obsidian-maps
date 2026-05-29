import { App, BasesEntry, BasesPropertyId, TFile, Value, Keymap } from 'obsidian';
import { GeoJSONSource, LngLatBounds, MapLayerMouseEvent } from 'maplibre-gl';
import { MarkerManager } from './markers';
import { PopupManager } from './popup';
import { MapGPX } from './types';
import { fileFromPath, parseGPX } from './utils';

export class GPXManager extends MarkerManager {
    private tracks: MapGPX[];
    constructor(
        app: App, 
        mapEl: HTMLElement, 
        popupManager: PopupManager, 
        onOpenFile: (path: string, newLeaf: boolean) => void, 
        getData: () => any, 
        getMapConfig: () => any,
        getDisplayName: (prop: BasesPropertyId) => string
    ) {
        console.log('Initializing GPXManager');
        super(app, mapEl, popupManager, onOpenFile, getData, getMapConfig, getDisplayName);
        this.tracks = [];
    }

    async updateGPX(data: { data: BasesEntry[] } | null): Promise<void> {
        console.log('Updating GPX');
        const mapConfig = this.getMapConfig();
        if (!this.map || !data || !mapConfig || !mapConfig.gpxProp) return;
        
        // Collect valid GPX entries
        const validEntries: MapGPX[] = [];
        for (const entry of data.data) {
            if (!entry) continue;
            let ValueFilePath: Value | null = null;
            let gpxData: TFile | null = null;
            let color: string | null = null;
            try {
                ValueFilePath = entry.getValue(mapConfig.gpxProp as BasesPropertyId);
                gpxData = fileFromPath(ValueFilePath, this.app);
            
            } catch (err) {
                continue;
            }
            
            if (gpxData) {
                const ValueColor = entry.getValue(mapConfig.gpxColorProp as BasesPropertyId);
                color = ValueColor?.toString() || null;
                validEntries.push({
                    entry,
                    gpxData,
                    color
                });
            }
        }
        this.tracks = validEntries;

        const features: GeoJSON.Feature[] = [];
        for (let i=0; i<validEntries.length; i++) {
            const { gpxData, color } = validEntries[i];
            try {
                const content = await this.app.vault.read(gpxData);
                const tracks = parseGPX(content);
                
                tracks.forEach((track) => {
                    features.push({
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: track,
                        },
                        properties: {
                            stroke: color || '#ff0000',
                            entryIndex: i, // Store entry index for popup reference
                        }
                    });
                });
            } catch (err) {
                console.warn('Failed to read/parse GPX file:', err);
                continue;
            }
        }

        // Find the bounds of all tracks to adjust map view
        const bounds = new LngLatBounds();
        features.forEach((feature) => {
            if (feature.geometry.type === 'LineString') {
                feature.geometry.coordinates.forEach((coord) => bounds.extend(coord as [number, number]));
            }
        });

        this.bounds = bounds;
        const map = this.map;
        if (!map) {
            console.warn('Map not available when updating GPX tracks');
            return;
        }
        const source = map.getSource('gpx-tracks') as GeoJSONSource;
        if (source) {
            source.setData({ 
                type: 'FeatureCollection', 
                features 
            });
        } else {
            map.addSource('gpx-tracks', {
                type: 'geojson',
                data: { 
                    type: 'FeatureCollection', 
                    features 
                },
            });
            
            map.addLayer({
                id: 'gpx-lines',
                type: 'line',
                source: 'gpx-tracks',
                layout: {
                    'line-join': 'round',
                    'line-cap': 'round',
                },
                paint: {
                    'line-color': ['get', 'stroke'],
                    'line-width': 4,
                    'line-opacity': 0.9,
                },
            });
            this.setupGPXInteractions();
        }
    }

    destroy(): void {
        const map = this.map;
        if (!map) return;
        if (map.getLayer('gpx-lines')) {
            map.removeLayer('gpx-lines');
        }
        if (map.getSource('gpx-tracks')) {
            map.removeSource('gpx-tracks');
        }
    }


    private setupGPXInteractions(): void {
        console.log('Setting up GPX interactions');
        const map = this.map;
        if (!map) return;
        map.on('mouseenter', 'gpx-lines', () => {
            if (map) {
                map.getCanvas().style.cursor = 'pointer';
            }
        });
        map.on('mouseleave', 'gpx-lines', () => {
            if (map) {
                map.getCanvas().style.cursor = '';
            }
            this.popupManager.hidePopup();
        });
        map.on('mouseenter', 'gpx-lines', (e: MapLayerMouseEvent) => {
            console.log('GPX interaction');
            if (!e.features || e.features.length == 0) return;
            console.log("Feature:", e.features[0]);
            const feature = e.features[0];
            const entryIndex = feature.properties?.entryIndex;
            console.log("Entry:", entryIndex);
            if (entryIndex!== undefined && this.tracks[entryIndex]) {
                const trackData = this.tracks[entryIndex];
                const data = this.getData();
                const mapConfig = this.getMapConfig();
                if (data && data.properties && mapConfig) {
                    console.log('Showing popup for GPX track:', trackData.entry);
                    const coordinates: [number, number] = [e.lngLat.lat, e.lngLat.lng];
                    console.log('Coordinates:', coordinates);
                    this.popupManager.showPopup(
                        trackData.entry,
                        coordinates,
                        data.properties,
                        mapConfig.coordinatesProp,
                        mapConfig.markerIconProp,
                        mapConfig.markerColorProp,
                        mapConfig.gpxProp,
                        mapConfig.gpxColorProp,
                        this.getDisplayName
                    );
                }
            }
        });

        map.on('click', 'gpx-lines', (e: MapLayerMouseEvent) => {
            if (!e.features || e.features.length == 0) return;
            const feature = e.features[0];
            const entryIndex = feature.properties?.entryIndex;
            if (entryIndex!== undefined && this.tracks[entryIndex]) {
                const trackData = this.tracks[entryIndex];
                const newLeaf = e.originalEvent ? Boolean(Keymap.isModEvent(e.originalEvent)) : false;
                this.onOpenFile(trackData.entry.file.path, newLeaf);
            }
        });
    }

}