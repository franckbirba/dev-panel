import React from 'react';
import { SignalRow } from '../../src/dashboard/components/signal-row.jsx';

export default {
  title: 'devpanel/SignalRow',
  component: SignalRow,
  parameters: { backgrounds: { default: 'devpanel-dark' } },
  args: {
    onSelect: () => {},
    onPrioritySet: () => {},
    isSelected: false,
  },
};

export const CaptureNew = {
  args: {
    signal: {
      subject_type: 'capture',
      subject_id: 'cap_123',
      signal_type: 'capture',
      title: 'Dashboard sidebar breaks on narrow viewport',
      urgency: 'needs_attention',
      priority: 'now',
      age_min: 12,
      project_name: 'zeno',
      has_screenshot: true,
    },
  },
};

export const JobFailed = {
  args: {
    signal: {
      subject_type: 'job',
      subject_id: 'job_789',
      signal_type: 'failed_job',
      title: 'Deploy zeno — npm test failed',
      urgency: 'needs_attention',
      priority: 'today',
      age_min: 45,
      project_name: 'zeno',
      has_screenshot: false,
    },
  },
};

export const WorkflowRunning = {
  args: {
    signal: {
      subject_type: 'workflow',
      subject_id: 'wf_456',
      signal_type: 'workflow_running',
      title: 'Build & deploy agent-stack',
      urgency: 'in_flight',
      priority: 'later',
      age_min: 3,
      project_name: 'dev-panel',
      has_screenshot: false,
    },
  },
};

export const WorkflowFinished = {
  args: {
    signal: {
      subject_type: 'workflow',
      subject_id: 'wf_101',
      signal_type: 'workflow_finished',
      title: 'Fix login redirect — shipped',
      urgency: 'fyi',
      priority: 'later',
      age_min: 92,
      project_name: 'edms',
      has_screenshot: false,
    },
  },
};

export const Selected = {
  args: {
    isSelected: true,
    signal: {
      subject_type: 'capture',
      subject_id: 'cap_999',
      signal_type: 'capture',
      title: 'Currently selected row example',
      urgency: 'in_flight',
      priority: 'today',
      age_min: 5,
      project_name: 'dev-panel',
      has_screenshot: false,
    },
  },
};
