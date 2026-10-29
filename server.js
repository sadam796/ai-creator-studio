const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));

// Server status check
app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    app: "Creator Auto Publisher",
    message: "Server is running"
  });
});

// Basic dashboard route
app.get("/", (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Creator Auto Publisher</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          background: #10131b;
          color: white;
          padding: 24px;
          text-align: center;
        }
        .card {
          max-width: 500px;
          margin: 30px auto;
          padding: 24px;
          background: #202636;
          border-radius: 16px;
        }
        .status { color: #65e6a0; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>Creator Auto Publisher</h1>
        <p>One dashboard for your social media.</p>
        <p class="status">Backend dashboard ready for setup</p>
        <p>YouTube · Instagram · Facebook · Telegram</p>
      </div>
    </body>
    </html>
  `);
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`Creator Auto Publisher running on port ${PORT}`);
});
