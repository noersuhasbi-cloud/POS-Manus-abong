import { useQueryClient } from "@tanstack/react-query";
import { createContext, useCallback, useContext, type ReactNode } from "react";
import { useAuth } from "@/hooks/use-auth";
import { trpc } from "@/lib/trpc";
import type { BusinessSettings } from "@/shared/pos";

type AuthState = ReturnType<typeof useAuth>;
type WorkspaceContextValue = {
  user: AuthState["user"];
  authLoading: boolean;
  isAuthenticated: boolean;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
  workspace: BusinessSettings | null;
  workspaceLoading: boolean;
  workspaceError: string | null;
  refreshWorkspace: () => Promise<unknown>;
};

type CurrentResponse = { sessionOpenId: string; workspace: BusinessSettings | null };

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceProvider({ children, auth }: { children: ReactNode; auth: AuthState }) {
  const queryClient = useQueryClient();
  const identity = auth.isAuthenticated ? auth.user?.openId ?? null : null;
  const current = trpc.workspace.current.useQuery({ cacheScope: identity ?? "unauthenticated" }, {
    enabled: auth.isAuthenticated,
    retry: false,
    staleTime: 0,
    refetchInterval: 3_000,
  });
  const response = current.data as CurrentResponse | null | undefined;
  const belongsToIdentity = Boolean(identity && response?.sessionOpenId === identity);

  const logout = useCallback(async () => {
    queryClient.clear();
    await auth.logout();
  }, [auth.logout, queryClient]);

  const value: WorkspaceContextValue = {
    user: auth.user,
    authLoading: auth.loading,
    isAuthenticated: auth.isAuthenticated,
    logout,
    refreshAuth: auth.refresh,
    workspace: belongsToIdentity ? response?.workspace ?? null : null,
    workspaceLoading: auth.isAuthenticated && current.isLoading,
    workspaceError: auth.isAuthenticated ? current.error?.message ?? null : null,
    refreshWorkspace: () => current.refetch(),
  };
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function useWorkspace() {
  const value = useContext(WorkspaceContext);
  if (!value) throw new Error("useWorkspace must be used within WorkspaceProvider");
  return value;
}
