// src/modules/preview-runner.js
import { execSync, spawn } from 'child_process';
import { join } from 'path';

/**
 * Preview Runner Module
 * Launches docker-compose services and monitors their status
 */

export class PreviewRunner {
  constructor(worktreePath) {
    this.worktreePath = worktreePath;
    this.projectName = this.generateProjectName(worktreePath);
  }

  generateProjectName(worktreePath) {
    // Generate a unique project name based on worktree path
    return `preview_${worktreePath.split('/').pop()}_${Date.now()}`;
  }

  /**
   * Start the preview services
   * @returns {Promise<{success: boolean, services: Array<Object>, preview_url: string|null}>}
   */
  async start() {
    try {
      // Check if docker-compose is available
      this.checkDockerCompose();

      // Navigate to worktree and start services
      const composeFile = join(this.worktreePath, 'docker-compose.yml');
      
      // Up the services
      execSync(`docker compose -f ${composeFile} -p ${this.projectName} up -d`, {
        cwd: this.worktreePath,
        stdio: 'inherit'
      });

      // Wait for services to be healthy with timeout
      const servicesStatus = await this.waitForHealth(60000); // 60 seconds timeout
      
      // Get the frontend port
      const frontendPort = this.getServicePort('frontend');
      
      return {
        success: true,
        services: servicesStatus,
        preview_url: frontendPort ? `http://localhost:${frontendPort}` : null
      };
    } catch (error) {
      return {
        success: false,
        error: error.message,
        services: [],
        preview_url: null
      };
    }
  }

  /**
   * Stop the preview services
   * @returns {Promise<{success: boolean}>}
   */
  async stop() {
    try {
      const composeFile = join(this.worktreePath, 'docker-compose.yml');
      
      // Down the services for this specific project only
      execSync(`docker compose -f ${composeFile} -p ${this.projectName} down`, {
        cwd: this.worktreePath,
        stdio: 'inherit'
      });
      
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  /**
   * Check if docker-compose is available
   */
  checkDockerCompose() {
    try {
      execSync('docker compose version', { stdio: 'ignore' });
    } catch (error) {
      throw new Error('docker compose v2 is required but not found. Please install Docker Desktop or docker-compose v2.');
    }
  }

  /**
   * Wait for services to become healthy
   * @param {number} timeoutMs - Timeout in milliseconds
   * @returns {Promise<Array<Object>>}
   */
  async waitForHealth(timeoutMs) {
    const startTime = Date.now();
    const composeFile = join(this.worktreePath, 'docker-compose.yml');
    
    while (Date.now() - startTime < timeoutMs) {
      try {
        const statusOutput = execSync(
          `docker compose -f ${composeFile} -p ${this.projectName} ps --format json`,
          { cwd: this.worktreePath, encoding: 'utf8' }
        );
        
        const services = statusOutput.trim().split('\n')
          .filter(line => line.trim())
          .map(line => JSON.parse(line));
        
        // Check if all services are running and healthy
        const allHealthy = services.every(service => 
          service.State === 'running' && 
          (service.Health === 'healthy' || service.Health === '')
        );
        
        if (allHealthy) {
          return services.map(service => ({
            name: service.Service,
            status: service.State,
            health: service.Health || 'unknown'
          }));
        }
        
        // Wait before checking again
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (error) {
        // Continue trying until timeout
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }
    
    throw new Error('Services did not become healthy within timeout period');
  }

  /**
   * Get the published port for a service
   * @param {string} serviceName - Name of the service
   * @returns {string|null} - Port number or null
   */
  getServicePort(serviceName) {
    try {
      const composeFile = join(this.worktreePath, 'docker-compose.yml');
      const portOutput = execSync(
        `docker compose -f ${composeFile} -p ${this.projectName} port ${serviceName} 3000`,
        { cwd: this.worktreePath, encoding: 'utf8' }
      ).trim();
      
      // Extract port from "0.0.0.0:PORT" format
      const match = portOutput.match(/:(\d+)$/);
      return match ? match[1] : null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get current status of all services
   * @returns {Array<Object>}
   */
  getServicesStatus() {
    try {
      const composeFile = join(this.worktreePath, 'docker-compose.yml');
      const statusOutput = execSync(
        `docker compose -f ${composeFile} -p ${this.projectName} ps --format json`,
        { cwd: this.worktreePath, encoding: 'utf8' }
      );
      
      return statusOutput.trim().split('\n')
        .filter(line => line.trim())
        .map(line => {
          const service = JSON.parse(line);
          return {
            name: service.Service,
            status: service.State,
            health: service.Health || 'unknown'
          };
        });
    } catch (error) {
      return [];
    }
  }
}

/**
 * Factory function to create a preview runner for a worktree
 * @param {string} worktreePath - Path to the worktree
 * @returns {PreviewRunner}
 */
export function createPreviewRunner(worktreePath) {
  return new PreviewRunner(worktreePath);
}