import "dotenv/config";
import crypto from "node:crypto";
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

// Keep the raw request body around so the Stripe webhook can verify its
// signature (Stripe signs the exact bytes it sent, not the parsed JSON).
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buffer) => {
      req.rawBody = buffer;
    },
  })
);

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
// Dashboard stats
// One endpoint for both the customer and owner overview cards.
// ---------------------------------------------------------------------------
app.get("/api/dashboard/stats", verifyToken, async (req, res) => {
  const userId = req.user.id;

  const [
    activeRentals,
    completedRentals,
    favorites,
    listedEquipment,
    pendingApproval,
    rentalRequests,
  ] = await Promise.all([
    db
      .collection("bookings")
      .countDocuments({ customerId: userId, status: "approved" }),
    db
      .collection("bookings")
      .countDocuments({ customerId: userId, status: "completed" }),
    db.collection("favorites").countDocuments({ userId }),
    db.collection("equipment").countDocuments({ ownerId: userId }),
    db
      .collection("equipment")
      .countDocuments({ ownerId: userId, status: "pending" }),
    db
      .collection("bookings")
      .countDocuments({ ownerId: userId, status: "pending" }),
  ]);

  res.json({
    activeRentals,
    completedRentals,
    favorites,
    listedEquipment,
    pendingApproval,
    rentalRequests,
  });
});

// ---------------------------------------------------------------------------
// Categories
// Admins manage the category list. Equipment stores the category name as text,
// so renaming a category also updates every equipment item that uses it.
// ---------------------------------------------------------------------------

const DEFAULT_CATEGORIES = [
  {
    name: "Construction Equipment",
    description: "Heavy machinery for every construction project.",
  },
  {
    name: "Photography Equipment",
    description: "Professional cameras and photography gear.",
  },
  {
    name: "Vehicles & Transportation",
    description: "Reliable vehicles for work and transportation.",
  },
  {
    name: "Agriculture Equipment",
    description: "Modern tools for smarter farming.",
  },
  {
    name: "Electronics",
    description: "Essential electronics for work and creativity.",
  },
  {
    name: "Event Equipment",
    description: "Everything you need for memorable events.",
  },
];

// Escape special characters before using a name inside a regex.
function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// First run: create the six starter categories.
async function ensureDefaultCategories() {
  const count = await db.collection("categories").countDocuments();

  if (count > 0) return;

  await db.collection("categories").insertMany(
    DEFAULT_CATEGORIES.map((category) => ({
      ...category,
      image: "",
      createdAt: new Date(),
    }))
  );

  console.log("Default categories created");
}

// Category list + how many equipment use each category.
async function buildCategoryList(equipmentFilter = {}) {
  const categories = await db
    .collection("categories")
    .find({})
    .sort({ name: 1 })
    .toArray();

  const equipment = await db
    .collection("equipment")
    .find(equipmentFilter)
    .sort({ createdAt: -1 })
    .toArray();

  const counts = new Map();
  const coverImages = new Map();

  for (const item of equipment) {
    if (!item.category) continue;

    counts.set(item.category, (counts.get(item.category) ?? 0) + 1);

    // Newest item's image becomes the fallback cover for the category.
    if (!coverImages.has(item.category) && item.image) {
      coverImages.set(item.category, item.image);
    }
  }

  return categories.map((category) => ({
    id: String(category._id),
    name: category.name,
    description: category.description ?? "",
    image: category.image || coverImages.get(category.name) || "",
    count: counts.get(category.name) ?? 0,
  }));
}

// GET /api/categories -> public list for the home page and owner forms
app.get("/api/categories", async (req, res) => {
  const items = await buildCategoryList({ status: "approved" });

  // Most popular categories first.
  items.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  res.json({ items });
});

// GET /api/admin/categories -> every category (including empty ones)
app.get("/api/admin/categories", verifyToken, verifyAdmin, async (req, res) => {
  res.json({ items: await buildCategoryList({}) });
});

