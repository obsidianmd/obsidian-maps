Requires [Obsidian 1.13.1](https://obsidian.md/changelog/) or later. This project demonstrates the Obsidian Bases API that allows plugin developers to create new view types.

## Map view for Obsidian Bases

Adds a [map layout](https://obsidian.md/help/bases/views/map) to [Obsidian Bases](https://obsidian.md/help/bases) so you can display notes as an interactive map view.

![Map view for Obsidian Bases](/images/map-view.png)

- Dynamically display markers that match your filters.
- Use marker icons and colors defined by properties.
- Load custom background tiles.
- Define default zoom options.

## Installation

1. Open **Settings → Community plugins**.
2. Select **Browse**, then search for **Maps**.
3. Select **Install**, then **Enable**.

## Usage

Add a coordinates property to each note you want to appear on the map. Both a text property and a list property work:

```yaml
location: 34.13956, -118.38710
```

```yaml
location:
  - 34.13956
  - -118.38710
```

Then open a base, add a view, and set its type to **Map**. In the view options, set **Marker coordinates** to your property. Markers appear for every note matching the view's filters, and update as those filters change.

The remaining view options let you set the center coordinates, default zoom, and zoom limits, and choose properties to drive each marker's icon and color.

### Backgrounds

Maps use [OpenFreeMap](https://openfreemap.org) tiles by default. To use different tiles, go to **Settings → Maps** and add a background with a tile URL or style URL. You can set a separate URL for dark mode.

See the [full documentation](https://obsidian.md/help/bases/views/map) on the Obsidian Help site for examples, tips, and troubleshooting.
