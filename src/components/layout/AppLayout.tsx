import type { ReactNode } from "react";

interface AppLayoutProps {
  sidebar: ReactNode;
  children: ReactNode;
}

export function AppLayout({ sidebar, children }: AppLayoutProps) {
  return (
    <div className="flex h-screen bg-background text-foreground">
      <aside className="w-[280px] shrink-0 bg-card border-r border-border">
        {sidebar}
      </aside>
      <main className="flex-1 overflow-hidden">
        {children}
      </main>
    </div>
  );
}
