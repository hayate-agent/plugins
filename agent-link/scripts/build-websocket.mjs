import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { copyFile } from 'node:fs/promises';
const root = fileURLToPath(new URL('../', import.meta.url));
await build({ absWorkingDir: root, stdin: { contents: "export { default as WebSocket, WebSocketServer } from 'ws';", resolveDir: root }, bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: root + 'vendor/websocket.mjs', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
await copyFile(root + 'node_modules/ws/LICENSE', root + 'vendor/ws-LICENSE');
