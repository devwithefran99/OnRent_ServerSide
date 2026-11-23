# OnRent Server Side (Express API)

REST API for the **OnRent Equipment Rental Platform**. It shares the same
MongoDB Atlas database (`OnRent`) as the Next.js client and verifies the JWT
access tokens issued by better-auth.

## Features (current)

- MongoDB connection using `MONGODB_URI` from environment variables
- JWT verification with better-auth's JWKS endpoint (`jose`)
- Role based middleware: `verifyToken`, `verifyRenter`, `verifyOwner`, `verifyAdmin`
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

## Scripts

```bash
npm run dev                                  # start with --watch
npm run start                                # production start
npm run set-role -- user@example.com admin   # assign a role
```

## Notes

- Both apps must use the `OnRent` database (`client.db("OnRent")`).
- Send the JWT as `Authorization: Bearer <token>`.
- The client gets a token from `GET /api/auth/token` (better-auth JWT plugin).
