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

const MAX_VIDEO_SIZE = 5 * 1024 * 1024 * 1024; // 5 GB upload limit

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
    uploadLimit: "5 GB",
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
// FFMPEG HELPERS
const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let errorOutput = "";

    child.stderr.on("data", data => {
      errorOutput += data.toString();
      if (errorOutput.length > 12000) {
        errorOutput = errorOutput.slice(-12000);
      }
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) return resolve();
      reject(new Error(errorOutput || `${command} failed (${code})`));
    });
  });
}

async function getVideoDuration(file) {
  const args = [
    "-v", "error",
    "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1",
    file
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, args);
    let output = "";

    child.stdout.on("data", data => output += data.toString());
    child.on("error", reject);

    child.on("close", code => {
      const duration = Number(output.trim());

      if (code !== 0 || !Number.isFinite(duration)) {
        return reject(new Error("Could not read video duration."));
      }

      resolve(duration);
    });
  });
}

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("AI mode requires OPENAI_API_KEY. Manual mode does not.");
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

// SHORTS JOBS
const shortsJobs = new Map();
const shortsQueue = [];
let shortsBusy = false;

function updateJob(job, updates) {
  Object.assign(job, updates);
  job.updatedAt = new Date().toISOString();
}

async function renderShort(input, output, start, duration) {
  const args = [
    "-y",
    "-ss", String(start),
    "-i", input,
    "-t", String(duration),
    "-vf",
    "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920",
    "-c:v", "libx264",
    "-preset", "veryfast",
    "-crf", "23",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output
  ];

  await runCommand(FFMPEG, args);
}

// MANUAL MODE
async function processManualShort(job) {
  const duration = await getVideoDuration(job.input);

  const start = Number(job.start);
  const end = Number(job.end);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > duration
  ) {
    throw new Error("Invalid trim times. Check the start and end times.");
  }

  if (end - start > 90) {
    throw new Error("Manual Shorts duration cannot exceed 90 seconds.");
  }

  const filename = "short-" + job.id + ".mp4";
  const output = path.join(SHORTS_DIR, filename);

  updateJob(job, {
    status: "processing",
    progress: 20,
    message: "Creating your manual Short..."
  });

  await renderShort(job.input, output, start, end - start);

  updateJob(job, {
    status: "completed",
    progress: 100,
    message: "Your Short is ready.",
    outputs: [filename]
  });
}

// AI MODE
async function processAIShorts(job) {
  const openai = getOpenAI();

  updateJob(job, {
    status: "processing",
    progress: 5,
    message: "Reading video duration..."
  });

  const duration = await getVideoDuration(job.input);

  const audioFile = path.join(SHORTS_DIR, job.id + "-audio.mp3");

  updateJob(job, {
    progress: 10,
    message: "Extracting audio for AI analysis..."
  });

  await runCommand(FFMPEG, [
    "-y",
    "-i", job.input,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "48k",
    audioFile
  ]);

  const audioStats = fs.statSync(audioFile);

  if (audioStats.size > 24 * 1024 * 1024) {
    throw new Error(
      "Audio is larger than the transcription limit. Use a shorter video."
    );
  }

  updateJob(job, {
    progress: 25,
    message: "AI is transcribing the video..."
  });

  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(audioFile),
    model: "whisper-1",
    language: "ur",
    response_format: "verbose_json"
  });

  const segments = transcription.segments || [];

  if (!segments.length) {
    throw new Error("AI could not find timestamped speech in this video.");
  }

  updateJob(job, {
    progress: 45,
    message: "AI is selecting interesting moments..."
  });

  const count = Number(job.count);
  const clipDuration = Number(job.duration);

  const transcriptText = segments.map(segment => ({
    start: segment.start,
    end: segment.end,
    text: segment.text
  }));

  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      {
        role: "system",
        content:
          "You are a video editor. Select engaging, self-contained moments from this timestamped transcript. Return JSON with a clips array. Each clip must have start and end in seconds, and a short title. Do not invent timestamps. Respect the requested duration."
      },
      {
        role: "user",
        content: JSON.stringify({
          videoDuration: duration,
          requestedClips: count,
          requestedClipDuration: clipDuration,
          transcript: transcriptText
        })
      }
    ]
  });

  const result = JSON.parse(
    response.choices[0].message.content || "{}"
  );

  if (!Array.isArray(result.clips) || !result.clips.length) {
    throw new Error("AI did not return any usable clips.");
  }

  const clips = result.clips.slice(0, count);

  updateJob(job, {
    progress: 60,
    message: "Rendering AI-selected Shorts..."
  });

  const outputs = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];

    const start = Math.max(0, Number(clip.start));
    const end = Math.min(
      duration,
      Number(clip.end),
      start + clipDuration
    );

    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start ||
      end - start < 5
    ) {
      continue;
    }

    const filename = `short-${job.id}-${i + 1}.mp4`;
    const output = path.join(SHORTS_DIR, filename);

    await renderShort(job.input, output, start, end - start);
    outputs.push(filename);

    updateJob(job, {
      progress: 60 + Math.round(((i + 1) / clips.length) * 35),
      message: `Rendering Short ${i + 1} of ${clips.length}...`
    });
  }

  if (!outputs.length) {
    throw new Error("AI selected no valid video clips.");
  }

  updateJob(job, {
    status: "completed",
    progress: 100,
    message: "Your AI Shorts are ready.",
    outputs
  });

  try {
    fs.unlinkSync(audioFile);
  } catch {}
}

