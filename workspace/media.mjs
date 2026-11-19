import { createHash, randomUUID } from 'node:crypto';

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export function inspectImage(bytes, declaredType) {
 if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > MAX_IMAGE_BYTES) throw Error('Image must be between 1 byte and 5 MiB');
 const detected = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ? 'image/png'
  : bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? 'image/jpeg'
  : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP' ? 'image/webp' : undefined;
 if (!detected || detected !== declaredType) throw Error('Only PNG, JPEG or WebP images with a matching signature are supported');
 return { mimeType: detected, size: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
}

export function validatePromptImages(images) {
 if (images === undefined) return [];
 if (!Array.isArray(images) || images.length > 4) throw Error('At most four images per message');
 let total = 0;
 return images.map(image => {
  if (!image || image.type !== 'image' || typeof image.data !== 'string' || image.data.length > Math.ceil(MAX_IMAGE_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) throw Error('Invalid image data');
  const bytes = Buffer.from(image.data, 'base64');
  if (bytes.toString('base64') !== image.data) throw Error('Invalid image encoding');
  const meta = inspectImage(bytes, image.mimeType); total += meta.size;
  if (total > MAX_IMAGE_BYTES) throw Error('Combined images exceed 5 MiB');
  return { type: 'image', mimeType: meta.mimeType, data: image.data };
 });
}

// Ephemeral staging only. The caller must derive scope from its authenticated
// principal + agent + session, never accept a browser-supplied principal.
export function createMediaStore({ now = Date.now, ttlMs = 10 * 60 * 1000, maxBytes = 20 * 1024 * 1024, maxItems = 128, maxPending = 64 } = {}) {
 const items = new Map(); let used = 0;
 function sweep() { for (const [id, item] of items) if (item.expires <= now()) { items.delete(id); used -= item.data.length; } }
 const pending = new Map();
 function prunePending() { for (const [id, item] of pending) if (item.expires <= now()) pending.delete(id); }
 return {
  chunk(scope, { uploadId, index, data, mimeType, final = false }) {
   sweep(); prunePending();
   if (typeof scope !== 'string' || !scope || typeof uploadId !== 'string' || !/^[a-f0-9-]{36}$/.test(uploadId) || !Number.isSafeInteger(index) || index < 0 || typeof data !== 'string' || data.length > 64000 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) throw Error('Invalid upload chunk');
   const bytes = Buffer.from(data, 'base64');
   if (!bytes.length || index >= 128) throw Error('Empty upload chunk or chunk count limit reached');
   if (bytes.toString('base64') !== data) throw Error('Invalid upload encoding');
   let item = pending.get(uploadId);
   if (!item) {
    // Per-conversation slots: one scope's unfinished uploads never block another's.
    if (index !== 0 || pending.size >= maxPending || [...pending.values()].filter(upload => upload.scope === scope).length >= 4) throw Error('Upload unavailable or capacity reached');
    item = { scope, mimeType, chunks: [], size: 0, expires: now() + ttlMs }; pending.set(uploadId, item);
   }
   if (item.scope !== scope || item.mimeType !== mimeType || item.chunks.length !== index || typeof final !== 'boolean') throw Error('Upload scope or sequence mismatch');
   if (item.size + bytes.length > MAX_IMAGE_BYTES || used + [...pending.values()].reduce((sum, upload) => sum + upload.size, 0) + bytes.length > maxBytes) { pending.delete(uploadId); throw Error('Image exceeds 5 MiB'); }
   item.chunks.push(bytes); item.size += bytes.length;
   if (!final) return { uploadId, next: index + 1 };
   pending.delete(uploadId);
   return this.put(scope, Buffer.concat(item.chunks), mimeType);
  },
  put(scope, bytes, mimeType) {
   if (typeof scope !== 'string' || !scope) throw Error('Authenticated upload scope required');
   sweep(); prunePending(); const meta = inspectImage(bytes, mimeType);
   if (items.size >= maxItems || used + [...pending.values()].reduce((sum, upload) => sum + upload.size, 0) + bytes.length > maxBytes) throw Error('Upload capacity reached');
   const id = randomUUID(); const data = Buffer.from(bytes);
   items.set(id, { scope, data, ...meta, expires: now() + ttlMs }); used += data.length;
   return { id, ...meta };
  },
  get(scope, id) {
   sweep(); const item = items.get(id);
   if (!item || item.scope !== scope) throw Error('Image unavailable in this conversation');
   return { type: 'image', mimeType: item.mimeType, data: item.data.toString('base64') };
  },
  remove(scope, id) {
   sweep(); const item = items.get(id);
   if (!item || item.scope !== scope) return false;
   items.delete(id); used -= item.data.length; return true;
  },
 };
}
