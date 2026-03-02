const express = require("express");
const fs = require("fs");
const os = require("os");
const {MongoClient, ServerApiVersion, GridFSBucket} = require("mongodb");
const mongoose = require("mongoose");
const path = require("path");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegStatic = require("ffmpeg-static");
const ffprobeStatic = require("ffprobe-static");
const cors = require("cors");
const multer = require("multer");
const jwt = require("jsonwebtoken");
const cookieParser = require("cookie-parser");

// determine if we're running in a serverless environment (e.g. Vercel)
const isServerless = !!process.env.VERCEL;

// compute directories; in serverless use /tmp because other paths are read-only/ephemeral
const baseDir = isServerless ? os.tmpdir() : __dirname;
const videoDir = path.join(baseDir, "videos");
const imageDir = path.join(baseDir, "image-output");

// make sure the directories exist
if (!fs.existsSync(videoDir)) {
	fs.mkdirSync(videoDir, {recursive: true});
}
if (!fs.existsSync(imageDir)) {
	fs.mkdirSync(imageDir, {recursive: true});
}

// configure storage so that the uploaded file keeps its original extension
const storage = multer.diskStorage({
	destination: (req, file, cb) => {
		cb(null, videoDir);
	},
	filename: (req, file, cb) => {
		// keep the original file name exactly as uploaded
		// if you want a unique name, you could prepend Date.now() or a UUID
		cb(null, file.originalname);
	},
});

const upload = multer({storage});
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({origin: true, credentials: true}));
app.use(express.json()); // parse application/json
app.use(cookieParser());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret";
const JWT_EXPIRES = "7d"; // stay logged in for a week

// simple user model
const userSchema = new mongoose.Schema({
	username: {type: String, unique: true},
	password: String, // NOTE: plaintext for demo; hash in production
	channelName: String, // optional display name for user's channel
});
const User = mongoose.model("User", userSchema);

// pick up a full URI if provided (Vercel often sets MONGODB_URI)
const uri =
	process.env.MONGODB_URI ||
	`mongodb+srv://${process.env.userNameMongodb}:${process.env.password}@cluster0.nxzntvt.mongodb.net/`;
if (!uri) {
	console.error("No MongoDB URI configured! set MONGODB_URI or userNameMongodb/password env vars.");
}
console.log("Using MongoDB URI (hidden credentials):", uri.replace(/(mongodb\+srv:\/\/)[^@]+@/, "$1***@"));

// cache connection for serverless environments
let mongoosePromise = null;
async function ensureDbConnection() {
	if (mongoosePromise) return mongoosePromise;
	mongoosePromise = connectToDatabase(uri);
	return mongoosePromise;
}

// if running normally we can fire off the connection on startup
if (!isServerless) {
	(async () => {
		await ensureDbConnection();
		app.listen(PORT, () => {
			console.log(`Server is running on http://localhost:${PORT}`);
		});
	})();
} else {
	// for serverless, connection will be established on first invocation
	console.log("Running in serverless mode, DB will connect on demand");
}

async function connectToDatabase(uri) {
	try {
		// Wait for the connection to be established (mongoose caches internally too)
		const conn = await mongoose.connect(uri); // options removed; modern mongoose handles parsing and topology automatically
		console.log("Database connected successfully to", conn.connection.db.databaseName);
		return conn;
	} catch (err) {
		console.error("Database connection failed", err.message || err);
		// log stack to Vercel logs for diagnosis
		console.error(err.stack);
		// in a serverless environment we can't just exit, so rethrow
		if (isServerless) throw err;
		process.exit(1);
	}
}

