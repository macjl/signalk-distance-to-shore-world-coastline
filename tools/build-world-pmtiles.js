#!/usr/bin/env node
'use strict'

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const vtpbf = require('vt-pbf')
const { Compression, TileType, zxyToTileId } = require('pmtiles')

const DEFAULT_SOURCE = path.join(__dirname, '..', 'data', 'sources', 'coastlines-split-4326', 'lines.shp')
const DEFAULT_OUTPUT = path.join(__dirname, '..', 'dist', 'world-display-z0-z11-runtime-z12.pmtiles')
const DEFAULT_BBOX = [-180, -85.05112878, 180, 85.05112878]
const DEFAULT_MIN_ZOOM = 0
const DEFAULT_MAX_ZOOM = 12
const DEFAULT_CHUNK_SIZE = 128
const DEFAULT_EXTENT = 4096
const DEFAULT_LAYER = 'coastline'
const LEAF_ENTRY_LIMIT = 4096

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exitCode = 1
})

async function main () {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    return
  }

  const source = path.resolve(args.source || DEFAULT_SOURCE)
  const output = path.resolve(args.output || DEFAULT_OUTPUT)
  const bbox = args.bbox || DEFAULT_BBOX
  const minZoom = Number.isInteger(args.minZoom) ? args.minZoom : DEFAULT_MIN_ZOOM
  const maxZoom = Number.isInteger(args.maxZoom) ? args.maxZoom : (Number.isInteger(args.zoom) ? args.zoom : DEFAULT_MAX_ZOOM)
  const chunkSize = args.chunkSize || DEFAULT_CHUNK_SIZE
  const snapGrid = args.snapGrid || 1
  const layerName = args.layer || DEFAULT_LAYER
  const name = args.name || `Distance To Shore Coastline - World z${minZoom}-z${maxZoom}`
  const description = args.description || 'World coastline used by signalk-distance-to-shore.'
  const attribution = args.attribution || '© OpenStreetMap contributors'
  const startedAt = Date.now()

  fs.mkdirSync(path.dirname(output), { recursive: true })
  const tempDataPath = `${output}.tiles.tmp`
  fs.rmSync(tempDataPath, { force: true })
  fs.rmSync(output, { force: true })

  const fd = fs.openSync(tempDataPath, 'w')
  const entries = []
  let tileOffset = 0
  let chunkNumber = 0
  const rangeByZoom = []

  try {
    for (let zoom = minZoom; zoom <= maxZoom; zoom += 1) {
      const range = tileRangeForBbox(bbox, zoom)
      rangeByZoom.push({ zoom, range })
      const zoomChunkSize = Math.min(chunkSizeForZoom(zoom, chunkSize), range.maxX - range.minX + 1)
      for (let xStart = range.minX; xStart <= range.maxX; xStart += zoomChunkSize) {
        const xEnd = Math.min(range.maxX, xStart + zoomChunkSize - 1)
        chunkNumber += 1
        const chunkStartedAt = Date.now()
        const tiles = await buildChunk(source, { bbox, zoom, xStart, xEnd, minY: range.minY, maxY: range.maxY, snapGrid })
        for (const tile of tiles) {
          const mvt = Buffer.from(vtpbf.fromVectorTileJs({
            layers: {
              [layerName]: createLayer(tile.segments, layerName)
            }
          }))
          const data = zlib.gzipSync(mvt)
          fs.writeSync(fd, data)
          entries.push({
            tileId: zxyToTileId(zoom, tile.x, tile.y),
            offset: tileOffset,
            length: data.length,
            runLength: 1
          })
          tileOffset += data.length
        }
        const elapsed = ((Date.now() - chunkStartedAt) / 1000).toFixed(1)
        console.log(`Chunk ${chunkNumber}: z ${zoom}, x ${xStart}-${xEnd}, tiles ${tiles.length}, elapsed ${elapsed} s`)
        if (global.gc) global.gc()
      }
    }
  } finally {
    fs.closeSync(fd)
  }

  const metadata = {
    name,
    description,
    attribution,
    version: '1.0.0',
    vector_layers: [
      {
        id: layerName,
        description: 'Coastline segments used by signalk-distance-to-shore.',
        minzoom: minZoom,
        maxzoom: maxZoom,
        fields: {}
      }
    ]
  }

  entries.sort((a, b) => a.tileId - b.tileId)
  writePmtiles({ output, tempDataPath, entries, metadata, minZoom, maxZoom, bbox })
  fs.rmSync(tempDataPath, { force: true })

  const elapsedSeconds = (Date.now() - startedAt) / 1000
  console.log(`Wrote ${output}`)
  console.log(`Tiles: ${entries.length}`)
  console.log(`Tile data bytes: ${tileOffset}`)
  console.log(`Elapsed: ${elapsedSeconds.toFixed(1)} s`)
}

