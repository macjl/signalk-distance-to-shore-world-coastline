# Signal K Distance To Shore World Coastline

World coastline MBTiles dataset for [`signalk-distance-to-shore`](https://github.com/macjl/signalk-distance-to-shore).

The release asset contains coastline line geometries in MBTiles / Mapbox Vector Tile format. It is intended to be used by the Signal K plugin for distance calculations and, optionally, as a Freeboard overlay.

This is auxiliary OpenStreetMap-derived information. It is not a certified navigation chart.

## Release Asset

Current file:

```text
world-display-z0-z11-runtime-z12.mbtiles
```

Properties:

- Format: MBTiles (SQLite), vector tiles
- Tile type: MVT
- Layer: `coastline`
- Bounds: `[-180, -85.05112878, 180, 85.05112878]`
- Display zooms: `0` to `11`, simplified
- Distance calculation zoom: `12`, precise
- Size: `2245009408` bytes
- Tile count: `381614` tiles
- Attribution: OpenStreetMap contributors

## Data Source

The dataset was generated from the processed OpenStreetMap coastline shapefile:

```text
https://osmdata.openstreetmap.de/download/coastlines-split-4326.zip
```

The generated local source used for this release was:

```text
coastlines-split-4326/lines.shp
```

The source contains processed `natural=coastline` line data in EPSG:4326.

## Build Strategy

The final archive combines two kinds of tiles:

- `z0-z11`: simplified tiles for display in Freeboard
- `z12`: precise tiles for runtime distance calculations

Simplification is done by snapping vector tile coordinates to a grid:

| Zooms | Snap grid |
| --- | ---: |
| `z0-z7` | `64` |
| `z8` | `32` |
| `z9` | `16` |
| `z10` | `8` |
| `z11` | `4` |
| `z12` | `1` |

## Rebuild

Install dependencies:

```sh
npm install
```

Download and extract the OSM coastline source into:

```text
data/sources/coastlines-split-4326/lines.shp
```

Generate the display zooms:

```sh
node --max-old-space-size=4096 --expose-gc tools/build-world-pmtiles.js \
  --source data/sources/coastlines-split-4326/lines.shp \
  --output dist/world-display-z0.pmtiles \
  --minzoom 0 --maxzoom 0 --chunk-size 128 --snap-grid 64 \
  --name "Distance To Shore Coastline - World display z0"
```

Repeat for `z1-z11`, using the snap grid table above. For `z11`, use `--chunk-size 32` to reduce memory pressure.

Generate the precise runtime zoom:

```sh
node --max-old-space-size=4096 --expose-gc tools/build-world-pmtiles.js \
  --source data/sources/coastlines-split-4326/lines.shp \
  --output dist/world-z12.pmtiles \
  --minzoom 12 --maxzoom 12 --chunk-size 128 --snap-grid 1 \
  --name "Distance To Shore Coastline - World z12"
```

Merge the disjoint archives:

```sh
pmtiles merge \
  dist/world-display-z0.pmtiles \
  dist/world-display-z1.pmtiles \
  dist/world-display-z2.pmtiles \
  dist/world-display-z3.pmtiles \
  dist/world-display-z4.pmtiles \
  dist/world-display-z5.pmtiles \
  dist/world-display-z6.pmtiles \
  dist/world-display-z7.pmtiles \
  dist/world-display-z8.pmtiles \
  dist/world-display-z9.pmtiles \
  dist/world-display-z10.pmtiles \
  dist/world-display-z11.pmtiles \
  dist/world-z12.pmtiles \
  dist/world-display-z0-z11-runtime-z12.pmtiles
```

Apply the metadata:

```sh
pmtiles edit dist/world-display-z0-z11-runtime-z12.pmtiles \
  --metadata=dist/world-display-z0-z11-runtime-z12.metadata.json
```

Verify:

```sh
pmtiles show dist/world-display-z0-z11-runtime-z12.pmtiles
pmtiles verify dist/world-display-z0-z11-runtime-z12.pmtiles
sha256sum -c checksums/SHA256SUMS
```

## Use With Signal K

Download the `.mbtiles` file from the GitHub release and place it somewhere persistent, for example:

```text
~/.signalk/plugin-config-data/distance-to-shore/charts/world-display-z0-z11-runtime-z12.mbtiles
```

Then configure `signalk-distance-to-shore` to use that file.

The MBTiles format uses standard SQLite storage with TMS `tile_row` convention. It can also be served by `signalk-charts-provider-simple` and exposed as a Signal K chart resource.

## Attribution

Generated coastline data is derived from OpenStreetMap and must keep appropriate attribution.

- OpenStreetMap contributors
- https://www.openstreetmap.org/copyright
