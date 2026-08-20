import { createFileRoute } from "@tanstack/react-router";
import { isDesktopRuntime } from "@/lib/runtime-mode";

async function handleAuthRequest(request: Request): Promise<Response> {
  if (isDesktopRuntime(process.env)) {
    return new Response("Not Found", { status: 404 });
  }
  const { auth } = await import("@/lib/auth/server");
  return auth.handler(request);
}

export const Route = createFileRoute("/api/auth/$")({
  server: {
    handlers: {
      GET: ({ request }) => handleAuthRequest(request),
      POST: ({ request }) => handleAuthRequest(request),
    },
  },
});
