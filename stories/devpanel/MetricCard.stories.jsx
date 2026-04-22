import React from 'react';
import { MetricCard } from '../../src/dashboard/components/metric-card.jsx';

export default {
  title: 'devpanel/MetricCard',
  component: MetricCard,
  parameters: { backgrounds: { default: 'devpanel-dark' } },
};

export const Default = {
  args: {
    label: 'Captures today',
    value: 14,
    delta: '+3 vs yesterday',
  },
};

export const WithAccent = {
  args: {
    label: 'Failed jobs',
    value: 2,
    delta: '↑ 2 since 09:00',
    accent: 'text-red-400',
  },
};

export const Zero = {
  args: {
    label: 'Shipped',
    value: 0,
    delta: 'no change',
    accent: 'text-muted-foreground',
  },
};

export const LargeNumber = {
  args: {
    label: 'Total tickets',
    value: 1284,
    delta: '+12 this week',
  },
};
