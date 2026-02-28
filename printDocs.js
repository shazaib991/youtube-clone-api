const mongoose = require("mongoose");
(async () => {
	const uri = `mongodb+srv://${process.env.userNameMongodb}:${process.env.password}@cluster0.nxzntvt.mongodb.net/`;
	await mongoose.connect(uri);
	const bucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {bucketName: "youtube-clone-bucket"});
	const docs = await bucket.find({}).toArray();
	console.log("docs count", docs.length);
	docs.forEach((d) => {
		console.log(
			"id",
			d._id.toString(),
			"filename",
			d.filename,
			"length",
			d.length,
			"contentType",
			d.contentType,
			"metadata",
			d.metadata,
		);
	});
	process.exit(0);
})();
