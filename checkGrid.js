const mongoose = require("mongoose");
(async () => {
	const uri = `mongodb+srv://${process.env.userNameMongodb}:${process.env.password}@cluster0.nxzntvt.mongodb.net/`;
	try {
		await mongoose.connect(uri);
		const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {bucketName: "youtube-clone-bucket"});
		bucket.find({}).toArray((err, docs) => {
			if (err) {
				console.error("find err", err);
				process.exit(1);
			}
			console.log(
				"docs",
				docs.map((d) => ({filename: d.filename, contentType: d.contentType, metadata: d.metadata})),
			);
			process.exit(0);
		});
	} catch (e) {
		console.error("connect error", e);
	}
})();
