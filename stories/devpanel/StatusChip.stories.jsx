import React from 'react';
import { StatusChip } from '../../src/dashboard/components/status-chip.jsx';

export default {
  title: 'devpanel/StatusChip',
  component: StatusChip,
  parameters: { backgrounds: { default: 'devpanel-dark' } },
  argTypes: {
    type: {
      control: 'select',
      options: ['bug', 'feature', 'published', 'rejected', 'pending', 'synced', 'created', 'updated', 'healthy', 'warning'],
    },
  },
};

export const Bug      = { args: { type: 'bug',       label: 'bug' } };
export const Feature  = { args: { type: 'feature',   label: 'feature' } };
export const Published = { args: { type: 'published', label: 'published' } };
export const Rejected = { args: { type: 'rejected',  label: 'rejected' } };
export const Pending  = { args: { type: 'pending',   label: 'pending' } };
export const Synced   = { args: { type: 'synced',    label: 'synced' } };
export const Created  = { args: { type: 'created',   label: 'created' } };
export const Updated  = { args: { type: 'updated',   label: 'updated' } };
export const Healthy  = { args: { type: 'healthy',   label: 'healthy' } };
export const Warning  = { args: { type: 'warning',   label: 'warning' } };
