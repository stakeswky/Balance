import { createFileRoute } from "@tanstack/react-router";
import { isDesktopRuntime } from "@/lib/runtime-mode";

const HEALTH_BODY = '{"app":"balance","mode":"desktop"}';

export const Route = createFileRoute("/api/desktop-health")({
  server: {
    handlers: {
      GET: () => {
        if (!isDesktopRuntime(process.env)) {
          return new Response("Not Found", { status: 404 });
        }
        return new Response(HEALTH_BODY, {
          status: 200,
          headers: {
            "cache-control": "no-store",
            "content-length": String(HEALTH_BODY.length),
            "content-type": "application/json; charset=utf-8",
          },
        });
      },
    },
  },
});
