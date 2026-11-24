import "dotenv/config";
import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import { connectToMongoDB, db } from "./db.js";
import meRouter from "./routes/me.js";
import equipmentRouter from "./routes/equipment.js";
import { verifyToken } from "./middleware/verifyToken.js";
import { verifyAdmin } from "./middleware/roles.js";

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
app.use("/api", equipmentRouter);

// ---------------------------------------------------------------------------
// Favorites (P3)
// A customer can save equipment to their favorites list.
// ---------------------------------------------------------------------------

// Small helper: turn a MongoDB document into a clean JSON object.
function equipmentToClient(item) {
  const { _id, ...rest } = item;
  return {
    ...rest,
    id: String(_id),
    available: (rest.availableQuantity ?? 0) > 0,
  };
}

// GET /api/favorites -> the logged-in user's favorite equipment
app.get("/api/favorites", verifyToken, async (req, res) => {
  const rows = await db
    .collection("favorites")
    .find({ userId: req.user.id })
    .sort({ createdAt: -1 })
    .toArray();

  const ids = rows
    .map((row) => row.equipmentId)
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));

  const items = await db
    .collection("equipment")
    .find({ _id: { $in: ids } })
    .toArray();

  res.json({ items: items.map(equipmentToClient) });
});

// POST /api/favorites/:equipmentId -> add to favorites
app.post("/api/favorites/:equipmentId", verifyToken, async (req, res) => {
  const { equipmentId } = req.params;

  if (!ObjectId.isValid(equipmentId)) {
    return res.status(400).json({ message: "Invalid equipment id" });
  }

  const alreadySaved = await db
    .collection("favorites")
    .findOne({ userId: req.user.id, equipmentId });

  if (alreadySaved) {
    return res.json({ message: "Already in favorites" });
  }

  await db.collection("favorites").insertOne({
    userId: req.user.id,
    equipmentId,
    createdAt: new Date(),
  });

  res.status(201).json({ message: "Added to favorites" });
});

// DELETE /api/favorites/:equipmentId -> remove from favorites
app.delete("/api/favorites/:equipmentId", verifyToken, async (req, res) => {
  await db
    .collection("favorites")
    .deleteOne({ userId: req.user.id, equipmentId: req.params.equipmentId });

  res.json({ message: "Removed from favorites" });
});

// ---------------------------------------------------------------------------
// Admin equipment approval (P3)
// Admins can see all listings and approve or reject them.
// ---------------------------------------------------------------------------

// GET /api/admin/equipment?status=pending
app.get("/api/admin/equipment", verifyToken, verifyAdmin, async (req, res) => {
  const status = req.query.status;

  const filter = status ? { status } : {};

  const items = await db
    .collection("equipment")
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();

  res.json({ items: items.map(equipmentToClient) });
});

// GET /api/admin/stats -> small numbers for the admin dashboard
app.get("/api/admin/stats", verifyToken, verifyAdmin, async (req, res) => {
  const [users, equipment, pending, bookings] = await Promise.all([
    db.collection("user").countDocuments(),
    db.collection("equipment").countDocuments(),
    db.collection("equipment").countDocuments({ status: "pending" }),
    db.collection("bookings").countDocuments(),
  ]);

  res.json({ users, equipment, pending, bookings });
});

// PATCH /api/admin/equipment/:id  { "status": "approved" | "rejected" }
app.patch(
  "/api/admin/equipment/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body ?? {};

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid equipment id" });
    }

    if (!["approved", "rejected", "pending"].includes(status)) {
      return res.status(400).json({
        message: 'status must be "approved", "rejected" or "pending"',
      });
    }

    const result = await db
      .collection("equipment")
      .updateOne(
        { _id: new ObjectId(id) },
        { $set: { status, updatedAt: new Date() } }
      );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Equipment not found" });
    }

    res.json({ message: `Equipment marked as ${status}` });
  }
);

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
