> [!NOTE]
> Requires [Obsidian 1.10.0+](https://obsidian.md/changelog/2025-10-01-desktop-v1.10.0/). This project demonstrates the new Obsidian Bases API that allows plugin developers to create new view types.

## Map view for Obsidian Bases

Adds a map layout to [Obsidian Bases](https://help.obsidian.md/bases) so you can display notes as an interactive map view.

![Map view for Obsidian Bases](/images/map-view.png)

- Dynamically display markers that match your filters.
- Use marker icons and colors defined by properties.
- Load custom background tiles.
- Define default zoom options.

### Examples

Open the [example files](https://github.com/obsidianmd/obsidian-maps/tree/master/examples) in Obsidian to see working map views with markers, icons, and colors already configured.

### Markers

To display markers on the map go to the view configuration menu and select a marker property. The property must contain latitude and longitude coordinates. The following formats are accepted:

```yaml
# Text property
coordinates: "lat, lng"

# List property
coordinates:
  - "lat"
  - "lng"
```

If you store coordinates as separate `longitude` and `latitude` properties you can combine them with a formula property by defining it as an array of coordinates: `[latitude, longitude]`.

#### Icons

You can add icons from Obsidian's built-in [Lucide library](https://lucide.dev/icons/) to markers.

#### Colors

You can define colors. Accepts values as RGB `rgb(0,0,0)`, HEX `#000`, or CSS variables like `var(--color-blue)`.
