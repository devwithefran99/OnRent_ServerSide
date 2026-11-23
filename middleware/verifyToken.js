import "dotenv/config";
import { createRemoteJWKSet, jwtVerify } from "jose";

const authUrl = process.env.BETTER_AUTH_URL || "http://localhost:3000";

// better-auth exposes its public keys at /api/auth/jwks.
const JWKS = createRemoteJWKSet(new URL("/api/auth/jwks", authUrl));

/**
 * Reads "Authorization: Bearer <token>", verifies the JWT signature,
 * and puts the user on req.user:
 *   req.user = { id, name, email, role }
 */
export async function verifyToken(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const [scheme, token] = header.split(" ");

    if (scheme !== "Bearer" || !token) {
      return res.status(401).json({ message: "No token provided" });
    }

    const { payload } = await jwtVerify(token, JWKS);

    req.user = {
      id: payload.sub,
      name: payload.name,
      email: payload.email,
      role: payload.role || "customer",
    };

    next();
  } catch {
    return res.status(401).json({ message: "Invalid or expired token" });
  }
}