async function runSearch(userId = null) {
	// returns an array of { baseName, videoUrl, imageUrl, videoLength, title, channelImageUrl } objects
	// ensure we have a connection (important in serverless)
	await ensureDbConnection();
	console.log("runSearch: connection state", mongoose.connection.readyState);
	const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
		bucketName: "youtube-clone-bucket",
	});

	if (!bucket) {
		console.error("GridFS bucket not initialized");
		return [];
	}
	// ignore the requesting user - return everything (but still omit the channel-image files themselves)
	// this makes /search deliver all videos after users upload them.
	const baseQuery = {}; // no filtering by userId
	const videoQuery = {...baseQuery, "metadata.type": {$ne: "channel"}};
	const cursor = bucket.find(videoQuery);
	let docs = [];
	await cursor.forEach((doc) => docs.push(doc));

	// collect unique userIds so we can fetch channel images
	const userIds = new Set();

	// group by base filename (without extension)
	const map = {};
	docs.forEach((doc) => {
		const base = path.basename(doc.filename, path.extname(doc.filename));
		if (!map[base]) {
			map[base] = {baseName: base, videoUrl: null, imageUrl: null, title: null, channelImageUrl: null};
		}
		const url = `/file/${doc._id}`;
		let ctype = doc.contentType || (doc.metadata && doc.metadata.contentType);
		if (!ctype) {
			// attempt to guess from file extension
			const ext = path.extname(doc.filename).toLowerCase();
			if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) {
				ctype = "video/mp4"; // generic video
			} else if ([".png", ".jpg", ".jpeg", ".gif"].includes(ext)) {
				ctype = "image/png"; // generic image
			}
		}
		if (ctype && ctype.startsWith("video")) {
			map[base].videoUrl = url;
			// compute length
			const dur = doc.metadata?.duration || 0;
			const h = Math.floor(dur / 3600);
			const m = Math.floor((dur % 3600) / 60);
			const s = Math.floor(dur % 60);
			map[base].videoLength = `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
			// preserve title if present
			if (doc.metadata?.title) {
				map[base].title = doc.metadata.title;
			}
			if (doc.metadata?.userId) {
				map[base].userId = doc.metadata.userId;
				userIds.add(doc.metadata.userId);
			}
		} else if (ctype && ctype.startsWith("image")) {
			// choose which image field based on filename
			if (doc.filename.toLowerCase().includes("highres")) {
				map[base].highResImageUrl = url;
			} else {
				map[base].imageUrl = url;
			}
		}
	});

	// fetch channel images for collected users
	let userChannelNames = {};
	if (userIds.size > 0) {
		const uidArray = Array.from(userIds);
		const chanCursor = bucket.find({
			"metadata.type": "channel",
			"metadata.userId": {$in: uidArray},
		});
		const channelDocs = [];
		await chanCursor.forEach((d) => channelDocs.push(d));
		const channelMap = {};
		channelDocs.forEach((d) => {
			if (!channelMap[d.metadata.userId]) {
				channelMap[d.metadata.userId] = `/file/${d._id}`;
			}
		});
		// also grab the users' channel names (falling back to username if none set)
		const users = await User.find({_id: {$in: uidArray}}).select("_id channelName username");
		users.forEach((u) => {
			userChannelNames[u._id.toString()] = u.channelName || u.username || "";
		});
		Object.values(map).forEach((entry) => {
			if (entry.userId && channelMap[entry.userId]) {
				entry.channelImageUrl = channelMap[entry.userId];
			}
			if (entry.userId && userChannelNames[entry.userId]) {
				entry.channelName = userChannelNames[entry.userId];
			}
		});
	}

	// drop any entries that are only a high-res image (no video or regular thumbnail)
	Object.keys(map).forEach((k) => {
		const entry = map[k];
		if (!entry.videoUrl && !entry.imageUrl) {
			// usually this means the baseName ends with _highres
			delete map[k];
		}
	});

	return Object.values(map);
}

async function runUpload(videoPath, opts = {}) {
	// videoPath should be an absolute path to the MP4 file
	// opts may include title and userId
	// DB is already connected

	// get duration using ffprobe synchronously
	let durationSecs = 0;
	// make sure ffmpeg/ffprobe binaries are known to fluent-ffmpeg
	ffmpeg.setFfmpegPath(ffmpegStatic);
	ffmpeg.setFfprobePath(ffprobeStatic.path);
	try {
		durationSecs = await new Promise((resolve, reject) => {
			ffmpeg.ffprobe(videoPath, function (err, metadata) {
				if (err) return reject(err);
				if (metadata && metadata.format && metadata.format.duration) {
					resolve(metadata.format.duration);
				} else resolve(0);
			});
		});
	} catch (e) {
		console.error("ffprobe error", e);
	}

	// derive names and output path for thumbnail
	const filename = path.basename(videoPath);
	const imagename = filename.replace(path.extname(filename), ".png");
	// use baseDir so on Vercel we write into /tmp
	const thumbDir = path.join(baseDir, "image-output");
	const imagePath = path.join(thumbDir, imagename);

	// make sure the thumbnail directory exists
	if (!fs.existsSync(thumbDir)) {
		fs.mkdirSync(thumbDir, {recursive: true});
	}

	const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
		bucketName: "youtube-clone-bucket",
	});
	let message = "";
	let status = "";

	if (!bucket) {
		console.error("GridFS bucket not initialized");
		return {status: "failed", message: "bucket not initialized"};
	}

	// capture a frame as thumbnail (small and high-res)
	const captureTime = "00:00:05";

	// small thumbnail
	await new Promise((resolve, reject) => {
		ffmpeg(videoPath)
			.screenshots({
				timestamps: [captureTime],
				filename: path.basename(imagePath),
				folder: path.dirname(imagePath),
				size: "320x240",
			})
			.on("end", () => resolve())
			.on("error", (err) => reject(err));
	});

	// high resolution screenshot
	const highResName = filename.replace(path.extname(filename), "_highres.png");
	const highResPath = path.join(thumbDir, highResName);
	await new Promise((resolve, reject) => {
		ffmpeg(videoPath)
			.screenshots({
				timestamps: [captureTime],
				filename: path.basename(highResPath),
				folder: path.dirname(highResPath),
				size: "1280x720",
			})
			.on("end", () => resolve())
			.on("error", (err) => reject(err));
	});

	// upload video (include duration metadata plus title/userId)
	let metadata = {source: "local upload", duration: durationSecs};
	if (opts.title) metadata.title = opts.title;
	if (opts.userId) metadata.userId = opts.userId.toString();
	let uploadStream = bucket.openUploadStream(filename, {
		contentType: "video/mp4",
		metadata,
	});
	let readStream = fs.createReadStream(videoPath);

	await new Promise((resolve, reject) => {
		readStream
			.pipe(uploadStream)
			.on("error", (err) => reject(err))
			.on("finish", () => resolve());
	});

	// remove the video file after it's pushed
	try {
		await fs.promises.unlink(videoPath);
	} catch (err) {
		console.error("Failed to delete local video", err);
	}

	// upload small thumbnail (propagate userId so search filter picks it up)
	uploadStream = bucket.openUploadStream(imagename, {
		contentType: "image/png",
		metadata: Object.assign({source: "local upload"}, opts.userId ? {userId: opts.userId.toString()} : {}),
	});
	readStream = fs.createReadStream(imagePath);

	await new Promise((resolve, reject) => {
		readStream
			.pipe(uploadStream)
			.on("error", (err) => reject(err))
			.on("finish", () => resolve());
	});

	// upload high-res thumbnail too (re-use previously computed name/path)
	uploadStream = bucket.openUploadStream(highResName, {
		contentType: "image/png",
		metadata: Object.assign({source: "local upload"}, opts.userId ? {userId: opts.userId.toString()} : {}),
	});
	readStream = fs.createReadStream(highResPath);

	await new Promise((resolve, reject) => {
		readStream
			.pipe(uploadStream)
			.on("error", (err) => reject(err))
			.on("finish", () => resolve());
	});

	// delete thumbnail files as well
	try {
		await fs.promises.unlink(imagePath);
	} catch (err) {
		console.error("Failed to delete local thumbnail", err);
	}
	try {
		await fs.promises.unlink(highResPath);
	} catch (err) {
		console.error("Failed to delete local high-res thumbnail", err);
	}
	return {status: "success", message: "uploaded video and thumbnail"};
}

app.get("/", (req, res) => {
	res.send("Hello World! Your API is running.");
});

app.get("/search", async (req, res) => {
	// public endpoint: anyone may fetch the video list, auth not required
	try {
		try {
			await ensureDbConnection();
		} catch (e) {
			console.error("/search could not connect to DB", e);
			return res.status(503).send({error: "database connection failed", message: e.message || String(e)});
		}
		const results = await runSearch();
		console.log(`/search returning ${results.length} entries`);
		// build absolute urls so frontend can use them directly
		const base = `${req.protocol}://${req.get("host")}`;
		const updated = results.map((r) => ({
			baseName: r.baseName,
			title: r.title || r.baseName,
			videoUrl: r.videoUrl ? base + r.videoUrl : null,
			imageUrl: r.imageUrl ? base + r.imageUrl : null,
			videoLength: r.videoLength || null,
			highResImageUrl: r.highResImageUrl ? base + r.highResImageUrl : null,
			channelImageUrl: r.channelImageUrl ? base + r.channelImageUrl : null,
			channelName: r.channelName || null,
		}));
		return res.send(updated);
	} catch (err) {
		console.error("Search error", err);
		return res.status(500).send([]);
	}
});

