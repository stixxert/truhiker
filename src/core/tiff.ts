/**
 * A deliberately small, dependency-free GeoTIFF reader.
 *
 * It exists because the Norwegian elevation service returns tiled float32
 * TIFFs, and pulling in `geotiff` (and its WASM/worker machinery) for what is
 * essentially "read the IFD, concatenate tiles" is not worth it.
 *
 * Supported: classic (not Big) TIFF, little- or big-endian, single band,
 * uncompressed, 32-bit IEEE float, tiled (as served by hoydedata.no) or
 * stripped. Anything else throws instead of producing plausible garbage.
 *
 * The trap this file exists for: a 500×500 response is **16 tiles** of
 * 128×128. Reading only `TileOffsets[0]` (or, worse, assuming `TileOffsets` is
 * always an inline value) yields a raster that is 94 % garbage and a profile
 * with wildly wrong ascent. See `assembleTiles` below.
 */

/** A decoded elevation raster. Pixel (0,0) is the north-west corner. */
export interface Raster {
  readonly width: number;
  readonly height: number;
  /**
   * Elevation in metres at pixel column `x`, row `y` (0-based, integer).
   * Returns `NaN` for NoData. Throws `RangeError` for out-of-bounds indices.
   */
  get(x: number, y: number): number;
}

// TIFF field types → byte size.
const TYPE_SIZE: Record<number, number> = {
  1: 1, // BYTE
  2: 1, // ASCII
  3: 2, // SHORT
  4: 4, // LONG
  5: 8, // RATIONAL
  6: 1, // SBYTE
  7: 1, // UNDEFINED
  8: 2, // SSHORT
  9: 4, // SLONG
  10: 8, // SRATIONAL
  11: 4, // FLOAT
  12: 8, // DOUBLE
  16: 8, // LONG8 (BigTIFF only)
  17: 8, // SLONG8
  18: 8, // IFD8
};

const TAG = {
  ImageWidth: 256,
  ImageLength: 257,
  BitsPerSample: 258,
  Compression: 259,
  Photometric: 262,
  StripOffsets: 273,
  SamplesPerPixel: 277,
  RowsPerStrip: 278,
  StripByteCounts: 279,
  PlanarConfiguration: 284,
  TileWidth: 322,
  TileLength: 323,
  TileOffsets: 324,
  TileByteCounts: 325,
  SampleFormat: 339,
  GDAL_METADATA: 42112,
  GDAL_NODATA: 42113,
} as const;

interface IfdEntry {
  readonly tag: number;
  readonly type: number;
  readonly count: number;
  /** Absolute byte offset of the payload (inline or out-of-line). */
  readonly payload: number;
}

const COMPRESSION_NAMES: Record<number, string> = {
  1: 'none',
  2: 'CCITT RLE',
  3: 'CCITT G3',
  4: 'CCITT G4',
  5: 'LZW',
  6: 'old JPEG',
  7: 'JPEG',
  8: 'Deflate',
  32773: 'PackBits',
  32946: 'Deflate',
};

function readEntryNumbers(view: DataView, entry: IfdEntry, little: boolean): number[] {
  const size = TYPE_SIZE[entry.type];
  if (size === undefined) {
    throw new Error(`TIFF: unsupported field type ${entry.type} for tag ${entry.tag}`);
  }
  const out = new Array<number>(entry.count);
  for (let i = 0; i < entry.count; i++) {
    const at = entry.payload + i * size;
    switch (entry.type) {
      case 1:
      case 7:
        out[i] = view.getUint8(at);
        break;
      case 6:
        out[i] = view.getInt8(at);
        break;
      case 3:
        out[i] = view.getUint16(at, little);
        break;
      case 8:
        out[i] = view.getInt16(at, little);
        break;
      case 4:
        out[i] = view.getUint32(at, little);
        break;
      case 9:
        out[i] = view.getInt32(at, little);
        break;
      case 11:
        out[i] = view.getFloat32(at, little);
        break;
      case 12:
        out[i] = view.getFloat64(at, little);
        break;
      default:
        throw new Error(`TIFF: field type ${entry.type} (tag ${entry.tag}) is not numeric`);
    }
  }
  return out;
}

