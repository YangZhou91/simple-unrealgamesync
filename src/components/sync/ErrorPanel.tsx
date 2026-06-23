import { Button } from "@/components/ui/button";
import { AlertCircle } from "lucide-react";

interface ErrorPanelProps {
  step: string;
  error: string;
  retryLabel?: string;
  onRetry: () => void;
  onDismiss: () => void;
}

export function ErrorPanel({ step, error, retryLabel, onRetry, onDismiss }: ErrorPanelProps) {
  return (
    <div
      className="flex h-full flex-col items-center justify-center gap-4 pt-12"
      role="alert"
    >
      <AlertCircle className="h-10 w-10 text-destructive" />
      <h2 className="text-xl font-semibold text-destructive">Sync Failed</h2>
      <p className="text-sm text-muted max-w-md text-center">
        {step} failed: {error}
      </p>
      <div className="flex gap-3">
        <Button
          variant="outline"
          className="border-destructive text-destructive hover:bg-destructive/10"
          onClick={onRetry}
        >
          {retryLabel ?? "Retry Step"}
        </Button>
        <Button variant="ghost" onClick={onDismiss}>
          Dismiss Error
        </Button>
      </div>
    </div>
  );
}