// POST /api/admin/categories -> create a category
app.post("/api/admin/categories", verifyToken, verifyAdmin, async (req, res) => {
  const name = String(req.body?.name ?? "").trim();
  const description = String(req.body?.description ?? "").trim();
  const image = String(req.body?.image ?? "").trim();

  if (!name) {
    return res.status(400).json({ message: "Category name is required" });
  }

  if (image && !/^https?:\/\//i.test(image)) {
    return res
      .status(400)
      .json({ message: "Image must be a valid link starting with http" });
  }

  // Do not allow the same category twice (ignoring capital letters).
  const duplicate = await db.collection("categories").findOne({
    name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
  });

  if (duplicate) {
    return res.status(409).json({ message: "This category already exists" });
  }

  const result = await db.collection("categories").insertOne({
    name,
    description,
    image,
    createdAt: new Date(),
  });

  res.status(201).json({
    id: String(result.insertedId),
    message: "Category created",
  });
});

// PATCH /api/admin/categories/:id -> rename or update a category
app.patch(
  "/api/admin/categories/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid category id" });
    }

    const category = await db
      .collection("categories")
      .findOne({ _id: new ObjectId(id) });

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    const name =
      req.body?.name !== undefined
        ? String(req.body.name).trim()
        : category.name;
    const description =
      req.body?.description !== undefined
        ? String(req.body.description).trim()
        : category.description ?? "";
    const image =
      req.body?.image !== undefined
        ? String(req.body.image).trim()
        : category.image ?? "";

    if (!name) {
      return res.status(400).json({ message: "Category name is required" });
    }

    if (image && !/^https?:\/\//i.test(image)) {
      return res
        .status(400)
        .json({ message: "Image must be a valid link starting with http" });
    }

    if (name.toLowerCase() !== category.name.toLowerCase()) {
      const duplicate = await db.collection("categories").findOne({
        _id: { $ne: category._id },
        name: { $regex: `^${escapeRegex(name)}$`, $options: "i" },
      });

      if (duplicate) {
        return res.status(409).json({ message: "This category already exists" });
      }
    }

    await db.collection("categories").updateOne(
      { _id: category._id },
      { $set: { name, description, image, updatedAt: new Date() } }
    );

    // Renaming a category must also rename it on every equipment item.
    if (name !== category.name) {
      await db
        .collection("equipment")
        .updateMany(
          { category: category.name },
          { $set: { category: name } }
        );
    }

    res.json({ message: "Category updated" });
  }
);

// DELETE /api/admin/categories/:id -> only when no equipment uses it
app.delete(
  "/api/admin/categories/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid category id" });
    }

    const category = await db
      .collection("categories")
      .findOne({ _id: new ObjectId(id) });

    if (!category) {
      return res.status(404).json({ message: "Category not found" });
    }

    const usedBy = await db
      .collection("equipment")
      .countDocuments({ category: category.name });

    if (usedBy > 0) {
      return res.status(400).json({
        message: `Cannot delete "${category.name}" — ${usedBy} equipment still use it`,
      });
    }

    await db.collection("categories").deleteOne({ _id: category._id });

    res.json({ message: "Category deleted" });
  }
);

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

// GET /api/admin/users -> every account for the admin "All Users" page
app.get("/api/admin/users", verifyToken, verifyAdmin, async (req, res) => {
  // Newest accounts first.
  const users = await db
    .collection("user")
    .find({})
    .sort({ createdAt: -1 })
    .toArray();

  // Count how many listings each owner has.
  const equipmentCounts = await db
    .collection("equipment")
    .aggregate([{ $group: { _id: "$ownerId", count: { $sum: 1 } } }])
    .toArray();

  // Count how many bookings each customer has made.
  const bookingCounts = await db
    .collection("bookings")
    .aggregate([{ $group: { _id: "$customerId", count: { $sum: 1 } } }])
    .toArray();

  // Small lookup maps: userId -> number.
  const listingsByUser = new Map(
    equipmentCounts.map((row) => [String(row._id), row.count])
  );
  const bookingsByUser = new Map(
    bookingCounts.map((row) => [String(row._id), row.count])
  );

  res.json({
    items: users.map((user) => ({
      id: String(user._id),
      name: user.name,
      email: user.email,
      image: user.image ?? null,
      role: user.role ?? "customer",
      emailVerified: Boolean(user.emailVerified),
      createdAt: user.createdAt,
      listings: listingsByUser.get(String(user._id)) ?? 0,
      bookings: bookingsByUser.get(String(user._id)) ?? 0,
    })),
  });
});