async function buildChunk (source, options) {
  const shapefile = require('shapefile')
  const byId = new Map()
  const collection = await shapefile.open(source)
  const chunkBbox = tileColumnRangeBbox(options.xStart, options.xEnd, options.zoom, options.bbox)

  while (true) {
    const result = await collection.read()
    if (result.done) break
    addGeometrySegments(byId, result.value.geometry, { ...options, bbox: chunkBbox })
  }

  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

function addGeometrySegments (byId, geometry, options) {
  if (!geometry) return
  if (geometry.type === 'LineString') {
    addLineSegments(byId, geometry.coordinates, options)
  } else if (geometry.type === 'MultiLineString') {
    for (const line of geometry.coordinates) addLineSegments(byId, line, options)
  } else if (geometry.type === 'GeometryCollection') {
    for (const child of geometry.geometries) addGeometrySegments(byId, child, options)
  }
}

function addLineSegments (byId, coordinates, options) {
  for (let i = 1; i < coordinates.length; i += 1) {
    const start = coordinates[i - 1]
    const end = coordinates[i]
    if (!validCoordinate(start) || !validCoordinate(end)) continue
    const segment = [
      [start[0], start[1]],
      [end[0], end[1]]
    ]
    if (!segmentIntersectsBbox(segment, options.bbox)) continue
    addSegmentTiles(byId, segment, options)
  }
}

function addSegmentTiles (byId, segment, options) {
  const minLon = Math.min(segment[0][0], segment[1][0])
  const maxLon = Math.max(segment[0][0], segment[1][0])
  const minLat = Math.min(segment[0][1], segment[1][1])
  const maxLat = Math.max(segment[0][1], segment[1][1])
  const topLeft = lonLatToTile(minLon, maxLat, options.zoom)
  const bottomRight = lonLatToTile(maxLon, minLat, options.zoom)
  const xStart = Math.max(topLeft.x, options.xStart)
  const xEnd = Math.min(bottomRight.x, options.xEnd)
  const yStart = Math.max(topLeft.y, options.minY)
  const yEnd = Math.min(bottomRight.y, options.maxY)
  if (xStart > xEnd || yStart > yEnd) return

  for (let x = xStart; x <= xEnd; x += 1) {
    for (let y = yStart; y <= yEnd; y += 1) {
      const id = `${options.zoom}-${x}-${y}`
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          x,
          y,
          segments: [],
          keys: new Set()
        })
      }
      const projected = snapSegment(projectSegmentToTile(segment, x, y, options.zoom), options.snapGrid || 1)
      // If the segment collapses to a single point after projection and snapping, force it to a
      // minimal 1-grid-unit marker rather than discarding it. This guarantees that any tile
      // containing coastline at a finer zoom will also be non-empty at this zoom, which is
      // required for the hierarchical pre-filter in signalk-distance-to-shore to work correctly.
      if (projected[0].x === projected[1].x && projected[0].y === projected[1].y) {
        projected[1] = { x: projected[0].x + (options.snapGrid || 1), y: projected[0].y }
      }
      const key = segmentKey(projected)
      const tile = byId.get(id)
      if (tile.keys.has(key)) continue
      tile.keys.add(key)
      tile.segments.push(projected)
    }
  }
}