function readAscii(view: DataView, entry: IfdEntry): string {
  let s = '';
  for (let i = 0; i < entry.count; i++) {
    const code = view.getUint8(entry.payload + i);
    if (code === 0) break;
    s += String.fromCharCode(code);
  }
  return s;
}

function parseNoData(entry: IfdEntry | undefined, view: DataView): number | undefined {
  if (!entry) return undefined;
  const text = readAscii(view, entry).trim();
  if (!text) return undefined;
  const first = text.split(/[\s,]+/)[0];
  const value = Number.parseFloat(first);
  return Number.isFinite(value) ? value : undefined;
}

function isNoDataValue(value: number, noData: number | undefined): boolean {
  if (!Number.isFinite(value)) return true;
  if (noData !== undefined && value === noData) return true;
  // Defensive sentinel check. Norway's DTM uses -32767 (and GDAL sometimes
  // writes -3.4e38 for float rasters); no real elevation in the service's
  // coverage is anywhere near -1000 m.
  return value <= -1000;
}

/**
 * Read a GeoTIFF into a raster. The resulting object owns a Float32Array copy;
 * the input buffer may be released.
 */
export function readTiffRaster(buffer: ArrayBuffer): Raster {
  const view = new DataView(buffer);
  if (buffer.byteLength < 8) {
    throw new Error(`TIFF: buffer is only ${buffer.byteLength} bytes, too short for a TIFF header`);
  }

  const byteOrder = view.getUint16(0, false);
  let little: boolean;
  if (byteOrder === 0x4949) little = true;
  else if (byteOrder === 0x4d4d) little = false;
  else {
    throw new Error(
      `TIFF: bad byte-order marker 0x${byteOrder.toString(16)} (expected 0x4949 'II' or 0x4d4d 'MM')`,
    );
  }

  const magic = view.getUint16(2, little);
  if (magic === 43) {
    throw new Error('TIFF: BigTIFF is not supported by this reader');
  }
  if (magic !== 42) {
    throw new Error(`TIFF: bad magic number ${magic} (expected 42)`);
  }

  const ifdOffset = view.getUint32(4, little);
  if (ifdOffset + 2 > buffer.byteLength) {
    throw new Error(`TIFF: IFD offset ${ifdOffset} is outside the ${buffer.byteLength}-byte buffer`);
  }

  const entryCount = view.getUint16(ifdOffset, little);
  const entries = new Map<number, IfdEntry>();
  for (let i = 0; i < entryCount; i++) {
    const at = ifdOffset + 2 + i * 12;
    if (at + 12 > buffer.byteLength) {
      throw new Error(`TIFF: IFD entry ${i} runs past the end of the buffer`);
    }
    const tag = view.getUint16(at, little);
    const type = view.getUint16(at + 2, little);
    const count = view.getUint32(at + 4, little);
    const size = TYPE_SIZE[type];
    if (size === undefined) continue; // unknown fields can be ignored
    const byteLength = size * count;
    let payload: number;
    if (byteLength <= 4) {
      // The value is stored inline in the entry itself.
      payload = at + 8;
    } else {
      payload = view.getUint32(at + 8, little);
      if (payload + byteLength > buffer.byteLength) {
        throw new Error(
          `TIFF: payload for tag ${tag} (${payload}+${byteLength}) runs past the end of the ${buffer.byteLength}-byte buffer`,
        );
      }
    }
    entries.set(tag, { tag, type, count, payload });
  }

  const numbers = (tag: number, fallback?: number): number[] => {
    const entry = entries.get(tag);
    if (!entry) {
      if (fallback !== undefined) return [fallback];
      throw new Error(`TIFF: required tag ${tag} is missing`);
    }
    return readEntryNumbers(view, entry, little);
  };
  const scalar = (tag: number, fallback?: number): number => {
    const values = numbers(tag, fallback);
    return values[0];
  };

  const width = scalar(TAG.ImageWidth);
  const height = scalar(TAG.ImageLength);
  if (!(width > 0 && height > 0)) {
    throw new Error(`TIFF: invalid image size ${width}×${height}`);
  }

  const samplesPerPixel = scalar(TAG.SamplesPerPixel, 1);
  if (samplesPerPixel !== 1) {
    throw new Error(`TIFF: only single-band rasters are supported (SamplesPerPixel=${samplesPerPixel})`);
  }
  const planar = scalar(TAG.PlanarConfiguration, 1);
  if (planar !== 1) {
    throw new Error(`TIFF: only PlanarConfiguration=1 is supported (got ${planar})`);
  }

  const bitsPerSample = scalar(TAG.BitsPerSample, 1);
  if (bitsPerSample !== 32) {
    throw new Error(`TIFF: only 32-bit samples are supported (BitsPerSample=${bitsPerSample})`);
  }
  const sampleFormat = scalar(TAG.SampleFormat, 1);
  if (sampleFormat !== 3) {
    throw new Error(`TIFF: only IEEE float samples are supported (SampleFormat=${sampleFormat})`);
  }

  const compression = scalar(TAG.Compression, 1);
  if (compression !== 1) {
    const name = COMPRESSION_NAMES[compression] ?? 'unknown';
    throw new Error(`TIFF: compression ${compression} (${name}) is not supported; expected uncompressed`);
  }

  const noData = parseNoData(entries.get(TAG.GDAL_NODATA), view);

  const tileWidth = entries.has(TAG.TileWidth) ? scalar(TAG.TileWidth) : undefined;
  const tileLength = entries.has(TAG.TileLength) ? scalar(TAG.TileLength) : undefined;

  const data = new Float32Array(width * height);
  data.fill(Number.NaN);

  if (tileWidth !== undefined && tileLength !== undefined) {
    assembleTiles({ view, little, entries, width, height, tileWidth, tileLength, noData, data });
  } else {
    assembleStrips({ view, little, entries, width, height, noData, data });
  }

  return {
    width,
    height,
    get(x: number, y: number): number {
      if (!Number.isInteger(x) || !Number.isInteger(y)) {
        throw new RangeError(`Raster.get requires integer pixel coordinates, got (${x}, ${y})`);
      }
      if (x < 0 || x >= width || y < 0 || y >= height) {
        throw new RangeError(`Raster.get(${x}, ${y}) is outside the ${width}×${height} raster`);
      }
      return data[y * width + x];
    },
  };
}

