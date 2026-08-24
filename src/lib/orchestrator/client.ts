import { useCallback, useEffect, useState } from "react";
import {
  analyzeOrchestratorPlan,
  cancelOrchestratorRun,
  getOrchestratorRun,
  listOrchestratorRuns,
  startOrchestratorRun,
  validateRepository,
} from "./actions.ts";
import { getOrchestratorAuthorization } from "./capability.ts";
import type { RunSnapshot, RunSummary } from "./supervisor.server.ts";
import type {
  CoordinatorChoice,
  ClientQuotaEvidence,
  OrchestratorRun,
  PlanDraft,
  RepositoryValidation,
  RunEventRecord,
  RunStatus,
} from "./types.ts";
import type { OfficialSlice } from "../quota/official.ts";
import type { QuotaValue } from "../quota/quota-value.ts";

const TERMINAL_STATUSES = new Set<RunStatus>([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "capacity_blocked",
]);

const POLLED_STATUSES = new Set<RunStatus>([
  "ready",
  "running",
  "cancelling",
  "integrating",
  "verifying",
]);

type LoadingOperation = "history" | "validate" | "analyze" | "start" | "cancel" | "select";

function messageFor(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function trustedDollarValue(values: readonly QuotaValue[]): QuotaValue | null {
  const candidates = values.flatMap((value) => {
    const trusted = value.confidence === "medium" || value.confidence === "high";
    if (
      !trusted ||
      value.remainingLowUsd === null ||
      value.remainingLowUsd < 0 ||
      value.totalHighUsd === null ||
      value.totalHighUsd <= 0
    ) {
      return [];
    }
    return [{ value, ratio: value.remainingLowUsd / value.totalHighUsd }];
  });
  candidates.sort((left, right) => left.ratio - right.ratio);
  return candidates[0]?.value ?? null;
}

export function buildQuotaCapacityEvidence(
  weekly: QuotaValue,
  fiveHour: QuotaValue,
  official: OfficialSlice | null,
  now = Date.now(),
): ClientQuotaEvidence {
  const value = trustedDollarValue([weekly, fiveHour]);
  const officialCandidates = official
    ? [
        official.windowPct !== null && !official.windowStale
          ? { used: official.windowPct, observedAt: official.windowFetchedAt ?? official.fetchedAt, resetsAt: official.windowResetsAt }
          : null,
        official.weekPct !== null && !official.weekStale
          ? { used: official.weekPct, observedAt: official.weekFetchedAt ?? official.fetchedAt, resetsAt: official.weekResetsAt }
          : null,
      ].filter((candidate): candidate is { used: number; observedAt: number; resetsAt: number | null } => candidate !== null)
    : [];
  officialCandidates.sort((left, right) => right.used - left.used);
  const selectedOfficial = officialCandidates[0] ?? null;
  const l3RemainingPct = value
    ? Math.max(0, Math.min(100, (value.remainingLowUsd! / value.totalHighUsd!) * 100))
    : null;
  return {
    officialRemainingPct: selectedOfficial ? Math.max(0, Math.min(100, 100 - selectedOfficial.used)) : null,
    officialObservedAt: selectedOfficial?.observedAt ?? null,
    officialResetsAt: selectedOfficial?.resetsAt ?? null,
    officialFresh: selectedOfficial !== null && now - selectedOfficial.observedAt <= 5 * 60 * 1_000,
    officialSource: selectedOfficial ? official?.source ?? "official" : null,
    l3RemainingPct,
    l3Confidence: value?.confidence ?? "none",
    l3ObservedAt: value ? now : null,
  };
}

function mergeEvents(current: RunEventRecord[], incoming: RunEventRecord[]): RunEventRecord[] {
  if (incoming.length === 0) return current;
  const bySequence = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySequence.set(event.seq, event);
  return [...bySequence.values()].sort((left, right) => left.seq - right.seq);
}

export function useOrchestratorController(
  quotaEvidence: Record<"claude" | "codex" | "grok", ClientQuotaEvidence>,
) {
  const [authorization] = useState(() => getOrchestratorAuthorization());
  const [repositoryPath, setRepositoryPathState] = useState("");
  const [repositoryValidation, setRepositoryValidation] = useState<RepositoryValidation | null>(
    null,
  );
  const [prompt, setPromptState] = useState("");
  const [coordinatorChoice, setCoordinatorChoiceState] = useState<CoordinatorChoice>("auto");
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [run, setRun] = useState<OrchestratorRun | null>(null);
  const [events, setEvents] = useState<RunEventRecord[]>([]);
  const [afterSeq, setAfterSeq] = useState(0);
  const [history, setHistory] = useState<RunSummary[]>([]);
  const [loading, setLoading] = useState<LoadingOperation | null>(null);
  const [error, setError] = useState<string | null>(null);

  const applySnapshot = useCallback((snapshot: RunSnapshot, replaceEvents: boolean) => {
    setRun(snapshot.run);
    setDraft(snapshot.run.draft);
    setEvents((current) =>
      replaceEvents ? snapshot.events : mergeEvents(current, snapshot.events),
    );
    setAfterSeq(snapshot.nextSeq);
  }, []);

  const refreshHistory = useCallback(async (): Promise<RunSummary[]> => {
    const summaries = await listOrchestratorRuns({ data: { authorization } });
    setHistory(summaries);
    return summaries;
  }, [authorization]);

  useEffect(() => {
    let cancelled = false;
    setLoading("history");
    void listOrchestratorRuns({ data: { authorization } })
      .then(async (summaries) => {
        if (cancelled) return;
        setHistory(summaries);
        const latest = summaries[0];
        if (!latest) return;
        const snapshot = await getOrchestratorRun({
          data: { authorization, runId: latest.id, afterSeq: 0 },
        });
        if (!cancelled) applySnapshot(snapshot, true);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(messageFor(caught));
      })
      .finally(() => {
        if (!cancelled) setLoading(null);
      });
    return () => {
      cancelled = true;
    };
  }, [applySnapshot, authorization]);

  useEffect(() => {
    if (!run || !POLLED_STATUSES.has(run.status) || TERMINAL_STATUSES.has(run.status)) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void getOrchestratorRun({
        data: { authorization, runId: run.id, afterSeq },
      })
        .then((snapshot) => {
          if (!cancelled) applySnapshot(snapshot, false);
        })
        .catch((caught: unknown) => {
          if (!cancelled) setError(messageFor(caught));
        });
    }, 1_000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [afterSeq, applySnapshot, authorization, run]);

  const setRepositoryPath = (value: string) => {
    setRepositoryPathState(value);
    setRepositoryValidation(null);
    setDraft(null);
  };

  const setPrompt = (value: string) => {
    setPromptState(value);
    setDraft(null);
  };

  const setCoordinatorChoice = (value: CoordinatorChoice) => {
    setCoordinatorChoiceState(value);
    setDraft(null);
  };

  const validate = async (): Promise<RepositoryValidation | null> => {
    if (loading || !repositoryPath.trim()) return null;
    setLoading("validate");
    setError(null);
    try {
      const result = await validateRepository({
        data: { authorization, repoPath: repositoryPath.trim() },
      });
      setRepositoryValidation(result);
      if (result.canonicalPath) setRepositoryPathState(result.canonicalPath);
      return result;
    } catch (caught) {
      setError(messageFor(caught));
      return null;
    } finally {
      setLoading(null);
    }
  };

  const analyze = async (): Promise<void> => {
    if (loading || !repositoryPath.trim() || !prompt.trim()) return;
    setLoading("analyze");
    setError(null);
    try {
      const validation = await validateRepository({
        data: { authorization, repoPath: repositoryPath.trim() },
      });
      setRepositoryValidation(validation);
      if (!validation.valid || !validation.canonicalPath) {
        throw new Error(validation.reasons[0] ?? "仓库校验未通过");
      }
      if (validation.dirty) throw new Error("仓库存在未提交改动，请清理后重新分析");
      setRepositoryPathState(validation.canonicalPath);
      const planned = await analyzeOrchestratorPlan({
        data: {
          authorization,
          repositoryPath: validation.canonicalPath,
          prompt: prompt.trim(),
          coordinator: coordinatorChoice,
          quotaEvidence,
        },
      });
      setDraft(planned);
      const snapshot = await getOrchestratorRun({
        data: { authorization, runId: planned.runId, afterSeq: 0 },
      });
      applySnapshot(snapshot, true);
      await refreshHistory();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(null);
    }
  };

  const start = async (): Promise<void> => {
    if (loading || !draft) return;
    setLoading("start");
    setError(null);
    try {
      await startOrchestratorRun({
        data: {
          authorization,
          runId: draft.runId,
          fingerprint: draft.fingerprint,
          trustedRepository: true,
          confirmedRepository: {
            path: draft.repositoryPath,
            device: draft.repositoryDevice,
            inode: draft.repositoryInode,
            baseSha: draft.baseSha,
          },
        },
      });
      const snapshot = await getOrchestratorRun({
        data: { authorization, runId: draft.runId, afterSeq: 0 },
      });
      applySnapshot(snapshot, true);
      await refreshHistory();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(null);
    }
  };

  const cancel = async (): Promise<void> => {
    if (loading || !run) return;
    setLoading("cancel");
    setError(null);
    try {
      await cancelOrchestratorRun({ data: { authorization, runId: run.id } });
      const snapshot = await getOrchestratorRun({
        data: { authorization, runId: run.id, afterSeq },
      });
      applySnapshot(snapshot, false);
      await refreshHistory();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(null);
    }
  };

  const selectRun = async (runId: string): Promise<void> => {
    if (loading) return;
    setLoading("select");
    setError(null);
    try {
      const snapshot = await getOrchestratorRun({
        data: { authorization, runId, afterSeq: 0 },
      });
      applySnapshot(snapshot, true);
      setRepositoryPathState(snapshot.run.repositoryPath);
      setPromptState(snapshot.run.draft.prompt);
      setCoordinatorChoiceState(snapshot.run.draft.coordinator);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setLoading(null);
    }
  };

  return {
    authorization,
    repositoryPath,
    repositoryValidation,
    prompt,
    coordinatorChoice,
    draft,
    run,
    events,
    afterSeq,
    history,
    loading,
    error,
    developmentProtection: authorization === "development-loopback",
    setRepositoryPath,
    setPrompt,
    setCoordinatorChoice,
    validate,
    analyze,
    start,
    cancel,
    selectRun,
  };
}
