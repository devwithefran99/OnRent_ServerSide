import "dotenv/config";
import express from "express";
import cors from "cors";
import { ObjectId } from "mongodb";
import { connectToMongoDB, db } from "./db.js";
import meRouter from "./routes/me.js";
import equipmentRouter from "./routes/equipment.js";
import { verifyToken } from "./middleware/verifyToken.js";
import { verifyAdmin, verifyOwner } from "./middleware/roles.js";

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

// Seeded demo equipment uses string ids, owner-created items use ObjectId.
// This helper lets a route find both kinds with one query.
function idVariants(id) {
  return ObjectId.isValid(id) ? [id, new ObjectId(id)] : [id];
}

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
    .filter(Boolean)
    .flatMap((id) => idVariants(id));

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
        { _id: { $in: idVariants(id) } },
        { $set: { status, updatedAt: new Date() } }
      );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Equipment not found" });
    }

    res.json({ message: `Equipment marked as ${status}` });
  }
);

// ---------------------------------------------------------------------------
// Bookings (P5 without payment)
// A customer requests equipment for some dates. The owner approves or rejects.
// ---------------------------------------------------------------------------

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Turn a booking document into clean JSON for the client.
function bookingToClient(booking) {
  const { _id, ...rest } = booking;
  return { ...rest, id: String(_id) };
}

// Daily -> days, Weekly -> weeks, Monthly -> months (rounded up).
function calculateUnits(startDate, endDate, rentalType) {
  const days =
    Math.floor((new Date(endDate) - new Date(startDate)) / MS_PER_DAY) + 1;

  if (rentalType === "Weekly") return Math.ceil(days / 7);
  if (rentalType === "Monthly") return Math.ceil(days / 30);
  return days;
}

// POST /api/bookings -> create a booking request
app.post("/api/bookings", verifyToken, async (req, res) => {
  const { equipmentId, startDate, endDate, quantity, phone, address, note } =
    req.body ?? {};

  if (!ObjectId.isValid(equipmentId)) {
    return res.status(400).json({ message: "Invalid equipment id" });
  }

  if (!startDate || !endDate || !phone || !address) {
    return res.status(400).json({
      message: "startDate, endDate, phone and address are required",
    });
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    return res.status(400).json({ message: "Invalid dates" });
  }

  if (end < start) {
    return res
      .status(400)
      .json({ message: "End date must be after the start date" });
  }

  const qty = Number(quantity);

  if (!Number.isInteger(qty) || qty < 1) {
    return res.status(400).json({ message: "Quantity must be at least 1" });
  }

  const equipment = await db
    .collection("equipment")
    .findOne({ _id: { $in: idVariants(equipmentId) }, status: "approved" });

  if (!equipment) {
    return res.status(404).json({ message: "Equipment not found" });
  }

  if (equipment.ownerId === req.user.id) {
    return res
      .status(400)
      .json({ message: "You cannot book your own equipment" });
  }

  if (qty > (equipment.availableQuantity ?? 0)) {
    return res
      .status(400)
      .json({ message: "Not enough quantity available for these dates" });
  }

  const units = calculateUnits(startDate, endDate, equipment.rentalType);
  const totalPrice = units * equipment.price * qty;

  const booking = {
    equipmentId: String(equipment._id),
    equipmentName: equipment.name,
    equipmentImage: equipment.image,
    ownerId: equipment.ownerId,
    ownerName: equipment.ownerName ?? "",
    customerId: req.user.id,
    customerName: req.user.name,
    customerEmail: req.user.email,
    startDate,
    endDate,
    quantity: qty,
    units,
    rentalType: equipment.rentalType,
    unitPrice: equipment.price,
    totalPrice,
    phone,
    address,
    note: note ?? "",
    status: "pending",
    createdAt: new Date(),
  };

  const result = await db.collection("bookings").insertOne(booking);

  res.status(201).json({
    id: String(result.insertedId),
    totalPrice,
    units,
    message: "Booking request sent",
  });
});

