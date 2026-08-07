import { cp, copyFile, mkdir } from 'node:fs/promises';

await mkdir('dist/.openai', { recursive: true });
await copyFile('.openai/hosting.json', 'dist/.openai/hosting.json');
await cp('drizzle', 'dist/.openai/drizzle', { recursive: true });
await copyFile('dist/server/entry.mjs', 'dist/server/index.js');