interface AssembleArgs {
  view: DataView;
  little: boolean;
  entries: Map<number, IfdEntry>;
  width: number;
  height: number;
  tileWidth?: number;
  tileLength?: number;
  noData: number | undefined;
  data: Float32Array;
}

/**
 * Copy every tile into the output grid.
 *
 * IMPORTANT: `TileOffsets` (324) and `TileByteCounts` (325) hold the list
 * inline when their count is 1, and an offset to the list when the count is
 * greater than 1. A 500×500 raster has 16 tiles → count 16 → an offset to an
 * array. Both cases are handled by `readEntryNumbers`, but the *grid* has to be
 * assembled in row-major tile order: tile index t maps to
 * (tx = t % across, ty = floor(t / across)).
 */
function assembleTiles(args: AssembleArgs): void {
  const { view, little, entries, width, height, tileWidth, tileLength, noData, data } = args;
  if (tileWidth === undefined || tileLength === undefined) {
    throw new Error('TIFF: internal error — tile dimensions missing for a tiled image');
  }

  const offsetsEntry = entries.get(TAG.TileOffsets);
  const countsEntry = entries.get(TAG.TileByteCounts);
  if (!offsetsEntry) throw new Error('TIFF: tiled image is missing TileOffsets (tag 324)');
  if (!countsEntry) throw new Error('TIFF: tiled image is missing TileByteCounts (tag 325)');

  const offsets = readEntryNumbers(view, offsetsEntry, little);
  const byteCounts = readEntryNumbers(view, countsEntry, little);

  const across = Math.ceil(width / tileWidth);
  const down = Math.ceil(height / tileLength);
  const expectedTiles = across * down;
  if (offsets.length < expectedTiles || byteCounts.length < expectedTiles) {
    throw new Error(
      `TIFF: image is ${width}×${height} with ${tileWidth}×${tileLength} tiles, which needs ${expectedTiles} tiles, ` +
        `but the file lists ${offsets.length} offsets and ${byteCounts.length} byte counts`,
    );
  }

  const fullTileBytes = tileWidth * tileLength * 4;

  for (let t = 0; t < expectedTiles; t++) {
    const tx = t % across;
    const ty = Math.floor(t / across);
    const x0 = tx * tileWidth;
    const y0 = ty * tileLength;
    const cols = Math.min(tileWidth, width - x0);
    const rows = Math.min(tileLength, height - y0);

    const offset = offsets[t];
    const byteCount = byteCounts[t];
    if (byteCount === 0) {
      // Empty tile: hoydedata.no returns offset 0 / byte count 0 for tiles
      // entirely outside coverage. Leave the region as NaN.
      continue;
    }

    let stride: number;
    if (byteCount === fullTileBytes) {
      stride = tileWidth;
    } else if (byteCount === cols * rows * 4) {
      // Writer packed the edge tile instead of padding it.
      stride = cols;
    } else {
      throw new Error(
        `TIFF: tile ${t} has ${byteCount} bytes; expected ${fullTileBytes} (full) or ${cols * rows * 4} (packed edge)`,
      );
    }
    if (offset < 0 || offset + byteCount > view.byteLength) {
      throw new Error(`TIFF: tile ${t} at offset ${offset}+${byteCount} runs past the end of the buffer`);
    }

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const value = view.getFloat32(offset + (row * stride + col) * 4, little);
        data[(y0 + row) * width + (x0 + col)] = isNoDataValue(value, noData) ? Number.NaN : value;
      }
    }
  }
}

