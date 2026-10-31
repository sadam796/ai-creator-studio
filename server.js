const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cron = require("node-cron");
const { google } = require("googleapis");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PLANS_FILE = path.join(DATA_DIR, "plans.json");
const TOKEN_FILE = path.join(DATA_DIR, "youtube-token.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!fs.existsSync(PLANS_FILE)) {
  fs.writeFileSync(PLANS_FILE, "[]", "utf8");
}

app.use(express.json({ limit: "1mb" }));

// ADMIN PASSWORD PROTECTION
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send("Admin password is not configured.");
  }

  const header = req.headers.authorization || "";
  const match = header.match(/^Basic\s+(.+)$/i);

  if (!match) {
    res.set("WWW-Authenticate", 'Basic realm="Creator Auto Publisher"');
    return res.status(401).send("Admin login required.");
  }

  let credentials;

  try {
    credentials = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return res.status(401).send("Invalid login.");
  }

  const separator = credentials.indexOf(":");
  const password = separator >= 0
    ? credentials.slice(separator + 1)
    : "";

  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.set("WWW-Authenticate", 'Basic realm="Creator Auto Publisher"');
    return res.status(401).send("Wrong admin password.");
  }

  next();
}

// Public health endpoint and OAuth callback only.
app.use((req, res, next) => {
  if (
    req.path === "/api/health" ||
    req.path === "/auth/youtube/callback"
  ) {
    return next();
  }

  adminAuth(req, res, next);
});

app.use(express.static(__dirname));

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const BASE_URL =
  process.env.APP_BASE_URL ||
  "https://lightseagreen-skunk-987290.hostingersite.com";

const REDIRECT_URI = BASE_URL + "/auth/youtube/callback";

function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function readPlans() {
  return readJSON(PLANS_FILE, []);
}

function savePlans(plans) {
  fs.writeFileSync(PLANS_FILE, JSON.stringify(plans, null, 2));
}

function readTokens() {
  return readJSON(TOKEN_FILE, null);
}

function saveTokens(tokens) {
  const previous = readTokens() || {};

  const saved = {
    ...previous,
    ...tokens,
    updatedAt: new Date().toISOString()
  };

  if (!tokens.refresh_token && previous.refresh_token) {
    saved.refresh_token = previous.refresh_token;
  }

  fs.writeFileSync(TOKEN_FILE, JSON.stringify(saved, null, 2), {
    mode: 0o600
  });
}

function oauthConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

function getOAuthClient() {
  const oauth = new google.auth.OAuth2(
    CLIENT_ID,
    CLIENT_SECRET,
    REDIRECT_URI
  );

  const tokens = readTokens();

  if (!tokens || !tokens.refresh_token) {
    throw new Error("YouTube account is not connected.");
  }

  oauth.setCredentials(tokens);
  return oauth;
}

const oauthStates = new Map();

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, crypto.randomUUID() + ext);
  }
});

const upload = multer({
  storage,
  limits: {
    fileSize: 100 * 1024 * 1024,
    files: 2
  },
  fileFilter: (req, file, cb) => {
    if (
      file.mimetype.startsWith("video/") ||
      file.mimetype.startsWith("image/")
    ) {
      return cb(null, true);
    }

    cb(new Error("Only video and image files are allowed."));
  }
});

// HEALTH
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    app: "Creator Auto Publisher",
    adminPasswordConfigured: Boolean(ADMIN_PASSWORD),
    googleOAuthConfigured: oauthConfigured(),
    youtubePublishingEnabled:
      process.env.ENABLE_YOUTUBE_PUBLISHING === "true",
    note: "YouTube test uploads use private visibility."
  });
});

// YOUTUBE STATUS
app.get("/api/youtube/status", (req, res) => {
  const tokens = readTokens();

  res.json({
    configured: oauthConfigured(),
    connected: Boolean(tokens && tokens.refresh_token),
    message:
      tokens && tokens.refresh_token
        ? "YouTube authorization tokens are stored."
        : "YouTube account has not been connected."
  });
});

// START GOOGLE AUTHORIZATION
app.get("/auth/youtube/start", (req, res) => {
  if (!oauthConfigured()) {
    return res.status(503).send("Google OAuth is not configured.");
  }

  const state = crypto.randomBytes(32).toString("hex");
  oauthStates.set(state, Date.now());

  setTimeout(() => oauthStates.delete(state), 10 * 60 * 1000).unref();

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: [
      "https://www.googleapis.com/auth/youtube.upload",
      "https://www.googleapis.com/auth/youtube.readonly"
    ].join(" "),
    access_type: "offline",
    prompt: "consent",
    state
  });

  res.redirect(
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    params.toString()
  );
});

