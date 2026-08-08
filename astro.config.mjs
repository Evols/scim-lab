// @ts-check
import { defineConfig } from 'astro/config';
import node from '@astrojs/node';
import tailwindcss from '@tailwindcss/vite';

// https://astro.build/config
export default defineConfig({
	output: 'server',
	session: false,
	adapter: node({ mode: 'standalone', bodySizeLimit: 1_048_576 }),
	server: {
		allowedHosts: true,
	},

	vite: {
		plugins: [tailwindcss()],
	},
});
