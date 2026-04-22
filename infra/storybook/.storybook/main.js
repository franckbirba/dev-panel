import path from 'path';
import tailwindcss from '@tailwindcss/vite';

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
    vite.plugins.push(tailwindcss());

    vite.resolve = vite.resolve || {};
    vite.resolve.alias = {
      ...(vite.resolve.alias || {}),
      // Per-project "@" alias: a story under /stories/<slug>/foo.stories.jsx
      // that writes `import ... from "@/components/..."` resolves into that
      // project's own /stories/<slug>/_src/ subtree. Source trees are copied
      // into _src/ by the sync workflow.
      '@': '/stories/devpanel/_src',
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
