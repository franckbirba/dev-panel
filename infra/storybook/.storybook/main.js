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

    vite.resolve = vite.resolve || {};
    // Per-project "@" alias: a story under /stories/<slug>/foo.stories.jsx
    // that writes `import ... from "@/components/..."` resolves into that
    // project's own /stories/<slug>/_src/ subtree. We use the array form
    // with a customResolver so the rewrite depends on the *importer* path
    // (each project gets its own _src), instead of a single global "@".
    const perProjectAtAlias = {
      find: /^@\/(.+)$/,
      replacement: '$1',
      customResolver(source, importer) {
        const m = importer && importer.match(/^\/stories\/([^/]+)\//);
        const slug = m ? m[1] : 'devpanel';
        return this.resolve(`/stories/${slug}/_src/${source}`, importer, {
          skipSelf: true
        }).then((r) => (r ? r.id : null));
      }
    };
    const bareDepAliases = {
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
    const existing = vite.resolve.alias;
    const existingArr = Array.isArray(existing)
      ? existing
      : Object.entries(existing || {}).map(([find, replacement]) => ({ find, replacement }));
    vite.resolve.alias = [
      perProjectAtAlias,
      ...Object.entries(bareDepAliases).map(([find, replacement]) => ({ find, replacement })),
      ...existingArr
    ];

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
