var Grid = require('gridfs-stream');
var mongoose = require('mongoose');
var fstream = require('fstream');
var fs = require("fs");
var winston = require("winston");

exports = module.exports;

var ObjectId = mongoose.Schema.ObjectId;

mongoose.connect('mongodb://' + process.env.XIMERA_MONGO_URL + "/" +
                 process.env.XIMERA_MONGO_DATABASE);
var gfs = Grid(mongoose.connection.db, mongoose.mongo);

// Notice this is different from Schema.ObjectId; Schema.ObjectId if for passing
// models/schemas, Types.ObjectId is for generating ObjectIds.
exports.ObjectId = mongoose.Types.ObjectId;
exports.gfs = gfs;

exports.initialize = function initialize() {
    winston.info("Initializing Mongo");
    exports.GitRepo = mongoose.model("GitRepo",
                                     { url: String, fileId: ObjectId,
                                       currentActivityIds: [ObjectId] });
    exports.Activity = mongoose.model("Activity",
                                      { htmlFileId: ObjectId,
                                        baseFileHash: {type: String, index: true},
                                        repoId: ObjectId,
                                        gitRelativePath: String,
                                        latexSource: String });


    /*var testRepo = new exports.GitRepo({
        url: "https://github.com/coreystaten/git-pull-test.git",
        fileId: mongoose.Types.ObjectId()
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
        if (locals.pipeErr) {
            callback("Unknown error saving archive.");
        }
        else {
            winston.info("GFS file written.")
            callback();                    
        }
    });
    read.pipe(write);	
}
            
