import { inspectImage } from './media.mjs';

// sharp is an optional native dependency: hosts without workspace/node_modules
// still load the plugin; image uploads then stay disabled (never silently dropped).
let decoder;
export function loadDecoder(load = () => import('sharp')) {
 decoder ??= Promise.resolve().then(load).then(module => module.default ?? module, () => null);
 return decoder;
}

export async function verifyDecodedImage(image) {
 image = { ...image };
 const sharp = await loadDecoder();
 if (!sharp) throw Error('Image decoding is unavailable on this host');
 const bytes = Buffer.from(image.data, 'base64');
 inspectImage(bytes, image.mimeType);
 const pipeline = sharp(bytes, { failOn: 'warning', limitInputPixels: 16000000, animated: false });
 const metadata = await pipeline.metadata();
 if (!metadata.width || !metadata.height || (metadata.pages ?? 1) > 1) throw Error('Animated images are not supported');
 // Decode actual pixels: metadata alone accepts some truncated raster files.
 await pipeline.raw().toBuffer();
 return image;
}
