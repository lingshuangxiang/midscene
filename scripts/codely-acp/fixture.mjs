import { deflateSync } from 'node:zlib';

export const fixtureSize = { width: 800, height: 600 };
export const targetBounds = [500, 360, 700, 480];

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([length, name, data, checksum]);
}

// A dependency-free, reproducible visual target. Expected geometry is kept
// outside the prompt, so the model must inspect the image to locate it.
export function createFixturePng() {
  const { width, height } = fixtureSize;
  const stride = width * 3 + 1;
  const pixels = Buffer.alloc(stride * height, 255);
  for (let y = 0; y < height; y++) pixels[y * stride] = 0;
  const rectangle = ([left, top, right, bottom], color) => {
    for (let y = top; y < bottom; y++) {
      for (let x = left; x < right; x++) {
        const offset = y * stride + 1 + x * 3;
        pixels.set(color, offset);
      }
    }
  };
  rectangle([20, 20, 780, 60], [226, 232, 240]);
  rectangle([80, 100, 280, 210], [37, 99, 235]);
  rectangle([340, 80, 480, 200], [22, 163, 74]);
  rectangle(targetBounds, [220, 38, 38]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function parseLocateResponse(text, expectedFound) {
  // Deliberately strict: protocol JSON does not guarantee JSON model content.
  const result = JSON.parse(text.trim());
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error('Expected a JSON object');
  }
  if (result.found !== expectedFound) {
    throw new Error(`Expected found=${expectedFound}, got ${result.found}`);
  }
  if (result.coordinateSystem !== 'pixels') {
    throw new Error('Expected coordinateSystem="pixels"');
  }
  const { bbox, center } = result;
  if (!expectedFound) {
    if (bbox !== null || center !== null) {
      throw new Error('An absent target must have null bbox and center');
    }
    return result;
  }
  if (
    !Array.isArray(bbox) ||
    bbox.length !== 4 ||
    !bbox.every(Number.isFinite) ||
    !Array.isArray(center) ||
    center.length !== 2 ||
    !center.every(Number.isFinite)
  ) {
    throw new Error('Expected finite bbox[4] and center[2]');
  }
  const [left, top, right, bottom] = bbox;
  const [x, y] = center;
  if (
    left < 0 ||
    top < 0 ||
    right > fixtureSize.width ||
    bottom > fixtureSize.height ||
    left >= right ||
    top >= bottom ||
    x < left ||
    x > right ||
    y < top ||
    y > bottom
  ) {
    throw new Error(
      'Coordinates are unordered, out of image bounds, or inconsistent',
    );
  }
  if (bbox.some((value, index) => Math.abs(value - targetBounds[index]) > 20)) {
    throw new Error(
      'Target bbox differs from the fixture by more than 20 pixels',
    );
  }
  if (Math.abs(x - 600) > 15 || Math.abs(y - 420) > 15) {
    throw new Error(
      'Target center differs from the fixture by more than 15 pixels',
    );
  }
  return result;
}