function projectSegmentToTile (segment, x, y, z) {
  return [
    projectPointToTile(segment[0], x, y, z),
    projectPointToTile(segment[1], x, y, z)
  ]
}

function projectPointToTile (coordinate, x, y, z) {
  const n = 2 ** z
  const worldX = ((coordinate[0] + 180) / 360) * n * DEFAULT_EXTENT
  const latRad = clamp(coordinate[1], -85.05112878, 85.05112878) * Math.PI / 180
  const worldY = ((1 - Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI) / 2) * n * DEFAULT_EXTENT
  return {
    x: Math.round(worldX - x * DEFAULT_EXTENT),
    y: Math.round(worldY - y * DEFAULT_EXTENT)
  }
}

function segmentKey (segment) {
  const a = `${segment[0].x},${segment[0].y}`
  const b = `${segment[1].x},${segment[1].y}`
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

function snapSegment (segment, grid) {
  if (grid <= 1) return segment
  return segment.map((point) => ({
    x: Math.round(point.x / grid) * grid,
    y: Math.round(point.y / grid) * grid
  }))
}

function createLayer (segments, name) {
  return {
    name,
    version: 2,
    extent: DEFAULT_EXTENT,
    length: segments.length,
    feature: (index) => ({
      properties: {},
      type: 2,
      loadGeometry: () => [segments[index]]
    })
  }
}

function writePmtiles ({ output, tempDataPath, entries, metadata, minZoom, maxZoom, bbox }) {
  const sortedEntries = entries
    .slice()
    .sort((a, b) => a.tileId - b.tileId)
    .map((entry) => ({
      ...entry,
      sourceOffset: entry.offset
    }))

  let clusteredTileOffset = 0
  for (const entry of sortedEntries) {
    entry.offset = clusteredTileOffset
    clusteredTileOffset += entry.length
  }

  const leafDirectories = []
  const rootEntries = []
  let leafOffset = 0
  for (let i = 0; i < sortedEntries.length; i += LEAF_ENTRY_LIMIT) {
    const leafEntries = sortedEntries.slice(i, i + LEAF_ENTRY_LIMIT)
    const leaf = serializeDirectory(leafEntries)
    leafDirectories.push(leaf)
    rootEntries.push({
      tileId: leafEntries[0].tileId,
      offset: leafOffset,
      length: leaf.length,
      runLength: 0
    })
    leafOffset += leaf.length
  }

  const rootDirectory = serializeDirectory(rootEntries)
  const metadataBytes = Buffer.from(JSON.stringify(metadata), 'utf8')
  const headerLength = 127
  const rootDirectoryOffset = headerLength
  const jsonMetadataOffset = rootDirectoryOffset + rootDirectory.length
  const leafDirectoryOffset = jsonMetadataOffset + metadataBytes.length
  const leafDirectoryLength = leafOffset
  const tileDataOffset = leafDirectoryOffset + leafDirectoryLength
  const tileDataLength = clusteredTileOffset
  const center = centerForBbox(bbox, maxZoom)

  const header = Buffer.alloc(headerLength)
  header.write('PMTiles', 0, 'ascii')
  header.writeUInt8(3, 7)
  writeUint64(header, 8, rootDirectoryOffset)
  writeUint64(header, 16, rootDirectory.length)
  writeUint64(header, 24, jsonMetadataOffset)
  writeUint64(header, 32, metadataBytes.length)
  writeUint64(header, 40, leafDirectoryOffset)
  writeUint64(header, 48, leafDirectoryLength)
  writeUint64(header, 56, tileDataOffset)
  writeUint64(header, 64, tileDataLength)
  writeUint64(header, 72, sortedEntries.length)
  writeUint64(header, 80, sortedEntries.length)
  writeUint64(header, 88, sortedEntries.length)
  header.writeUInt8(1, 96)
  header.writeUInt8(Compression.None, 97)
  header.writeUInt8(Compression.Gzip, 98)
  header.writeUInt8(TileType.Mvt, 99)
  header.writeUInt8(minZoom, 100)
  header.writeUInt8(maxZoom, 101)
  writeCoord(header, 102, bbox[0])
  writeCoord(header, 106, bbox[1])
  writeCoord(header, 110, bbox[2])
  writeCoord(header, 114, bbox[3])
  header.writeUInt8(center.zoom, 118)
  writeCoord(header, 119, center.longitude)
  writeCoord(header, 123, center.latitude)

  const fd = fs.openSync(output, 'w')
  try {
    fs.writeSync(fd, header)
    fs.writeSync(fd, rootDirectory)
    fs.writeSync(fd, metadataBytes)
    for (const leaf of leafDirectories) fs.writeSync(fd, leaf)
    const input = fs.openSync(tempDataPath, 'r')
    try {
      for (const entry of sortedEntries) copyRange(input, fd, entry.sourceOffset, entry.length)
    } finally {
      fs.closeSync(input)
    }
  } finally {
    fs.closeSync(fd)
  }
}

function copyRange (input, output, offset, length) {
  const buffer = Buffer.alloc(Math.min(1024 * 1024, length))
  let copied = 0
  while (copied < length) {
    const chunkLength = Math.min(buffer.length, length - copied)
    const bytesRead = fs.readSync(input, buffer, 0, chunkLength, offset + copied)
    if (bytesRead === 0) throw new Error(`Unexpected end of tile data at offset ${offset + copied}`)
    fs.writeSync(output, buffer, 0, bytesRead)
    copied += bytesRead
  }
}

function serializeDirectory (entries) {
  const chunks = []
  writeVarint(chunks, entries.length)

  let previousTileId = 0
  for (const entry of entries) {
    writeVarint(chunks, entry.tileId - previousTileId)
    previousTileId = entry.tileId
  }
  for (const entry of entries) writeVarint(chunks, entry.runLength)
  for (const entry of entries) writeVarint(chunks, entry.length)
  for (let i = 0; i < entries.length; i += 1) {
    const previous = entries[i - 1]
    const entry = entries[i]
    const expectedOffset = previous ? previous.offset + previous.length : 0
    writeVarint(chunks, i > 0 && entry.offset === expectedOffset ? 0 : entry.offset + 1)
  }

  return Buffer.from(chunks)
}

function writeVarint (chunks, value) {
  let remaining = value
  while (remaining > 0x7f) {
    chunks.push((remaining & 0x7f) | 0x80)
    remaining = Math.floor(remaining / 128)
  }
  chunks.push(remaining)
}

function writeUint64 (buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset)
  buffer.writeUInt32LE(Math.floor(value / 4294967296), offset + 4)
}

