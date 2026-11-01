const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const cron = require("node-cron");
const { google } = require("googleapis");
const OpenAI = require("openai");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, "data");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const SHORTS_DIR = path.join(__dirname, "shorts");
const PLANS_FILE = path.join(DATA_DIR, "plans.json");
const TOKEN_FILE = path.join(DATA_DIR, "youtube-token.json");

const MAX_VIDEO_SIZE = 1024 * 1024 * 1024;

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(SHORTS_DIR, { recursive: true });

if (!fs.existsSync(PLANS_FILE)) {
  fs.writeFileSync(PLANS_FILE, "[]");
}

app.use(express.json({ limit: "1mb" }));

// ADMIN AUTH
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
  const password = separator >= 0 ? credentials.slice(separator + 1) : "";

  const a = Buffer.from(password);
  const b = Buffer.from(ADMIN_PASSWORD);

  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.set("WWW-Authenticate", 'Basic realm="Creator Auto Publisher"');
    return res.status(401).send("Wrong admin password.");
  }

  next();
}

// PUBLIC ROUTES
app.use((req, res, next) => {
  if (
    req.path === "/api/health" ||
    req.path === "/auth/youtube/callback"
  ) {
    return next();
  }

  adminAuth(req, res, next);
});

// GOOGLE SETTINGS
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
  if (!oauthConfigured()) {
    throw new Error("Google OAuth is not configured.");
  }

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

// UPLOAD STORAGE
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
    fileSize: MAX_VIDEO_SIZE,
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

const shortsStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),

  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).slice(0, 12);
    cb(null, "shorts-" + crypto.randomUUID() + ext);
  }
});

const shortsUpload = multer({
  storage: shortsStorage,
  limits: {
    fileSize: MAX_VIDEO_SIZE,
    files: 1
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("video/")) {
      return cb(null, true);
    }

    cb(new Error("Please select a video file."));
  }
});

// HEALTH
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    app: "Creator Auto Publisher",
    adminPasswordConfigured: Boolean(ADMIN_PASSWORD),
    googleOAuthConfigured: oauthConfigured(),
    uploadApi: "available",
    uploadLimit: "1 GB",
    scheduler: "running",
    youtubePublishingEnabled:
      process.env.ENABLE_YOUTUBE_PUBLISHING === "true",
    shortsApi: "available",
    ffmpegConfigured: Boolean(process.env.FFMPEG_PATH),
    openAIConfigured: Boolean(process.env.OPENAI_API_KEY),
    note: "Manual YouTube test uploads always use private visibility."
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

