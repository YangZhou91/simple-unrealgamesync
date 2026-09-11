import { useState, useEffect, useCallback } from "react";
import type { WorkspaceConfig } from "@/lib/types";
import * as commands from "@/lib/commands";

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceConfig[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [currentCl, setCurrentCl] = useState<string | null>(null);

  const selectedWorkspace =
    workspaces.find((ws) => ws.id === selectedId) ?? null;

  const loadWorkspaces = useCallback(async () => {
    try {
      const list = await commands.getWorkspaces();
      setWorkspaces(list);
    } catch (e) {
      console.error("Failed to load workspaces:", e);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    if (selectedId) {
      commands
        .getCurrentCl(selectedId)
        .then(setCurrentCl)
        .catch(() => setCurrentCl(null));
    } else {
      setCurrentCl(null);
    }
  }, [selectedId]);

  const addWorkspace = useCallback(
    async (
      name: string,
      rootPath: string,
      projectDir: string,
      p4Client: string,
      p4User: string,
    ) => {
      await commands.addWorkspace(name, rootPath, projectDir, p4Client, p4User);
      await loadWorkspaces();
      const list = await commands.getWorkspaces();
      const last = list[list.length - 1];
      if (last) {
        setSelectedId(last.id);
      }
    },
    [loadWorkspaces],
  );

  const deleteWorkspace = useCallback(
    async (id: string) => {
      await commands.deleteWorkspace(id);
      if (selectedId === id) {
        setSelectedId(null);
      }
      await loadWorkspaces();
    },
    [selectedId, loadWorkspaces],
  );

  const selectWorkspace = useCallback((id: string) => {
    setSelectedId(id);
  }, []);

  const reload = loadWorkspaces;

  const refreshCurrentCl = useCallback((cl: string | null) => {
    setCurrentCl(cl);
  }, []);

  const updateSettings = useCallback(
    async (
      id: string,
      parallelThreads: number,
      exclusions: string[],
      intervalMinutes: number,
    ) => {
      await commands.updateWorkspaceSettings(
        id,
        parallelThreads,
        exclusions,
        intervalMinutes,
      );
      await loadWorkspaces();
    },
    [loadWorkspaces],
  );

  return {
    workspaces,
    selectedId,
    selectedWorkspace,
    isLoading,
    currentCl,
    addWorkspace,
    deleteWorkspace,
    selectWorkspace,
    reload,
    refreshCurrentCl,
    updateSettings,
  };
}
