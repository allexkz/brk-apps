/**
 * Provides Cloudflare Worker environment to Remix loaders/actions via context.
 * This bridges the gap between Cloudflare's `env` and Remix's `context`.
 */
export function getLoadContext({ context }) {
  return {
    env: context.cloudflare.env,
  };
}
