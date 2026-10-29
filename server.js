const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const PLANS_FILE = path.join(DATA_DIR, "plans.json");
const YOUTUBE_TOKEN_FILE = path.join(DATA_DIR, "youtube-token.json");

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!fs.existsSync(PLANS_FILE)) {
  fs.writeFileSync(PLANS_FILE, "[]", "utf8");
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const BASE_URL =
  process.env.APP_BASE_URL ||
  "https://lightseagreen-skunk-987290.hostingersite.com";

const REDIRECT_URI = BASE_URL + "/auth/youtube/callback";

const YOUTUBE_SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly"
];

const oauthStates = new Map();

function readPlans() {
  try {
    return JSON.parse(fs.readFileSync(PLANS_FILE, "utf8"));
  } catch {
    return [];
  }
}

function writePlans(plans) {
  fs.writeFileSync(PLANS_FILE, JSON.stringify(plans, null, 2));
}

function readYouTubeTokens() {
  try {
    if (!fs.existsSync(YOUTUBE_TOKEN_FILE)) return null;

    return JSON.parse(
      fs.readFileSync(YOUTUBE_TOKEN_FILE, "utf8")
    );
  } catch {
    return null;
  }
}

function saveYouTubeTokens(tokens) {
  const previous = readYouTubeTokens() || {};

  const saved = {
    ...previous,
    ...tokens,
    updatedAt: new Date().toISOString()
  };

  // Keep the refresh token if Google does not send a new one.
  if (!tokens.refresh_token && previous.refresh_token) {
    saved.refresh_token = previous.refresh_token;
  }

  fs.writeFileSync(
    YOUTUBE_TOKEN_FILE,
    JSON.stringify(saved, null, 2),
    { encoding: "utf8", mode: 0o600 }
  );
}

function oauthConfigured() {
  return Boolean(GOOGLE_CLIENT_ID && GOOGLE_CLIENT_SECRET);
}

// Video and thumbnail upload
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, UPLOAD_DIR);
  },
  filename: function (req, file, cb) {
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
  fileFilter: function (req, file, cb) {
    const allowed =
      file.mimetype.startsWith("video/") ||
      file.mimetype.startsWith("image/");

    if (!allowed) {
      return cb(new Error("Only video and image files are allowed."));
    }

    cb(null, true);
  }
});

// Server health
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    app: "Creator Auto Publisher",
    uploads: "API ready",
    scheduling: "Plan storage ready",
    googleOAuthConfigured: oauthConfigured(),
    automaticPublishing: "Not configured"
  });
});

// YouTube connection status
app.get("/api/youtube/status", (req, res) => {
  const tokens = readYouTubeTokens();

  res.json({
    configured: oauthConfigured(),
    connected: Boolean(tokens && tokens.refresh_token),
    connectUrl: "/auth/youtube/start",
    message: !oauthConfigured()
      ? "Add Google OAuth credentials in Hostinger environment variables."
      : tokens && tokens.refresh_token
        ? "YouTube authorization tokens are stored."
        : "YouTube account has not been connected yet."
  });
});

// Start Google OAuth
app.get("/auth/youtube/start", (req, res) => {
  if (!oauthConfigured()) {
    return res.status(503).send(
      "Google OAuth is not configured. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in Hostinger."
    );
  }

  const state = crypto.randomBytes(32).toString("hex");

  // Expire the login state after 10 minutes.
  oauthStates.set(state, Date.now());

  setTimeout(() => {
    oauthStates.delete(state);
  }, 10 * 60 * 1000).unref();

  const params = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: YOUTUBE_SCOPES.join(" "),
    access_type: "offline",
    prompt: "consent",
    include_granted_scopes: "true",
    state
  });

  res.redirect(
    "https://accounts.google.com/o/oauth2/v2/auth?" +
    params.toString()
  );
});

// Google OAuth callback
app.get("/auth/youtube/callback", async (req, res) => {
  try {
    if (!oauthConfigured()) {
      return res.status(503).send(
        "Google OAuth credentials are missing in Hostinger."
      );
    }

    if (req.query.error) {
      return res.status(400).send(
        "Google authorization was not completed: " +
        String(req.query.error)
      );
    }

    const code = req.query.code;
    const state = req.query.state;

    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      !oauthStates.has(state)
    ) {
      return res.status(400).send(
        "Invalid or expired authorization request. Please try connecting again."
      );
    }

    oauthStates.delete(state);

    const response = await fetch(
      "https://oauth2.googleapis.com/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: new URLSearchParams({
          code,
          client_id: GOOGLE_CLIENT_ID,
          client_secret: GOOGLE_CLIENT_SECRET,
          redirect_uri: REDIRECT_URI,
          grant_type: "authorization_code"
        })
      }
    );

    const tokenData = await response.json();

    if (!response.ok) {
      console.error("Google token exchange failed:", tokenData.error);

      return res.status(400).send(
        "Google token exchange failed. Check your OAuth client and redirect URI in Google Cloud."
      );
    }

    saveYouTubeTokens(tokenData);

    res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>YouTube Connection</title>
        <style>
          body {
            background: #0b1020;
            color: white;
            font-family: Arial, sans-serif;
            padding: 25px;
            text-align: center;
          }
          h1 { color: #73e6a6; }
          p { line-height: 1.7; }
          a { color: #9eb5ff; }
        </style>
      </head>
      <body>
        <h1>YouTube Authorization Successful!</h1>
        <p>Google authorization tokens have been saved.</p>
        <p>Automatic video publishing is not enabled yet.</p>
        <p><a href="/">Return to Creator Auto Publisher</a></p>
      </body>
      </html>
    `);
  } catch (error) {
    console.error("YouTube OAuth callback error:", error.message);

    res.status(500).send(
      "YouTube connection failed. Please check the server configuration and try again."
    );
  }
});

// Upload video and/or thumbnail
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
        error: "Select a video or thumbnail to upload."
      });
    }

    res.status(201).json({
      message: "Upload completed",
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

// Save publishing plan
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
    return res.status(400).json({
      error: "Title is required."
    });
  }

  const allowedPlatforms = [
    "YouTube",
    "Instagram",
    "Facebook",
    "Telegram"
  ];

  if (
    !Array.isArray(platforms) ||
    platforms.length === 0 ||
    platforms.some(p => !allowedPlatforms.includes(p))
  ) {
    return res.status(400).json({
      error: "Select at least one valid platform."
    });
  }

  if (
    typeof dateTime !== "string" ||
    !Number.isFinite(Date.parse(dateTime))
  ) {
    return res.status(400).json({
      error: "A valid publishing date and time are required."
    });
  }

  const plans = readPlans();

  const plan = {
    id: crypto.randomUUID(),
    title: title.trim().slice(0, 200),
    description: String(description).slice(0, 10000),
    tags: String(tags).slice(0, 2000),
    hashtags: String(hashtags).slice(0, 2000),
    platforms,
    contentType: String(contentType).slice(0, 100),
    dateTime,
    videoFileName: String(videoFileName).slice(0, 255),
    thumbnailFileName: String(thumbnailFileName).slice(0, 255),
    status: "scheduled",
    createdAt: new Date().toISOString()
  };

  plans.push(plan);
  writePlans(plans);

  res.status(201).json({
    message: "Plan saved. Automatic publishing is not configured yet.",
    plan
  });
});

// List publishing plans
app.get("/api/plans", (req, res) => {
  res.json({ plans: readPlans() });
});

// Handle upload errors
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error: err.code === "LIMIT_FILE_SIZE"
        ? "File is too large. Maximum size is 100 MB."
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

// Dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Creator Auto Publisher running on port ${PORT}`);
});
