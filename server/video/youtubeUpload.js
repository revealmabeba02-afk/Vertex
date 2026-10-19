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

module.exports = { uploadVideo, getAccessToken };
