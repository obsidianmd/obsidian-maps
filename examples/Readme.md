## Basic map

Click **Map** in the top left corner of the base to configure view options. In the view configuration menu, open **Markers** to defined how markers are displayed. Markers use properties assigned to notes.

![[Places.base|Map]]

For example [[Eiffel Tower]] has the following properties:

| Property      | Value                    |                                                                                                                                                      |
| ------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `coordinates` | `48.85837`<br>`2.294481` | Coordinates are stored as `latitude, longitude`. You can get coordinates by right-clicking a location on the map and selecting **Copy coordinates**. |
| `icon`        | `landmark`               | The name of an icon from the [Lucide library](https://lucide.dev/).                                                                                  |
| `color`       | `red`                    | A valid CSS value: hex, RGB, named color, etc.                                                                                                       |

## Map with type-based markers

Instead of getting the icon and color from the note, we can also get them from the note's assigned type. In this example, [[Musée d'Orsay]] is assigned the type [[Museums]]. To get the map marker from the Museum type we use [formula](https://help.obsidian.md/bases/functions) properties called **Type icon** and **Type color**:

```js
// Get the icon from the type
list(type)[0].asFile().properties.icon

// Get the color from the type
list(type)[0].asFile().properties.color
```

You can see these properties by selecting **Properties** at the top of the base toolbar.

![[Places.base#Type-based markers]]

## Related notes map

See the [[Museums]] note for an example of a map that only displays markers for its assigned type.

## Custom SVG markers

For full control over marker appearance, use the **Marker SVG** property to provide custom SVG markup. This works well with formulas to create dynamic markers.

![[Places.base#SVG markers]]

The **SVG Marker** formula renders a custom pin shape:

```js
'<svg viewBox="0 0 366 552" height="30">...</svg>'
```

You can also create markers with dynamic content. The **Dynamic SVG marker** formula displays each place's rating inside a pill:

```js
'<svg width="32" height="18" viewBox="0 0 32 18">...' + rating + '...</svg>'
```

Or vary marker size based on data as in the **Dynamic size SVG marker** formula:

```js
'<svg viewBox="0 0 366 552" height="' + (15 + size * 8) + '">...</svg>'
```

SVGs with explicit `width` and `height` display at that fixed size. SVGs with only a `viewBox` scale with zoom like default markers.
