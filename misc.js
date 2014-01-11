var findit = require('findit')
  , path = require('path');

// Calls callback(err, filePathList) with a list of paths to unhidden files having the given extension.
exports.getUnhiddenFileList = function (dirPath, extension, callback) {
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
        else if (fileName.substring(fileName.length - extension.length, fileName.length) === extension) {
            filePaths.push(filePath);
        }
    });

    finder.on('error', callback);

    finder.on('end', function () {
        callback(null, filePaths);
    });
}
