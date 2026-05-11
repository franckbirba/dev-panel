import path from 'path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';

/** @type { import('@storybook/react-vite').StorybookConfig } */
const config = {
  stories: ['/stories/**/*.mdx', '/stories/**/*.stories.@(js|jsx|ts|tsx)'],
  addons: ['@storybook/addon-essentials'],
  framework: {
    name: '@storybook/react-vite',
    options: {}
  },
  core: {
    disableTelemetry: true,
    disableWhatsNewNotifications: true
  },
  async viteFinal(vite) {
    vite.plugins = vite.plugins || [];
    // Re-apply the React plugin with explicit include covering /stories/.
    // Storybook's default react plugin instance only transforms files under
    // /app; JSX in synced source trees would otherwise compile with the
    // classic runtime (requires `import React`), breaking rendering.
    vite.plugins.push(react({ include: ['/stories/**/*.{js,jsx,ts,tsx}'] }));
    vite.plugins.push(tailwindcss());

    // Per-project "@" alias resolved via a Vite plugin (not resolve.alias)
    // so the rewrite depends on the *importer* path. A story under
    // /stories/<slug>/foo.stories.jsx that writes `import ... from "@/..."`
    // resolves into its own project's /stories/<slug>/_src/ subtree.
    // resolve.alias's customResolver isn't reliably invoked by Vite's
    // dependency scanner, so we use the plugin pipeline instead.
    vite.plugins.push({
      name: 'devpanl-per-project-at-alias',
      enforce: 'pre',
      async resolveId(source, importer) {
        if (!source.startsWith('@/') || !importer) return null;
        const m = importer.match(/^\/stories\/([^/]+)\//);
        if (!m) return null;
        const slug = m[1];
        const rest = source.slice(2);
        // Roots to try, in priority order:
        //   1. /stories/<slug>/_src/<rest>            (when source-path covers a parent dir, e.g. src/dashboard)
        //   2. /stories/<slug>/_src/<rest sans leading "components/">
        //      (when source-path IS the components dir, e.g. apps/chat/components → _src/devpanl/...)
        const roots = [`/stories/${slug}/_src/${rest}`];
        if (rest.startsWith('components/')) {
          roots.push(`/stories/${slug}/_src/${rest.slice('components/'.length)}`);
        }
        const exts = ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts', '/index.jsx', '/index.js'];
        for (const root of roots) {
          for (const ext of exts) {
            const r = await this.resolve(root + ext, importer, { skipSelf: true });
            if (r) return r.id;
          }
        }
        return null;
      }
    });

    vite.resolve = vite.resolve || {};
    vite.resolve.alias = {
      ...(vite.resolve.alias || {}),
      // Bare-import deps used by synced source trees won't resolve up from
      // /stories/ to /app/node_modules on their own. Pin each one to the
      // container's own installed copy.
      'radix-ui': '/app/node_modules/radix-ui',
      'class-variance-authority': '/app/node_modules/class-variance-authority',
      'clsx': '/app/node_modules/clsx',
      'tailwind-merge': '/app/node_modules/tailwind-merge',
      'react': '/app/node_modules/react',
      'react-dom': '/app/node_modules/react-dom'
    };

    // /stories/ is bind-mounted outside of /app, so Vite's default
    // node_modules lookup from a story file won't find the storybook
    // container's own node_modules. Force it.
    vite.server = vite.server || {};
    vite.server.fs = vite.server.fs || {};
    vite.server.fs.allow = ['/app', '/stories'];

    vite.optimizeDeps = vite.optimizeDeps || {};
    vite.optimizeDeps.include = [
      ...(vite.optimizeDeps.include || []),
      'tailwind-merge',
      'clsx',
      'class-variance-authority',
      'radix-ui'
    ];

    return vite;
  }
};

export default config;
