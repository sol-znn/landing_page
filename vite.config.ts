import { defineConfig, loadEnv } from 'vite'

/**
 * A static page with no server side and no secrets to substitute -- the only
 * thing worth configuring is where it will be served from, since that decides
 * the prefix on every asset URL.
 *
 * '/' covers both cases this page actually has: `npm run dev`, and the
 * deployed site, which is a custom domain (zenon.foo) serving from the root.
 * A project site on the plain https://<owner>.github.io/<repo>/ URL would need
 * '/<repo>/' instead, via LANDING_BASE_PATH -- get that wrong in either
 * direction and the assets 404 with no error anywhere, leaving an unstyled
 * page.
 */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    base: env.LANDING_BASE_PATH || '/',

    build: {
      target: 'es2022',
      rollupOptions: {
        // Two pages. Vite only builds index.html unless told about the rest,
        // and the projects index would be missing from dist with no error.
        input: { main: 'index.html', projects: 'projects/index.html' },
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
