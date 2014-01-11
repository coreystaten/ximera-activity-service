var async = require('async');
var tar = require('tar');
var Grid = require('gridfs-stream');
var mongoose = require('mongoose');
var temp = require("temp");
var fs = require("fs");
var git = require("./git-basic")
var path = require('path');
var wrench = require('wrench');
var winston = require('winston');
var fstream = require('fstream');
var exec = require('child_process').exec;
var mdb = require('./mdb');

temp.track();

exports = module.exports;

// TODO: Detect errors in repositories, and reclone if any.
exports.actOnGitFiles = function actOnGitFiles(action, callback) {
    var locals = {};

    winston.info('Acting on git files.');

    winston.info('Finding all GitRepos.');
    mdb.GitRepo.find(function (err, repos) {
        winston.info('Found %d repos; mapping action.', repos.length);

        async.map(repos, function (repo, callback) {
            var locals = {};
            var repoUrl = 'https://github.com/' + repo.gitIdent + '.git';
            winston.info('Mapping to repo %s at %s', repo.fileId.toString(), repoUrl);

            async.series([
                // Find out if archive file is in GFS.
                function (callback) {
                    if (repo.fileId) {
                        winston.info("Searching for archive file %s in GFS.", repo.fileId.toString());
                        mdb.gfs.files.find({ _id: repo.fileId }).count(function (err, count) {
                            if (err) { callback(err); }
                            else {
                                locals.inGfs = count > 0;
                                callback();
                            }
                        });                        
                    }
                    else {
                        winston.info("Archive not yet cloned.");
                        locals.inGfs = false;
                        callback();
                    }

                },

                function (callback) {
                    // If archive file is in GFS, pull it out and unzip it.
                    if (locals.inGfs) {
                        winston.info("Archive file %s found in GFS.", repo.fileId.toString());
                        locals.extractPath = temp.path();
                        async.series([
                            // Pulling the file out.
                            function (callback) {
                                locals.archivePath = temp.path();
                                var writeStream = fs.createWriteStream(locals.archivePath);
                                winston.info("Loading file %s from GFS to %s", repo.fileId.toString(), locals.archivePath);

                                readStream = mdb.gfs.createReadStream(repo.fileId);
                                writeStream.on('close', callback);
                                readStream.pipe(writeStream);
                            },
                            // Unpacking temporary file.
                            function (callback) {
                                winston.info("Unpacking %s to %s", locals.archivePath, locals.extractPath);

                                var extractStream = tar.Extract({path: locals.extractPath}).on('error', function (err) {
                                        locals.pipeErr = true;
                                        winston.error("Error unpacking archive: %s", err.toString());
                                    })
                                    .on('end', function () {
                                        if (locals.pipeErr) {
                                            callback("Unpacking error.");
                                        }
                                        else {
                                            winston.info("Unpacking complete.")
                                            callback();
                                        }
                                    });

                                fs.createReadStream(locals.archivePath)
                                    .pipe(extractStream);
                            },
                            // Setting gitDirPath.
                            function (callback) {
                                // Should only be one folder in the directory.
                                fs.readdir(locals.extractPath, function (err, files) {
                                    locals.gitDirPath = path.join(locals.extractPath, files[0]);
                                    winston.info ("Setting gitDirPath to %s", locals.gitDirPath);
                                    callback();
                                });
                            }
                            ],
                            function (err) {
                                if (err) {callback(err)}
                                else {callback();}
                            });
                    }
                    // Otherwise, clone it and save it.
                    else {
                        locals.gitDirPath = temp.path();
                        winston.info("Archive file %s not found; cloning from repository to %s.", repo.fileId.toString(), locals.gitDirPath);
                        git.clone(repoUrl, locals.gitDirPath, function (err) {
                            if (err) { callback(err); }
                            else {
                                winston.info("Repository successfully cloned.");
                                exports.updateGitAction(repo, locals.gitDirPath, callback);
                            }
                        });
                    }
                },

                // Perform the action.
                function (callback) {
                    winston.info("Performing action on %s", repo.fileId.toString());
                    action(repo, locals.gitDirPath, function (err, result) {
                        if (err) { callback(err) }
                        else {
                            locals.result = result;
                            callback();
                        }
                    });
                }],
                // Final callback; attempt to perform cleanup and return result.
                function (err) {
                    winston.info ("Final ");

                    if (err) {
                        winston.error(err);                        
                    }

                    if (locals.archivePath) {
                        winston.info("Attempting cleanup of temporary file %s", locals.archivePath);
                        fs.unlink(locals.archivePath, function (err) {if (err) {winston.error(err)}});                        
                    }

                    var deletePath;
                    if (locals.extractPath) {
                        deletePath = locals.extractPath;
                    }
                    else {
                        deletePath = locals.gitDirPath;
                    }
                    winston.info("Attempting cleanup of temporary directory %s", deletePath);
                    //wrench.rmdirRecursive(deletePath, false, function (err) {if (err) {winston.error(err);}});

                    callback(err, {repo: repo, result: locals.result});
                }
            );
        },
        callback);
    });
}

