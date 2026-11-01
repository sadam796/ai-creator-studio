"use strict";

const express = require("express");
const multer = require("multer");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
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

const MAX_VIDEO_SIZE = 5 * 1024 * 1024 * 1024;

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(SHORTS_DIR, { recursive: true });

if (!fs.existsSync(PLANS_FILE)) {
  fs.writeFileSync(PLANS_FILE, "[]");
}

app.use(express.json({ limit: "2mb" }));

// ==========================================
// ADMIN AUTHENTICATION
// ==========================================

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

function adminAuth(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(503).send("ADMIN_PASSWORD is not configured.");
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

  if (
    a.length !== b.length ||
    !crypto.timingSafeEqual(a, b)
  ) {
    res.set("WWW-Authenticate", 'Basic realm="Creator Auto Publisher"');
    return res.status(401).send("Wrong password.");
  }

  next();
}

// Health and OAuth callback are public.
// All other routes require admin authentication.
app.use((req, res, next) => {
  if (
    req.path === "/api/health" ||
    req.path === "/auth/youtube/callback"
  ) {
    return next();
  }

  adminAuth(req, res, next);
});

// ==========================================
// GOOGLE / YOUTUBE CONFIGURATION
// ==========================================

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;

const BASE_URL =
  process.env.APP_BASE_URL ||
  "https://lightseagreen-skunk-987290.hostingersite.com";

const REDIRECT_URI =
  BASE_URL + "/auth/youtube/callback";

function oauthConfigured() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

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
  fs.writeFileSync(
    PLANS_FILE,
    JSON.stringify(plans, null, 2)
  );
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

  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify(saved, null, 2),
    { mode: 0o600 }
  );
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

// ==========================================
// FILE UPLOAD CONFIGURATION
// ==========================================

function makeStorage(prefix) {
  return multer.diskStorage({
    destination: (req, file, cb) => {
      cb(null, UPLOAD_DIR);
    },

    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 12);
      cb(null, prefix + crypto.randomUUID() + ext);
    }
  });
}

const upload = multer({
  storage: makeStorage("upload-"),
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

const shortsUpload = multer({
  storage: makeStorage("shorts-"),
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

// ==========================================
// HEALTH API
// ==========================================

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    app: "Creator Auto Publisher",
    uploadLimit: "5 GB",
    adminPasswordConfigured: Boolean(ADMIN_PASSWORD),
    googleOAuthConfigured: oauthConfigured(),
    youtubeConnected: Boolean(
      readTokens() && readTokens().refresh_token
    ),
    openAIConfigured: Boolean(process.env.OPENAI_API_KEY),
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    shortsApi: "available",
    automaticPublishing: false,
    message: "Automatic YouTube publishing is disabled."
  });
});

// ==========================================
// YOUTUBE AUTHENTICATION
// ==========================================

const oauthStates = new Map();

app.get("/api/youtube/status", (req, res) => {
  const tokens = readTokens();

  res.json({
    configured: oauthConfigured(),
    connected: Boolean(tokens && tokens.refresh_token)
  });
});

app.get("/auth/youtube/start", (req, res) => {
  if (!oauthConfigured()) {
    return res.status(503).send(
      "Google OAuth is not configured."
    );
  }

  const state = crypto.randomBytes(32).toString("hex");

  oauthStates.set(state, Date.now());

  setTimeout(() => {
    oauthStates.delete(state);
  }, 10 * 60 * 1000).unref();

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

app.get("/auth/youtube/callback", async (req, res) => {
  try {
    if (req.query.error) {
      return res.status(400).send(
        "Google authorization was cancelled."
      );
    }

    const { code, state } = req.query;

    if (
      typeof code !== "string" ||
      typeof state !== "string" ||
      !oauthStates.has(state)
    ) {
      return res.status(400).send(
        "Authorization request expired."
      );
    }

    oauthStates.delete(state);

    const oauth = new google.auth.OAuth2(
      CLIENT_ID,
      CLIENT_SECRET,
      REDIRECT_URI
    );

    const result = await oauth.getToken(code);

    saveTokens(result.tokens);

    res.send(`
      <h2>YouTube connected successfully!</h2>
      <p>Your authorization tokens have been saved.</p>
      <p>Automatic publishing remains OFF.</p>
      <a href="/">Return to dashboard</a>
    `);

  } catch (error) {
    console.error("OAuth error:", error.message);

    res.status(500).send(
      "YouTube authorization failed."
    );
  }
});

// ==========================================
// FFMPEG HELPERS
// ==========================================

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "pipe"]
    });

    let errorOutput = "";

    child.stderr.on("data", data => {
      errorOutput += data.toString();

      if (errorOutput.length > 15000) {
        errorOutput = errorOutput.slice(-15000);
      }
    });

    child.on("error", reject);

    child.on("close", code => {
      if (code === 0) {
        return resolve();
      }

      reject(
        new Error(errorOutput || command + " failed.")
      );
    });
  });
}

