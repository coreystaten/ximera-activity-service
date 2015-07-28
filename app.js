
var async = require('async')
  , git_commands = require('./git-commands')
  , git = require('nodegit')
  , sleep = require('sleep')
  , winston = require('winston')
  , mdb = require('./mdb')
  , crypto = require('crypto')
  , githubApi = require('github')
  , fdSlicer = require('fd-slicer')
  ;

var XIMERA_URL = "https://497a6980.ngrok.com/sha/";

var tar = require("tar")
, fstream = require("fstream")
, rimraf = require("rimraf")
, fs = require("fs");

var temp = require('temp');
temp.track();

var path = require('path');
var extname = path.extname;
var basename = path.basename;

var exec = require('child_process').exec;
var child_process = require('child_process');

if (!process.env.XIMERA_MONGO_DATABASE ||
    !process.env.XIMERA_MONGO_URL) {
    throw "Appropriate environment variables not set.";
}

/** @function saveToContentAddressableFilesystem saves data to the CAFS and returns a hash via the callback */
function saveToContentAddressableFilesystem( data, callback ) {
    var hash = "";
    
    async.series(
	[
	    // Compute hash
	    function(callback) {
		var shasum = crypto.createHash('sha256');
		shasum.update(data);
		hash = shasum.digest('hex');
		callback(null);
	    },
	    
	    function(callback) {
		var blob = new mdb.Blob({
		    hash: hash,
		    data: data
		});
		
		blob.save(callback);
	    }
	],function(err, result) {
	    callback( err, hash );
	    return;
	}
    );

    return;
}

/* This should be using git clone --mirror so that I can git clone without pulling everything from github every single time. */

/* Then I have to
   * update the mirror (which should only pull the new data)
   * git clone (from the mirror).
   * get this into qemu using sandbox.sh
   * pdflatex all the tex files inside the sandbox
   * store the log output under the the sha1's for the tex file
   * store the PDFs
   * rasterize the PNGs 
   * convert the PDFs to SVGs
*/

/** @function createMirror asynchronously initializes a bare repoDirectory with the contents of the github repo at githubIdentifier
*/
function createMirror( githubIdentifier, repoDirectory, callback ) {
    
    async.waterfall([
    	function (callback) {
	    winston.info( "Creating a bare repo at " + repoDirectory + "..." );
	    git.Repository.init(repoDirectory, 1 ).then( function(repo) {
		callback( null, repo );
	    }).catch( function(err) { callback(err); });
	},
	
	function (repo, callback) {
	    winston.info( "Creating an 'origin' remote with the mirror fetch refspec..." );
	    var result = git.Remote.createWithFetchspec(repo, "origin", "http://github.com/" + githubIdentifier, "+refs/*:refs/*").then( function(origin) {
		callback( null, repo, origin );
	    }).catch( function(err) { callback(err); });
	},
	
	function (repo, origin, callback) {
	    winston.info( "Opening repository configuration options..." );
	    repo.config().then( function(config) {
		winston.info( "Setting remote.origin.mirror = true for compatibility with git-core..." );
		// There is a missing config.setBool method, but setString does the right thing in the repository's config file
		config.setString("remote.origin.mirror", "true" ).then( function(result) {
		    callback(null);
		});
	    }).catch( function(err) { callback(err); });
	},
	
    ], function (err, result) {
	callback( err );
    });
}

