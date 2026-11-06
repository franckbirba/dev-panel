import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

describe('crons configuration', () => {
  it('should contain both morning and evening digest cron jobs', () => {
    // Read the crons file directly to check its content
    const cronsPath = join(__dirname, '../../src/worker/crons.js');
    const cronsContent = readFileSync(cronsPath, 'utf8');
    
    // Check that both cron jobs are defined
    expect(cronsContent).toContain('shelly:morning-digest');
    expect(cronsContent).toContain('shelly:evening-digest');
    
    // Check that the evening digest has the correct digest_type
    expect(cronsContent).toContain('digest_type: \'evening\'');
    
    // Check that both cron jobs have the correct timezone
    expect(cronsContent).toContain('DEPLOY_TIMEZONE || \'Europe/Paris\'');
  });

  it('should have correct cron schedules', () => {
    const cronsPath = join(__dirname, '../../src/worker/crons.js');
    const cronsContent = readFileSync(cronsPath, 'utf8');
    
    // Morning digest at 07:00
    expect(cronsContent).toMatch(/0 7 \* \* \*/);
    
    // Evening digest at 19:00
    expect(cronsContent).toMatch(/0 19 \* \* \*/);
  });
});