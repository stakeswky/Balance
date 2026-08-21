import { createFileRoute } from "@tanstack/react-router";
import { TrayDashboard } from "@/components/balance/tray-dashboard";

export const Route = createFileRoute("/tray")({ component: TrayDashboard });
