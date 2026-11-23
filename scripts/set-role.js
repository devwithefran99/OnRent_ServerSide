// Usage: node scripts/set-role.js user@example.com admin
import "dotenv/config";
import { MongoClient } from "mongodb";

const allowedRoles = ["customer", "owner", "admin"];
const [email, role] = process.argv.slice(2);

if (!email || !allowedRoles.includes(role)) {
  console.log("Usage: node scripts/set-role.js <email> <customer|owner|admin>");
  process.exit(1);
}

const client = new MongoClient(process.env.MONGODB_URI);

try {
  await client.connect();
  const users = client.db("OnRent").collection("user");

  const result = await users.updateOne(
    { email },
    { $set: { role, updatedAt: new Date() } }
  );

  if (result.matchedCount === 0) {
    console.log(`No user found with email: ${email}`);
  } else {
    console.log(`Done: ${email} is now "${role}"`);
  }
} catch (error) {
  console.error("Failed:", error.message);
} finally {
  await client.close();
}
