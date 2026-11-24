// Usage: npm run seed
// Copies the demo equipment into MongoDB (only if the collection is empty).
import "dotenv/config";
import { MongoClient } from "mongodb";

const demo = [
  { name: "Mini Excavator", category: "Construction Equipment", location: "Chattogram", price: 8500, rentalType: "Daily", quantity: 3, image: "https://images.unsplash.com/photo-1580901368919-7738efb0f87e?auto=format&fit=crop&w=900&q=85", rating: 4.9, reviews: 128 },
  { name: "Professional DSLR Camera", category: "Photography Equipment", location: "Dhaka", price: 2500, rentalType: "Daily", quantity: 5, image: "https://images.unsplash.com/photo-1516035069371-29a1b244cc32?auto=format&fit=crop&w=900&q=85", rating: 5, reviews: 96 },
  { name: "20ft Delivery Truck", category: "Vehicles & Transportation", location: "Chattogram", price: 6500, rentalType: "Weekly", quantity: 2, image: "https://images.unsplash.com/photo-1533473359331-0135ef1b58bf?auto=format&fit=crop&w=900&q=85", rating: 4.7, reviews: 64 },
  { name: "Power Tiller", category: "Agriculture Equipment", location: "Cumilla", price: 5000, rentalType: "Daily", quantity: 4, image: "https://images.unsplash.com/photo-1500382017468-9049fed747ef?auto=format&fit=crop&w=900&q=85", rating: 4.8, reviews: 41 },
  { name: "Heavy Duty Generator", category: "Electronics", location: "Chattogram", price: 3500, rentalType: "Daily", quantity: 6, image: "https://images.unsplash.com/photo-1473341304170-971dccb5ac1e?auto=format&fit=crop&w=900&q=85", rating: 4.6, reviews: 73 },
  { name: "Event Sound System", category: "Event Equipment", location: "Sylhet", price: 4000, rentalType: "Weekly", quantity: 2, image: "https://images.unsplash.com/photo-1506157786151-b8491531f063?auto=format&fit=crop&w=900&q=85", rating: 4.9, reviews: 88 },
  { name: "Scaffolding Set", category: "Construction Equipment", location: "Dhaka", price: 1200, rentalType: "Weekly", quantity: 10, image: "https://images.unsplash.com/photo-1541888946425-d81bb19240f5?auto=format&fit=crop&w=900&q=85", rating: 4.5, reviews: 37 },
  { name: "Cine Prime Lens Kit", category: "Photography Equipment", location: "Dhaka", price: 3200, rentalType: "Daily", quantity: 3, image: "https://images.unsplash.com/photo-1502920917128-1aa500764cbd?auto=format&fit=crop&w=900&q=85", rating: 4.8, reviews: 52 },
  { name: "Commuter Motorcycle", category: "Vehicles & Transportation", location: "Chattogram", price: 1500, rentalType: "Daily", quantity: 8, image: "https://images.unsplash.com/photo-1558981806-ec527fa84c39?auto=format&fit=crop&w=900&q=85", rating: 4.6, reviews: 110 },
  { name: "DSLR Drone", category: "Photography Equipment", location: "Dhaka", price: 2800, rentalType: "Weekly", quantity: 4, image: "https://images.unsplash.com/photo-1473968512647-3e447244af8f?auto=format&fit=crop&w=900&q=85", rating: 4.9, reviews: 67 },
  { name: "Portable Projector", category: "Event Equipment", location: "Rajshahi", price: 1800, rentalType: "Monthly", quantity: 5, image: "https://images.unsplash.com/photo-1517604931442-7e0c8ed2963c?auto=format&fit=crop&w=900&q=85", rating: 4.5, reviews: 29 },
  { name: "Industrial Power Drill", category: "Construction Equipment", location: "Chattogram", price: 800, rentalType: "Daily", quantity: 12, image: "https://images.unsplash.com/photo-1504148455328-c376907d081c?auto=format&fit=crop&w=900&q=85", rating: 4.7, reviews: 143 },
  { name: "Desktop Workstation", category: "Electronics", location: "Dhaka", price: 2200, rentalType: "Monthly", quantity: 6, image: "https://images.unsplash.com/photo-1496181133206-80ce9b88a853?auto=format&fit=crop&w=900&q=85", rating: 4.4, reviews: 31 },
  { name: "Commercial Treadmill", category: "Electronics", location: "Chattogram", price: 2000, rentalType: "Monthly", quantity: 0, image: "https://images.unsplash.com/photo-1571019613454-1cb2f99b2d8b?auto=format&fit=crop&w=900&q=85", rating: 4.3, reviews: 18 },
  { name: "Mini Harvester", category: "Agriculture Equipment", location: "Rangpur", price: 7200, rentalType: "Weekly", quantity: 0, image: "https://images.unsplash.com/photo-1581092160562-40aa08e78837?auto=format&fit=crop&w=900&q=85", rating: 4.8, reviews: 24 },
  { name: "Tower Light", category: "Construction Equipment", location: "Khulna", price: 4300, rentalType: "Daily", quantity: 3, image: "https://images.unsplash.com/photo-1504307651254-35680f356dfd?auto=format&fit=crop&w=900&q=85", rating: 4.2, reviews: 12 },
  { name: "Vintage Video Camera", category: "Photography Equipment", location: "Barishal", price: 900, rentalType: "Daily", quantity: 2, image: "https://images.unsplash.com/photo-1492691527719-9d1e07e534b4?auto=format&fit=crop&w=900&q=85", rating: 4.1, reviews: 9 },
];

const client = new MongoClient(process.env.MONGODB_URI);

try {
  await client.connect();
  const collection = client.db("OnRent").collection("equipment");

  const existing = await collection.countDocuments();
  if (existing > 0) {
    console.log(`equipment already has ${existing} documents, skipping seed.`);
  } else {
    const now = Date.now();
    const docs = demo.map((item, index) => ({
      ...item,
      description: `${item.name} available for ${item.rentalType.toLowerCase()} rental in ${item.location}.`,
      availableQuantity: item.quantity,
      condition: "Good",
      brand: "OnRent Verified",
      model: `OR-${100 + index}`,
      terms: "Valid ID required. Return in the same condition.",
      status: "approved",
      ownerId: "seed",
      ownerName: "OnRent Demo Owner",
      ownerEmail: "owner@onrent.demo",
      createdAt: new Date(now - index * 86_400_000),
    }));

    await collection.insertMany(docs);
    await collection.createIndex({ status: 1, category: 1, createdAt: -1 });
    console.log(`Seeded ${docs.length} equipment items.`);
  }
} catch (error) {
  console.error("Seed failed:", error.message);
} finally {
  await client.close();
}
