#!/usr/bin/env node
/**
 * Buffer GraphQL API Client
 * Direct integration with Buffer's API, bypassing Zapier.
 * Posts videos with captions to TikTok, LinkedIn, Facebook, YouTube, and Instagram.
 */

const fs = require("fs");
const path = require("path");

const BUFFER_API_URL = "https://api.buffer.com";
const BUFFER_CONFIG_FILE = path.join(__dirname, "buffer-config.json");

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(BUFFER_CONFIG_FILE, "utf8"));
  } catch {
    return { accessToken: null, enabled: false, channels: {} };
  }
}

function saveConfig(config) {
  fs.writeFileSync(BUFFER_CONFIG_FILE, JSON.stringify(config, null, 2));
}

async function graphql(query, variables = {}, token) {
  const accessToken = token || loadConfig().accessToken;
  if (!accessToken) throw new Error("Buffer API token not configured");

  const res = await fetch(BUFFER_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Buffer API error ${res.status}: ${text}`);
  }

  const json = await res.json();
  if (json.errors && json.errors.length > 0) {
    throw new Error(`Buffer GraphQL error: ${json.errors.map(e => e.message).join(", ")}`);
  }
  return json.data;
}

/**
 * Get account info and organization IDs
 */
async function getAccount(token) {
  const data = await graphql(`
    query GetAccount {
      account {
        id
        email
        name
        organizations {
          id
          name
        }
      }
    }
  `, {}, token);
  return data.account;
}

/**
 * Fetch all channels for a given organization
 */
async function getChannels(organizationId, token) {
  const data = await graphql(`
    query GetChannels($input: ChannelsInput!) {
      channels(input: $input) {
        id
        name
        service
        type
        avatar
        isDisconnected
        isLocked
      }
    }
  `, { input: { organizationId } }, token);
  return data.channels;
}

/**
 * Create a post on a specific channel.
 * Handles service-specific metadata (TikTok, LinkedIn, Facebook, YouTube, Instagram).
 */
async function createPost({ channelId, service, text, videoUrl, videoThumbnailUrl, schedulingType = "automatic", mode = "shareNow" }) {
  // Build service-specific metadata
  const metadata = {};

  if (service === "tiktok") {
    metadata.tiktok = { title: null };
  } else if (service === "linkedin") {
    metadata.linkedin = {};
  } else if (service === "facebook") {
    metadata.facebook = { type: "reel" };
  } else if (service === "youtube") {
    metadata.youtube = {
      title: text.split("\n")[0].substring(0, 100),
      privacy: "public",
      categoryId: "22", // People & Blogs
      notifySubscribers: true,
      embeddable: true,
      madeForKids: false,
    };
  } else if (service === "instagram") {
    metadata.instagram = { type: "reel", shouldShareToFeed: true };
  }

  const input = {
    channelId,
    text,
    schedulingType,
    mode,
    assets: {
      videos: [{ url: videoUrl, thumbnailUrl: videoThumbnailUrl || undefined }],
    },
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };

  const data = await graphql(`
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            status
            channelService
          }
        }
        ... on RestProxyError {
          message
          code
        }
        ... on InvalidInputError {
          message
        }
        ... on UnauthorizedError {
          message
        }
        ... on UnexpectedError {
          message
        }
        ... on LimitReachedError {
          message
        }
        ... on NotFoundError {
          message
        }
      }
    }
  `, { input });

  const result = data.createPost;

  // Check for error types
  if (result.message) {
    throw new Error(`Buffer post failed (${service}): ${result.message}`);
  }

  return result;
}

/**
 * Publish a video with caption to all configured channels.
 * Returns results per channel.
 */
async function publishToAllChannels({ caption, videoUrl, videoThumbnailUrl, channels }) {
  const results = [];

  for (const ch of channels) {
    try {
      const result = await createPost({
        channelId: ch.id,
        service: ch.service,
        text: caption,
        videoUrl,
        videoThumbnailUrl,
      });
      results.push({ channel: ch.name, service: ch.service, success: true, result });
    } catch (err) {
      results.push({ channel: ch.name, service: ch.service, success: false, error: err.message });
    }
  }

  return results;
}

/**
 * Full publish flow:
 * 1. Load config to get enabled channels
 * 2. Post to each channel
 */
async function publish({ caption, videoUrl, videoThumbnailUrl }) {
  const config = loadConfig();
  if (!config.accessToken) throw new Error("Buffer API token not configured");
  if (!config.channels || Object.keys(config.channels).length === 0) {
    throw new Error("No Buffer channels configured. Go to Settings to set up channels.");
  }

  // Filter to only enabled channels
  const enabledChannels = Object.values(config.channels).filter(ch => ch.enabled);
  if (enabledChannels.length === 0) {
    throw new Error("No Buffer channels enabled for publishing.");
  }

  return publishToAllChannels({ caption, videoUrl, videoThumbnailUrl, channels: enabledChannels });
}

module.exports = {
  loadConfig,
  saveConfig,
  getAccount,
  getChannels,
  createPost,
  publish,
  graphql,
};