// user authentication endpoints
// allow optional channel image when signing up
const signupUpload = multer({storage}).single("channelImage");

app.post("/signup", signupUpload, async (req, res) => {
	const {username, password, channelName} = req.body;
	if (!username || !password) return res.status(400).send({success: false, message: "username/password required"});
	try {
		const existing = await User.findOne({username});
		if (existing) return res.status(409).send({success: false, message: "username taken"});
		const user = new User({username, password, channelName});
		await user.save();
		// if there is an uploaded channel image, put it in gridfs
		if (req.file) {
			await ensureDbConnection();
			const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
				bucketName: "youtube-clone-bucket",
			});
			const uploadStream = bucket.openUploadStream(req.file.originalname, {
				contentType: req.file.mimetype,
				metadata: {type: "channel", userId: user._id.toString()},
			});
			fs.createReadStream(req.file.path)
				.pipe(uploadStream)
				.on("finish", () => {
					// cleanup local file
					fs.unlink(req.file.path, () => {});
				});
		}
		// issue token
		const token = jwt.sign({userId: user._id, username}, JWT_SECRET, {expiresIn: JWT_EXPIRES});
		res.cookie("token", token, {httpOnly: true, maxAge: 7 * 24 * 3600 * 1000});
		return res.send({success: true});
	} catch (e) {
		console.error("signup error", e);
		return res.status(500).send({success: false});
	}
});