async function getVideoDuration(file) {
  return new Promise((resolve, reject) => {
    const child = spawn(FFPROBE, [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      file
    ]);

    let output = "";

    child.stdout.on("data", data => {
      output += data.toString();
    });

    child.on("error", reject);

    child.on("close", code => {
      const duration = Number(output.trim());

      if (code !== 0 || !Number.isFinite(duration)) {
        return reject(
          new Error("Could not read video duration.")
        );
      }

      resolve(duration);
    });
  });
}

function getOpenAI() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error(
      "AI mode requires OPENAI_API_KEY. Manual mode does not."
    );
  }

  return new OpenAI({
    apiKey: process.env.OPENAI_API_KEY
  });
}

// ==========================================
// SHORTS JOB MANAGEMENT
// ==========================================

const shortsJobs = new Map();
const shortsQueue = [];

let shortsBusy = false;

function updateJob(job, updates) {
  Object.assign(job, updates);

  job.updatedAt = new Date().toISOString();
}

 async function renderShort(
  input,
  output,
  start,
  duration,
  subtitleFile = null
) {
  let videoFilter =
    "scale=1080:1920:force_original_aspect_ratio=increase," +
    "crop=1080:1920";

  if (subtitleFile) {
    const escaped = subtitleFile
      .replace(/\\/g, "/")
      .replace(/:/g, "\\:")
      .replace(/'/g, "\\'");

    videoFilter += ",subtitles='" + escaped + "'";
  }

  const args = [
    "-y",
    "-ss", String(start),
    "-i", input,
    "-t", String(duration),
    "-vf", videoFilter,
    "-c:v", "libx264",
    "-threads:v", "1",
    "-preset", "ultrafast",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "128k",
    "-movflags", "+faststart",
    output
  ];

  await runCommand(FFMPEG, args);
}

// ==========================================
// ROMAN URDU CAPTIONS
// ==========================================

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));

  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  const millis = ms % 1000;

  return (
    String(hours).padStart(2, "0") + ":" +
    String(minutes).padStart(2, "0") + ":" +
    String(secs).padStart(2, "0") + "," +
    String(millis).padStart(3, "0")
  );
}

