var async = require('async')
  , winston = require('winston')
  , findit = require("findit")
  , fs = require('fs')
  , exec = require('child_process').exec
  , util = require('util')
  , mdb = require('../mdb')
  , misc = require('../misc')
  , crypto = require('crypto')
  , path = require('path')
  , _ = require('underscore')
  , yaml = require('js-yaml');

// Course unique identifier is gitusername/gitrepo:relativeFilePath. Do not keep old versions.

// Active/inactive tag for course files (and activities?)
// Sessions expressed via new course file, e.g. moocolus-autumn-2013.xim

// Tag scopes with date updated; index by activity/user/date, index user/activity
// Tag activity with date updated; index gitIdent/date, index hash

module.exports = function compileCourses(repo, gitDirPath, callback) {
    winston.info('Compiling courses from Git repo.');
    var locals = {};

    async.series([
        // Get list of .xim files to process
        function (callback) {
            misc.getUnhiddenFileList(gitDirPath, '.xim', function (err, filePaths) {
                if (err) {callback(err)}
                else {
                    locals.filePaths = filePaths;
                    callback();
                }
            })
        },
        // Process each .xim file.
        function (callback) {
            async.each(
                locals.filePaths,
                function (filePath, callback) {
                    var fileName = path.basename(filePath).toString();
                    var relativeFilePath = path.relative(gitDirPath, filePath);
                    fs.readFile(filePath, 'utf8', function (err, data) {
                        if (err) callback (err)
                        else {
                            var ximDoc = parseXimDoc(data, repo.gitIdent);
                            var courseKey = {relativePath: relativeFilePath, repoId: repo._id};
                            // Save course file.
                            mdb.Course.findOne(courseKey, function (err, course) {
                                if (err) callback(err);
                                else {
                                    if (!course) {
                                        course = new mdb.Course(courseKey);
                                    }
                                    course.activityTree = ximDoc.activityTree;
                                    course.name = ximDoc.metadata.name;
                                    course.markModified('activityTree');
                                    course.save(callback);
                                }
                            });
                        }
                    });
                },
                callback);
        }], callback);
}

function parseXimDoc(data, gitIdent) {
    lines = data.split('\n')
    var ximTree = []
    var context = {subtree: ximTree, prev: null, indent: 0}
    var lastAct = null;
    var inMeta = false;
    var meta = "";

    _.each(lines, function(line) {
        var indent = line.match(/^ */)[0].length;
        var trimmedLine = line.trim()

        if (trimmedLine === "") {
            return;
        }
        else if (trimmedLine === "---") {
            // Toggle meta mode.
            inMeta = !inMeta;
            return;
        }

        if (inMeta) {
            meta += line + "\n";
        }
        else {
            if (indent > context.indent) {
                // Descend.
                if (context.length > 0) {
                    context = {subtree: _.last(context.subtree).children, prev: context, indent: indent}
                }
                else {
                    // Nothing to descend, just increase initial indent level.
                    context.indent = indent;
                }
            }
            else if (indent < context.indent) {
                // Ascend
                while (indent != context.indent) {
                    context = context.prev;
                }
            }
            lastAct = trimmedLine;
            // Is a relative path for this repo: prefix repo's gitIdent.
            if (lastAct.indexOf(':') == -1) {
                lastAct = gitIdent + ':' + lastAct;
            }
            context.subtree.push({value: lastAct, children: []});
        }
    });
    var metadata = yaml.safeLoad(meta);
    return {activityTree: ximTree, metadata: metadata};
}