/** Fallback for stripped TIFFs (not what hoydedata.no serves, but harmless). */
function assembleStrips(args: AssembleArgs): void {
  const { view, little, entries, width, height, noData, data } = args;

  const offsetsEntry = entries.get(TAG.StripOffsets);
  const countsEntry = entries.get(TAG.StripByteCounts);
  if (!offsetsEntry || !countsEntry) {
    throw new Error('TIFF: image is neither tiled (322/323/324/325) nor stripped (273/278/279)');
  }
  const offsets = readEntryNumbers(view, offsetsEntry, little);
  const byteCounts = readEntryNumbers(view, countsEntry, little);
  const rowsPerStrip = entries.has(TAG.RowsPerStrip) ? readEntryNumbers(view, entries.get(TAG.RowsPerStrip)!, little)[0] : height;

  for (let s = 0; s < offsets.length; s++) {
    const y0 = s * rowsPerStrip;
    if (y0 >= height) break;
    const rows = Math.min(rowsPerStrip, height - y0);
    const offset = offsets[s];
    const byteCount = byteCounts[s];
    if (byteCount === 0) continue;
    if (offset + byteCount > view.byteLength) {
      throw new Error(`TIFF: strip ${s} runs past the end of the buffer`);
    }
    const values = Math.floor(byteCount / 4);
    if (values < rows * width) {
      throw new Error(`TIFF: strip ${s} has only ${values} values, expected at least ${rows * width}`);
    }
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < width; col++) {
        const value = view.getFloat32(offset + (row * width + col) * 4, little);
        data[(y0 + row) * width + col] = isNoDataValue(value, noData) ? Number.NaN : value;
      }
    }
  }
}
