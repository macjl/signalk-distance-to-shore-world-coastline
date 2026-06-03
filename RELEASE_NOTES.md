# 2026.06.03-1

Bug fix release: guarantee non-empty parent tiles for any coastline feature.

Assets:

- `world-display-z0-z11-runtime-z12.mbtiles.gz` (gzip-compressed, decompress before use)
- `SHA256SUMS` (checksums for both `.mbtiles.gz` and uncompressed `.mbtiles`)

**Fix:** Coastline segments that collapsed to a single point after tile projection and coordinate snapping were previously silently discarded. They are now preserved as a minimal 1-unit marker. This guarantees that any tile containing coastline at a finer zoom is also non-empty at coarser zooms, which is required for the hierarchical pre-filter in `signalk-distance-to-shore` to work correctly.

The release asset switches from PMTiles to MBTiles — same tile data and layer structure, standard SQLite format.

Source: processed OpenStreetMap coastline shapefile from `osmdata.openstreetmap.de`.

---

# 2026.06.03

Initial world coastline PMTiles release for `signalk-distance-to-shore`.

Assets:

- `world-display-z0-z11-runtime-z12.pmtiles`
- `world-display-z0-z11-runtime-z12.metadata.json`
- `SHA256SUMS`

The PMTiles archive contains simplified coastline tiles from zoom `0` to `11` for display, plus precise zoom `12` tiles for distance calculations.

Source: processed OpenStreetMap coastline shapefile from `osmdata.openstreetmap.de`.
