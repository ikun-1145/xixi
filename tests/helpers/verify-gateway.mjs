export function usagePreflightResponse(request) {
  if (new URL(request.url).pathname !== "/v1/usage") return null;
  return Response.json({
    userId: "user-a", date: "2026-10-03", limit: 20, remain: 20, isPro: false,
  });
}