async function createRomanUrduSRT(
  openai,
  input,
  jobId
) {
  const audioFile = path.join(
    SHORTS_DIR,
    jobId + "-captions.mp3"
  );

  const srtFile = path.join(
    SHORTS_DIR,
    jobId + "-captions.srt"
  );

  await runCommand(FFMPEG, [
    "-y",
    "-i", input,
    "-vn",
    "-ac", "1",
    "-ar", "16000",
    "-b:a", "48k",
    audioFile
  ]);

  const stats = fs.statSync(audioFile);

  if (stats.size > 24 * 1024 * 1024) {
    fs.unlink(audioFile, () => {});

    throw new Error(
      "Caption audio exceeds the transcription limit. Use a shorter video."
    );
  }

  const transcription =
    await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: "whisper-1",
      language: "ur",
      response_format: "verbose_json"
    });

  const segments = transcription.segments || [];

  if (!segments.length) {
    throw new Error(
      "No speech was found for captions."
    );
  }

  const translated =
    await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "Convert each Urdu speech segment into natural Roman Urdu. Keep the same order and return JSON with an array called captions. Each item must have an index and text. Do not use Urdu script. Do not translate into English."
        },
        {
          role: "user",
          content: JSON.stringify(
            segments.map((segment, index) => ({
              index,
              text: segment.text
            }))
          )
        }
      ]
    });

  const data = JSON.parse(
    translated.choices[0].message.content || "{}"
  );

  if (!Array.isArray(data.captions)) {
    throw new Error(
      "Roman Urdu caption conversion failed."
    );
  }

  const captionMap = new Map();

  data.captions.forEach(item => {
    captionMap.set(
      Number(item.index),
      String(item.text || "")
    );
  });

  let srt = "";

  segments.forEach((segment, index) => {
    const text = captionMap.get(index);

    if (!text) return;

    srt +=
      (index + 1) + "\n" +
      srtTime(segment.start) + " --> " +
      srtTime(segment.end) + "\n" +
      text.replace(/\n/g, " ") + "\n\n";
  });

  fs.writeFileSync(srtFile, srt, "utf8");

  fs.unlink(audioFile, () => {});

  return {
    srtFile,
    segments
  };
}

// ==========================================
// MANUAL SHORTS MODE
// ==========================================

async function processManualShort(job) {
  const videoDuration = await getVideoDuration(job.input);

  const start = Number(job.start);
  const end = Number(job.end);

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > videoDuration
  ) {
    throw new Error(
      "Invalid trim times. Check start and end."
    );
  }

  if (end - start > 90) {
    throw new Error(
      "Manual Short cannot exceed 90 seconds."
    );
  }

  let subtitleFile = null;

  if (job.captions) {
    updateJob(job, {
      status: "processing",
      progress: 15,
      message: "Creating Roman Urdu captions..."
    });

    const openai = getOpenAI();

    const captionData = await createRomanUrduSRT(
      openai,
      job.input,
      job.id
    );

    subtitleFile = captionData.srtFile;
  }

  const filename = "short-" + job.id + ".mp4";

  const output = path.join(
    SHORTS_DIR,
    filename
  );

  updateJob(job, {
    status: "processing",
    progress: 50,
    message: "Rendering your Short..."
  });

  await renderShort(
    job.input,
    output,
    start,
    end - start,
    subtitleFile
  );

  if (subtitleFile) {
    fs.unlink(subtitleFile, () => {});
  }

  updateJob(job, {
    status: "completed",
    progress: 100,
    message: "Your Short is ready.",
    outputs: [filename]
  });
}

// ==========================================
// AI SHORTS MODE
// ==========================================

