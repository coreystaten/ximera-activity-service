var Grid = require('gridfs-stream');
var mongoose = require('mongoose');
var fstream = require('fstream');
var fs = require("fs");

exports = module.exports;

var ObjectId = mongoose.Schema.ObjectId;

mongoose.connect('mongodb://' + process.env.XIMERA_MONGO_URL + "/" + process.env.XIMERA_MONGO_DATABASE);
var gfs = Grid(mongoose.connection.db, mongoose.mongo);

var GitRepo;
var Activity;

exports.initialize = function initialize() {
    GitRepo = mongoose.model("GitRepo", { url: String, fileId: ObjectId, currentActivityIds: [ObjectId] });
    Activity = mongoose.model("Activity", { htmlFileId: ObjectId, fileHash: {type: String, index: true}, repoId: ObjectId });
    /*var testRepo = new GitRepo({
        url: "https://github.com/coreystaten/git-pull-test.git",
        fileId: ObjectId()
    });
    testRepo.save(function () {});*/
}

exports.copyLocalFileToGfs = function (path, fileId, callback) {
	var locals = {pipeErr: false};
	read = fs.createReadStream(path);
    write = gfs.createWriteStream({
        _id: fileId,
        mode: 'w'
    });
    write.on('error', function (err) {
        locals.pipeErr = true;
    });
    write.on('close', function (file) {
        winston.info("GFS file written.")
        if (locals.pipeErr) {
            callback("Unknown error saving archive.");
        }
        else {
            callback();                    
        }
    });
    read.pipe(write);	
}
            