exports.storeAlteredRepo = function storeDirectory(repo, gitDirPath, callback) {
    var locals = { archivePath: temp.path() };

    async.series([
        // Put files into archive.
        function (callback) {
            winston.info("Packing archive for %s to %s", repo.fileId.toString(), locals.archivePath);

            writer = fstream.Writer({path: locals.archivePath})
                .on('error', function () {
                    winston.info("error");
                    locals.pipeErr = true;
                })
                .on('close', function () {
                    winston.info("end");
                    if (locals.pipeErr) {
                        callback("Unknown error packing archive.");
                    }
                    else {
                        callback();                        
                    }
                });


            fstream.Reader({path: gitDirPath, type: 'Directory'})
                .pipe(tar.Pack())
                .pipe(writer);            
        },

        // Save archive to GFS
        function (callback) {
            winston.info("Saving archive from %s to GFS for repo %s", locals.archivePath, repo.fileId.toString());
            read = fs.createReadStream(locals.archivePath);
            write = mdb.gfs.createWriteStream({
                _id: repo.fileId,
                mode: 'w'
            });
            write.on('error', function (err) {
                locals.pipeErr = true;
            });
            write.on('close', function (file) {
                repo.fileId = file._id;
                repo.save(function () {});

                winston.info("GFS file written.")
                if (locals.pipeErr) {
                    callback("Unknown error saving archive.");
                }
                else {
                    callback();                    
                }
            });
            read.pipe(write);
        }],
        // Final callback, attempt to perform cleanup.
        function (err) {
            if (err) {
                winston.error(err);
            }

            winston.info("Attempting cleanup of %s", locals.archivePath);
            fs.unlink(locals.archivePath, callback);
        }
    );
}

exports.updateGitAction = function updateGitAction(repo, gitDirPath, callback) {
    
    async.series([
        // Perform a pull on the git repository.
        function (callback) {
            winston.info("Pulling git repository for %s at ", repo.fileId.toString(), gitDirPath);
            git.pull(gitDirPath, function (err, stdout, stderr) {
                winston.info("Stdout: %s", stdout);
                winston.info("Stderr: %s", stderr);
                callback();
            });
        },
        // Store
        function (callback) {
            exports.storeAlteredRepo(repo, gitDirPath, callback);
        }],
        callback
    );
}

exports.readTestAction = function readTestAction(repo, gitDirPath, callback) {
    var fileToRead = path.join(gitDirPath, 'test.tex');
    winston.info("Reading file %s.", fileToRead)
    fs.readFile(fileToRead, function (err, data) {
        winston.info("Read file. Data: %s", data ? data.toString() : "undefined");
        callback(err, data);
    });
}
