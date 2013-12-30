var async = require('async')
  , findit = require("findit")
  , fs = require('fs')
  , git = require('./git')
  , sleep = require('sleep')
  , exec = require('child_process').exec
  , util = require('util')
  , mdb = require('./mdb')
  , crypto = require('crypto')
  , winston = require('winston')
  , path = require('path')
  , _ = require('underscore');

// Following commands will be replaced by environments so that Pandoc will receive raw blocks for them.
var replaceCommands = ["headline", "activitytitle"];

// For now, just run through main loop once.

function main () {
    winston.info("Starting main loop.");
	async.series([
		// Update all Git Repos.
		function (callback) {
			git.actOnGitFiles(git.updateGitAction, callback);
		},

		// Compile TeX files in all repos and save the results.
		function (callback) {
			git.actOnGitFiles(compileAndStoreTexFiles, callback)
		}
	], function (err) {
        if (err) {
            winston.error(err);
        }
    });
}

// Calls callback(err, filePathList) with a list of paths to unhidden tex files.
function getUnhiddenTexFileList(dirPath, callback) {
    var finder = findit(dirPath);
    var filePaths = [];

    finder.on('directory', function (dir, stat, stop) {
        if (path.basename(dir)[0] === ".") {
            // Don't navigate hidden folders.
            stop();
        }
    });

    finder.on('file', function(filePath, stat) {
        var fileName = path.basename(filePath).toString();
        if (fileName[0] === ".") {
            // Don't do anything with hidden files.
            return;
        }
        else if (fileName.substring(fileName.length - 4, fileName.length) === ".tex") {        
            filePaths.push(filePath);
        }
    });

    finder.on("error", callback);

    finder.on('end', function () {
        callback(null, filePaths);
    });
}

// TODO: LaTeX is not trustable; this needs to be sandboxed using a Linux container or other mechanism before accepting user-generated content.
function compileAndStoreTexFiles(repo, gitDirPath, callback) {
    winston.info("Compiling Git Repo.");
    var locals = {newActivityIds: []};

    async.series([
        // Get list of .tex files to process
        function (callback) {
            getUnhiddenTexFileList(gitDirPath, function (err, filePaths) {
                if (err) {callback(err)}
                else {
                    locals.filePaths = filePaths;
                    callback();
                }
            })
        },
        // Process each .tex file.
        function (callback) {
            async.each(
                locals.filePaths,
                function (filePath, callback) {
                    var fileName = path.basename(filePath).toString();
                    var htmlFileName = fileName.substring(0, fileName.length - 4) + ".html";
                    var htmlPath = path.join(path.dirname(filePath), htmlFileName);
                    async.series([
                        // Replace known commands with environments so that filter will see them.
                        function (callback) {
                            async.each(replaceCommands, 
                                function(command, callback) {
                                    winston.info("Replacing commands in file.");
                                    var shellStr = util.format("(cat %s | sed -e 's/\\(\\\\%s\\){\\([^}]*\\)}/\\\\begin{\\1}\\2\\\\end{\\1}/g') > %s", filePath, command, filePath);
                                    winston.info(shellStr);
                                    exec(shellStr, callback);
                                },
                                callback
                            );
                        },
                        // Pandoc compilation.
                        function (callback) {
                            var filterPath = process.env.XIMERA_FILTER_PATH;
                            winston.info("Executing pandoc.");
                            var shellStr = util.format('pandoc --standalone --metadata=repoId:%s --parse-raw -f latex -t html --filter=%s --output=%s %s', repo._id, filterPath, htmlPath, filePath);
                            winston.info(shellStr);
                            exec(shellStr, function (err, stdout, stderr) {
                                winston.info ("Stdout: %s", stdout);
                                winston.info("Stderr: %s", stderr);
                                callback(err);
                            });
                        },
                        // Hash file.
                        function (callback) {
                            winston.info("Hashing file.");
                            var readStream = fs.createReadStream(htmlPath);
                            var hasher = crypto.createHash('sha1');
                            hasher.setEncoding('hex');                          
                            readStream.on('end', function() {
                                hasher.end();
                                locals.hash = hasher.read();
                                callback();
                            });
                            readStream.pipe(hasher);
                        },
                        // Find activity entry if it exists.
                        function (callback) {
                            winston.info("Finding activity entry.");
                            mdb.Activity.findOne({hash: locals.hash}, function (err, activity) {
                                if (err)  { callback(err); }
                                else {
                                    locals.activity = activity;
                                    callback();
                                }
                            });
                        },
                        // If activity doesn't exist, save file and create one.  Add activity id to new activity list.
                        function (callback) {
                            if (locals.activity) {
                                // No need to load activity.
                                winston.info ("Adding activity to list.")
                                locals.newActivityIds.push(locals.activity._id);
                            }
                            else {
                                winston.info("Copying activity file to GFS");
                                var fileObjectId = mdb.ObjectId();
                                mdb.copyLocalFileToGfs(htmlPath, fileObjectId, function (err) {
                                    if (err) callback (err);
                                    else {
                                        winston.info("Saving activity.");
                                        var activity = new mdb.Activity({
                                            htmlFileId: fileObjectId,
                                            fileHash: locals.hash,
                                            repoId: repo._id
                                        });
                                        activity.save(function (err) {
                                            if (err) {
                                                winston.info("Error saving.")
                                                callback (err);
                                            }
                                            else {
                                                winston.info("Activity saved, adding to list.");
                                                locals.newActivityIds.push(activity._id);                                                
                                                callback();
                                            }
                                        });
                                    }
                                });                                                                 
                            }                           
                        }
                    ], callback);
                },
                callback
            );
        }],
        function (err) {
            if (err) callback(err);
            else {
                // Update GitRepo's list of activities to only reflect those we just loaded. (Deleted activities will disappear.)
                repo.currentActivityIds = locals.newActivityIds;
                repo.save(callback);                
            }
        }
    );
}

mdb.initialize();
main();