// GET /api/bookings/my -> bookings created by the logged-in customer
app.get("/api/bookings/my", verifyToken, async (req, res) => {
  const items = await db
    .collection("bookings")
    .find({ customerId: req.user.id })
    .sort({ createdAt: -1 })
    .toArray();

  res.json({ items: items.map(bookingToClient) });
});

// DELETE /api/bookings/:id -> customer cancels a pending request
app.delete("/api/bookings/:id", verifyToken, async (req, res) => {
  const { id } = req.params;

  if (!ObjectId.isValid(id)) {
    return res.status(400).json({ message: "Invalid booking id" });
  }

  const booking = await db
    .collection("bookings")
    .findOne({ _id: new ObjectId(id) });

  if (!booking) {
    return res.status(404).json({ message: "Booking not found" });
  }

  if (booking.customerId !== req.user.id) {
    return res.status(403).json({ message: "This is not your booking" });
  }

  if (booking.status !== "pending") {
    return res
      .status(400)
      .json({ message: "Only pending bookings can be cancelled" });
  }

  await db.collection("bookings").deleteOne({ _id: booking._id });

  res.json({ message: "Booking cancelled" });
});

// GET /api/owner/bookings -> bookings for the owner's equipment
app.get("/api/owner/bookings", verifyToken, verifyOwner, async (req, res) => {
  const items = await db
    .collection("bookings")
    .find({ ownerId: req.user.id })
    .sort({ createdAt: -1 })
    .toArray();

  res.json({ items: items.map(bookingToClient) });
});

// PATCH /api/owner/bookings/:id -> approve, reject or complete
app.patch(
  "/api/owner/bookings/:id",
  verifyToken,
  verifyOwner,
  async (req, res) => {
    const { id } = req.params;
    const { status } = req.body ?? {};

    if (!["approved", "rejected", "completed"].includes(status)) {
      return res.status(400).json({
        message: 'status must be "approved", "rejected" or "completed"',
      });
    }

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    const booking = await db
      .collection("bookings")
      .findOne({ _id: new ObjectId(id) });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.ownerId !== req.user.id) {
      return res.status(403).json({ message: "This is not your booking" });
    }

    // Simple status flow: pending -> approved/rejected, approved -> completed.
    if (booking.status === "pending" && status === "completed") {
      return res
        .status(400)
        .json({ message: "Approve the booking before completing it" });
    }

    if (booking.status === "approved" && status !== "completed") {
      return res
        .status(400)
        .json({ message: "An approved booking can only be completed" });
    }

    if (["rejected", "completed"].includes(booking.status)) {
      return res
        .status(400)
        .json({ message: "This booking is already closed" });
    }

    if (status === "approved") {
      const equipment = await db
        .collection("equipment")
        .findOne({ _id: { $in: idVariants(booking.equipmentId) } });

      if (!equipment) {
        return res.status(404).json({ message: "Equipment not found" });
      }

      if ((equipment.availableQuantity ?? 0) < booking.quantity) {
        return res
          .status(400)
          .json({ message: "Not enough quantity available" });
      }

      // Reserve the quantity when the owner approves.
      await db
        .collection("equipment")
        .updateOne(
          { _id: equipment._id },
          { $inc: { availableQuantity: -booking.quantity } }
        );
    }

    if (status === "completed") {
      // Item returned: put the reserved quantity back into stock.
      await db
        .collection("equipment")
        .updateOne(
          { _id: { $in: idVariants(booking.equipmentId) } },
          { $inc: { availableQuantity: booking.quantity } }
        );
    }

    await db
      .collection("bookings")
      .updateOne(
        { _id: booking._id },
        { $set: { status, updatedAt: new Date() } }
      );

    res.json({ message: `Booking ${status}` });
  }
);

// GET /api/admin/bookings -> all bookings for the admin dashboard
app.get("/api/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  const items = await db
    .collection("bookings")
    .find({})
    .sort({ createdAt: -1 })
    .toArray();

  res.json({ items: items.map(bookingToClient) });
});

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
