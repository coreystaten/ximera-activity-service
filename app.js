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
var replaceCommands = ['headline', 'activitytitle', 'youtube', 'answer', 'choice'];

// For now, just run through main loop once.

function main () {
    winston.info('Starting main loop.');
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

    finder.on('error', callback);

    finder.on('end', function () {
        callback(null, filePaths);
    });
}

// TODO: LaTeX is not trustable; this needs to be sandboxed using a Linux container or other mechanism before accepting user-generated content.
function compileAndStoreTexFiles(repo, gitDirPath, callback) {
    winston.info('Compiling Git Repo.');
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
                    var htmlFileName = fileName.substring(0, fileName.length - 4) + '.html';
                    var htmlPath = path.join(path.dirname(filePath), htmlFileName);
                    var locals2 = {skipped: false}; // Set to true if this document's compilation was skipped; won't propagate error.


                    async.series([
                        // Check if file contains \documentclass; if not, don't compile it.
                        function (callback) {
                            var shellStr = util.format("grep '\\\\documentclass' %s", filePath);
                            exec(shellStr, function (err, stdout) {
                                if (stdout.length == 0) {
                                    locals2.skipped = true;                                    
                                    callback('Skipping file: \\documentclass not found.');
                                }
                                else {
                                    callback();
                                }
                            });
                        },
                        // Replace known commands with environments so that filter will see them.
                        function (callback) {
                            async.eachSeries(replaceCommands, 
                                function(command, callback) {
                                    winston.info("Replacing commands in file.");
                                    var shellStr = util.format("sed -ie 's/\\\\\\(%s\\)\\(\\(\\[[^\\]]*\\]\\)*\\({[^}]*}\\)*\\)/\\\\begin{\\1}\\2\\\\end{\\1}/g'", command, filePath);
                                    winston.info(shellStr);
                                    exec(shellStr, callback);
                                },
                                callback
                            );
                        },
                        // Hash file.
                        function (callback) {
                            // Note that we hash the original file, since the Pandoc filter is non-deterministic and will include unique IDs.
                            winston.info("Hashing file.");
                            var readStream = fs.createReadStream(filePath);
                            var hasher = crypto.createHash('sha1');
                            hasher.setEncoding('hex');                          
                            readStream.on('end', function() {
                                hasher.end();
                                locals.hash = hasher.read();
                                callback();
                            });
                            readStream.pipe(hasher);
                        },                        
                        // Pandoc compilation.
                        function (callback) {
                            // TODO: Run pandoc from working directory of tex file, so that inputs are read appropriately?
                            // (cd blah; pandoc blah) - spawns subshell
                            var filterPath = process.env.XIMERA_FILTER_PATH;
                            winston.info("Executing pandoc.");
                            var baseDir = path.dirname(filePath);
                            var shellStr = util.format('(cd %s; pandoc --metadata=repoId:%s,hash:%s --parse-raw -f latex -t html --filter=%s --output=%s %s)', baseDir, repo._id, locals.hash, filterPath, htmlPath, filePath);
                            winston.info(shellStr);
                            exec(shellStr, function (err, stdout, stderr) {
                                winston.info ("Stdout: %s", stdout);
                                winston.info("Stderr: %s", stderr);
                                callback(err);
                            });
                        },
                        // Find activity entry if it exists.
                        function (callback) {
                            winston.info("Finding activity entry.");
                            mdb.Activity.findOne({baseFileHash: locals.hash}, function (err, activity) {
                                if (err)  { callback(err); }
                                else {
                                    locals.activity = activity;
                                    callback();
                                }
                            });
                        },
                        // If activity doesn't exist, or has no associated file, save file and create one.  Add activity id to new activity list.
                        function (callback) {
                            if (locals.activity && locals.activity.htmlFileId) {
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
                                        if (!locals.activity) {
                                            locals.activity = new mdb.Activity({
                                                htmlFileId: fileObjectId,
                                                baseFileHash: locals.hash,
                                                repoId: repo._id
                                            });                                            
                                        }
                                        locals.activity.save(function (err) {
                                            if (err) {
                                                winston.info("Error saving.")
                                                callback (err);
                                            }
                                            else {
                                                winston.info("Activity saved, adding to list.");
                                                locals.newActivityIds.push(locals.activity._id);                                                
                                                callback();
                                            }
                                        });
                                    }
                                });                                                                 
                            }                           
                        }
                    ], function (err) {
                        if (locals2.skipped) {
                            winston.info(err);
                            callback();
                        }
                        else if (err) {
                            callback(err);
                        }
                        else {
                            callback();
                        }
                    });
                },
                callback
            );
        }],
        function (err) {
            if (err) {
                callback(err);
            }
            else {
                winston.info("Saving activities");
                // Update GitRepo's list of activities to only reflect those we just loaded. (Deleted activities will disappear.)
                repo.currentActivityIds = locals.newActivityIds;
                repo.save(callback);                
            }
        }
    );
}

mdb.initialize();
main();