function writeCoord (buffer, offset, value) {
  buffer.writeInt32LE(Math.round(value * 10000000), offset)
}

function segmentIntersectsBbox (segment, bbox) {
  const minLon = Math.min(segment[0][0], segment[1][0])
  const maxLon = Math.max(segment[0][0], segment[1][0])
  const minLat = Math.min(segment[0][1], segment[1][1])
  const maxLat = Math.max(segment[0][1], segment[1][1])
  return maxLon >= bbox[0] && minLon <= bbox[2] && maxLat >= bbox[1] && minLat <= bbox[3]
}

function validCoordinate (coordinate) {
  return Array.isArray(coordinate) &&
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1])
}

function tileRangeForBbox (bbox, zoom) {
  const topLeft = lonLatToTile(bbox[0], bbox[3], zoom)
  const bottomRight = lonLatToTile(bbox[2], bbox[1], zoom)
  return {
    minX: topLeft.x,
    maxX: bottomRight.x,
    minY: topLeft.y,
    maxY: bottomRight.y
  }
}

function tileColumnRangeBbox (xStart, xEnd, zoom, bbox) {
  const minLon = xStart / (2 ** zoom) * 360 - 180
  const maxLon = (xEnd + 1) / (2 ** zoom) * 360 - 180
  return [Math.max(minLon, bbox[0]), bbox[1], Math.min(maxLon, bbox[2]), bbox[3]]
}

