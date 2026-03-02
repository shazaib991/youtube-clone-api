# YouTube Clone API

A Node.js + Express backend for the React YouTube Clone. Stores videos and images in MongoDB GridFS, handles user authentication via JWT cookies, and auto-generates video thumbnails with FFmpeg.

## Stack

| Technology | Purpose |
|---|---|
| Express 5 | HTTP server / routing |
| MongoDB + Mongoose | Database |
| GridFS (GridFSBucket) | Video & image storage |
| FFmpeg (fluent-ffmpeg) | Thumbnail generation & video conversion |
| Multer | Multipart file uploads |
| JSON Web Tokens (JWT) | Stateless authentication |
| cookie-parser | Cookie handling |

## Getting Started

### Prerequisites
- Node.js 18+
- MongoDB Atlas cluster (or local instance)

### Environment Variables

Create a `.env` file in the project root:

```env
# Option A – full connection string (recommended for Vercel/cloud)
MONGODB_URI=mongodb+srv://<user>:<password>@cluster0.xxx.mongodb.net/

# Option B – separate credentials (used to build the URI automatically)
userNameMongodb=<user>
password=<password>

# JWT signing secret
JWT_SECRET=your-secret-here

# Port (default: 3000)
PORT=3000
```

### Install & Run

```bash
npm install
npm start
```

The server starts on `http://localhost:3000`.

---

## API Endpoints

### Health Check

#### `GET /`

Returns a confirmation that the API is running.

**Response**
```
200 OK
Hello World! Your API is running.
```

---

### Authentication

All auth endpoints accept/return JSON.

#### `POST /signup`

Register a new user. Optionally upload a channel profile image.

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `username` | string | ✅ | Unique username |
| `password` | string | ✅ | Password (plaintext — hash in production) |
| `channelName` | string | ❌ | Display name for the user's channel |
| `channelImage` | file | ❌ | Profile/channel image (any common image format) |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| `200 OK` | `{ "success": true }` | Registered & signed in (JWT cookie set) |
| `400 Bad Request` | `{ "success": false, "message": "username/password required" }` | Missing fields |
| `409 Conflict` | `{ "success": false, "message": "username taken" }` | Duplicate username |
| `500` | `{ "success": false }` | Server error |

Sets an `httpOnly` cookie named `token` (7-day expiry).

---

#### `POST /signin`

Sign in with existing credentials.

**Content-Type:** `application/json`

```json
{
  "username": "john",
  "password": "secret"
}
```

**Responses**

| Status | Body | Meaning |
|---|---|---|
| `200 OK` | `{ "success": true }` | Signed in (JWT cookie set) |
| `400 Bad Request` | `{ "success": false, "message": "username/password required" }` | Missing fields |
| `401 Unauthorized` | `{ "success": false }` | Wrong credentials |
| `500` | `{ "success": false }` | Server error |

Sets an `httpOnly` cookie named `token` (7-day expiry).

---

#### `POST /signout`

Clear the auth cookie.

**Auth required:** No

**Response**
```json
200 OK
{ "success": true }
```

---

### Videos

#### `GET /search`

Fetch all available videos with their metadata and asset URLs.

**Auth required:** No — public endpoint.

**Response** — `200 OK` — Array of video objects:

```json
[
  {
    "baseName": "my-video",
    "title": "My Awesome Video",
    "videoUrl": "https://your-api.com/file/64abc123...",
    "imageUrl": "https://your-api.com/file/64abc456...",
    "highResImageUrl": "https://your-api.com/file/64abc789...",
    "videoLength": "0:03:45",
    "channelImageUrl": "https://your-api.com/file/64abcdef...",
    "channelName": "John's Channel"
  }
]
```

| Field | Type | Description |
|---|---|---|
| `baseName` | string | Filename without extension |
| `title` | string | Display title (falls back to `baseName`) |
| `videoUrl` | string \| null | Absolute URL to stream the video |
| `imageUrl` | string \| null | Absolute URL for the small thumbnail (320×240) |
| `highResImageUrl` | string \| null | Absolute URL for the HD thumbnail (1280×720) |
| `videoLength` | string \| null | Duration in `H:MM:SS` format |
| `channelImageUrl` | string \| null | Absolute URL for the uploader's channel image |
| `channelName` | string \| null | Uploader's channel display name |

**Error responses**

| Status | Meaning |
|---|---|
| `503` | Database not reachable |
| `500` | Unexpected server error (returns `[]`) |

---

#### `POST /upload`

Upload a video file. Automatically:
- Converts non-MP4 formats to MP4 via FFmpeg
- Generates a small (320×240) and high-res (1280×720) thumbnail at the 5-second mark
- Stores the video, both thumbnails, and metadata in MongoDB GridFS
- Deletes local temp files after upload

**Auth required:** ✅ (JWT cookie)

**Content-Type:** `multipart/form-data`

| Field | Type | Required | Description |
|---|---|---|---|
| `videoFile` | file | ✅ | Video file (MP4 preferred; other formats auto-converted) |
| `title` | string | ❌ | Display title (defaults to the filename without extension) |

**Responses**

| Status | Body | Meaning |
|---|---|---|
| `200 OK` | `{ "message": "File processed", "details": { "status": "success", "message": "uploaded video and thumbnail" } }` | Success |
| `400 Bad Request` | `"No file uploaded."` | Missing file |
| `401 Unauthorized` | `{ "success": false }` | Missing / invalid JWT cookie |
| `500` | `{ "error": "Failed to process upload" }` | Processing or DB error |

---

### Files / Media

#### `GET /file/:id`

Stream any file (video or image) from GridFS by its MongoDB ObjectId.

**Auth required:** No

**Path Parameter**

| Param | Type | Description |
|---|---|---|
| `id` | string | MongoDB ObjectId of the GridFS file (returned by `/search`) |

**Response**

Streams the raw file with the appropriate `Content-Type` header set (e.g., `video/mp4`, `image/png`).

**Error responses**

| Status | Meaning |
|---|---|
| `400` | `id` is `*` or not a valid ObjectId |
| `404` | File not found in GridFS |
| `503` | Database not reachable |
| `500` | Stream error |

---

## Authentication Flow

The API uses **JWT stored in an `httpOnly` cookie**.

```
1. POST /signup  →  server issues "token" cookie
2. POST /signin  →  server issues "token" cookie
3. POST /upload  →  browser sends cookie automatically; server validates with requireAuth middleware
4. POST /signout →  server clears the "token" cookie
```

Protected routes use the `requireAuth` middleware which reads `req.cookies.token`, verifies it with `JWT_SECRET`, and attaches the decoded payload to `req.user`.

---

## GridFS Bucket

All media is stored in a single GridFS bucket named **`youtube-clone-bucket`**.

| File Type | `metadata.type` | Description |
|---|---|---|
| Video | *(not set)* | The uploaded MP4 video |
| Thumbnail (small) | *(not set)* | 320×240 PNG thumbnail |
| Thumbnail (HD) | *(not set)* | 1280×720 PNG thumbnail (filename ends with `_highres`) |
| Channel image | `"channel"` | User's profile/channel picture |

Each document also stores `metadata.userId` (for videos and channel images) and `metadata.duration` (for videos) to support the `/search` aggregation logic.

---

## Deployment (Vercel / Serverless)

When the `VERCEL` environment variable is set, the server:
- Uses `/tmp` for temporary file storage instead of local directories
- Connects to MongoDB lazily (on the first request) rather than at startup
- Exports `app` for Vercel's serverless handler instead of calling `app.listen()`