// JOB PROCESSOR
async function processShorts(job) {
  if (shortsBusy) {
    shortsQueue.push(job);
    updateJob(job, {
      status: "queued",
      message: "Waiting for another job to finish."
    });
    return;
  }

  shortsBusy = true;

  try {
    if (job.mode === "manual") {
      await processManualShort(job);
    } else {
      await processAIShorts(job);
    }
  } catch (error) {
    console.error("Shorts processing error:", error);

    updateJob(job, {
      status: "failed",
      message: error.message || "Shorts processing failed."
    });
  } finally {
    shortsBusy = false;

    if (shortsQueue.length) {
      const nextJob = shortsQueue.shift();
      processShorts(nextJob);
    }
  }
    }
// SHORTS API
app.post("/api/shorts", shortsUpload.single("video"), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "Please upload a video." });
    }

    const mode = req.body.mode === "manual" ? "manual" : "ai";
    const id = crypto.randomUUID();

    const job = {
      id,
      input: req.file.path,
      originalName: req.file.originalname,
      mode,
      count: Math.min(15, Math.max(1, Number(req.body.count) || 5)),
      duration: Number(req.body.duration) || 30,
      start: Number(req.body.start) || 0,
      end: Number(req.body.end) || 60,
      captions: req.body.captions === "true",
      status: "queued",
      progress: 0,
      message: "Job received.",
      outputs: [],
      createdAt: new Date().toISOString()
    };

    if (
      mode === "ai" &&
      (![5, 10, 15].includes(job.count) ||
       ![30, 45, 60].includes(job.duration))
    ) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({
        error: "AI mode supports 5, 10 or 15 clips and 30, 45 or 60 seconds."
      });
    }

    if (job.captions) {
      fs.unlink(req.file.path, () => {});
      return res.status(501).json({
        error: "Roman Urdu captions are not implemented in this server version. Turn captions OFF."
      });
    }

    shortsJobs.set(id, job);
    processShorts(job);

    res.json({ id, jobId: id, status: job.status });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/shorts/:id", (req, res) => {
  const job = shortsJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }

  res.json(job);
});

app.get("/api/shorts/:id/download/:file", (req, res) => {
  const job = shortsJobs.get(req.params.id);

  if (!job || !job.outputs.includes(req.params.file)) {
    return res.status(404).send("File not found.");
  }

  const file = path.join(SHORTS_DIR, path.basename(req.params.file));

  if (!fs.existsSync(file)) {
    return res.status(404).send("File not found.");
  }

  res.download(file);
});

// PLANS API
app.get("/api/plans", (req, res) => {
  res.json(readPlans());
});

app.post("/api/plans", (req, res) => {
  const plans = readPlans();
  const plan = {
    id: crypto.randomUUID(),
    ...req.body,
    createdAt: new Date().toISOString()
  };

  plans.push(plan);
  savePlans(plans);

  res.json({ success: true, plan });
});

app.put("/api/plans/:id", (req, res) => {
  const plans = readPlans();
  const index = plans.findIndex(p => p.id === req.params.id);

  if (index === -1) {
    return res.status(404).json({ error: "Plan not found." });
  }

  plans[index] = {
    ...plans[index],
    ...req.body,
    id: req.params.id
  };

  savePlans(plans);
  res.json({ success: true, plan: plans[index] });
});

app.delete("/api/plans/:id", (req, res) => {
  const plans = readPlans();
  const updated = plans.filter(p => p.id !== req.params.id);

  savePlans(updated);
  res.json({ success: true });
});

// PRIVATE YOUTUBE TEST UPLOAD
app.post("/api/youtube/test-upload", upload.single("video"), async (req, res) => {
  let uploadedFile = req.file ? req.file.path : null;

  try {
    if (!req.file) {
      return res.status(400).json({ error: "Select a video first." });
    }

    const oauth = getOAuthClient();
    const youtube = google.youtube({
      version: "v3",
      auth: oauth
    });

    const title = String(req.body.title || "Private test upload").slice(0, 100);
    const description = String(req.body.description || "").slice(0, 5000);

    const result = await youtube.videos.insert
