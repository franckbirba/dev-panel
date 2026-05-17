import { useState, useEffect, useRef } from "react";

interface LogEntry {
  id: string;
  timestamp: string;
  level: "INFO" | "WARN" | "ERROR";
  source: string;
  message: string;
}

interface LogStreamArtifactProps {
  artifact: {
    id: string;
    type: "stream";
    title: string;
    meta: string;
    payload: {
      jobId: string;
    };
  };
}

export function LogStreamArtifactView({ artifact }: LogStreamArtifactProps) {
  const [logs, setLogs] = useState<LogEntry[]>([
    // Mock data for demonstration
    {
      id: "1",
      timestamp: "14:32:15.245",
      level: "INFO",
      source: "builder",
      message: "Starting job execution..."
    },
    {
      id: "2",
      timestamp: "14:32:16.102",
      level: "INFO",
      source: "git",
      message: "Cloning repository from origin/main"
    },
    {
      id: "3",
      timestamp: "14:32:18.742",
      level: "WARN",
      source: "dependencies",
      message: "Package version mismatch detected"
    },
    {
      id: "4",
      timestamp: "14:32:22.001",
      level: "ERROR",
      source: "test",
      message: "Unit test failed in src/components/Button.test.ts"
    }
  ]);
  
  const scrollRef = useRef<HTMLDivElement>(null);
  
  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);
  
  const getLevelColor = (level: string) => {
    switch (level) {
      case "INFO": return "text-[var(--color-foreground-muted)]";
      case "WARN": return "text-amber-400";
      case "ERROR": return "text-red-400";
      default: return "text-[var(--color-foreground)]";
    }
  };
  
  return (
    <div className="flex h-full flex-col">
      {/* Header with pulse dot */}
      <div className="flex items-center justify-between border-b border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="relative flex size-3 items-center justify-center">
            <div className="absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-60 animate-ping" />
            <div className="relative size-2 rounded-full bg-green-500" />
          </div>
          <h4 className="text-[13px] font-semibold">Job Stream</h4>
        </div>
        <div className="font-mono text-[11px] text-[var(--color-foreground-faint)]">
          {artifact.payload.jobId}
        </div>
      </div>
      
      {/* Log entries */}
      <div 
        ref={scrollRef}
        className="flex-1 overflow-auto bg-[var(--color-background)] font-mono text-[11px]"
      >
        <div className="divide-y divide-[var(--color-border-subtle)]">
          {logs.map((log) => (
            <div 
              key={log.id} 
              className="flex items-start gap-3 px-4 py-2 hover:bg-[var(--color-surface-container-low)]"
            >
              {/* Timestamp */}
              <div className="w-16 shrink-0 font-mono text-[var(--color-foreground-faint)]">
                {log.timestamp}
              </div>
              
              {/* Level badge */}
              <div className={`w-12 shrink-0 text-center ${getLevelColor(log.level)}`}>
                {log.level}
              </div>
              
              {/* Source */}
              <div className="w-16 shrink-0 font-mono text-[var(--color-foreground-faint)]">
                {log.source}
              </div>
              
              {/* Message */}
              <div className="min-w-0 flex-1 truncate text-[var(--color-foreground)]">
                {log.message}
              </div>
            </div>
          ))}
        </div>
      </div>
      
      {/* Footer */}
      <div className="border-t border-[var(--color-border-subtle)] bg-[var(--color-surface-container)] px-4 py-2">
        <div className="flex items-center justify-between text-[10px] text-[var(--color-foreground-faint)]">
          <span>Streaming live logs...</span>
          <span>{logs.length} entries</span>
        </div>
      </div>
    </div>
  );
}