// GOOGLE CALLBACK
app.get("/auth/youtube/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return res.status(400).send("Google authorization was cancelled.");
    }

    const { code, state } = req.query;

    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      !oauthStates.has(state)
    ) {
      return res.status(400).send(
        "Authorization request expired. Please connect again."
      );
    }

    oauthStates.delete(state);

    const oauth = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    const { tokens } = await oauth.getToken(code);
    saveTokens(tokens);

    res.send(`
      <h2>YouTube authorization successful!</h2>
      <p>Authorization tokens have been saved.</p>
      <p>Automatic publishing is controlled separately.</p>
      <a href="/">Return to Creator Auto Publisher</a>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).send("YouTube authorization failed. Check server logs.");
  }
});

// UPLOAD VIDEO OR THUMBNAIL
app.post(
  "/api/upload",
  upload.fields([
    { name: "video", maxCount: 1 },
    { name: "thumbnail", maxCount: 1 }
  ]),
  (req, res) => {
    const video = req.files?.video?.[0];
    const thumbnail = req.files?.thumbnail?.[0];

    if (!video && !thumbnail) {
      return res.status(400).json({
        error: "Select a video or thumbnail."
      });
    }

    res.status(201).json({
      message: "Upload completed.",
      video: video
        ? {
            fileName: video.filename,
            originalName: video.originalname,
            size: video.size
          }
        : null,
      thumbnail: thumbnail
        ? {
            fileName: thumbnail.filename,
            originalName: thumbnail.originalname,
            size: thumbnail.size
          }
        : null
    });
  }
);

// SAVE PUBLISHING PLAN
app.post("/api/plans", (req, res) => {
  const {
    title,
    description = "",
    tags = "",
    hashtags = "",
    platforms,
    contentType = "",
    dateTime,
    videoFileName = "",
    thumbnailFileName = ""
  } = req.body || {};

  if (!title || typeof title !== "string" || !title.trim()) {
    return res.status(400).json({ error: "Title is required." });
  }

  if (!Array.isArray(platforms) || !platforms.length) {
    return res.status(400).json({
      error: "Select at least one platform."
    });
  }

  if (
    typeof dateTime !== "string" ||
    !Number.isFinite(Date.parse(dateTime)) ||
    Date.parse(dateTime) <= Date.now()
  ) {
    return res.status(400).json({
      error: "Select a future publishing date and time."
    });
  }

  const plans = readPlans();

  const plan = {
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 100),
    description: String(description).slice(0, 5000),
    tags: String(tags).slice(0, 1000),
    hashtags: String(hashtags).slice(0, 1000),
    platforms,
    contentType: String(contentType).slice(0, 100),
    dateTime,
    videoFileName: String(videoFileName).slice(0, 255),
    thumbnailFileName: String(thumbnailFileName).slice(0, 255),
    status: "scheduled",
    createdAt: new Date().toISOString()
  };

  plans.push(plan);
  savePlans(plans);

  res.status(201).json({
    message: "Plan saved. Publishing is not enabled yet.",
    plan
  });
});

// LIST PLANS
app.get("/api/plans", (req, res) => {
  res.json({ plans: readPlans() });
});

// YOUTUBE PRIVATE TEST UPLOAD
async function publishYouTubePlan(plan) {
  if (!plan.videoFileName) {
    throw new Error("No video file is attached to this plan.");
  }

  const videoPath = path.join(
    UPLOAD_DIR,
    path.basename(plan.videoFileName)
  );

  if (!fs.existsSync(videoPath)) {
    throw new Error("The uploaded video file could not be found.");
  }

  const auth = getOAuthClient();

  const youtube = google.youtube({
    version: "v3",
    auth
  });

  const tags = String(plan.tags || "")
    .split(",")
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 30);

  const videoResource = {
    snippet: {
      title: plan.title,
      description:
        [plan.description, plan.hashtags]
          .filter(Boolean)
          .join("\n\n")
          .slice(0, 5000),
      categoryId: "22"
    },
    status: {
      privacyStatus: "private",
      selfDeclaredMadeForKids: false
    }
  };

  if (tags.length) {
    videoResource.snippet.tags = tags;
  }

  const response = await youtube.videos.insert({
    part: ["snippet", "status"],
    requestBody: videoResource,
    media: {
      body: fs.createReadStream(videoPath)
    }
  });

  const videoId = response.data.id;

  if (plan.thumbnailFileName) {
    const thumbnailPath = path.join(
      UPLOAD_DIR,
      path.basename(plan.thumbnailFileName)
    );

    if (fs.existsSync(thumbnailPath)) {
      await youtube.thumbnails.set({
        videoId,
        media: {
          body: fs.createReadStream(thumbnailPath)
        }
      });
    }
  }

  return videoId;
}

// SCHEDULER - DISABLED UNLESS ENV VARIABLE IS TRUE
cron.schedule("* * * * *", async () => {
  if (process.env.ENABLE_YOUTUBE_PUBLISHING !== "true") {
    return;
  }

  const plans = readPlans();

  for (const plan of plans) {
    if (
      plan.status !== "scheduled" ||
      !plan.platforms?.includes("YouTube") ||
      Date.parse(plan.dateTime) > Date.now()
    ) {
      continue;
    }

    plan.status = "publishing";
    plan.attemptedAt = new Date().toISOString();
    savePlans(plans);

    try {
      const videoId = await publishYouTubePlan(plan);

      plan.status = "published";
      plan.youtubeVideoId = videoId;
      plan.publishedAt = new Date().toISOString();
      plan.error = "";
    } catch (err) {
      console.error("YouTube publish failed:", err.message);
      plan.status = "failed";
      plan.error = String(err.message).slice(0, 500);
    }

    savePlans(plans);
  }
});

// UPLOAD ERRORS
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error:
        err.code === "LIMIT_FILE_SIZE"
          ? "Maximum file size is 100 MB."
          : err.message
    });
  }

  if (err) {
    return res.status(400).json({
      error: err.message || "Request failed."
    });
  }

  next();
});

// DASHBOARD
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Creator Auto Publisher running on port ${PORT}`);
});
