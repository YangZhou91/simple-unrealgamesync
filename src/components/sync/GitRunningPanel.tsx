import { LogViewer } from "./LogViewer";
import { Button } from "@/components/ui/button";
import { CheckCircle, XCircle, ArrowLeft } from "lucide-react";

interface GitRunningPanelProps {
  gitState: "running" | "success" | "error";
  logLines: string[];
  errorInfo: { error: string } | null;
  onCancel: () => void;
  onBack: () => void;
}

export function GitRunningPanel({
  gitState,
  logLines,
  errorInfo,
  onCancel,
  onBack,
}: GitRunningPanelProps) {
  return (
    <div className="flex h-full flex-col">
      {/* Result banner — success */}
      {gitState === "success" && (
        <div className="flex items-center justify-between bg-emerald-500/10 border-b border-emerald-500/20 text-emerald-400 px-4 py-3">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-4 w-4" />
            <span className="text-sm">Git pull completed successfully</span>
          </div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </div>
      )}

      {/* Result banner — error */}
      {gitState === "error" && (
        <div className="flex items-center justify-between bg-destructive/10 border-b border-destructive/20 text-destructive px-4 py-3">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 shrink-0" />
            <span className="text-sm">
              Git pull failed: {errorInfo?.error ?? "Unknown error"}
            </span>
          </div>
          <Button variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft className="h-4 w-4 mr-1" />
            Back
          </Button>
        </div>
      )}

      {/* Header — running state */}
      {gitState === "running" && (
        <div className="px-4 py-3 text-center">
          <span className="text-sm text-muted animate-pulse">
            Pulling UnrealEngine from Git...
          </span>
        </div>
      )}

      {/* Log output */}
      <div className="flex-1 overflow-hidden">
        <LogViewer lines={logLines} />
      </div>

      {/* Cancel button — running state only */}
      {gitState === "running" && (
        <div className="flex justify-center py-3 border-t border-border">
          <Button variant="outline" onClick={onCancel} className="h-9 px-6">
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
