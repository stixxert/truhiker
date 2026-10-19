import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { readTiffRaster } from '../src/core/tiff';
import { buildTiff } from './helpers/tiff-writer';

function fixtureBuffer(name: string): ArrayBuffer {
  const path = fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
  const nodeBuffer = readFileSync(path);
  return nodeBuffer.buffer.slice(
    nodeBuffer.byteOffset,
    nodeBuffer.byteOffset + nodeBuffer.byteLength,
  ) as ArrayBuffer;
}

function syntheticRamp(width: number, height: number): Float32Array {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // A value that is unique per pixel and survives float32 exactly.
      data[y * width + x] = x * 100 + y + 0.5;
    }
  }
  return data;
}

describe('readTiffRaster — synthetic multi-tile rasters', () => {
  it('assembles every tile of a multi-tile image, handles clipped edges and inline single-tile offsets', () => {
    const width = 500;
    const height = 500;
    const data = syntheticRamp(width, height);
    const raster = readTiffRaster(
      buildTiff({ width, height, tileWidth: 128, tileLength: 128, data }),
    );
    expect(raster.width).toBe(500);
    expect(raster.height).toBe(500);

    // Sampled on a stride rather than 250 000 assertions: a reader that only
    // handles TileOffsets[0] fails from x = 128 onwards, and one that misreads
    // the offset array as an inline value fails almost everywhere.
    let checked = 0;
    for (let y = 0; y < height; y += 13) {
      for (let x = 0; x < width; x += 13) {
        expect(raster.get(x, y)).toBe(data[y * width + x]);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1000);

    // Spot-check across all four tile columns/rows, including the last pixel.
    for (const [x, y] of [
      [0, 0],
      [127, 127],
      [128, 0],
      [0, 128],
      [255, 255],
      [256, 256],
      [383, 383],
      [384, 384],
      [499, 499],
    ] as const) {
      expect(raster.get(x, y)).toBe(data[y * width + x]);
    }

    // A single tile stores TileOffsets/TileByteCounts inline.
    const inlineData = syntheticRamp(128, 128);
    const single = readTiffRaster(buildTiff({ width: 128, height: 128, data: inlineData }));
    for (const [x, y] of [
      [0, 0],
      [64, 64],
      [127, 0],
      [0, 127],
      [127, 127],
    ] as const) {
      expect(single.get(x, y)).toBe(inlineData[y * 128 + x]);
    }

    // A 300×200 image has tiles clipped at the edges.
    const clippedWidth = 300;
    const clippedHeight = 200;
    const clippedData = syntheticRamp(clippedWidth, clippedHeight);
    const clipped = readTiffRaster(buildTiff({ width: clippedWidth, height: clippedHeight, data: clippedData }));
    for (let y = 0; y < clippedHeight; y += 7) {
      for (let x = 0; x < clippedWidth; x += 11) {
        expect(clipped.get(x, y)).toBe(clippedData[y * clippedWidth + x]);
      }
    }
  });

  it('maps NoData and empty (zero-byte) tiles to NaN', () => {
    const width = 64;
    const height = 64;
    const data = new Float32Array(width * height).fill(500);
    data[10 * width + 20] = -32767;
    data[11 * width + 21] = -3.4e38;
    const raster = readTiffRaster(buildTiff({ width, height, data, noData: -32767 }));
    expect(Number.isNaN(raster.get(20, 10))).toBe(true);
    expect(Number.isNaN(raster.get(21, 11))).toBe(true);
    expect(raster.get(19, 10)).toBe(500);

    // hoydedata.no returns offset 0 / byte count 0 outside coverage.
    const bigWidth = 300;
    const bigHeight = 300;
    const bigData = syntheticRamp(bigWidth, bigHeight);
    const empty = readTiffRaster(buildTiff({ width: bigWidth, height: bigHeight, data: bigData, emptyTiles: [0, 5] }));
    expect(Number.isNaN(empty.get(0, 0))).toBe(true);
    expect(Number.isNaN(empty.get(127, 127))).toBe(true);
    // Tile 5 = row 1, column 2 → x 256..299, y 128..255
    expect(Number.isNaN(empty.get(256, 128))).toBe(true);
    expect(Number.isNaN(empty.get(299, 255))).toBe(true);
    // Tile 1 (x 128..255, y 0..127) is intact.
    expect(empty.get(200, 50)).toBe(bigData[50 * bigWidth + 200]);
  });

  it('throws on unsupported compression and rejects out-of-bounds or non-integer pixel access', () => {
    const data = new Float32Array(64 * 64).fill(1);
    expect(() =>
      readTiffRaster(buildTiff({ width: 64, height: 64, data, compression: 8 })),
    ).toThrow(/compression 8 \(Deflate\) is not supported/);

    const raster = readTiffRaster(
      buildTiff({ width: 4, height: 4, tileWidth: 4, tileLength: 4, data: new Float32Array(16).fill(1) }),
    );
    expect(() => raster.get(4, 0)).toThrow(RangeError);
    expect(() => raster.get(-1, 0)).toThrow(RangeError);
    expect(() => raster.get(0.5, 0)).toThrow(RangeError);
  });
});

describe('readTiffRaster — real hoydedata.no response', () => {
  it('decodes the captured 128×128 Galdhøpiggen window', () => {
    // Captured with:
    //   curl -o galdhopiggen-128.tif \
    //     'https://hoydedata.no/arcgis/rest/services/DTM/ImageServer/exportImage?bbox=145496,6851374,146496,6852374&bboxSR=25833&imageSR=25833&size=128,128&format=tiff&f=image'
    const raster = readTiffRaster(fixtureBuffer('galdhopiggen-128.tif'));

    expect(raster.width).toBe(128);
    expect(raster.height).toBe(128);

    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    for (let y = 0; y < raster.height; y++) {
      for (let x = 0; x < raster.width; x++) {
        const v = raster.get(x, y);
        expect(Number.isFinite(v)).toBe(true);
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }

    // The Galdhøpiggen anchor: 2469 ± 5 m (the service's local maximum is
    // 2467.8 m). This is the real-world check that the IFD, sample format and
    // tile assembly are right — garbage decoding gives min 0 / max 2185.
    expect(max).toBeGreaterThan(2464);
    expect(max).toBeLessThan(2474);
    expect(max).toBeCloseTo(2467.81, 1);
    expect(min).toBeCloseTo(2075.03, 1);

    // The nominal summit coordinate sits at pixel (64, 64) in this window.
    expect(raster.get(64, 64)).toBeCloseTo(2460.29, 1);
  });
});
