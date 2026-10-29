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

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

if (!fs.existsSync(PLANS_FILE)) {
  fs.writeFileSync(PLANS_FILE, "[]", "utf8");
}

app.use(express.json({ limit: "1mb" }));
app.use(express.static(__dirname));

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
    automaticPublishing: "Not configured"
  });
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

// Save a publishing plan
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

  if (!title || typeof title !== "string") {
    return res.status(400).json({ error: "Title is required." });
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
    message: "Plan saved on server. Publishing is not connected yet.",
    plan
  });
});

// List saved plans
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
    return res.status(400).json({ error: err.message });
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