function lonLatToTile (longitude, latitude, zoom) {
  const latRad = clamp(latitude, -85.05112878, 85.05112878) * Math.PI / 180
  const n = 2 ** zoom
  const x = Math.floor(((longitude + 180) / 360) * n)
  const y = Math.floor((1 - Math.log(Math.tan(latRad) + (1 / Math.cos(latRad))) / Math.PI) / 2 * n)
  return {
    x: clampInteger(x, 0, n - 1),
    y: clampInteger(y, 0, n - 1)
  }
}

function centerForBbox (bbox, zoom) {
  return {
    longitude: (bbox[0] + bbox[2]) / 2,
    latitude: (bbox[1] + bbox[3]) / 2,
    zoom
  }
}

function chunkSizeForZoom (zoom, requestedChunkSize) {
  if (zoom <= 8) return Math.min(requestedChunkSize, 4)
  if (zoom <= 10) return Math.min(requestedChunkSize, 32)
  return requestedChunkSize
}

function clamp (value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function clampInteger (value, min, max) {
  return Math.trunc(clamp(value, min, max))
}

function parseArgs (argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--source' || arg === '-s') args.source = argv[++i]
    else if (arg === '--output' || arg === '-o') args.output = argv[++i]
    else if (arg === '--bbox') args.bbox = parseBbox(argv[++i])
    else if (arg === '--zoom' || arg === '-z') args.zoom = parseInteger(argv[++i], 'zoom')
    else if (arg === '--minzoom') args.minZoom = parseInteger(argv[++i], 'minzoom')
    else if (arg === '--maxzoom') args.maxZoom = parseInteger(argv[++i], 'maxzoom')
    else if (arg === '--chunk-size') args.chunkSize = parseInteger(argv[++i], 'chunk-size')
    else if (arg === '--snap-grid') args.snapGrid = parseInteger(argv[++i], 'snap-grid')
    else if (arg === '--layer') args.layer = argv[++i]
    else if (arg === '--name') args.name = argv[++i]
    else if (arg === '--description') args.description = argv[++i]
    else if (arg === '--attribution') args.attribution = argv[++i]
    else throw new Error(`Unknown argument: ${arg}`)
  }
  return args
}

function parseBbox (value) {
  const bbox = String(value).split(',').map(Number)
  if (bbox.length !== 4 || bbox.some((entry) => !Number.isFinite(entry))) {
    throw new Error(`Invalid bbox: ${value}`)
  }
  if (bbox[0] >= bbox[2] || bbox[1] >= bbox[3]) {
    throw new Error(`Invalid bbox ordering: ${value}`)
  }
  return bbox
}

function parseInteger (value, name) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid ${name}: ${value}`)
  }
  return parsed
}

function printHelp () {
  console.log(`Usage: node tools/build-world-pmtiles-z12.js [options]

Options:
  --source <file>      Input coastline .shp file
  --output <file>      Output .pmtiles file
  --bbox <minLon,minLat,maxLon,maxLat>
  --minzoom <z>        Minimum tile zoom, default ${DEFAULT_MIN_ZOOM}
  --maxzoom <z>        Maximum tile zoom, default ${DEFAULT_MAX_ZOOM}
  --zoom <z>           Shortcut for maxzoom when minzoom is omitted
  --chunk-size <n>     Number of tile columns per pass, default ${DEFAULT_CHUNK_SIZE}
  --snap-grid <n>      Snap MVT coordinates to this grid, default 1
  --layer <name>       MVT layer name, default ${DEFAULT_LAYER}
  --name <name>        Chart display name
  --description <text> Chart description
  --attribution <text> Chart attribution
`)
}
