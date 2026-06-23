import { Virtuoso } from "react-virtuoso";

interface LogViewerProps {
  lines: string[];
}

export function LogViewer({ lines }: LogViewerProps) {
  if (lines.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-muted text-sm">
        Waiting for output...
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-hidden">
      <Virtuoso
        data={lines}
        followOutput="smooth"
        itemContent={(_, line) => (
          <div className="px-4 py-0.5 text-sm font-mono text-muted whitespace-nowrap">
            {line}
          </div>
        )}
        className="h-full"
      />
    </div>
  );
}
