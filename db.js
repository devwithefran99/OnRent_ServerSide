import "dotenv/config";
import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is missing from .env");
}

const client = new MongoClient(uri);

// Both Next.js (better-auth) and this server must use the SAME database.
export const db = client.db("OnRent");

export async function connectToMongoDB() {
  await client.connect();
  console.log("MongoDB connected → database: OnRent");
  return client;
}

export default client;
