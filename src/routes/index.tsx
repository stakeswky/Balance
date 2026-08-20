import { useCallback, useEffect, useRef, useState } from "react";
import { createFileRoute } from "@tanstack/react-router";
import { Dashboard } from "@/components/synq/dashboard";
import { Onboarding } from "@/components/synq/onboarding";
import { useQuota } from "@/lib/quota/store";
import { pullAgentAvailability } from "@/lib/quota/watch";

export const Route = createFileRoute("/")({ component: Home });

function LoadingShell() {
  return (
    <div className="min-h-dvh bg-canvas px-4 py-8 text-ink">
      <div className="mx-auto max-w-6xl space-y-4">
        <div className="h-16 rounded-xl bg-surface" />
        <div className="grid gap-4 lg:grid-cols-[17rem_1fr]">
          <div className="h-64 rounded-2xl bg-surface" />
          <div className="h-64 rounded-2xl bg-surface" />
        </div>
      </div>
    </div>
  );
}

function Home() {
  const onboardingComplete = useQuota((state) => state.onboardingComplete);
  const availability = useQuota((state) => state.agentAvailability);
  const [clientMounted, setClientMounted] = useState(false);
  const [persistHydrated, setPersistHydrated] = useState(false);
  const [availabilityChecking, setAvailabilityChecking] = useState(false);
  const [availabilityResolved, setAvailabilityResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const detectionStarted = useRef(false);

  const detect = useCallback(async () => {
    setAvailabilityChecking(true);
    setError(null);
    try {
      const result = await pullAgentAvailability();
      useQuota.getState().setAgentAvailability(result);
    } catch {
      setError("无法检测本机 Agent，请稍后重试");
    } finally {
      setAvailabilityChecking(false);
      setAvailabilityResolved(true);
    }
  }, []);

  useEffect(() => {
    setClientMounted(true);
    const afterHydration = () => {
      setPersistHydrated(true);
      if (useQuota.getState().demoMode) useQuota.getState().resetDemo();
      if (!detectionStarted.current) {
        detectionStarted.current = true;
        void detect();
      }
    };
    if (useQuota.persist.hasHydrated()) {
      afterHydration();
      return;
    }
    return useQuota.persist.onFinishHydration(afterHydration);
  }, [detect]);

  if (!clientMounted || !persistHydrated) return <LoadingShell />;
  if (!onboardingComplete) {
    return (
      <Onboarding
        availability={availability}
        checking={availabilityChecking || !availabilityResolved}
        error={error}
        onRetry={() => void detect()}
        onContinue={() => useQuota.getState().setOnboardingComplete(true)}
        onDemo={() => {
          useQuota.getState().setDemoMode(true);
          useQuota.getState().setOnboardingComplete(true);
        }}
      />
    );
  }
  if (!availabilityResolved) return <LoadingShell />;
  return <Dashboard />;
}
