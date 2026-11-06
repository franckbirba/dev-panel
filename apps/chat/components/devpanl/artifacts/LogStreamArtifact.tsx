// LogStreamArtifact.tsx - Live tail of dispatched job logs
//
// Wraps existing WorkbenchLogs plumbing with job-specific scoping.

import { useState, useEffect } from "react";
import { LogStreamArtifact as LogStreamArtifactType } from "@/lib/artifact-registry";
import { WorkbenchLogs } from "../WorkbenchLogs";

interface LogEntry {
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR";
  source: string;
  message: string;
}

export function LogStreamArtifactView({ artifact }: { artifact: LogStreamArtifactType }) {
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connectionState, setConnectionState] = useState<"connecting" | "connected" | "disconnected">("connecting");

  // Simulate log streaming - in a real implementation, this would connect to the actual job logs
  useEffect(() => {
    setConnectionState("connecting");
    
    // Simulate connection delay
    const connectTimer = setTimeout(() => {
      setConnectionState("connected");
      
      // Simulate incoming logs
      const logInterval = setInterval(() => {
        const levels: ("INFO" | "WARN" | "ERROR")[] = ["INFO", "INFO", "INFO", "WARN", "ERROR"];
        const sources = ["builder", "reviewer", "qa", "pm", "system"];
        const messages = [
          "Processing file...",
          "Running tests...",
          "Validating output...",
          "Checking dependencies...",
          "Optimizing code...",
          "Generating documentation...",
          "Building assets...",
          "Linting code...",
          "Type checking...",
          "Packaging distribution..."
        ];
        
        const newLog: LogEntry = {
          timestamp: new Date().toISOString(),
          level: levels[Math.floor(Math.random() * levels.length)],
          source: sources[Math.floor(Math.random() * sources.length)],
          message: messages[Math.floor(Math.random() * messages.length)]
        };
        
        setLogs(prev => [...prev.slice(-49), newLog]); // Keep only last 50 entries
      }, 1000);
      
      return () => clearInterval(logInterval);
    }, 1000);
    
    return () => {
      clearTimeout(connectTimer);
    };
  }, [artifact.jobId]);

  // Map our log entries to the format expected by WorkbenchLogs
  const logLines = logs.map(log => ({
    ts: log.timestamp,
    severity: log.level.toLowerCase() as "info" | "warn" | "error",
    text: `[${log.source}] ${log.message}`
  }));

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container-low)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-semibold">Job Logs</h2>
            <p className="text-[12px] text-[var(--color-foreground-muted)]">
              Live stream for job {artifact.jobId}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className={`h-2 w-2 rounded-full ${
              connectionState === "connected" 
                ? "bg-green-500 pulse-dot" 
                : connectionState === "connecting" 
                  ? "bg-amber-500" 
                  : "bg-red-500"
            }`} />
            <span className="text-[11px] capitalize">
              {connectionState}
            </span>
          </div>
        </div>
      </div>

      {/* Logs */}
      <div className="flex-1 overflow-hidden">
        <WorkbenchLogs 
          initialAgentJobId={artifact.jobId}
          title="Job Logs"
          lines={logLines}
          state={connectionState}
        />
      </div>
    </div>
  );
}