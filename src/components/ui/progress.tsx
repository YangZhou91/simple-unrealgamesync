import * as React from "react"
import { Progress as ProgressPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

function Progress({
  className,
  value,
  indeterminate = false,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & {
  indeterminate?: boolean
}) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      // Phase 26 (26-02): Radix value semantics live on the Root — determinate
      // bars expose the real value (aria-valuenow/valuetext); indeterminate
      // bars pass undefined so no fabricated numeric value is announced
      // (UI-SPEC §11.6).
      value={indeterminate ? undefined : value}
      {...props}
    >
      {indeterminate ? (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="h-full flex-1 bg-primary progress-indeterminate-indicator"
        />
      ) : (
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="h-full bg-primary transition-[width]"
          style={{ width: `${Math.min(100, Math.max(0, value ?? 0))}%` }}
        />
      )}
    </ProgressPrimitive.Root>
  )
}

export { Progress }
