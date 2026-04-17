import { useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import type { WorkbenchHistoryEntry } from "@/lib/workbenchHistory";

type LocationState = { faHistoryRestore?: WorkbenchHistoryEntry } | null;

/**
 * 从顶部「历史记录」跳转时，Router state 会携带完整 entry；路径匹配且 snapshot 校验通过时应用，并清除 state。
 */
export function useFaHistoryRestore(
  path: string,
  apply: (snapshot: NonNullable<WorkbenchHistoryEntry["snapshot"]>) => void,
  canApply: (snapshot: unknown) => boolean,
) {
  const location = useLocation();
  const navigate = useNavigate();
  const applyRef = useRef(apply);
  const canApplyRef = useRef(canApply);
  applyRef.current = apply;
  canApplyRef.current = canApply;

  useEffect(() => {
    const st = location.state as LocationState;
    const entry = st?.faHistoryRestore;
    if (!entry || entry.path !== path) return;
    if (entry.snapshot != null && canApplyRef.current(entry.snapshot)) {
      applyRef.current(entry.snapshot);
    }
    navigate(location.pathname + location.search, { replace: true, state: {} });
  }, [location.pathname, location.search, location.state, path, navigate]);
}
