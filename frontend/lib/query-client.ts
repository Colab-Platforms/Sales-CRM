import { QueryClient, isServer } from "@tanstack/react-query";

const STALE_TIME_MS = 5 * 60 * 1000; // 5 minutes

function makeQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_TIME_MS,
      },
    },
  });
}

let browserQueryClient: QueryClient | undefined;

// Server: always create a fresh client per request, never share across requests.
// Browser: reuse a single client so navigations don't lose the cache.
export function getQueryClient() {
  if (isServer) {
    return makeQueryClient();
  }
  if (!browserQueryClient) {
    browserQueryClient = makeQueryClient();
  }
  return browserQueryClient;
}