// GOOGLE AUTH
const oauthStates = new Map();

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
    "https://accounts.google.com/o/oauth2/v2/auth?" + params.toString()
  );
});

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
      return res.status(400).send("Authorization request expired.");
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
      <p>Tokens have been saved.</p>
      <p>Automatic publishing remains separately controlled.</p>
      <a href="/">Return to dashboard</a>
    `);
  } catch (err) {
    console.error("OAuth callback error:", err.message);
    res.status(500).send("YouTube authorization failed.");
  }
});

// NORMAL VIDEO UPLOAD - 1 GB
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

const ALLOWED_PLATFORMS = [
  "YouTube",
  "Instagram",
  "Facebook",
  "Telegram"
];

function validFutureDate(dateTime) {
  return (
    typeof dateTime === "string" &&
    Number.isFinite(Date.parse(dateTime)) &&
    Date.parse(dateTime) > Date.now()
  );
}

// SAVE PLAN
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

  if (
    !Array.isArray(platforms) ||
    !platforms.length ||
    platforms.some(p => !ALLOWED_PLATFORMS.includes(p))
  ) {
    return res.status(400).json({ error: "Select valid platforms." });
  }

  if (!validFutureDate(dateTime)) {
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
    videoFileName: path.basename(String(videoFileName)).slice(0, 255),
    thumbnailFileName: path.basename(String(thumbnailFileName)).slice(0, 255),
    status: "scheduled",
    createdAt: new Date().toISOString()
  };

  plans.push(plan);
  savePlans(plans);

  res.status(201).json({
    message: "Plan saved. Automatic publishing is not enabled.",
    plan
  });
});

// LIST PLANS
app.get("/api/plans", (req, res) => {
  res.json({ plans: readPlans() });
});

// EDIT PLAN
app.put("/api/plans/:id", (req, res) => {
  const plans = readPlans();
  const plan = plans.find(p => p.id === req.params.id);

  if (!plan) {
    return res.status(404).json({ error: "Publishing plan not found." });
  }

  if (plan.status !== "scheduled") {
    return res.status(400).json({
      error: "Only scheduled plans can be edited."
    });
  }

  const body = req.body || {};

  if (
    typeof body.title !== "string" ||
    !body.title.trim() ||
    body.title.trim().length > 100
  ) {
    return res.status(400).json({ error: "Invalid title." });
  }

  if (!validFutureDate(body.dateTime)) {
    return res.status(400).json({
      error: "Choose a future publishing date and time."
    });
  }

  if (
    !Array.isArray(body.platforms) ||
    !body.platforms.length ||
    body.platforms.some(p => !ALLOWED_PLATFORMS.includes(p))
  ) {
    return res.status(400).json({ error: "Select valid platforms." });
  }

  plan.title = body.title.trim();
  plan.description = String(body.description || "").slice(0, 5000);
  plan.tags = String(body.tags || "").slice(0, 1000);
  plan.hashtags = String(body.hashtags || "").slice(0, 1000);
  plan.platforms = body.platforms;
  plan.contentType = String(body.contentType || "").slice(0, 100);
  plan.dateTime = body.dateTime;
  plan.updatedAt = new Date().toISOString();

  savePlans(plans);
  res.json({ message: "Publishing plan updated.", plan });
});

// CANCEL PLAN
app.post("/api/plans/:id/cancel", (req, res) => {
  const plans = readPlans();
  const plan = plans.find(p => p.id === req.params.id);

  if (!plan) {
    return res.status(404).json({ error: "Publishing plan not found." });
  }

  if (plan.status !== "scheduled") {
    return res.status(400).json({
      error: "Only scheduled plans can be cancelled."
    });
  }

  plan.status = "cancelled";
  plan.cancelledAt = new Date().toISOString();

  savePlans(plans);
  res.json({ message: "Publishing plan cancelled successfully.", plan });
});

// YOUTUBE PRIVATE UPLOAD
async function publishYouTubePlan(plan) {
  if (!plan.videoFileName) {
    throw new Error("No video file is attached to this plan.");
  }

  const videoPath = path.join(UPLOAD_DIR, path.basename(plan.videoFileName));

  if (!fs.existsSync(videoPath)) {
    throw new Error("Uploaded video file could not be found.");
  }

  const youtube = google.youtube({
    version: "v3",
    auth: getOAuthClient()
  });

  const tags = String(plan.tags || "")
    .split(",")
    .map(tag => tag.trim())
    .filter(Boolean)
    .slice(0, 30);

  const videoResource = {
    snippet: {
      title: plan.title,
      description: [
        plan.description,
        plan.hashtags
      ].filter(Boolean).join("\n\n").slice(0, 5000),
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
    media: { body: fs.createReadStream(videoPath) }
  });

  const videoId = response.data.id;

  if (!videoId) {
    throw new Error("YouTube did not return a video ID.");
  }

  plan.youtubeVideoId = videoId;
  plan.youtubeUploadedAt = new Date().toISOString();

  const savedPlans = readPlans().map(p =>
    p.id === plan.id ? { ...p, ...plan } : p
  );
  savePlans(savedPlans);

  if (plan.thumbnailFileName) {
    const thumbnailPath = path.join(
      UPLOAD_DIR,
      path.basename(plan.thumbnailFileName)
    );

    if (fs.existsSync(thumbnailPath)) {
      try {
        await youtube.thumbnails.set({
          videoId,
          media: { body: fs.createReadStream(thumbnailPath) }
        });
      } catch (err) {
        console.error("Thumbnail upload failed:", err.message);
        plan.thumbnailError = String(err.message).slice(0, 300);
      }
    }
  }

  return videoId;
}

// PRIVATE TEST UPLOAD
app.post("/api/plans/:id/test-upload", async (req, res) => {
  const plans = readPlans();
  const plan = plans.find(p => p.id === req.params.id);

  if (!plan) {
    return res.status(404).json({ error: "Publishing plan not found." });
  }

  if (plan.status !== "scheduled") {
    return res.status(400).json({
      error: "Only scheduled plans can be test-uploaded."
    });
  }

  if (!plan.platforms?.includes("YouTube")) {
    return res.status(400).json({
      error: "YouTube is not selected for this plan."
    });
  }

  if (!plan.videoFileName) {
    return res.status(400).json({ error: "This plan has no video file." });
  }

  plan.status = "publishing";
  plan.testUploadStartedAt = new Date().toISOString();
  savePlans(plans);

  try {
    const videoId = await publishYouTubePlan(plan);

    const updatedPlans = readPlans();
    const index = updatedPlans.findIndex(p => p.id === plan.id);

    if (index !== -1) {
      updatedPlans[index] = {
        ...updatedPlans[index],
        ...plan,
        status: "test-published",
        youtubeVideoId: videoId,
        publishedAt: new Date().toISOString(),
        error: ""
      };
      savePlans(updatedPlans);
    }

    res.json({
      message: "Private test upload completed successfully.",
      privacyStatus: "private",
      youtubeVideoId: videoId,
      youtubeUrl: "https://www.youtube.com/watch?v=" + videoId
    });
  } catch (err) {
    console.error("Private test upload failed:", err.message);

    const updatedPlans = readPlans();
    const index = updatedPlans.findIndex(p => p.id === plan.id);

    if (index !== -1) {
      updatedPlans[index].status = "failed";
      updatedPlans[index].error = String(err.message).slice(0, 500);
      updatedPlans[index].failedAt = new Date().toISOString();
      savePlans(updatedPlans);
    }

    res.status(500).json({
      error: err.message || "Private test upload failed."
    });
  }
});

// AI SHORTS JOBS
const shortsJobs = new Map();
let shortsBusy = false;

function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
    const process = spawn(ffmpegPath, args);

    let errorText = "";

    process.stderr.on("data", data => {
      errorText += data.toString();

      if (errorText.length > 12000) {
        errorText = errorText.slice(-12000);
      }
    });

    process.on("error", reject);

    process.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error("FFmpeg failed: " + errorText.slice(-1500)));
    });
  });
}

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is missing in Hostinger Environment Variables.");
  }

  return new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
}

async function getClipSuggestions(client, transcript, count, duration) {
  const prompt = `