// PATCH /api/admin/equipment/:id
// Approve/reject, or edit any listing field.
const ADMIN_EQUIPMENT_FIELDS = [
  "name",
  "description",
  "category",
  "location",
  "price",
  "rentalType",
  "quantity",
  "availableQuantity",
  "condition",
  "brand",
  "model",
  "image",
  "terms",
  "status",
];

const EQUIPMENT_STATUSES = ["approved", "rejected", "pending"];

app.patch(
  "/api/admin/equipment/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid equipment id" });
    }

    const body = req.body ?? {};
    const updates = {};

    for (const key of ADMIN_EQUIPMENT_FIELDS) {
      if (body[key] !== undefined) updates[key] = body[key];
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "Nothing to update" });
    }

    if (
      updates.status !== undefined &&
      !EQUIPMENT_STATUSES.includes(updates.status)
    ) {
      return res.status(400).json({
        message: 'status must be "approved", "rejected" or "pending"',
      });
    }

    for (const key of ["price", "quantity", "availableQuantity"]) {
      if (updates[key] !== undefined) {
        const value = Number(updates[key]);

        if (!Number.isFinite(value) || value < 0) {
          return res
            .status(400)
            .json({ message: `${key} must be a positive number` });
        }

        updates[key] = value;
      }
    }

    if (
      updates.image !== undefined &&
      !/^https?:\/\//i.test(String(updates.image))
    ) {
      return res
        .status(400)
        .json({ message: "Image must be a valid link starting with http" });
    }

    updates.updatedAt = new Date();

    const result = await db
      .collection("equipment")
      .updateOne({ _id: { $in: idVariants(id) } }, { $set: updates });

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "Equipment not found" });
    }

    res.json({ message: "Equipment updated" });
  }
);

// DELETE /api/admin/equipment/:id -> admin can remove any listing
app.delete(
  "/api/admin/equipment/:id",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid equipment id" });
    }

    const result = await db
      .collection("equipment")
      .deleteOne({ _id: { $in: idVariants(id) } });

    if (result.deletedCount === 0) {
      return res.status(404).json({ message: "Equipment not found" });
    }

    res.json({ message: "Equipment deleted" });
  }
);

// ---------------------------------------------------------------------------
// Admin user management
// ---------------------------------------------------------------------------

const ROLES = ["customer", "owner", "admin"];

// PATCH /api/admin/users/:id/role  { "role": "customer" | "owner" | "admin" }
app.patch(
  "/api/admin/users/:id/role",
  verifyToken,
  verifyAdmin,
  async (req, res) => {
    const { id } = req.params;
    const { role } = req.body ?? {};

    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ message: "Invalid user id" });
    }

    if (!ROLES.includes(role)) {
      return res
        .status(400)
        .json({ message: 'role must be "customer", "owner" or "admin"' });
    }

    // Safety: an admin cannot lock themselves out of the dashboard.
    if (String(req.user.id) === id) {
      return res
        .status(400)
        .json({ message: "You cannot change your own role" });
    }

    const result = await db
      .collection("user")
      .updateOne(
        { _id: new ObjectId(id) },
        { $set: { role, updatedAt: new Date() } }
      );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: "User not found" });
    }

    res.json({ message: `Role changed to ${role}`, role });
  }
);

// ---------------------------------------------------------------------------
// Platform settings (admin only)
// ---------------------------------------------------------------------------

const SETTINGS_ID = "platform";

const DEFAULT_SETTINGS = {
  siteName: "OnRent",
  supportEmail: "support@onrent.com",
  supportPhone: "+880 1700-000000",
  address: "Chattogram, Bangladesh",
  currency: "BDT",
  defaultRentalTerms:
    "Equipment must be returned in the same condition. Late returns may incur an extra day's charge.",
  autoApproveListings: false,
};

async function getPlatformSettings() {
  const doc = await db.collection("settings").findOne({ _id: SETTINGS_ID });

  if (!doc) return { ...DEFAULT_SETTINGS };

  const { _id, ...rest } = doc;
  return { ...DEFAULT_SETTINGS, ...rest };
}

// GET /api/admin/settings -> platform settings with defaults
app.get("/api/admin/settings", verifyToken, verifyAdmin, async (req, res) => {
  res.json({ settings: await getPlatformSettings() });
});

