/**
 * Role guard factory.
 * Use AFTER verifyToken, because it reads req.user.role.
 */
export const verifyRole = (...allowedRoles) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({
        message: `Forbidden: requires role ${allowedRoles.join(" or ")}`,
      });
    }

    next();
  };
};

// Requirement names: verifyToken, verifyRenter, verifyOwner, verifyAdmin
export const verifyRenter = verifyRole("customer");
export const verifyOwner = verifyRole("owner");
export const verifyAdmin = verifyRole("admin");