You are an expert Urdu video editor.
Choose ${count} interesting clips from this Urdu transcript.
Each clip should be close to ${duration} seconds.
Choose funny, emotional, useful or engaging moments.
Do not invent timestamps.
Return JSON only:
{"clips":[{"start":0,"end":30,"reason":"short reason"}]}

Transcript:
${transcript}
`;

  const result = await client.chat.completions.create({
    model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    response_format: { type: "json_object" }
  });

  const parsed = JSON.parse(result.choices[0].message.content);
  return Array.isArray(parsed.clips) ? parsed.clips : [];
}

async function processShorts(job) {
  if (shortsBusy) {
    job.status = "queued";
    return;
  }

  shortsBusy = true;

  try {
    const client = getOpenAI();
    const videoPath = path.join(UPLOAD_DIR, job.fileName);

    job.status = "transcribing";
    job.progress = 10;

    const audioPath = path.join(SHORTS_DIR, job.id + ".mp3");

    await runFFmpeg([
      "-y",
      "-i", videoPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-b:a", "48k",
      audioPath
    ]);

    const audioStats = fs.statSync(audioPath);

    if (audioStats.size > 24 * 1024 * 1024) {
      throw new Error("Audio is too large for one transcription request. A shorter video is needed.");
    }

    const transcription = await client.audio.transcriptions.create({
      file: fs.createReadStream(audioPath),
      model: "whisper-1",
      language: "ur",
      response_format: "verbose_json",
      timestamp_granularities: ["segment"]
    });

    job.progress = 35;

    const segments = transcription.segments || [];
    const transcript = segments.map(s =>
      `[${Number(s.start).toFixed(1)}-${Number(s.end).toFixed(1)}] ${s.text}`
    ).join("\n");

    if (!transcript.trim()) {
      throw new Error("No Urdu speech was detected in this video.");
    }

    let clips = [];

    if (job.mode === "manual") {
      clips = [{
        start: job.manualStart,
        end: job.manualEnd,
        reason: "Manual selection"
      }];
    } else {
      job.status = "selecting moments";
      clips = await getClipSuggestions(
        client,
        transcript.slice(0, 45000),
        job.count,
        job.duration
      );
    }

    const videoDuration = Number(
      transcription.duration || 0
    );

    clips = clips
      .map(c => ({
        start: Math.max(0, Number(c.start)),
        end: Math.min(videoDuration, Number(c.end)),
        reason: String(c.reason || "")
      }))
      .filter(c =>
        Number.isFinite(c.start) &&
        Number.isFinite(c.end) &&
        c.end > c.start &&
        c.end - c.start <= 90
      );

    if (!clips.length) {
      throw new Error("AI could not find valid clips.");
    }

    job.status = "rendering";
    job.progress = 50;
    job.outputs = [];

    for (let i = 0; i < clips.length; i++) {
      const clip = clips[i];
      const outputName = job.id + "-short-" + (i + 1) + ".mp4";
      const outputPath = path.join(SHORTS_DIR, outputName);

      const args = [
        "-y",
        "-ss", String(clip.start),
        "-i", videoPath,
        "-t", String(clip.end - clip.start),
        "-vf",
        "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-crf", "23",
        "-c:a", "aac",
        "-b:a", "128k",
        "-movflags", "+faststart",
        outputPath
      ];

      await runFFmpeg(args);

      job.outputs.push({
        fileName: outputName,
        start: clip.start,
        end: clip.end,
        reason: clip.reason,
        captions: "off"
      });

      job.progress = 50 + Math.round(((i + 1) / clips.length) * 45);
    }

    job.status = "completed";
    job.progress = 100;
    job.completedAt = new Date().toISOString();

    try {
      fs.unlinkSync(audioPath);
    } catch {}
  } catch (err) {
    console.error("Shorts processing failed:", err.message);
    job.status = "failed";
    job.error = String(err.message).slice(0, 1000);
  } finally {
    shortsBusy = false;

    const nextJob = [...shortsJobs.values()].find(
      j => j.status === "queued"
    );

    if (nextJob) {
      processShorts(nextJob);
    }
  }
}

// CREATE AI SHORTS JOB
app.post("/api/shorts", shortsUpload.single("video"), (req, res) => {
  const video = req.file;

  if (!video) {
    return res.status(400).json({ error: "Select a video." });
  }

  const mode = req.body.mode === "manual" ? "manual" : "ai";
  const count = Math.max(1, Math.min(15, Number(req.body.count) || 5));
  const duration = [30, 45, 60].includes(Number(req.body.duration))
    ? Number(req.body.duration)
    : 30;

  const manualStart = Number(req.body.start);
  const manualEnd = Number(req.body.end);

  if (
    mode === "manual" &&
    (
      !Number.isFinite(manualStart) ||
      !Number.isFinite(manualEnd) ||
      manualStart < 0 ||
      manualEnd <= manualStart ||
      manualEnd - manualStart > 90
    )
  ) {
    fs.unlink(video.path, () => {});
    return res.status(400).json({
      error: "Enter valid manual start and end times. Maximum clip duration is 90 seconds."
    });
  }

  const id = crypto.randomUUID();

  const job = {
    id,
    fileName: video.filename,
    mode,
    count,
    duration,
    manualStart,
    manualEnd,
    status: "queued",
    progress: 0,
    outputs: [],
    createdAt: new Date().toISOString()
  };

  shortsJobs.set(id, job);
  processShorts(job);

  res.status(202).json({
    message: "Shorts job accepted.",
    jobId: id,
    status: job.status
  });
});

// CHECK SHORTS JOB
app.get("/api/shorts/:id", (req, res) => {
  const job = shortsJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: "Shorts job not found." });
  }

  res.json({
    id: job.id,
    status: job.status,
    progress: job.progress,
    outputs: job.outputs,
    error: job.error || ""
  });
});

// DOWNLOAD SHORT
app.get("/api/shorts/:id/download/:file", (req, res) => {
  const job = shortsJobs.get(req.params.id);

  if (!job || job.status !== "completed") {
    return res.status(404).send("Shorts output not found.");
  }

  const fileName = path.basename(req.params.file);

  if (!job.outputs.some(o => o.fileName === fileName)) {
    return res.status(404).send("Invalid output file.");
  }

  const filePath = path.join(SHORTS_DIR, fileName);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File no longer exists.");
  }

  res.download(filePath);
});

// SCHEDULER
let schedulerBusy = false;

cron.schedule("* * * * *", async () => {
  if (
    process.env.ENABLE_YOUTUBE_PUBLISHING !== "true" ||
    schedulerBusy
  ) {
    return;
  }

  schedulerBusy = true;

  try {
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
  } finally {
    schedulerBusy = false;
  }
});

// REQUEST ERRORS
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({
      error:
        err.code === "LIMIT_FILE_SIZE"
          ? "Maximum file size is 1 GB."
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