// PATCH /api/admin/settings -> update the platform settings
app.patch("/api/admin/settings", verifyToken, verifyAdmin, async (req, res) => {
  const allowed = [
    "siteName",
    "supportEmail",
    "supportPhone",
    "address",
    "currency",
    "defaultRentalTerms",
    "autoApproveListings",
  ];

  const updates = {};

  for (const key of allowed) {
    if (req.body?.[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ message: "Nothing to update" });
  }

  if (
    updates.supportEmail !== undefined &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(updates.supportEmail))
  ) {
    return res.status(400).json({ message: "Support email is not valid" });
  }

  if (updates.autoApproveListings !== undefined) {
    updates.autoApproveListings = Boolean(updates.autoApproveListings);
  }

  updates.updatedAt = new Date();

  await db
    .collection("settings")
    .updateOne({ _id: SETTINGS_ID }, { $set: updates }, { upsert: true });

  res.json({
    message: "Settings saved",
    settings: await getPlatformSettings(),
  });
});


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
    paymentStatus: "unpaid",
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

// GET /api/admin/bookings?status=pending -> all bookings for the admin panel
app.get("/api/admin/bookings", verifyToken, verifyAdmin, async (req, res) => {
  const status = req.query.status;

  // Only apply the filter when it is a real booking status.
  const filter = ["pending", "approved", "rejected", "completed"].includes(
    status
  )
    ? { status }
    : {};

  const items = await db
    .collection("bookings")
    .find(filter)
    .sort({ createdAt: -1 })
    .toArray();

  res.json({ items: items.map(bookingToClient) });
});

// ---------------------------------------------------------------------------
// Payments (Stripe Checkout)
// Flow A: customer books -> owner approves -> customer pays online.
//
// Stripe is called through its REST API with plain fetch so this file stays the
// only server file that needs to change (no extra npm dependency).
// ---------------------------------------------------------------------------

const STRIPE_API = "https://api.stripe.com/v1";
const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || "";
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || "";
const STRIPE_CURRENCY = (process.env.STRIPE_CURRENCY || "usd").toLowerCase();
// The demo Stripe account is US-based, so BDT booking amounts are converted
// before charging. Override the rate with STRIPE_BDT_PER_USD.
const STRIPE_BDT_PER_USD =
  Number(process.env.STRIPE_BDT_PER_USD) > 0
    ? Number(process.env.STRIPE_BDT_PER_USD)
    : 120;
// Where Stripe sends the customer after checkout (the first allowed origin).
const PAYMENT_RETURN_URL = allowedOrigins[0] || "http://localhost:3000";

// Turn nested params into Stripe's application/x-www-form-urlencoded format,
// e.g. { line_items: [{ quantity: 1 }] } -> line_items[0][quantity]=1
function toStripeForm(params, prefix = "", target = new URLSearchParams()) {
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null) continue;

    const name = prefix ? `${prefix}[${key}]` : key;

    if (Array.isArray(value)) {
      value.forEach((item, index) => {
        if (item !== null && typeof item === "object") {
          toStripeForm(item, `${name}[${index}]`, target);
        } else {
          target.append(`${name}[${index}]`, String(item));
        }
      });
    } else if (typeof value === "object") {
      toStripeForm(value, name, target);
    } else {
      target.append(name, String(value));
    }
  }

  return target;
}

async function stripeRequest(path, params = {}, method = "POST") {
  if (!STRIPE_SECRET_KEY) {
    const error = new Error("Stripe is not configured on the server");
    error.status = 503;
    throw error;
  }

  const query = toStripeForm(params).toString();
  const url =
    method === "GET"
      ? `${STRIPE_API}${path}${query ? `?${query}` : ""}`
      : `${STRIPE_API}${path}`;

  const response = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
      ...(method === "GET"
        ? {}
        : { "Content-Type": "application/x-www-form-urlencoded" }),
    },
    body: method === "GET" ? undefined : query,
  });

  const data = await response.json().catch(() => null);

  if (!response.ok) {
    const error = new Error(
      data?.error?.message || "Stripe request failed"
    );
    error.status = response.status >= 500 || response.status === 401
      ? 502
      : response.status;
    error.stripe = data?.error;
    throw error;
  }

  return data;
}

