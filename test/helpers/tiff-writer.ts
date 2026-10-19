/**
 * Test helper: write a minimal classic little-endian tiled float32 TIFF.
 *
 * Used to exercise the reader's tile assembly and the count-1-inline vs
 * count-N-array `TileOffsets` behaviour without shipping a megabyte fixture.
 */

export interface BuildTiffOptions {
  width: number;
  height: number;
  /** Default 128, matching hoydedata.no. */
  tileWidth?: number;
  /** Default 128, matching hoydedata.no. */
  tileLength?: number;
  /** Row-major pixel values, length width*height. */
  data: ArrayLike<number>;
  /** Emit a GDAL_NODATA (42113) tag with this value. */
  noData?: number;
  /** Tile indices to write as "empty" (offset 0, byte count 0). */
  emptyTiles?: readonly number[];
  /** Compression tag value; default 1 (none). */
  compression?: number;
}

const TYPE_SIZE: Record<number, number> = { 2: 1, 3: 2, 4: 4 };

interface EntrySpec {
  tag: number;
  type: number;
  count: number;
  values: number[];
  ascii?: string;
}

function typeSize(type: number): number {
  const size = TYPE_SIZE[type];
  if (size === undefined) throw new Error(`unsupported test TIFF type ${type}`);
  return size;
}

function encodeEntry(entry: EntrySpec, little = true): Uint8Array {
  const bytes = new Uint8Array(typeSize(entry.type) * entry.count);
  const view = new DataView(bytes.buffer);
  if (entry.type === 2) {
    const text = entry.ascii ?? '';
    for (let i = 0; i < entry.count; i++) bytes[i] = i < text.length ? text.charCodeAt(i) & 0xff : 0;
    return bytes;
  }
  for (let i = 0; i < entry.count; i++) {
    if (entry.type === 3) view.setUint16(i * 2, entry.values[i], little);
    else if (entry.type === 4) view.setUint32(i * 4, entry.values[i], little);
    else throw new Error(`unsupported test TIFF type ${entry.type}`);
  }
  return bytes;
}

export function buildTiff(options: BuildTiffOptions): ArrayBuffer {
  const {
    width,
    height,
    tileWidth = 128,
    tileLength = 128,
    data,
    noData,
    emptyTiles = [],
    compression = 1,
  } = options;

  if (data.length !== width * height) {
    throw new Error(`buildTiff: data has ${data.length} values, expected ${width * height}`);
  }

  const across = Math.ceil(width / tileWidth);
  const down = Math.ceil(height / tileLength);
  const tileCount = across * down;
  const fullTileBytes = tileWidth * tileLength * 4;

  const entries: EntrySpec[] = [
    { tag: 256, type: 4, count: 1, values: [width] },
    { tag: 257, type: 4, count: 1, values: [height] },
    { tag: 258, type: 3, count: 1, values: [32] },
    { tag: 259, type: 3, count: 1, values: [compression] },
    { tag: 262, type: 3, count: 1, values: [1] },
    { tag: 277, type: 3, count: 1, values: [1] },
    { tag: 284, type: 3, count: 1, values: [1] },
    { tag: 322, type: 4, count: 1, values: [tileWidth] },
    { tag: 323, type: 4, count: 1, values: [tileLength] },
    { tag: 324, type: 4, count: tileCount, values: new Array<number>(tileCount).fill(0) },
    { tag: 325, type: 4, count: tileCount, values: new Array<number>(tileCount).fill(0) },
    { tag: 339, type: 3, count: 1, values: [3] },
  ];
  if (noData !== undefined) {
    const text = `${noData}\0`;
    entries.push({ tag: 42113, type: 2, count: text.length, ascii: text, values: [] });
  }
  entries.sort((a, b) => a.tag - b.tag);

  // --- layout -------------------------------------------------------------
  const ifdOffset = 8;
  const ifdSize = 2 + entries.length * 12 + 4;
  let extraEnd = ifdOffset + ifdSize;
  const layout = entries.map((entry) => {
    const byteLength = typeSize(entry.type) * entry.count;
    if (byteLength <= 4) return { entry, inline: true, offset: -1, byteLength };
    if (extraEnd % 2 !== 0) extraEnd++;
    const offset = extraEnd;
    extraEnd += byteLength;
    return { entry, inline: false, offset, byteLength };
  });
  if (extraEnd % 4 !== 0) extraEnd += 4 - (extraEnd % 4);
  const tileDataStart = extraEnd;

  // --- tile offsets/byte counts ------------------------------------------
  const tileOffsets = new Array<number>(tileCount).fill(0);
  const tileByteCounts = new Array<number>(tileCount).fill(0);
  let cursor = tileDataStart;
  for (let t = 0; t < tileCount; t++) {
    if (emptyTiles.includes(t)) continue;
    tileOffsets[t] = cursor;
    tileByteCounts[t] = fullTileBytes;
    cursor += fullTileBytes;
  }
  const offsetsEntry = entries.find((e) => e.tag === 324)!;
  const countsEntry = entries.find((e) => e.tag === 325)!;
  offsetsEntry.values = tileOffsets;
  countsEntry.values = tileByteCounts;

  const total = cursor;
  const buffer = new ArrayBuffer(total);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);

  // --- header + IFD -------------------------------------------------------
  bytes[0] = 0x49; // 'I'
  bytes[1] = 0x49; // 'I' → little endian
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries.length, true);

  for (let i = 0; i < layout.length; i++) {
    const { entry, inline, offset } = layout[i];
    const at = ifdOffset + 2 + i * 12;
    view.setUint16(at, entry.tag, true);
    view.setUint16(at + 2, entry.type, true);
    view.setUint32(at + 4, entry.count, true);
    const encoded = encodeEntry(entry);
    if (inline) {
      bytes.set(encoded, at + 8);
    } else {
      view.setUint32(at + 8, offset, true);
      bytes.set(encoded, offset);
    }
  }
  view.setUint32(ifdOffset + 2 + entries.length * 12, 0, true);

  // --- tile payloads ------------------------------------------------------
  for (let t = 0; t < tileCount; t++) {
    if (tileByteCounts[t] === 0) continue;
    const tx = t % across;
    const ty = Math.floor(t / across);
    const offset = tileOffsets[t];
    for (let row = 0; row < tileLength; row++) {
      for (let col = 0; col < tileWidth; col++) {
        const x = tx * tileWidth + col;
        const y = ty * tileLength + row;
        const value = x < width && y < height ? data[y * width + x] : Number.NaN;
        view.setFloat32(offset + (row * tileWidth + col) * 4, value, true);
      }
    }
  }

  return buffer;
}
