import { defineCloudflareConfig } from "@opennextjs/cloudflare";

const config = defineCloudflareConfig({});

// When Next.js traces standalone assets for Node, pg-cloudflare's workerd-specific files
// are omitted from nft traces. Setting useWorkerdCondition to false prevents esbuild
// from attempting to resolve missing conditional workerd exports inside pg.
config.cloudflare = {
  ...config.cloudflare,
  useWorkerdCondition: false,
};

export default config;