// Constant-time string compare for webhook signatures.
function safeCompare(a, b) {
  const bufferA = Buffer.from(String(a));
  const bufferB = Buffer.from(String(b));

  if (bufferA.length !== bufferB.length) return false;

  return crypto.timingSafeEqual(bufferA, bufferB);
}

// Verify the "Stripe-Signature" header (t=timestamp,v1=signature).
function verifyStripeSignature(payload, header, secret, toleranceSeconds = 300) {
  if (!header || !secret) return false;

  let timestamp = null;
  const signatures = [];

  for (const part of String(header).split(",")) {
    const [key, value] = part.split("=");

    if (key === "t") timestamp = value;
    if (key === "v1") signatures.push(value);
  }

  if (!timestamp || signatures.length === 0) return false;

  const age = Math.floor(Date.now() / 1000) - Number(timestamp);

  if (!Number.isFinite(age) || age > toleranceSeconds) return false;

  const expected = crypto
    .createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");

  return signatures.some((signature) => safeCompare(expected, signature));
}

function paymentIntentIdOf(session) {
  if (!session) return null;
  if (typeof session.payment_intent === "string") return session.payment_intent;
  return session.payment_intent?.id ?? null;
}

// Convert a BDT booking amount to the smallest unit of the charge currency.
function bookingChargeAmount(totalPrice) {
  const converted = Math.round((Number(totalPrice) / STRIPE_BDT_PER_USD) * 100);

  // Stripe's minimum charge for USD is 50 cents.
  return Math.max(converted, 50);
}

// Mark a booking as paid. Safe to call more than once (webhook + success page).
async function markPaymentPaid(session) {
  const sessionId = session?.id ?? null;
  const paymentIntentId = paymentIntentIdOf(session);

  let payment = sessionId
    ? await db.collection("payments").findOne({ sessionId })
    : null;

  const bookingId =
    payment?.bookingId ||
    session?.metadata?.bookingId ||
    session?.client_reference_id ||
    null;

  if (!bookingId || !ObjectId.isValid(bookingId)) {
    return { ok: false, reason: "booking-not-found" };
  }

  const booking = await db
    .collection("bookings")
    .findOne({ _id: new ObjectId(bookingId) });

  if (!booking) {
    return { ok: false, reason: "booking-not-found" };
  }

  // A replayed "completed" event must not un-refund a booking that was already
  // refunded. A brand new checkout session still gets a fresh pending payment
  // document, so re-paying after a refund keeps working.
  if (booking.paymentStatus === "refunded" && payment?.status === "refunded") {
    return { ok: false, reason: "refunded" };
  }

  const paidAt = new Date();
  const amount = Number(booking.totalPrice) || 0;

  const paymentFields = {
    bookingId: String(bookingId),
    customerId: booking.customerId,
    ownerId: booking.ownerId,
    amount,
    chargeAmount:
      session?.amount_total ?? payment?.chargeAmount ?? bookingChargeAmount(amount),
    currency: session?.currency ?? payment?.currency ?? STRIPE_CURRENCY,
    status: "paid",
    sessionId: sessionId ?? payment?.sessionId ?? null,
    paymentIntentId: paymentIntentId ?? payment?.paymentIntentId ?? null,
    method: "card",
    paidAt,
    updatedAt: paidAt,
  };

  if (payment) {
    await db
      .collection("payments")
      .updateOne({ _id: payment._id }, { $set: paymentFields });
  } else {
    await db.collection("payments").insertOne({
      ...paymentFields,
      createdAt: paidAt,
    });
  }

  await db.collection("bookings").updateOne(
    { _id: booking._id },
    {
      $set: {
        paymentStatus: "paid",
        transactionId: paymentIntentId ?? sessionId,
        paidAt,
        updatedAt: paidAt,
      },
    }
  );

  return {
    ok: true,
    booking: {
      ...booking,
      paymentStatus: "paid",
      transactionId: paymentIntentId ?? sessionId,
      paidAt,
      updatedAt: paidAt,
    },
  };
}

