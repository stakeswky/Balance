import { createFileRoute } from "@tanstack/react-router";

const HEALTH_BODY = '{"app":"synq","mode":"desktop"}';

export const Route = createFileRoute("/api/desktop-health")({
  server: {
    handlers: {
      GET: () => {
        if (process.env.SYNQ_DESKTOP !== "1") {
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
