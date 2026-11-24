import "dotenv/config";
import express from "express";
import cors from "cors";
import { connectToMongoDB } from "./db.js";
import meRouter from "./routes/me.js";

const app = express();

// Needed on Render/Railway so client IPs and rate limits work correctly.
app.set("trust proxy", 1);

// Allow the Next.js app (and only it) to call this API with cookies/JWT.
const allowedOrigins = (process.env.CLIENT_ORIGIN || "http://localhost:3000")
  .split(",")
  .map((origin) => origin.trim());

app.use(
  cors({
    origin: (origin, callback) => {
      // Requests without an Origin header (curl, Postman) are allowed.
      if (!origin || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }

      const error = new Error("Origin not allowed by CORS");
      error.status = 403;
      return callback(error);
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 5000;

app.get("/", (req, res) => {
  res.json({ ok: true, message: "OnRent API is running" });
});

app.get("/api/health", (req, res) => {
  res.json({ ok: true, service: "onrent-serverside", time: new Date().toISOString() });
});

app.use("/api", meRouter);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error("Server error:", err.message);
  res.status(err.status || 500).json({
    message: err.message || "Internal server error",
  });
});

async function start() {
  try {
    await connectToMongoDB();

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

start();
