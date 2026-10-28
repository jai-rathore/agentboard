// Animated GIF of a replay: PNG screenshots, 2x box-downscaled to 480x300, one shared-quality palette per frame.
import { PNG } from "pngjs";
import gifenc from "gifenc";
const { GIFEncoder, quantize, applyPalette } = gifenc;

function half(png) {
  const w = png.width >> 1, h = png.height >> 1, out = new Uint8Array(w * h * 4), s = png.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    for (let c = 0; c < 4; c++) {
      const i = ((2 * y) * png.width + 2 * x) * 4 + c, j = i + png.width * 4;
      out[(y * w + x) * 4 + c] = (s[i] + s[i + 4] + s[j] + s[j + 4]) >> 2;
    }
  }
  return { w, h, data: out };
}

/** frames: PNG buffers. Returns a GIF Buffer (last frame held longer). */
export function makeGif(frames, delayMs = 900) {
  const gif = GIFEncoder();
  frames.forEach((buf, i) => {
    const { w, h, data } = half(PNG.sync.read(buf));
    const palette = quantize(data, 128);
    gif.writeFrame(applyPalette(data, palette), w, h, { palette, delay: i === frames.length - 1 ? 2500 : delayMs });
  });
  gif.finish();
  return Buffer.from(gif.bytes());
}
