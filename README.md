Requires [Obsidian 1.10](https://obsidian.md/changelog/2025-11-11-desktop-v1.10.3/). This project demonstrates the Obsidian Bases API that allows plugin developers to create new view types.

## Map view for Obsidian Bases

Adds a [map layout](https://help.obsidian.md/bases/views/map) to [Obsidian Bases](https://help.obsidian.md/bases) so you can display notes as an interactive map view.

![Map view for Obsidian Bases](/images/map-view.png)

- Dynamically display markers that match your filters.
- Use marker icons and colors defined by properties.
- Load custom background tiles.
- Define default zoom options.

See the [full documentation](https://help.obsidian.md/bases/views/map) on the Obsidian Help site.


# New features in this branch
Added support for GPX.

I do not have access to the documentation so I will document it here.

A new setting group has been added to map view bases that allows users to specify two new properties that are stored for each view
## GPX file
This is a property that the user selects to be used to render gpx files.
- In a note that you want to add a GPX to, type the file name. 
- Note this does support typing the file in [[square brackets.gpx]]
# GPX color
Type a colour (British spelling is superior) into this field and the gpx will be rendered in this colour.
Note that leaving this field empty will cause the gpx to be black