app.post("/signin", async (req, res) => {
	const {username, password} = req.body;
	if (!username || !password) return res.status(400).send({success: false, message: "username/password required"});
	try {
		const user = await User.findOne({username});
		if (!user || user.password !== password) return res.status(401).send({success: false});
		const token = jwt.sign({userId: user._id, username}, JWT_SECRET, {expiresIn: JWT_EXPIRES});
		res.cookie("token", token, {httpOnly: true, maxAge: 7 * 24 * 3600 * 1000});
		return res.send({success: true});
	} catch (e) {
		console.error("signin error", e);
		return res.status(500).send({success: false});
	}
});

// signout clears the cookie
app.post("/signout", (req, res) => {
	res.clearCookie("token");
	res.send({success: true});
});

// middleware to verify JWT
function requireAuth(req, res, next) {
	const token = req.cookies.token;
	if (!token) return res.status(401).send({success: false});
	try {
		const data = jwt.verify(token, JWT_SECRET);
		req.user = data;
		next();
	} catch (e) {
		return res.status(401).send({success: false});
	}
}

// streaming endpoint for any file in GridFS
// if someone literally requests `/file/*`, return a helpful error instead of crashing
app.get("/file/:id", async (req, res) => {
	const rawId = req.params.id;
	if (rawId === "*") {
		return res.status(400).send("You must specify a file id (not '*'). Use the URLs returned by /search.");
	}
	console.log("/file request", req.params.id);

	try {
		// ensure DB connection (important for serverless)
		try {
			await ensureDbConnection();
		} catch (e) {
			console.error("/file could not connect to DB", e);
			return res.status(503).send("Database not connected");
		}
		if (mongoose.connection.readyState !== 1) {
			console.log("DB not ready after ensureDbConnection, state", mongoose.connection.readyState);
			return res.status(503).send("Database not connected");
		}

		const id = req.params.id;
		const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
			bucketName: "youtube-clone-bucket",
		});

		let objId;
		try {
			objId = new mongoose.Types.ObjectId(id);
		} catch (e) {
			console.log("invalid object id", id);
			return res.status(400).send("Invalid id");
		}

		// fetch file metadata using promise style
		const docs = await bucket.find({_id: objId}).toArray();
		console.log("bucket.find promise result length", docs.length);
		if (!docs || docs.length === 0) {
			console.log("file not found for id", id);
			return res.status(404).send("File not found");
		}
		const file = docs[0];
		console.log("file metadata", {
			filename: file.filename,
			length: file.length,
			contentType: file.contentType,
			metadata: file.metadata,
		});
		const ctype = file.contentType || (file.metadata && file.metadata.contentType);
		if (ctype) {
			res.set("Content-Type", ctype);
		}
		if (typeof file.length === "number") {
			res.set("Content-Length", file.length);
		}
		if (!ctype) {
			const ext = path.extname(file.filename).toLowerCase();
			if ([".png", ".jpg", ".jpeg", ".gif"].includes(ext)) {
				res.set("Content-Type", "image/png");
			} else if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) {
				res.set("Content-Type", "video/mp4");
			}
		}

		const download = bucket.openDownloadStream(objId);
		download.on("error", (e) => {
			console.log("stream error", e);
			if (!res.headersSent) res.status(500).end();
			else res.end();
		});
		download.on("end", () => {
			console.log("stream ended");
			res.end();
		});
		download.pipe(res);
	} catch (e) {
		console.log("/file handler caught", e, e.stack);
		return res.status(500).send("Internal error");
	}
});

