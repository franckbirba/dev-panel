#!/usr/bin/env node

// Demo script for an external agent node connecting to the hub
// This would run on a separate machine (builder node) with no Redis or centralized secrets

import { connectAgentHub, claimTask, sendHeartbeat, sendResult } from '../src/worker/agent-hub-client.js';
import { randomUUID } from 'crypto';

// Node identity (would be pre-registered with the hub)
const NODE_ID = process.env.NODE_ID || randomUUID();
const NODE_NAME = process.env.NODE_NAME || 'demo-external-node';

// Task token (would be issued by the hub)
const TASK_TOKEN = process.env.TASK_TOKEN;

// Connect to the agent hub
const socket = connectAgentHub({
  url: process.env.AGENT_HUB_URL || 'http://localhost:3000/agents/socket.io',
  token: process.env.AGENT_HUB_TOKEN || 'test-shared-token'
});

socket.on('connect', async () => {
  console.log(`[${NODE_NAME}] Connected to agent hub`);
  
  try {
    // Claim a task using the provided token
    if (TASK_TOKEN) {
      console.log(`[${NODE_NAME}] Claiming task with token: ${TASK_TOKEN}`);
      const task = await claimTask(TASK_TOKEN);
      console.log(`[${NODE_NAME}] Successfully claimed task:`, task);
      
      // Simulate work with periodic heartbeats
      const workInterval = setInterval(async () => {
        try {
          await sendHeartbeat();
          console.log(`[${NODE_NAME}] Heartbeat sent for task ${task.id}`);
        } catch (error) {
          console.error(`[${NODE_NAME}] Failed to send heartbeat:`, error.message);
        }
      }, 30000); // Every 30 seconds
      
      // Simulate work completion
      setTimeout(async () => {
        clearInterval(workInterval);
        
        // Send result
        try {
          await sendResult(true, { 
            message: 'Task completed successfully', 
            files_modified: ['src/demo.js'],
            commits: ['abc123']
          });
          console.log(`[${NODE_NAME}] Task result sent successfully`);
        } catch (error) {
          console.error(`[${NODE_NAME}] Failed to send result:`, error.message);
        }
      }, 5000); // Complete after 5 seconds
    } else {
      console.log(`[${NODE_NAME}] No task token provided, exiting`);
    }
  } catch (error) {
    console.error(`[${NODE_NAME}] Failed to claim task:`, error.message);
  }
});

socket.on('disconnect', (reason) => {
  console.log(`[${NODE_NAME}] Disconnected from agent hub: ${reason}`);
});

socket.on('connect_error', (error) => {
  console.error(`[${NODE_NAME}] Connection error:`, error.message);
});