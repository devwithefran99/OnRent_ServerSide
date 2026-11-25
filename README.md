# OnRent Server Side (Express API)

REST API for the **OnRent Equipment Rental Platform**. It shares the same
MongoDB Atlas database (`OnRent`) as the Next.js client and verifies the JWT
access tokens issued by better-auth.

## Features (current)

- MongoDB connection using `MONGODB_URI` from environment variables
- JWT verification with better-auth's JWKS endpoint (`jose`)
- Role based middleware: `verifyToken`, `verifyRenter`, `verifyOwner`, `verifyAdmin`
- Equipment API with backend search, filtering, sorting and pagination
- Owner-only equipment create, update and delete (new listings start as `pending`)
- Favorites API for logged-in users
- Admin equipment list with approve/reject
- Protected routes: `GET /api/me`, `GET /api/admin/ping`
- CORS allowlist via `CLIENT_ORIGIN`
- Central 404 and error handlers

## Setup

```bash
npm install
cp .env.example .env   # then fill in the values
npm run dev            # http://localhost:5000
```

## Environment variables

| Key | Description |
| --- | --- |
| `PORT` | Server port (default `5000`) |
| `MONGODB_URI` | MongoDB Atlas connection string (same as the client) |
| `CLIENT_ORIGIN` | Next.js app URL for CORS (comma separated for many) |
| `BETTER_AUTH_URL` | Next.js app URL, used to fetch `/api/auth/jwks` |

## Endpoints

| Method | Path | Access | Description |
| --- | --- | --- | --- |
| GET | `/` | Public | Health message |
| GET | `/api/health` | Public | Service health check |
| GET | `/api/me` | JWT | Current user profile |
| GET | `/api/admin/ping` | Admin JWT | Role guard test |
| GET | `/api/equipment` | Public | Search, filter, sort and paginate approved equipment |
| GET | `/api/equipment/featured` | Public | Latest 6 available items for the home page |
| GET | `/api/categories` | Public | Categories with equipment counts and cover images |
| GET | `/api/admin/categories` | Admin JWT | All categories, including empty ones |
| POST | `/api/admin/categories` | Admin JWT | Create a category |
| PATCH | `/api/admin/categories/:id` | Admin JWT | Update a category (rename updates equipment too) |
| DELETE | `/api/admin/categories/:id` | Admin JWT | Delete an empty category |
| GET | `/api/equipment/:id` | Public | Single equipment details |
| POST | `/api/equipment` | Owner JWT | Create a listing (status `pending`) |
| GET | `/api/owner/equipment` | Owner JWT | List the owner's own equipment |
| PATCH | `/api/equipment/:id` | Owner JWT | Update own equipment |
| DELETE | `/api/equipment/:id` | Owner JWT | Delete own equipment |
| GET | `/api/favorites` | JWT | Favorite equipment of the current user |
| POST | `/api/favorites/:equipmentId` | JWT | Add equipment to favorites |
| DELETE | `/api/favorites/:equipmentId` | JWT | Remove equipment from favorites |
| GET | `/api/admin/equipment` | Admin JWT | All equipment (`?status=pending`) |
| GET | `/api/admin/users` | Admin JWT | All accounts with listing and booking counts |
| GET | `/api/admin/stats` | Admin JWT | Totals for the admin dashboard |
| PATCH | `/api/admin/equipment/:id` | Admin JWT | Approve or reject a listing |
| POST | `/api/bookings` | JWT | Create a booking request (status `pending`) |
| GET | `/api/bookings/my` | JWT | Bookings requested by the current user |
| DELETE | `/api/bookings/:id` | JWT | Cancel own pending booking |
| GET | `/api/owner/bookings` | Owner JWT | Booking requests for the owner's equipment |
| PATCH | `/api/owner/bookings/:id` | Owner JWT | Approve, reject or complete a booking |
| GET | `/api/admin/bookings` | Admin JWT | All bookings (`?status=pending`) |

### Booking flow (no payment yet)

1. Customer sends `POST /api/bookings` with dates, quantity, phone and address.
2. Owner approves or rejects from `GET /api/owner/bookings`.
3. Approving reserves the quantity (`availableQuantity` goes down).
4. Owner marks an approved booking as `completed`; the quantity goes back to stock.
5. Customers can cancel only while the booking is still `pending`.

Status flow: `pending → approved | rejected`, then `approved → completed`.

### Query parameters for `GET /api/equipment`

| Param | Example | Description |
| --- | --- | --- |
| `search` | `excavator` | Matches name or location (case-insensitive) |
| `category` | `Construction Equipment` | Exact category match |
| `rentalType` | `Daily` | `Daily`, `Weekly` or `Monthly` |
| `availability` | `Available` | `Available` or `Booked` |
| `minPrice` / `maxPrice` | `1000` / `9000` | Price range |
| `sort` | `price-asc` | `price-asc`, `price-desc` or `newest` |
| `page` / `limit` | `1` / `9` | Pagination (`limit` max 50) |

## Scripts

```bash
npm run dev                                  # start with --watch
npm run start                                # production start
npm run seed                                 # insert demo equipment if empty
npm run set-role -- user@example.com admin   # assign a role
```

## Notes

- Both apps must use the `OnRent` database (`client.db("OnRent")`).
- Send the JWT as `Authorization: Bearer <token>`.
- The client gets a token from `GET /api/auth/token` (better-auth JWT plugin).
