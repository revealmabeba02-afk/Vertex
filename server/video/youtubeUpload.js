// Minimal YouTube Data API v3 upload — no googleapis package, just fetch.
// Needs YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET / YOUTUBE_REFRESH_TOKEN
// (obtained once via the /api/admin/youtube/connect flow) set as env vars.

const fs = require("fs");

async function getAccessToken() {
  const clientId = (process.env.YOUTUBE_CLIENT_ID || "").trim();
  const clientSecret = (process.env.YOUTUBE_CLIENT_SECRET || "").trim();
  const refreshToken = (process.env.YOUTUBE_REFRESH_TOKEN || "").trim();
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error("YouTube is not connected yet (missing client id/secret/refresh token).");
  }
  const res = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token"
    })
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Could not refresh YouTube access token: ${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

// Uploads as an unlisted Short by default — King can flip it to public from
// YouTube Studio once he's happy with how it looks, without risking an
// embarrassing public post from an untested pipeline.
async function uploadVideo(filePath, { title, description, tags, privacyStatus = "unlisted" }) {
  const accessToken = await getAccessToken();
  const videoBuffer = fs.readFileSync(filePath);

  const metadata = {
    snippet: {
      title: String(title || "Vertex Signal").slice(0, 100),
      description: description || "",
      tags: Array.isArray(tags) ? tags : undefined,
      categoryId: "25" // News & Politics has worked fine for finance content; "22" (People & Blogs) is a reasonable alt
    },
    status: { privacyStatus, selfDeclaredMadeForKids: false }
  };

  const boundary = `vertex_boundary_${Date.now()}`;
  const metadataPart = Buffer.from(
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`
  );
  const videoPartHeader = Buffer.from(`--${boundary}\r\nContent-Type: video/mp4\r\n\r\n`);
  const closing = Buffer.from(`\r\n--${boundary}--`);
  const body = Buffer.concat([metadataPart, videoPartHeader, videoBuffer, closing]);

  const res = await fetch(
    "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(body.length)
      },
      body
    }
  );
  const data = await res.json();
  if (!res.ok) {
    throw new Error(`YouTube upload failed: ${JSON.stringify(data.error || data)}`);
  }
  return { videoId: data.id, url: `https://youtube.com/shorts/${data.id}` };
}

// --- Reading comments back (the "spy" side) --------------------------------
// Used by Q2 Insight's YouTube report: pulls recent videos from the channel,
// then the top comments on each, so the AI can read real viewer reactions
// instead of just upload counts.

async function listRecentVideos(accessToken, maxVideos = 5) {
  // mine=true needs the uploader's own OAuth token (which is what we have) —
  // no channel ID to hardcode or keep in sync.
  const channelRes = await fetch(
    "https://www.googleapis.com/youtube/v3/channels?part=contentDetails&mine=true",
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const channelData = await channelRes.json();
  if (!channelRes.ok) {
    throw new Error(`Could not read channel: ${JSON.stringify(channelData.error || channelData)}`);
  }
  const uploadsPlaylistId = channelData.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
  if (!uploadsPlaylistId) return [];

  const itemsRes = await fetch(
    `https://www.googleapis.com/youtube/v3/playlistItems?part=snippet&playlistId=${uploadsPlaylistId}&maxResults=${maxVideos}`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const itemsData = await itemsRes.json();
  if (!itemsRes.ok) {
    throw new Error(`Could not list videos: ${JSON.stringify(itemsData.error || itemsData)}`);
  }
  return (itemsData.items || []).map((item) => ({
    videoId: item.snippet?.resourceId?.videoId,
    title: item.snippet?.title,
    publishedAt: item.snippet?.publishedAt
  })).filter((v) => v.videoId);
}

// Comments are disabled/unavailable on some videos (e.g. still processing,
// or comments off) — that's normal, not an error, so this returns [] rather
// than throwing when the API says so.
async function listComments(accessToken, videoId, maxComments = 20) {
  const res = await fetch(
    `https://www.googleapis.com/youtube/v3/commentThreads?part=snippet&videoId=${videoId}&maxResults=${maxComments}&order=relevance&textFormat=plainText`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );
  const data = await res.json();
  if (!res.ok) {
    // commentsDisabled, videoNotFound, etc. — skip quietly rather than fail
    // the whole report over one video.
    return [];
  }
  return (data.items || []).map((item) => {
    const top = item.snippet?.topLevelComment?.snippet;
    return {
      author: top?.authorDisplayName || "—",
      text: top?.textDisplay || "",
      likeCount: top?.likeCount ?? 0
    };
  });
}

module.exports = { uploadVideo, getAccessToken, listRecentVideos, listComments };
