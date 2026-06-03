#!/usr/bin/env python3
import argparse
import gzip
import json
import os
import sqlite3
import struct
import sys

HEADER_SIZE = 127
COMPRESSION_NONE = 1
COMPRESSION_GZIP = 2


def main():
    parser = argparse.ArgumentParser(description="Convert a PMTiles v3 MVT archive to vector MBTiles.")
    parser.add_argument("--input", required=True, help="Input .pmtiles file")
    parser.add_argument("--output", required=True, help="Output .mbtiles file")
    parser.add_argument("--name", default=None, help="Override MBTiles name metadata")
    parser.add_argument("--batch-size", type=int, default=2000, help="SQLite insert batch size")
    args = parser.parse_args()

    if os.path.exists(args.output):
        os.remove(args.output)

    with open(args.input, "rb") as source:
        header = read_header(source)
        metadata = read_metadata(source, header)
        if args.name:
            metadata["name"] = args.name

        entries = list(iter_tile_entries(source, header))
        write_mbtiles(args.output, source, header, metadata, entries, args.batch_size)

    print(f"Wrote {args.output}")
    print(f"Tiles: {sum(entry['run_length'] for entry in entries)}")


def read_header(source):
    source.seek(0)
    data = source.read(HEADER_SIZE)
    if len(data) != HEADER_SIZE:
        raise ValueError("Input is too small to be a PMTiles archive")
    if data[:7] != b"PMTiles":
        raise ValueError("Wrong PMTiles magic number")
    if data[7] != 3:
        raise ValueError(f"Unsupported PMTiles spec version {data[7]}")

    def uint64(offset):
        return struct.unpack_from("<Q", data, offset)[0]

    def int32(offset):
        return struct.unpack_from("<i", data, offset)[0]

    return {
        "root_directory_offset": uint64(8),
        "root_directory_length": uint64(16),
        "json_metadata_offset": uint64(24),
        "json_metadata_length": uint64(32),
        "leaf_directory_offset": uint64(40),
        "leaf_directory_length": uint64(48),
        "tile_data_offset": uint64(56),
        "tile_data_length": uint64(64),
        "num_addressed_tiles": uint64(72),
        "num_tile_entries": uint64(80),
        "num_tile_contents": uint64(88),
        "clustered": data[96] == 1,
        "internal_compression": data[97],
        "tile_compression": data[98],
        "tile_type": data[99],
        "minzoom": data[100],
        "maxzoom": data[101],
        "bounds": [
            int32(102) / 10000000,
            int32(106) / 10000000,
            int32(110) / 10000000,
            int32(114) / 10000000,
        ],
        "center_zoom": data[118],
        "center": [
            int32(119) / 10000000,
            int32(123) / 10000000,
        ],
    }


def read_metadata(source, header):
    data = read_range(source, header["json_metadata_offset"], header["json_metadata_length"])
    data = decompress(data, header["internal_compression"])
    metadata = json.loads(data.decode("utf-8")) if data else {}
    return metadata


def iter_tile_entries(source, header):
    root = read_directory(source, header, header["root_directory_offset"], header["root_directory_length"])
    for entry in root:
        if entry["run_length"] == 0:
            leaf_offset = header["leaf_directory_offset"] + entry["offset"]
            leaf = read_directory(source, header, leaf_offset, entry["length"])
            for leaf_entry in leaf:
                yield leaf_entry
        else:
            yield entry


def read_directory(source, header, offset, length):
    data = read_range(source, offset, length)
    data = decompress(data, header["internal_compression"])
    return deserialize_directory(data)


def deserialize_directory(data):
    reader = VarintReader(data)
    count = reader.read()
    entries = []
    tile_id = 0

    for _ in range(count):
        tile_id += reader.read()
        entries.append({"tile_id": tile_id, "offset": 0, "length": 0, "run_length": 1})

    for entry in entries:
        entry["run_length"] = reader.read()

    for entry in entries:
        entry["length"] = reader.read()

    for index, entry in enumerate(entries):
        value = reader.read()
        if value == 0 and index > 0:
            previous = entries[index - 1]
            entry["offset"] = previous["offset"] + previous["length"]
        else:
            entry["offset"] = value - 1

    return entries


