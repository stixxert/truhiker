/**
 * A synthetic elevation source for the browser gates.
 *
 * `e2e.mjs` and `a11y.mjs` drive the real app through the real elevation
 * pipeline, but that pipeline fetches Kartverket's DTM from hoydedata.no. A live
 * service must not be able to decide the gate: hoydedata has answered 503 for
 * extended periods, and when it does, the profile never arrives — the energy
 * panel has nothing to report, the chart has no cursor to move, and a green
 * build looks broken.
 *
 * So the gates serve a synthetic DEM instead: an uncompressed 32-bit float
 * GeoTIFF, which is exactly what the service returns, with a gentle north-south
 * gradient so ascent, descent, time and energy all have a real range. Correct
 * elevation *values* are not what these gates test — `test/dem.test.ts`,
 * `test/profile.test.ts` and `npm run test:live` own that.
 *
 * The reader (`src/core/tiff.ts`) needs: width, height, one 32-bit IEEE-float
 * sample per pixel, uncompressed, single strip. No georeferencing: the app maps
 * pixels with the bbox it requested, not with TIFF tags.
 */

/** Bytes reserved for the IFD before the pixel data. */
const IFD_OFFSET = 8;
const DATA_OFFSET = 512;

const TAG = {
  imageWidth: 256,
  imageLength: 257,
  bitsPerSample: 258,
  compression: 259,
  photometric: 262,
  stripOffsets: 273,
  samplesPerPixel: 277,
  rowsPerStrip: 278,
  stripByteCounts: 279,
  planarConfig: 284,
  sampleFormat: 339,
};

const SHORT = 3;
const LONG = 4;

/**
 * Build a float32 GeoTIFF of `width` × `height` whose elevation rises from
 * 900 m in the south to 1,500 m in the north.
 */
export function syntheticDemTiff(width, height) {
  const byteCount = width * height * 4;
  const buffer = Buffer.alloc(DATA_OFFSET + byteCount);
  buffer.write('II', 0, 'ascii');
  buffer.writeUInt16LE(42, 2);
  buffer.writeUInt32LE(IFD_OFFSET, 4);

  const entries = [
    [TAG.imageWidth, SHORT, width],
    [TAG.imageLength, SHORT, height],
    [TAG.bitsPerSample, SHORT, 32],
    [TAG.compression, SHORT, 1],
    [TAG.photometric, SHORT, 1],
    [TAG.stripOffsets, LONG, DATA_OFFSET],
    [TAG.samplesPerPixel, SHORT, 1],
    [TAG.rowsPerStrip, LONG, height],
    [TAG.stripByteCounts, LONG, byteCount],
    [TAG.planarConfig, SHORT, 1],
    [TAG.sampleFormat, SHORT, 3],
  ];

  let cursor = IFD_OFFSET;
  buffer.writeUInt16LE(entries.length, cursor);
  cursor += 2;
  for (const [tag, type, value] of entries) {
    buffer.writeUInt16LE(tag, cursor);
    buffer.writeUInt16LE(type, cursor + 2);
    buffer.writeUInt32LE(1, cursor + 4);
    // Every value fits in the 4-byte inline field.
    buffer.writeUInt32LE(value >>> 0, cursor + 8);
    cursor += 12;
  }
  buffer.writeUInt32LE(0, cursor);

  for (let y = 0; y < height; y++) {
    const elevation = 900 + 600 * (1 - y / Math.max(1, height - 1));
    for (let x = 0; x < width; x++) {
      buffer.writeFloatLE(elevation, DATA_OFFSET + (y * width + x) * 4);
    }
  }
  return buffer;
}

/** Serve the synthetic DEM for every `exportImage` request the page makes. */
export async function stubDem(page) {
  await page.route('**/hoydedata.no/**/exportImage*', (route) => {
    const url = new URL(route.request().url());
    const [rawWidth, rawHeight] = (url.searchParams.get('size') ?? '64,64').split(',');
    const width = Number(rawWidth) || 64;
    const height = Number(rawHeight) || 64;
    return route.fulfill({
      status: 200,
      contentType: 'image/tiff',
      body: syntheticDemTiff(width, height),
    });
  });
}
