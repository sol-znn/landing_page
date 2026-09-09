import { defineConfig, loadEnv } from 'vite'

/**
 * A static page with no server side and no secrets to substitute -- the only
 * thing worth configuring is where it will be served from, because GitHub
 * Pages serves a project site out of /<repo>/ and every asset URL has to be
 * prefixed accordingly. '/' is right for `npm run dev` and for a user site.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    base: env.LANDING_BASE_PATH || '/',

    build: {
      target: 'es2022',
      rollupOptions: {
        output: {
          // three.js is ~500kB and the page's own code is a few hundred lines;
          // splitting them means a cached renderer survives a copy change.
          manualChunks: (id: string) =>
            id.includes('node_modules/three') ? 'three' : undefined,
        },
      },
    },

    server: { port: 5181 },
  }
})