async function processAIShorts(job) {
  const openai = getOpenAI();

  updateJob(job, {
    status: "processing",
    progress: 5,
    message: "Checking video..."
  });

  const videoDuration = await getVideoDuration(job.input);

  const audioFile = path.join(
    SHORTS_DIR,
    job.id + "-audio.mp3"
  );

  updateJob(job, {
    progress: 10,
    message: "Extracting audio..."
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
    fs.unlink(audioFile, () => {});

    throw new Error(
      "Audio exceeds the transcription limit. Use a shorter video."
    );
  }

  updateJob(job, {
    progress: 25,
    message: "AI is transcribing your video..."
  });

  const transcription =
    await openai.audio.transcriptions.create({
      file: fs.createReadStream(audioFile),
      model: "whisper-1",
      language: "ur",
      response_format: "verbose_json"
    });

  fs.unlink(audioFile, () => {});

  const segments = transcription.segments || [];

  if (!segments.length) {
    throw new Error(
      "AI could not find timestamped speech."
    );
  }

  updateJob(job, {
    progress: 45,
    message: "AI is selecting interesting moments..."
  });

  const transcript = segments.map(segment => ({
    start: segment.start,
    end: segment.end,
    text: segment.text
  }));

  const response =
    await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content:
            "You are an expert short-video editor. Select engaging, self-contained moments from the timestamped transcript. Return JSON with a clips array. Every clip must have start, end and title. Use only supplied timestamps. Do not invent timestamps. Respect requested clip duration."
        },
        {
          role: "user",
          content: JSON.stringify({
            videoDuration,
            requestedClips: job.count,
            requestedClipDuration: job.duration,
            transcript
          })
        }
      ]
    });

  const result = JSON.parse(
    response.choices[0].message.content || "{}"
  );

  if (
    !Array.isArray(result.clips) ||
    result.clips.length === 0
  ) {
    throw new Error(
      "AI did not return any usable clips."
    );
  }

  const clips = result.clips.slice(0, job.count);

  let subtitleFile = null;

  if (job.captions) {
    updateJob(job, {
      progress: 55,
      message: "Preparing Roman Urdu captions..."
    });

    const captionData = await createRomanUrduSRT(
      openai,
      job.input,
      job.id
    );

    subtitleFile = captionData.srtFile;
  }

  const outputs = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];

    const start = Number(clip.start);

    if (!Number.isFinite(start) || start < 0) {
      continue;
    }

    const end = Math.min(
      videoDuration,
      Number(clip.end),
      start + job.duration
    );

    if (
      !Number.isFinite(end) ||
      end <= start ||
      end - start < 5
    ) {
      continue;
    }

    const filename =
      "short-" + job.id + "-" + (i + 1) + ".mp4";

    const output = path.join(
      SHORTS_DIR,
      filename
    );

    await renderShort(
      job.input,
      output,
      start,
      end - start,
      subtitleFile
    );

    outputs.push(filename);

    updateJob(job, {
      progress:
        60 + Math.round(((i + 1) / clips.length) * 35),
      message:
        "Rendering Short " + (i + 1) +
        " of " + clips.length + "..."
    });
  }

  if (subtitleFile) {
    fs.unlink(subtitleFile, () => {});
  }

  if (!outputs.length) {
    throw new Error(
      "AI selected no valid clips."
    );
  }

  updateJob(job, {
    status: "completed",
    progress: 100,
    message: "Your AI Shorts are ready.",
    outputs
  });
}

// ==========================================
// JOB QUEUE
// ==========================================

async function processShorts(job) {
  if (shortsBusy) {
    shortsQueue.push(job);

    updateJob(job, {
      status: "queued",
      message: "Waiting for another job..."
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
    console.error(
      "Shorts processing error:",
      error
    );

    updateJob(job, {
      status: "failed",
      message: error.message || "Processing failed."
    });

  } finally {
    shortsBusy = false;

    if (shortsQueue.length > 0) {
      const nextJob = shortsQueue.shift();

      setImmediate(() => {
        processShorts(nextJob);
      });
    }

    // Remove original input after processing.
    if (job.input && fs.existsSync(job.input)) {
      fs.unlink(job.input, () => {});
    }
  }
}

// ==========================================
// SHORTS API
// ==========================================

app.post(
  "/api/shorts",
  shortsUpload.single("video"),
  (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Please upload a video."
        });
      }

      const mode =
        req.body.mode === "manual" ? "manual" : "ai";

      const id = crypto.randomUUID();

      const count = Number(req.body.count) || 5;
      const clipDuration = Number(req.body.duration) || 30;

      const job = {
        id,
        input: req.file.path,
        originalName: req.file.originalname,
        mode,
        count,
        duration: clipDuration,
        start: Number(req.body.start ?? 0),
        end: Number(req.body.end ?? 60),
        captions: req.body.captions === "true",
        status: "queued",
        progress: 0,
        message: "Job received.",
        outputs: [],
        createdAt: new Date().toISOString()
      };

      if (
        mode === "ai" &&
        (
          ![5, 10, 15].includes(count) ||
          ![30, 45, 60].includes(clipDuration)
        )
      ) {
        fs.unlink(req.file.path, () => {});

        return res.status(400).json({
          error:
            "AI mode supports 5, 10 or 15 clips and 30, 45 or 60 seconds."
        });
      }

      if (job.captions && !process.env.OPENAI_API_KEY) {
        fs.unlink(req.file.path, () => {});

        return res.status(400).json({
          error:
            "Roman Urdu captions require OPENAI_API_KEY. Captions are optional."
        });
      }

      shortsJobs.set(id, job);

      processShorts(job);

      res.json({
        id,
        jobId: id,
        status: job.status
      });

    } catch (error) {
      console.error(error);

      res.status(500).json({
        error: error.message
      });
    }
  }
);

