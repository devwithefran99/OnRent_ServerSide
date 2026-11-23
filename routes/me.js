import { Router } from "express";
import { ObjectId } from "mongodb";
import { db } from "../db.js";
import { verifyToken } from "../middleware/verifyToken.js";
import { verifyAdmin } from "../middleware/roles.js";

const router = Router();

/**
 * GET /api/me
 * Protected: requires a valid JWT in "Authorization: Bearer <token>".
 */
router.get("/me", verifyToken, async (req, res) => {
  if (!ObjectId.isValid(req.user.id)) {
    return res.status(400).json({ message: "Invalid user id in token" });
  }

  const user = await db
    .collection("user")
    .findOne({ _id: new ObjectId(req.user.id) });

  if (!user) {
    return res.status(404).json({ message: "User not found" });
  }

  res.json({
    user: {
      id: String(user._id),
      name: user.name,
      email: user.email,
      role: user.role ?? "customer",
      image: user.image ?? null,
      phone: user.phone ?? null,
      address: user.address ?? null,
    },
  });
});

/**
 * GET /api/admin/ping
 * Only admins can call this. Used to test role based access.
 */
router.get("/admin/ping", verifyToken, verifyAdmin, (req, res) => {
  res.json({ ok: true, message: `Welcome admin ${req.user.email}` });
});

export default router;