/** @function processMatchingFiles runs handler on each file matching extension stored in the tar file at outputTarPath
    @param {string} readStream to process
    @param {string} extension
    @param {string} handler
*/
function processMatchingFiles(readStream, extension, handler, callback)
{
    winston.info( "Reading output tarfile for " + extension + " files..." );
    
    var finished = false;
    
    // Queue for saving tex file content to the database
    var q = async.queue(function (task, callback) {
	handler( task.path, task.text, callback );
    }, 2 );
    
    q.drain = function() {
	if (finished)
	    callback(null);
    };
    
    readStream
	.pipe(tar.Parse())
	.on("end", function(e) {
	    if (q.length() > 0)
		finished = true;
	    else
		callback(null);
	})
	.on("entry", function (e) {
	    var path = e.props.path.replace( /^.\//, "" );
	    
	    var regexp = extension;
	    if (typeof extension  === 'string' || extension instanceof String)
		var regexp = new RegExp("\\." + extension + "$","g");
	    
	    if (path.match( regexp )) {
		// Grab text as it comes in through the stream
		var text = new Buffer(0);
		
		e.on("data", function (c) {
		    text = Buffer.concat([text,c]);
		});
		
		// When the file is finished...
		e.on("end", function () {
		    q.push( { path: path, text: text }, function(err) {
			winston.info( "Finished processing " + path );
		    });
		});
	    }
	});

    return;
}

/** @function updateCachedMirror asynchronously creates (or refreshes) a bare repo containing a mirrored copy of the repo at githubIdentifier
    @param {string} githubIdentifier 
    @param callback called with the repoDirectory, which is a base64 encoding of the github identifier in a .cache directory
*/
function updateCachedMirror( githubIdentifier, callback ) {
    var homeDirectory = process.env.HOME;
    var cacheDirectory = path.resolve( homeDirectory, '.cache', 'ximera' );
    var cacheSubdirectory = new Buffer(githubIdentifier).toString('base64');
    var repoDirectory = path.resolve( cacheDirectory, cacheSubdirectory );    
    
    async.waterfall([
	function (callback) {
	    // Create bare repo if repoDirectory doesn't exist
	    winston.info( "Checking if there is a repo at " + repoDirectory + "..." );
	    fs.exists(repoDirectory, function(exists) {
		if (!exists) {
		    createMirror( githubIdentifier, repoDirectory, callback );
		} else {
		    callback( null );
		}
	    });
	},

	function (callback) {
	    winston.info( "Opening bare repository at " + repoDirectory + "..." );
	    git.Repository.openBare(repoDirectory).then( function(repo) {
		callback( null, repo );
	    }).catch( function(err) { callback(err); });
	},

	function (repo, callback) {
	    winston.info( "Getting remote..." );
	    git.Remote.lookup( repo, "origin" ).then( function(remote) {
		callback( null, repo, remote );
	    }).catch( function(err) { callback(err); });
	},

	function (repo, origin, callback) {
	    winston.info( "Fetching remote from http://github.com/" + githubIdentifier + "..." );
	    var refspecs = "";
	    origin.fetch(refspecs, git.Signature.now( "Ximera", "ximera@math.osu.edu" ), "fetch").then( function() {
		callback( null, repoDirectory );
	    });
	},
    ], function (err, result) {
	callback( err, result );
    });
}

/** @function updateRepo
    Grab a copy of the repo given by githubIdentifier, fetch the content associated to the given commitSha, and run LaTeX on it inside a sandbox, saving the results in the database
    @param {string} githubIdentifier 
*/
function updateRepo(githubIdentifier, commitSha, callback) {
    var repositoryDirectory = "";
    var bareDirectory = "";
    var sandboxTarPath = "";
    var overlayPath = "";
    var outputTarPath = "";
    var outputTarFd = -1;
    var outputTarSlicer;
    var repository = null;
    var headCommit = null;
    
    async.waterfall([
	// Get the repository from the repo
	function (callback) {
	    mdb.GitRepo.findOne({gitIdentifier: githubIdentifier}).exec( function (err, repoInformation) {
		callback(err, repoInformation);
	    });
	},

	function (repoInformation, callback) {
	    winston.info( "Creating or updating the mirror..." );
	    updateCachedMirror( githubIdentifier, function(err, directory) {
		winston.info( "Created or updated at " + directory );
		bareDirectory = directory;
		callback( err ); 
	    });
	},

	function (callback) {
	    repositoryDirectory = "/tmp/sandbox";
	    winston.info( "Clearing temporary directory " + repositoryDirectory + "..." );
	    rimraf(repositoryDirectory, function(err) {
		callback( err );
	    });
	},

	/*
	function (callback) {
	    winston.info( "Creating temporary directory..." );
	    temp.mkdir('sandbox', function(err, dirPath) {
		repositoryDirectory = dirPath;
		callback( null );
	    });
	},
	*/
	
	function (callback) {
	    winston.info( "Cloning the mirror from " + bareDirectory + " into " + repositoryDirectory );
	    git.Clone.clone(bareDirectory, repositoryDirectory, null ).then( function(repo) {
		callback( null  );
	    }).catch( function(err) { callback(err); });
	},

	function (callback) {
	    winston.info( "Opening repository..." );
	    git.Repository.open(repositoryDirectory).then( function(repo) {
		repository = repo;
		callback( null );
	    }).catch( function(err) { callback(err); });
	},

	/*
	function (callback) {
	    winston.info( "Finding HEAD reference in repository at " + repository.path() + "..." );
	    repository.getReference("HEAD", function(err, ref) {
		if (err) callback(err);

		winston.info( "Finding HEAD commit in repository..." );
		repository.getCommit(ref.target(), function (err, commit) {
		    console.log( "commit = ", commit.sha() );
		    headCommit = commit;
		    callback(err);
		});
	    });
	},
	*/

	function (callback) {
	    winston.info( "Finding given commit in repository..." );
	    repository.getCommit(commitSha, function (err, commit) {
		console.log( "commit = ", commit.sha() );
		headCommit = commit;
		callback(err);
	    });
	},	

	function (callback) {
	    winston.info( "Resetting to the given commit..." );
	    git.Reset.reset( repository, headCommit, git.Reset.TYPE.HARD, null, git.Signature.now( "Ximera", "ximera@math.osu.edu" ), "fetch").then(
		function(result) {
		    callback( null );
		});
	},	
	
	/*
	function (callback) {
	    winston.info( "Display README.md for fun" );
	    fs.readFile(path.resolve( repositoryDirectory, "README.md" ), 'utf8', function (err,data) {
		console.log( data );
		//exec( "cat " + repositoryDirectory + "/README.md" );
		callback( null );
	    });
	},
	*/
	
	function (callback) {
	    winston.info( "Queueing sandbox commands..." );
	    commands = "";
	    commands = commands + "#!/bin/bash\n";
	    // Change to the sandbox directory
	    commands = commands + "cd ~/sandbox\n";
	    // Set up some of the environment
	    commands = commands + "export HOME=/root\n";
	    // Make the line length a bit bigger on the latex log output
	    commands = commands + "export max_print_line=2048\n";
	    commands = commands + "export TEXMFHOME=/root/texmf\n";
	    // Add the tikzexport class option to every tex file
	    commands = commands + 'find . -iname \'*.tex\' -execdir sed -i \'1s/^/\\\\PassOptionsToClass{tikzexport}{ximera}\\\\nonstopmode/\' {} \\;\n';
	    // Run pdflatex just once on all tex files
	    commands = commands + 'find . -iname \'*.tex\' -execdir pdflatex -shell-escape {} \\; > /dev/ttyS0\n';
	    // Run tex4ht just once on all tex files
	    commands = commands + 'find . -iname \'*.tex\' -execdir htlatex {} "ximera,charset=utf-8,-css" "" "" "--interaction=nonstopmode -shell-escape" \\; > /dev/ttyS0\n';
	    // Convert the PDF files to SVG files -- no need to do this now because I do it from pdflatex
	    // commands = commands + 'find . -iname \'*.pdf\' -execdir pdf2svg {} {}.svg \\; > /dev/ttyS0\n';
	    // Tidy up the html files
	    commands = commands + 'find . -iname \'*.html\' -execdir tidy -m -asxhtml -utf8 -q -i {} \\; > /dev/ttyS0\n';
	    // Save everything to the block device
	    commands = commands + "tar -cvf /dev/sdc .\n";
	    // Exit
	    commands = commands + "poweroff\n";
	    
	    fs.writeFile(path.resolve( repositoryDirectory, "sandbox.sh" ), commands, function (err,data) {
		callback( err );
	    });
	},

	function (callback) {
	    winston.info( "Making sandbox.sh executable..." );
	    fs.chmod(path.resolve( repositoryDirectory, "sandbox.sh" ), '700', function(err,data) {
		callback(err);
	    });
	},

	function (callback) {
	    winston.info( "Creating temporary tar file..." );
	    temp.open({prefix: "sandbox", suffix: ".tar"}, function(err, info) {
		sandboxTarPath = info.path;
		callback(err);
	    });
	},
	
	function (callback) {
	    winston.info( "Packing tarfile with repository contents..." );

	    var destination = fs.createWriteStream(sandboxTarPath);
	    
	    var packer = tar.Pack({ noProprietary: true })
		.on('error', callback)
		.on('end', function () { callback(null); } );

	    fstream.Reader({ path: repositoryDirectory, type: "Directory" })
		.on('error', callback)
		.pipe(packer)
		.pipe(destination);
	},

	function (callback) {
	    winston.info( "Creating temp overlay file..." );
	    temp.open('overlay', function(err, info) {
		overlayPath = info.path;
		callback( err );
	    });
	},
	
	function( callback ) {
	    winston.info( "Initializing disk overlay with linux image..." );
	    var qemu_img = child_process.spawn( "qemu-img", ['create',
							     '-o','backing_file=' + path.resolve(process.cwd(),'linux','archlinux.raw') + ',backing_fmt=raw',
							     '-f','qcow2',
							     overlayPath] );

	    qemu_img.stdout.on('data', function (data) {
		winston.info('stdout: ' + data);
	    });

	    qemu_img.stderr.on('data', function (data) {
		winston.info('stderr: ' + data);
	    });
	    
	    qemu_img.on('close', function (code) {
		if (code == 0) {
		    callback( null );
		} else {
		    callback( code );
		}
	    });
	},

	function( callback ) {
	    winston.info( "Initializing empty disk..." );
	    
	    temp.open({prefix: "output", suffix: ".tar"}, function(err, info) {
		if (err) {
		    callback( err );
		} else {
		    outputTarPath = info.path;
		    outputTarFd = info.fd;
		    
		    // 50 megabytes of available output space
		    var writeBuffer = new Buffer (1024*1024*50);
		    
		    var bufferPosition = 0,
			bufferLength = writeBuffer.length,
			filePosition = null;
		    
		    fs.write( info.fd,
			      writeBuffer,
			      bufferPosition,
			      bufferLength,
			      filePosition,
			      function (err, written) {
				  if (err) {
				      callback( err, overlayPath, null );
				  } else {
				      fs.fsync(info.fd, function(err) {
					  outputTarSlicer = fdSlicer.createFromFd(info.fd);
					  callback( err );
				      });
				  }
			      });
		}
	    });
	},
	
	function( callback ) {
	    winston.info( "Running LaTeX inside sandbox..." );
	    
	    var qemu = child_process.spawn( "qemu-system-x86_64", ['-enable-kvm',
								   '-cpu','host',
								   '-m','256',
								   '-hda', overlayPath,
								   '-hdb', sandboxTarPath,
								   '-hdc', outputTarPath,
								   '-kernel',"linux/vmlinuz-linux",
								   "-initrd","linux/initramfs-linux.img",
								   "-append",'console=ttyS0 root=/dev/sda',
								   "-nographic"
								  ]);

	    // Look at each line of output---although sometimes line are split when they are fed to stdout.on
	    var remainder = "";
	    var qemuLog = [];
	    var qemuError = null;

	    var lastOutputTime = process.hrtime();
	    
	    qemu.stdout.on('data', function (data) {
		var lines = (remainder + data).split( "\n" );
		remainder = lines.pop();

		lines.forEach( function(line) {
		    qemuLog.push( line );
		    console.log( line );

		    if (line.match("Failed to start Sandbox Service.")) {
			qemuError = "Failed to start Sandbox Service.";
			qemu.kill();
		    }
		});

		lastOutputTime = process.hrtime();
	    });

	    // Every second, see if we have gone a while without seeing any output from the sandboxed process
	    var watchdog = setInterval( function() {
		var secondsSinceLastOutput = process.hrtime(lastOutputTime)[0];

		// If so, kill the sandbox.
		if (secondsSinceLastOutput > 10) {
		    qemuError = "Too many seconds passed without output.";
		    qemu.kill();
		}
	    }, 1000 );
	    

	    qemu.on('close', function (code) {
		clearInterval( watchdog );
		callback( qemuError );
	    });
	},

	function (callback) {
	    winston.info( "fsync the output file descriptor" );
	    fs.fsync(outputTarFd, function(err) {	    
		callback(err);
	    });
	},
	
	function (callback) {
	    winston.info( "Saving git blobs and trees..." );
	    
	    processMatchingFiles(outputTarSlicer.createReadStream(), new RegExp("\\.(tex|js|css)$", "g"),
				 function( path, text, callback ) {
				     winston.info( "Saving " + path + "..." );
				     headCommit.getEntry(path).then(function(entry) {
					 async.parallel(
					     [
						 function(callback) {
						     var gitFile = new mdb.GitFile({
							 hash: entry.sha(),
							 commit: headCommit.sha(),
							 path: path
						     });
						     
						     gitFile.save(callback);
						 },
						 
						 function(callback) {
						     var blob = new mdb.Blob({
							 hash: entry.sha(),
							 data: text
						     });
						     
						     blob.save(callback);
						 },
					     ], callback );
				     });
				 }, callback);
	},

	function (callback) {
	    winston.info( "Saving log files..." );
	    
	    processMatchingFiles(outputTarSlicer.createReadStream(), "log",
				 function( path, text, callback ) {
				     var texpath = path.replace( /.log$/, ".tex" );
				     // Get the associated SHA's and...
				     headCommit.getEntry(texpath).then(function(entry) {
					 // Save the log to the database
					 var compileLog = new mdb.CompileLog({
					     hash: entry.sha(),
					     commit: headCommit.sha(),
					     log: text
					 });
					 
					 var errorList = [];
					 
					 var errorRegexp = /^! (.*)\nl\.([0-9]+) /g;
					 var match = errorRegexp.exec(text);
					 while (match != null) {
					     errorList.push( { error: match[1], line: match[2], file: texpath } );
					     match = errorRegexp.exec(text);
					 }
					 
					 compileLog.errorList = errorList;
					 compileLog.save(callback);
				     });
				 }, callback);
	},	

	function (callback) {
	    winston.info("Saving HTML files...");
	    
	    processMatchingFiles(outputTarSlicer.createReadStream(), "html",
				 function( path, text, callback ) {
				     // Get the title from the filename, or the <title> tag if there is one
				     var title = basename(path).replace(".html", "");
				     var re = /(<\s*title[^>]*>(.+?)<\s*\/\s*title)>/gi;
				     var match = re.exec(text);
				     if (match && match[2]) {
					 title = match[2];
				     }

				     // BADBAD: extract everything between body tags
				     text = text.toString().replace(/[\s\S]*<body>/ig,'').replace(/<\/body>[\s\S]*/ig,'');
				     
				     saveToContentAddressableFilesystem( text, function(err, hash) {
					 var activity = new mdb.Activity();
					 
					 // Save the HTML file to the database as an activity
					 activity.commit = headCommit.sha();
					 activity.hash = hash;
					 activity.path = path.replace( /.html$/, "" );
                                         activity.title = title;
					 
					 activity.save(callback);
				     });
				 }, callback);
	},	
	
	function (callback) {
	    winston.info("Saving images...");
	    processMatchingFiles(outputTarSlicer.createReadStream(), new RegExp("\\.(pdf|svg|jpg|png)$", "g"),
				 function( path, text, callback ) {
				     saveToContentAddressableFilesystem( text, function(err, hash) {
					 var gitFile = new mdb.GitFile();
					 gitFile.commit = headCommit.sha();
					 gitFile.path = path;
					 gitFile.hash = hash;
					 gitFile.save(callback);
				     });
				 }, callback);
	},

	function (callback) {
	    winston.info("Closing outputTarFd...");
	    fs.close( outputTarFd, function(err) {
		callback(err);
	    });
	},
	
	function (callback) {
	    winston.info("Cleaning up temporary files...");
	    temp.cleanup(function(err, stats) {
		winston.info("Cleaned up " + stats.files + " temp files");
		callback(err);
	    });
	},
	
	function (callback) {
	    console.log( "All done." );
	    callback( null );
	},
	
    ], function (err, result) {
	console.log( "Done." );
	
	// This needs to post an appropriate error as a GitHub status, with a link to a Ximera page which details all the errors
        if (err) {
	    winston.error(JSON.stringify(err));
	    winston.error(err.toString('utf-8'));
	    console.log( "err!" );
	    //mdb.GitRepo.update( repo, {$set: { feedback : err.toString('utf-8') }}, {}, function( err, document ) {} );

        } else {
	    winston.info("Success.");
	}
	
	callback( err, null );
    });
}

/** @function updateGithubStatus
    Post a commit status associated with the push data from the webhook.
    @param {object} push The data sent from the Ximera server through the Github webhook
    @param {string} state Either "pending" or "success" or "failure" or "error"
    @param {string} description Some text to associate with the commit status
*/
function updateGithubStatus( push, state, description, callback ) {
    var senderAccessToken = push.senderAccessToken;    
    var repository = push.repository;
    var headCommit = push.headCommit;
    if (headCommit == undefined)
	return;
    
    var github = new githubApi({version: "3.0.0"});

    if (!senderAccessToken)
	return;
    
    github.authenticate({
	type: "oauth",
	token: senderAccessToken
    });    

    github.statuses.create( {
	user: repository.owner.name,
	repo: repository.name,
	sha: headCommit.id,
	state: state,
	target_url: XIMERA_URL + headCommit.id,
	description: description
    }, function( err, response ) {
	if (err) 
	    winston.error( "GitHub commit status creation error: " + err );
	
	winston.info( "GitHub commit status creation response: " + JSON.stringify(response) );

	callback(err, null);
    });

    return;
}

/** @function onPush
    Process the webhook push event
*/
function onPush( push )
{
    async.series(
	[
	    function(callback){
		winston.info(" Testing for push event... ");
		
		console.log( JSON.stringify(push) );
		
		if (push.finishedProcessing == true)
		    callback("Already processed the push event");
		else
		    callback(null);
		
		return;
	    },
	    
	    function(callback){
		winston.info("Saving branch information...");

		var branch = new mdb.Branch();
		branch.repository = push.repository.name;
		branch.owner = push.repository.owner.name;

		if (push.ref)
		    branch.name = push.ref.replace( /^refs\/heads\//, '' );

		if (push.headCommit)
		    branch.commit = push.headCommit.id;

		branch.lastUpdate = new Date(); // Could also be using push.repository.updated_at?
		branch.save(callback);
	    },
	    
	    function(callback){
		updateGithubStatus( push, "pending", "Compiling Ximera files...", callback );
	    },
	    
	    function(callback){
		// do some more stuff ...
		//callback(null, 'two');
		//console.log( JSON.stringify( message ) );
		//winston.info( "Updating or creating " + message );
		//var githubIdentifier = message.repository.full_name;
		try {
		    updateRepo( push.repository.full_name, push.headCommit.id, callback );
		}
		catch (err) {
		    callback( err, null );
		}
	    },
	],
	
	function(err, results){
	    if (err)
		updateGithubStatus( push, "failure", "Ximera failed: " + err, function() {} );
	    else
		updateGithubStatus( push, "success", "Ximera successfully built content", function() {} );

	    push.finishedProcessing = true;
	    
	    push.save(function(err) {
		winston.info( "Finished processing commit SHA " + push.headCommit.id );
	    });	    
	}
    );
}

////////////////////////////////////////////////////////////////
mdb.initialize(function(error) {
    winston.info( "Listening for work." );

    // GitPushes is a capped collection which includes data from the GitHub push webhook
    var stream = mdb.GitPushes.find({finishedProcessing: false}).tailable({awaitdata:true, numberOfRetries: Number.MAX_VALUE}).stream();

    stream.on('data', function(push) {
	console.log( JSON.stringify(push) );
	onPush( push );
    });
});