app.get("/api/shorts/:id", (req, res) => {
  const job = shortsJobs.get(req.params.id);

  if (!job) {
    return res.status(404).json({
      error: "Job not found."
    });
  }

  res.json(job);
});

app.get(
  "/api/shorts/:id/download/:file",
  (req, res) => {
    const job = shortsJobs.get(req.params.id);

    const filename = path.basename(req.params.file);

    if (!job || !job.outputs.includes(filename)) {
      return res.status(404).send("File not found.");
    }

    const file = path.join(
      SHORTS_DIR,
      filename
    );

    if (!fs.existsSync(file)) {
      return res.status(404).send("File not found.");
    }

    res.download(file);
  }
);

// ==========================================
// PLANS API
// ==========================================

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

  res.json({
    success: true,
    plan
  });
});

app.put("/api/plans/:id", (req, res) => {
  const plans = readPlans();

  const index = plans.findIndex(
    item => item.id === req.params.id
  );

  if (index === -1) {
    return res.status(404).json({
      error: "Plan not found."
    });
  }

  plans[index] = {
    ...plans[index],
    ...req.body,
    id: req.params.id
  };

  savePlans(plans);

  res.json({
    success: true,
    plan: plans[index]
  });
});

app.delete("/api/plans/:id", (req, res) => {
  const plans = readPlans();

  const updated = plans.filter(
    item => item.id !== req.params.id
  );

  savePlans(updated);

  res.json({
    success: true
  });
});

// ==========================================
// PRIVATE YOUTUBE TEST UPLOAD
// ==========================================

app.post(
  "/api/youtube/test-upload",
  upload.single("video"),
  async (req, res) => {
    const uploadedFile = req.file
      ? req.file.path
      : null;

    try {
      if (!req.file) {
        return res.status(400).json({
          error: "Select a video first."
        });
      }

      const oauth = getOAuthClient();

      const youtube = google.youtube({
        version: "v3",
        auth: oauth
      });

      const title = String(
        req.body.title || "Private test upload"
      ).slice(0, 100);

      const description = String(
        req.body.description || ""
      ).slice(0, 5000);

      const result = await youtube.videos.insert({
        part: ["snippet", "status"],

        requestBody: {
          snippet: {
            title,
            description,
            categoryId: "22"
          },

          status: {
            privacyStatus: "private",
            selfDeclaredMadeForKids: false
          }
        },

        media: {
          body: fs.createReadStream(uploadedFile)
        }
      });

      res.json({
        success: true,
        videoId: result.data.id,
        privacyStatus: "private",
        message: "Private test upload successful."
      });

    } catch (error) {
      console.error(
        "YouTube upload error:",
        error
      );

      res.status(500).json({
        error: error.message
      });

    } finally {
      if (uploadedFile) {
        fs.unlink(uploadedFile, () => {});
      }
    }
  }
);

// ==========================================
// AUTOMATIC PUBLISHING
// ==========================================

// Intentionally disabled.
// No automatic publishing task is started.

console.log("Automatic YouTube publishing is OFF.");

// ==========================================
// ERROR HANDLING
// ==========================================

app.use((err, req, res, next) => {
  console.error("Request error:", err.message);

  if (err instanceof multer.MulterError) {
    if (err.code === "LIMIT_FILE_SIZE") {
      return res.status(413).json({
        error: "File exceeds the 5 GB upload limit."
      });
    }

    return res.status(400).json({
      error: err.message
    });
  }

  res.status(500).json({
    error: err.message || "Server error."
  });
});

// ==========================================
// DASHBOARD
// ==========================================

app.get("/", (req, res) => {
  res.sendFile(
    path.join(__dirname, "index.html")
  );
});

// ==========================================
// START SERVER
// ==========================================

app.listen(PORT, "0.0.0.0", () => {
  console.log(
    "Creator Auto Publisher running on port " + PORT
  );
});