async function markPaymentRefunded(charge) {
  const paymentIntentId =
    typeof charge?.payment_intent === "string"
      ? charge.payment_intent
      : charge?.payment_intent?.id;

  if (!paymentIntentId) return;

  const payment = await db
    .collection("payments")
    .findOne({ paymentIntentId });

  await db
    .collection("payments")
    .updateOne(
      { paymentIntentId },
      { $set: { status: "refunded", updatedAt: new Date() } }
    );

  if (payment?.bookingId && ObjectId.isValid(payment.bookingId)) {
    await db
      .collection("bookings")
      .updateOne(
        { _id: new ObjectId(payment.bookingId) },
        {
          $set: {
            paymentStatus: "refunded",
            updatedAt: new Date(),
          },
        }
      );
  }
}

// GET /api/payments/config -> currency + conversion info for the checkout page
app.get("/api/payments/config", (req, res) => {
  res.json({
    currency: STRIPE_CURRENCY,
    bdtPerUsd: STRIPE_BDT_PER_USD,
    configured: Boolean(STRIPE_SECRET_KEY),
  });
});

// POST /api/payments/checkout -> create a Stripe Checkout Session
app.post("/api/payments/checkout", verifyToken, async (req, res, next) => {
  try {
    const { bookingId } = req.body ?? {};

    if (!ObjectId.isValid(bookingId)) {
      return res.status(400).json({ message: "Invalid booking id" });
    }

    const booking = await db
      .collection("bookings")
      .findOne({ _id: new ObjectId(bookingId) });

    if (!booking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    if (booking.customerId !== req.user.id) {
      return res.status(403).json({ message: "This is not your booking" });
    }

    if (booking.status !== "approved") {
      return res.status(400).json({
        message: "The owner must approve this booking before you can pay",
      });
    }

    if (booking.paymentStatus === "paid") {
      return res.status(400).json({ message: "This booking is already paid" });
    }

    const amount = Number(booking.totalPrice) || 0;

    if (amount <= 0) {
      return res.status(400).json({ message: "This booking has no payable amount" });
    }

    const chargeAmount = bookingChargeAmount(amount);
    const bookingIdString = String(booking._id);

    // Reuse an open Checkout Session so clicking "Pay now" twice does not
    // create two payable sessions for the same booking.
    const existingPayment = await db
      .collection("payments")
      .findOne({ bookingId: bookingIdString, status: "pending" });

    if (existingPayment?.sessionId) {
      try {
        const existingSession = await stripeRequest(
          `/checkout/sessions/${encodeURIComponent(existingPayment.sessionId)}`,
          {},
          "GET"
        );

        if (existingSession.status === "open" && existingSession.url) {
          return res.json({
            url: existingSession.url,
            sessionId: existingSession.id,
            amount,
            chargeAmount: existingSession.amount_total ?? existingPayment.chargeAmount,
            currency: existingSession.currency ?? existingPayment.currency,
            reused: true,
          });
        }

        if (existingSession.payment_status === "paid") {
          // The card was charged but the webhook has not landed yet. Confirm it
          // now instead of opening a second payable session.
          await markPaymentPaid(existingSession);

          return res.json({
            paid: true,
            sessionId: existingSession.id,
            amount,
            chargeAmount: existingSession.amount_total ?? existingPayment.chargeAmount,
            currency: existingSession.currency ?? existingPayment.currency,
          });
        }

        if (existingSession.status === "expired") {
          await db
            .collection("payments")
            .updateOne(
              { _id: existingPayment._id },
              { $set: { status: "expired", updatedAt: new Date() } }
            );
        }
      } catch {
        // If Stripe cannot be reached, fall through and create a new session.
      }
    }

    const metadata = {
      bookingId: bookingIdString,
      customerId: booking.customerId,
      ownerId: booking.ownerId,
    };

    const session = await stripeRequest("/checkout/sessions", {
      mode: "payment",
      client_reference_id: bookingIdString,
      customer_email: booking.customerEmail,
      success_url: `${PAYMENT_RETURN_URL}/payment?status=success&session_id={CHECKOUT_SESSION_ID}&booking_id=${bookingIdString}`,
      cancel_url: `${PAYMENT_RETURN_URL}/payment?status=cancelled&booking_id=${bookingIdString}`,
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: STRIPE_CURRENCY,
            unit_amount: chargeAmount,
            product_data: {
              name: `OnRent rental - ${booking.equipmentName}`.slice(0, 250),
              description: `${booking.quantity} x ${booking.units} ${booking.rentalType} rental (${booking.startDate} to ${booking.endDate})`.slice(
                0,
                250
              ),
            },
          },
        },
      ],
      metadata,
      payment_intent_data: { metadata },
    });

    const now = new Date();

    await db.collection("payments").insertOne({
      bookingId: bookingIdString,
      customerId: booking.customerId,
      ownerId: booking.ownerId,
      amount,
      chargeAmount: session.amount_total ?? chargeAmount,
      currency: session.currency ?? STRIPE_CURRENCY,
      status: "pending",
      sessionId: session.id,
      paymentIntentId: paymentIntentIdOf(session),
      method: "card",
      createdAt: now,
      updatedAt: now,
    });

    res.json({
      url: session.url,
      sessionId: session.id,
      amount,
      chargeAmount: session.amount_total ?? chargeAmount,
      currency: session.currency ?? STRIPE_CURRENCY,
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/payments/webhook -> Stripe tells us the payment succeeded
app.post("/api/payments/webhook", async (req, res) => {
  if (!STRIPE_WEBHOOK_SECRET) {
    return res
      .status(503)
      .json({ message: "Stripe webhook secret is not configured" });
  }

  const rawPayload = req.rawBody ? req.rawBody.toString("utf8") : "";

  if (
    !verifyStripeSignature(
      rawPayload,
      req.headers["stripe-signature"],
      STRIPE_WEBHOOK_SECRET
    )
  ) {
    return res.status(400).json({ message: "Invalid Stripe signature" });
  }

  let event;

  try {
    event = JSON.parse(rawPayload);
  } catch {
    return res.status(400).json({ message: "Invalid webhook payload" });
  }

  try {
    const session = event.data?.object ?? {};

    if (
      event.type === "checkout.session.completed" ||
      event.type === "checkout.session.async_payment_succeeded"
    ) {
      // Card payments are already "paid" here; delayed methods may not be.
      if (
        event.type === "checkout.session.async_payment_succeeded" ||
        session.payment_status === "paid"
      ) {
        await markPaymentPaid(session);
      }
    } else if (event.type === "checkout.session.expired") {
      await db
        .collection("payments")
        .updateOne(
          { sessionId: session.id },
          { $set: { status: "expired", updatedAt: new Date() } }
        );
    } else if (event.type === "charge.refunded") {
      await markPaymentRefunded(session);
    }
  } catch (error) {
    console.error("Stripe webhook error:", error.message);
    return res.status(500).json({ message: "Webhook handling failed" });
  }

  // Always answer 200 quickly so Stripe does not retry a handled event.
  res.json({ received: true });
});

// GET /api/payments/session/:sessionId -> verify a payment after redirect.
// This keeps local testing working even without the Stripe CLI forwarding
// webhooks, and it double-checks the webhook in production.
app.get("/api/payments/session/:sessionId", verifyToken, async (req, res, next) => {
  try {
    const { sessionId } = req.params;

    const session = await stripeRequest(
      `/checkout/sessions/${encodeURIComponent(sessionId)}`,
      {},
      "GET"
    );

    const sessionCustomerId = session.metadata?.customerId;

    if (
      req.user.role !== "admin" &&
      sessionCustomerId &&
      sessionCustomerId !== req.user.id
    ) {
      return res.status(403).json({ message: "This payment is not yours" });
    }

    let booking = null;

    if (session.payment_status === "paid") {
      const result = await markPaymentPaid(session);
      booking = result.booking ?? null;
    }

    if (!booking) {
      const bookingId =
        session.metadata?.bookingId || session.client_reference_id;

      if (bookingId && ObjectId.isValid(bookingId)) {
        booking = await db
          .collection("bookings")
          .findOne({ _id: new ObjectId(bookingId) });
      }
    }

    res.json({
      sessionId: session.id,
      status: session.status,
      paymentStatus: session.payment_status,
      amountTotal: session.amount_total,
      currency: session.currency,
      booking: booking ? bookingToClient(booking) : null,
    });
  } catch (error) {
    next(error);
  }
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
    await ensureDefaultCategories();

    app.listen(PORT, () => {
      console.log(`Server is running on port ${PORT}`);
    });
  } catch (error) {
    console.error("Failed to start server:", error.message);
    process.exit(1);
  }
}

start();
