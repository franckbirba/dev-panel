import '@/app.css';

/** @type { import('@storybook/react').Preview } */
const preview = {
  parameters: {
    backgrounds: {
      default: 'devpanel-dark',
      values: [
        { name: 'devpanel-dark', value: '#0A0A0B' },
        { name: 'light', value: '#FFFFFF' }
      ]
    },
    options: {
      storySort: {
        order: ['shared', 'devpanel', 'zeno', 'edms', 'candidat', '*']
      }
    }
  }
};

export default preview;