class VarintReader:
    def __init__(self, data):
        self.data = data
        self.pos = 0

    def read(self):
        shift = 0
        result = 0
        while True:
            if self.pos >= len(self.data):
                raise ValueError("Unexpected end of varint")
            byte = self.data[self.pos]
            self.pos += 1
            result |= (byte & 0x7F) << shift
            if byte < 0x80:
                return result
            shift += 7
            if shift > 63:
                raise ValueError("Varint is too long")


def write_mbtiles(output, source, header, metadata, entries, batch_size):
    connection = sqlite3.connect(output)
    try:
        connection.execute("PRAGMA journal_mode=OFF")
        connection.execute("PRAGMA synchronous=OFF")
        connection.execute("PRAGMA locking_mode=EXCLUSIVE")
        connection.execute("PRAGMA temp_store=MEMORY")
        connection.execute("CREATE TABLE metadata (name TEXT, value TEXT)")
        connection.execute(
            "CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER, tile_row INTEGER, tile_data BLOB)"
        )

        insert_metadata(connection, header, metadata)

        tile_sql = "INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)"
        batch = []
        written = 0
        for entry in entries:
            blob = read_range(source, header["tile_data_offset"] + entry["offset"], entry["length"])
            for run_offset in range(entry["run_length"]):
                z, x, y = tile_id_to_zxy(entry["tile_id"] + run_offset)
                tms_y = (1 << z) - 1 - y
                batch.append((z, x, tms_y, sqlite3.Binary(blob)))
                if len(batch) >= batch_size:
                    connection.executemany(tile_sql, batch)
                    connection.commit()
                    written += len(batch)
                    print(f"Inserted {written} tiles", file=sys.stderr)
                    batch = []

        if batch:
            connection.executemany(tile_sql, batch)
            connection.commit()
            written += len(batch)
            print(f"Inserted {written} tiles", file=sys.stderr)

        connection.execute("CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row)")
        connection.execute("ANALYZE")
        connection.commit()
    finally:
        connection.close()


def insert_metadata(connection, header, metadata):
    bounds = header["bounds"]
    center = header["center"]
    rows = {
        "name": metadata.get("name", "Distance To Shore Coastline"),
        "description": metadata.get("description", "Coastline used by signalk-distance-to-shore."),
        "attribution": metadata.get("attribution", "OpenStreetMap contributors"),
        "type": "tilelayer",
        "version": metadata.get("version", "1.0.0"),
        "format": "pbf",
        "minzoom": str(header["minzoom"]),
        "maxzoom": str(header["maxzoom"]),
        "bounds": ",".join(format_float(value) for value in bounds),
        "center": f"{format_float(center[0])},{format_float(center[1])},{header['center_zoom']}",
        "json": json.dumps(
            {
                "vector_layers": metadata.get("vector_layers", []),
                "tilestats": metadata.get("tilestats", {}),
                "signalk_distance_to_shore": metadata.get("signalk_distance_to_shore", {}),
            },
            separators=(",", ":"),
        ),
    }
    connection.executemany(
        "INSERT INTO metadata (name, value) VALUES (?, ?)",
        [(key, str(value)) for key, value in rows.items()],
    )


def read_range(source, offset, length):
    source.seek(offset)
    data = source.read(length)
    if len(data) != length:
        raise ValueError(f"Unexpected end of file at offset {offset}")
    return data


def decompress(data, compression):
    if compression == COMPRESSION_NONE:
        return data
    if compression == COMPRESSION_GZIP:
        return gzip.decompress(data)
    raise ValueError(f"Unsupported PMTiles compression method {compression}")


def tile_id_to_zxy(tile_id):
    z = tile_id_to_z(tile_id) >> 1
    if z > 26:
        raise ValueError("Tile zoom level exceeds max safe number limit")
    acc = (((1 << z) * (1 << z)) - 1) // 3
    t = tile_id - acc
    x = 0
    y = 0
    n = 1 << z
    s = 1
    while s < n:
        rx = s & (t // 2)
        ry = s & (t ^ rx)
        x, y = rotate(s, x, y, rx, ry)
        t = t // 2
        x += rx
        y += ry
        s <<= 1
    return z, x, y


def tile_id_to_z(tile_id):
    return (3 * tile_id + 1).bit_length() - 1


def rotate(n, x, y, rx, ry):
    if ry == 0:
        if rx != 0:
            return n - 1 - y, n - 1 - x
        return y, x
    return x, y


def format_float(value):
    return f"{value:.8f}".rstrip("0").rstrip(".")


if __name__ == "__main__":
    main()