// require auth to upload and accept title field
app.post("/upload", requireAuth, upload.single("videoFile"), async (req, res) => {
	if (!req.file) return res.status(400).send("No file uploaded.");
	const videoTitle = req.body.title || path.basename(req.file.originalname, path.extname(req.file.originalname));

	// multer saved the file to disk under videos/ with original name
	let uploadedPath = req.file.path;
	const currentExt = path.extname(uploadedPath).toLowerCase();
	const targetPath = uploadedPath.replace(currentExt, ".mp4");

	try {
		// convert if necessary
		if (currentExt !== ".mp4") {
			ffmpeg.setFfmpegPath(ffmpegStatic);
			ffmpeg.setFfprobePath(ffprobeStatic.path);

			await new Promise((resolve, reject) => {
				ffmpeg(uploadedPath).toFormat("mp4").save(targetPath).on("end", resolve).on("error", reject);
			});

			// remove original non-mp4 file
			try {
				await fs.promises.unlink(uploadedPath);
			} catch (e) {
				console.error("Failed to remove temp file", e);
			}

			uploadedPath = targetPath; // update to converted file
		}

		// push to GridFS with thumbnail including metadata
		const result = await runUpload(path.resolve(uploadedPath), {title: videoTitle, userId: req.user.userId});
		return res.send({message: `File processed`, details: result});
	} catch (err) {
		console.error("Upload error:", err);
		// attempt cleanup of whatever might still exist
		try {
			await fs.promises.unlink(uploadedPath);
		} catch {}
		return res.status(500).send({error: "Failed to process upload"});
	}
});

// (server launched above once DB ready)

// when deployed on a platform like Vercel the framework will import the app
module.exports = app;
