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
});
const User = mongoose.model("User", userSchema);

// connect once at startup instead of on every request
const uri = `mongodb+srv://${process.env.userNameMongodb}:${process.env.password}@cluster0.nxzntvt.mongodb.net/`;
(async () => {
	await connectToDatabase(uri);
	// only start listening if we're running normally; Vercel will handle requests itself
	if (!isServerless) {
		app.listen(PORT, () => {
			console.log(`Server is running on http://localhost:${PORT}`);
		});
	}
})();

async function connectToDatabase(uri) {
	try {
		// Wait for the connection to be established
		await mongoose.connect(uri);
		console.log("Database connected successfully");
	} catch (err) {
		console.error("Database connection failed", err);
		// It is good practice to shut down the application if the DB connection fails
		process.exit(1);
	}
}

async function runSearch() {
	// returns an array of { baseName, videoUrl, imageUrl } objects
	// assume DB connection already established
	const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
		bucketName: "youtube-clone-bucket",
	});

	if (!bucket) {
		console.error("GridFS bucket not initialized");
		return [];
	}
	const cursor = bucket.find({});
	let docs = [];
	await cursor.forEach((doc) => docs.push(doc));

	// group by base filename (without extension)
	const map = {};
	docs.forEach((doc) => {
		const base = path.basename(doc.filename, path.extname(doc.filename));
		if (!map[base]) {
			map[base] = {baseName: base, videoUrl: null, imageUrl: null};
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
		} else if (ctype && ctype.startsWith("image")) {
			map[base].imageUrl = url;
		} else {
			console.warn("runSearch: could not determine type for", doc.filename, "ctype", ctype);
		}
	});

	return Object.values(map);
}

async function runUpload(videoPath) {
	// videoPath should be an absolute path to the MP4 file
	// DB is already connected

	// get duration using ffprobe synchronously
	let durationSecs = 0;
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

	// capture a frame as thumbnail
	ffmpeg.setFfmpegPath(ffmpegStatic);
	ffmpeg.setFfprobePath(ffprobeStatic.path);
	const captureTime = "00:00:05";

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

	// upload video (include duration metadata so search can use it)
	let uploadStream = bucket.openUploadStream(filename, {
		contentType: "video/mp4",
		metadata: {source: "local upload", duration: durationSecs},
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

	// upload thumbnail
	uploadStream = bucket.openUploadStream(imagename, {
		contentType: "image/png",
		metadata: {source: "local upload"},
	});
	readStream = fs.createReadStream(imagePath);

	await new Promise((resolve, reject) => {
		readStream
			.pipe(uploadStream)
			.on("error", (err) => reject(err))
			.on("finish", () => resolve());
	});

	// delete thumbnail file as well
	try {
		await fs.promises.unlink(imagePath);
	} catch (err) {
		console.error("Failed to delete local thumbnail", err);
	}
	return {status: "success", message: "uploaded video and thumbnail"};
}

app.get("/", (req, res) => {
	res.send("Hello World! Your API is running.");
});

app.get("/search", async (req, res) => {
	try {
		const results = await runSearch();
		// build absolute urls so frontend can use them directly
		const base = `${req.protocol}://${req.get("host")}`;
		const updated = results.map((r) => ({
			baseName: r.baseName,
			videoUrl: r.videoUrl ? base + r.videoUrl : null,
			imageUrl: r.imageUrl ? base + r.imageUrl : null,
			videoLength: r.videoLength || null,
		}));
		return res.send(updated);
	} catch (err) {
		console.error("Search error", err);
		return res.status(500).send([]);
	}
});

// user authentication endpoints
app.post("/signup", async (req, res) => {
	const {username, password} = req.body;
	if (!username || !password) return res.status(400).send({success: false, message: "username/password required"});
	try {
		const existing = await User.findOne({username});
		if (existing) return res.status(409).send({success: false, message: "username taken"});
		const user = new User({username, password});
		await user.save();
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
		// ensure DB connected
		if (mongoose.connection.readyState !== 1) {
			console.log("DB not ready, state", mongoose.connection.readyState);
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
		console.log("/file handler caught", e);
		return res.status(500).send("Internal error");
	}
});

app.post("/upload", upload.single("videoFile"), async (req, res) => {
	if (!req.file) return res.status(400).send("No file uploaded.");

	// also accept optional username/password to create user? upload unrelated

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

		// push to GridFS with thumbnail
		const result = await runUpload(path.resolve(uploadedPath));
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
