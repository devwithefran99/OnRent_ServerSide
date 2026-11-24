import { Router } from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyOwner } from "../middleware/roles.js";

const router = Router();
const equipment = () => db.collection("equipment");

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function toClient(item) {
  const { _id, ...rest } = item;
  return {
    ...rest,
    id: String(_id),
    rating: rest.rating ?? 0,
    reviews: rest.reviews ?? 0,
    available: (rest.availableQuantity ?? 0) > 0,
  };
}

function buildFilter(query) {
  const {
    search = "",
    category = "All",
    rentalType = "All",
    availability = "All",
  } = query;

  const filter = { status: "approved" };

  if (String(search).trim()) {
    const rx = new RegExp(escapeRegex(String(search).trim()), "i");
    filter.$or = [{ name: rx }, { location: rx }];
  }
  if (category !== "All") filter.category = category;
  if (rentalType !== "All") filter.rentalType = rentalType;
  if (availability === "Available") filter.availableQuantity = { $gt: 0 };
  if (availability === "Booked") filter.availableQuantity = { $lte: 0 };

  const minPrice = Number(query.minPrice ?? 0);
  const maxPrice = Number(query.maxPrice ?? 1_000_000);
  filter.price = { $gte: minPrice, $lte: maxPrice };

  return filter;
}

const SORTS = {
  "price-asc": { price: 1 },
  "price-desc": { price: -1 },
  newest: { createdAt: -1 },
};

// GET /api/equipment  (public, backend search + filter + sort)
router.get("/equipment", async (req, res) => {
  const page = Math.max(1, Number(req.query.page ?? 1));
  const limit = Math.min(50, Math.max(1, Number(req.query.limit ?? 50)));
  const sort = SORTS[req.query.sort] ?? SORTS.newest;

  const filter = buildFilter(req.query);

  const [items, total] = await Promise.all([
    equipment()
      .find(filter)
      .sort(sort)
      .skip((page - 1) * limit)
      .limit(limit)
      .toArray(),
    equipment().countDocuments(filter),
  ]);

  res.json({ items: items.map(toClient), total, page, limit });
});

// GET /api/equipment/featured  (public, limit 6)
router.get("/equipment/featured", async (req, res) => {
  const items = await equipment()
    .find({ status: "approved", availableQuantity: { $gt: 0 } })
    .sort({ createdAt: -1 })
    .limit(6)
    .toArray();

  res.json({ items: items.map(toClient) });
});

// GET /api/equipment/:id  (public)
router.get("/equipment/:id", async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid equipment id" });
  }

  const item = await equipment().findOne({
    _id: new ObjectId(req.params.id),
  });

  if (!item) {
    return res.status(404).json({ message: "Equipment not found" });
  }

  res.json({ item: toClient(item) });
});

// POST /api/equipment  (owner only, starts as pending)
router.post("/equipment", verifyToken, verifyOwner, async (req, res) => {
  const { name, category, location, price, rentalType, quantity, image } =
    req.body ?? {};

  if (!name || !category || !location || !price || !rentalType || !quantity || !image) {
    return res.status(400).json({
      message:
        "name, category, location, price, rentalType, quantity and image are required",
    });
  }

  const doc = {
    name,
    description: req.body.description ?? "",
    category,
    location,
    price: Number(price),
    rentalType,
    quantity: Number(quantity),
    availableQuantity: Number(req.body.availableQuantity ?? quantity),
    condition: req.body.condition ?? "",
    brand: req.body.brand ?? "",
    model: req.body.model ?? "",
    image,
    terms: req.body.terms ?? "",
    status: "pending",
    ownerId: req.user.id,
    ownerName: req.user.name,
    ownerEmail: req.user.email,
    rating: 0,
    reviews: 0,
    createdAt: new Date(),
  };

  const result = await equipment().insertOne(doc);
  res.status(201).json({ id: String(result.insertedId) });
});

// GET /api/owner/equipment  (owner only)
router.get("/owner/equipment", verifyToken, verifyOwner, async (req, res) => {
  const items = await equipment()
    .find({ ownerId: req.user.id })
    .sort({ createdAt: -1 })
    .toArray();

  res.json({ items: items.map(toClient) });
});

// PATCH /api/equipment/:id  (owner only, own item)
router.patch("/equipment/:id", verifyToken, verifyOwner, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid equipment id" });
  }

  const item = await equipment().findOne({
    _id: new ObjectId(req.params.id),
  });

  if (!item) {
    return res.status(404).json({ message: "Equipment not found" });
  }
  if (item.ownerId !== req.user.id) {
    return res.status(403).json({ message: "You can only edit your own equipment" });
  }

  const allowed = [
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
  ];

  const updates = {};
  for (const key of allowed) {
    if (req.body?.[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ message: "Nothing to update" });
  }

  await equipment().updateOne(
    { _id: new ObjectId(req.params.id) },
    { $set: updates }
  );

  res.json({ message: "Equipment updated" });
});

// DELETE /api/equipment/:id  (owner only, own item)
router.delete("/equipment/:id", verifyToken, verifyOwner, async (req, res) => {
  if (!ObjectId.isValid(req.params.id)) {
    return res.status(400).json({ message: "Invalid equipment id" });
  }

  const item = await equipment().findOne({
    _id: new ObjectId(req.params.id),
  });

  if (!item) {
    return res.status(404).json({ message: "Equipment not found" });
  }
  if (item.ownerId !== req.user.id) {
    return res.status(403).json({ message: "You can only delete your own equipment" });
  }

  await equipment().deleteOne({ _id: new ObjectId(req.params.id) });
  res.json({ message: "Equipment deleted" });
});

export default router;
