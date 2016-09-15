/*
 * Copyright (c) 2014
 *
 * This file is licensed under the Affero General Public License version 3
 * or later.
 *
 * See the COPYING-README file.
 *
 */

/**
 * The file upload code uses several hooks to interact with blueimps jQuery file upload library:
 * 1. the core upload handling hooks are added when initializing the plugin,
 * 2. if the browser supports progress events they are added in a separate set after the initialization
 * 3. every app can add it's own triggers for fileupload
 *    - files adds d'n'd handlers and also reacts to done events to add new rows to the filelist
 *    - TODO pictures upload button
 *    - TODO music upload button
 */

/* global jQuery, humanFileSize, md5 */

/**
 * File upload object
 *
 * @class OC.FileUpload
 * @classdesc
 *
 * Represents a file upload
 *
 * @param {OC.Uploader} uploader uploader
 * @param {Object} data blueimp data
 */
OC.FileUpload = function(uploader, data) {
	this.uploader = uploader;
	this.data = data;
	var path = '';
	if (this.uploader.fileList) {
		path = OC.joinPaths(this.uploader.fileList.getCurrentDirectory(), this.getFile().name);
	} else {
		path = this.getFile().name;
	}
	this.id = 'web-file-upload-' + md5(path) + '-' + (new Date()).getTime();
};
OC.FileUpload.CONFLICT_MODE_DETECT = 0;
OC.FileUpload.CONFLICT_MODE_OVERWRITE = 1;
OC.FileUpload.CONFLICT_MODE_AUTORENAME = 2;
OC.FileUpload.prototype = {

	/**
	 * Unique upload id
	 *
	 * @type string
	 */
	id: null,

	/**
	 * Upload element
	 *
	 * @type Object
	 */
	$uploadEl: null,

	/**
	 * Target folder
	 *
	 * @type string
	 */
	_targetFolder: '',

	/**
	 * @type int
	 */
	_conflictMode: OC.FileUpload.CONFLICT_MODE_DETECT,

	/**
	 * New name from server after autorename
	 *
	 * @type String
	 */
	_newName: null,

	/**
	 * Returns the unique upload id
	 *
	 * @return string
	 */
	getId: function() {
		return this.id;
	},

	/**
	 * Returns the file to be uploaded
	 *
	 * @return {File} file
	 */
	getFile: function() {
		return this.data.files[0];
	},

	/**
	 * Return the final filename.
	 * Either this is the original file name or the file name
	 * after an autorename.
	 *
	 * @return {String} file name
	 */
	getFileName: function() {
		// in case of autorename
		if (this._newName) {
			return this._newName;
		}

		if (this._conflictMode === OC.FileUpload.CONFLICT_MODE_AUTORENAME) {

			var locationUrl = this.getResponseHeader('Content-Location');
			if (locationUrl) {
				this._newName = decodeURIComponent(OC.basename(locationUrl));
				return this._newName;
			}
		}

		return this.getFile().name;
	},

	setTargetFolder: function(targetFolder) {
		this._targetFolder = targetFolder;
	},

	getTargetFolder: function() {
		return this._targetFolder;
	},

	/**
	 * Get full path for the target file, including relative path,
	 * without the file name.
	 *
	 * @return {String} full path
	 */
	getFullPath: function() {
		return OC.joinPaths(this._targetFolder, this.getFile().relativePath || '');
	},

	/**
	 * Set conflict resolution mode.
	 * See CONFLICT_MODE_* constants.
	 */
	setConflictMode: function(mode) {
		this._conflictMode = mode;
	},

	/**
	 * Returns whether the upload is in progress
	 *
	 * @return {bool}
	 */
	isPending: function() {
		return this.data.state() === 'pending';
	},

	deleteUpload: function() {
		delete this.data.jqXHR;
	},

	/**
	 * Submit the upload
	 */
	submit: function() {
		var self = this;
		var data = this.data;
		var file = this.getFile();

		// it was a folder upload, so make sure the parent directory exists alrady
		var folderPromise;
		if (file.relativePath) {
			folderPromise = this.uploader.ensureFolderExists(this.getFullPath());
		} else {
			folderPromise = $.Deferred().resolve().promise();
		}

		if (this.uploader.fileList) {
			this.data.url = this.uploader.fileList.getUploadUrl(file.name, this.getFullPath());
		}

		if (!this.data.headers) {
			this.data.headers = {};
		}

		// webdav without multipart
		this.data.multipart = false;
		this.data.type = 'PUT';

		delete this.data.headers['If-None-Match'];
		if (this._conflictMode === OC.FileUpload.CONFLICT_MODE_DETECT) {
			this.data.headers['If-None-Match'] = '*';
		} else if (this._conflictMode === OC.FileUpload.CONFLICT_MODE_AUTORENAME) {
			// POST to parent folder, with slug
			this.data.type = 'POST';
			this.data.url = this.uploader.fileList.getUploadUrl('&' + file.name, this.getFullPath());
		}

		if (file.lastModified) {
			// preserve timestamp
			this.data.headers['X-OC-Mtime'] = file.lastModified / 1000;
		}

		var userName = this.uploader.filesClient.getUserName();
		var password = this.uploader.filesClient.getPassword();
		if (userName) {
			// copy username/password from DAV client
			this.data.headers['Authorization'] =
				'Basic ' + btoa(userName + ':' + (password || ''));
		}

		if (!this.uploader.isXHRUpload()) {
			data.formData = [];

			// pass headers as parameters
			data.formData.push({name: 'headers', value: JSON.stringify(this.data.headers)});
			data.formData.push({name: 'requesttoken', value: OC.requestToken});
			if (data.type === 'POST') {
				// still add the method to the URL
				data.url += '?_method=POST';
			}
		}

		var chunkFolderPromise;
		if ($.support.blobSlice
			&& this.uploader.fileUploadParam.maxChunkSize
			&& this.getFile().size > this.uploader.fileUploadParam.maxChunkSize
		) {
			data.isChunked = true;
			chunkFolderPromise = this.uploader.filesClient.createDirectory(
				'uploads/' + encodeURIComponent(OC.getCurrentUser().uid) + '/' + encodeURIComponent(this.getId())
			);
			// TODO: if fails, it means same id already existed, need to retry
		} else {
			chunkFolderPromise = $.Deferred().resolve().promise();
		}

		// wait for creation of the required directory before uploading
		$.when(folderPromise, chunkFolderPromise).then(function() {
			data.submit();
		}, function() {
			self.abort();
		});

	},

	/**
	 * Process end of transfer
	 */
	done: function() {
		if (!this.data.isChunked) {
			return $.Deferred().resolve().promise();
		}

		var uid = OC.getCurrentUser().uid;
		return this.uploader.filesClient.move(
			'uploads/' + encodeURIComponent(uid) + '/' + encodeURIComponent(this.getId()) + '/.file',
			'files/' + encodeURIComponent(uid) + '/' + OC.joinPaths(this.getFullPath(), this.getFileName())
		);
	},

	/**
	 * Abort the upload
	 */
	abort: function() {
		if (this.data.isChunked) {
			// delete transfer directory for this upload
			this.uploader.filesClient.remove(
				'uploads/' + encodeURIComponent(OC.getCurrentUser().uid) + '/' + encodeURIComponent(this.getId())
			);
		}
		this.data.abort();
	},

	/**
	 * Returns the server response
	 *
	 * @return {Object} response
	 */
	getResponse: function() {
		var response = this.data.response();
		if (typeof response.result !== 'string') {
			//fetch response from iframe
			response = $.parseJSON(response.result[0].body.innerText);
			if (!response) {
				// likely due to internal server error
				response = {status: 500};
			}
		} else {
			response = response.result;
		}
		return response;
	},

	/**
	 * Returns the status code from the response
	 *
	 * @return {int} status code
	 */
	getResponseStatus: function() {
		if (this.uploader.isXHRUpload()) {
			var xhr = this.data.response().jqXHR;
			if (xhr) {
				return xhr.status;
			}
			return null;
		}
		return this.getResponse().status;
	},

	/**
	 * Returns the response header by name
	 *
	 * @param {String} headerName header name
	 * @return {Array|String} response header value(s)
	 */
	getResponseHeader: function(headerName) {
		headerName = headerName.toLowerCase();
		if (this.uploader.isXHRUpload()) {
			return this.data.response().jqXHR.getResponseHeader(headerName);
		}

		var headers = this.getResponse().headers;
		if (!headers) {
			return null;
		}

		var value =  _.find(headers, function(value, key) {
			return key.toLowerCase() === headerName;
		});
		if (_.isArray(value) && value.length === 1) {
			return value[0];
		}
		return value;
	}
};

/**
 * keeps track of uploads in progress and implements callbacks for the conflicts dialog
 * @namespace
 */

OC.Uploader = function() {
	this.init.apply(this, arguments);
};

OC.Uploader.prototype = _.extend({
	/**
	 * @type Array<OC.FileUpload>
	 */
	_uploads: {},

	/**
	 * List of directories known to exist.
	 *
	 * Key is the fullpath and value is boolean, true meaning that the directory
	 * was already created so no need to create it again.
	 */
	_knownDirs: {},

	/**
	 * @type OCA.Files.FileList
	 */
	fileList: null,

	/**
	 * @type OC.Files.Client
	 */
	filesClient: null,

	/**
	 * Function that will allow us to know if Ajax uploads are supported
	 * @link https://github.com/New-Bamboo/example-ajax-upload/blob/master/public/index.html
	 * also see article @link http://blog.new-bamboo.co.uk/2012/01/10/ridiculously-simple-ajax-uploads-with-formdata
	 */
	_supportAjaxUploadWithProgress: function() {
		if (window.TESTING) {
			return true;
		}
		return supportFileAPI() && supportAjaxUploadProgressEvents() && supportFormData();

		// Is the File API supported?
		function supportFileAPI() {
			var fi = document.createElement('INPUT');
			fi.type = 'file';
			return 'files' in fi;
		}

		// Are progress events supported?
		function supportAjaxUploadProgressEvents() {
			var xhr = new XMLHttpRequest();
			return !! (xhr && ('upload' in xhr) && ('onprogress' in xhr.upload));
		}

		// Is FormData supported?
		function supportFormData() {
			return !! window.FormData;
		}
	},

	/**
	 * Returns whether an XHR upload will be used
	 *
	 * @return {bool} true if XHR upload will be used,
	 * false for iframe upload
	 */
	isXHRUpload: function () {
		return !this.fileUploadParam.forceIframeTransport &&
			((!this.fileUploadParam.multipart && $.support.xhrFileUpload) ||
			$.support.xhrFormDataFileUpload);
	},

	/**
	 * Makes sure that the upload folder and its parents exists
	 *
	 * @param {String} fullPath full path
	 * @return {Promise} promise that resolves when all parent folders
	 * were created
	 */
	ensureFolderExists: function(fullPath) {
		if (!fullPath || fullPath === '/') {
			return $.Deferred().resolve().promise();
		}

		// remove trailing slash
		if (fullPath.charAt(fullPath.length - 1) === '/') {
			fullPath = fullPath.substr(0, fullPath.length - 1);
		}

		var self = this;
		var promise = this._knownDirs[fullPath];

		if (this.fileList) {
			// assume the current folder exists
			this._knownDirs[this.fileList.getCurrentDirectory()] = $.Deferred().resolve().promise();
		}

		if (!promise) {
			var deferred = new $.Deferred();
			promise = deferred.promise();
			this._knownDirs[fullPath] = promise;

			// make sure all parents already exist
			var parentPath = OC.dirname(fullPath);
			var parentPromise = this._knownDirs[parentPath];
			if (!parentPromise) {
				parentPromise = this.ensureFolderExists(parentPath);
			}

			parentPromise.then(function() {
				self.filesClient.createDirectory(fullPath).always(function(status) {
					// 405 is expected if the folder already exists
					if ((status >= 200 && status < 300) || status === 405) {
						self.trigger('createdfolder', fullPath);
						deferred.resolve();
						return;
					}
					OC.Notification.showTemporary(t('files', 'Could not create folder "{dir}"', {dir: fullPath}));
					deferred.reject();
				});
			}, function() {
				deferred.reject();
			});
		}

		return promise;
	},

	/**
	 * Submit the given uploads
	 *
	 * @param {Array} array of uploads to start
	 */
	submitUploads: function(uploads) {
		var self = this;
		_.each(uploads, function(upload) {
			self._uploads[upload.data.uploadId] = upload;
			upload.submit();
		});
	},

	/**
	 * Show conflict for the given file object
	 *
	 * @param {OC.FileUpload} file upload object
	 */
	showConflict: function(fileUpload) {
		//show "file already exists" dialog
		var self = this;
		var file = fileUpload.getFile();
		// retrieve more info about this file
		this.filesClient.getFileInfo(fileUpload.getFullPath()).then(function(status, fileInfo) {
			var original = fileInfo;
			var replacement = file;
			OC.dialogs.fileexists(fileUpload, original, replacement, self);
		});
	},
	/**
	 * cancels all uploads
	 */
	cancelUploads:function() {
		this.log('canceling uploads');
		jQuery.each(this._uploads, function(i, upload) {
			upload.abort();
		});
		this.clear();
	},
	/**
	 * Clear uploads
	 */
	clear: function() {
		this._uploads = {};
		this._knownDirs = {};
	},
	/**
	 * Returns an upload by id
	 *
	 * @param {int} data uploadId
	 * @return {OC.FileUpload} file upload
	 */
	getUpload: function(data) {
		if (_.isString(data)) {
			return this._uploads[data];
		} else if (data.uploadId) {
			return this._uploads[data.uploadId];
		}
		return null;
	},

	showUploadCancelMessage: _.debounce(function() {
		OC.Notification.showTemporary(t('files', 'Upload cancelled.'), {timeout: 10});
	}, 500),
	/**
	 * Checks the currently known uploads.
	 * returns true if any hxr has the state 'pending'
	 * @returns {boolean}
	 */
	isProcessing:function() {
		var count = 0;

		jQuery.each(this._uploads, function(i, upload) {
			if (upload.isPending()) {
				count++;
			}
		});
		return count > 0;
	},
	/**
	 * callback for the conflicts dialog
	 */
	onCancel:function() {
		this.cancelUploads();
	},
	/**
	 * callback for the conflicts dialog
	 * calls onSkip, onReplace or onAutorename for each conflict
	 * @param {object} conflicts - list of conflict elements
	 */
	onContinue:function(conflicts) {
		var self = this;
		//iterate over all conflicts
		jQuery.each(conflicts, function (i, conflict) {
			conflict = $(conflict);
			var keepOriginal = conflict.find('.original input[type="checkbox"]:checked').length === 1;
			var keepReplacement = conflict.find('.replacement input[type="checkbox"]:checked').length === 1;
			if (keepOriginal && keepReplacement) {
				// when both selected -> autorename
				self.onAutorename(conflict.data('data'));
			} else if (keepReplacement) {
				// when only replacement selected -> overwrite
				self.onReplace(conflict.data('data'));
			} else {
				// when only original seleted -> skip
				// when none selected -> skip
				self.onSkip(conflict.data('data'));
			}
		});
	},
	/**
	 * handle skipping an upload
	 * @param {OC.FileUpload} upload
	 */
	onSkip:function(upload) {
		this.log('skip', null, upload);
		upload.deleteUpload();
	},
	/**
	 * handle replacing a file on the server with an uploaded file
	 * @param {FileUpload} data
	 */
	onReplace:function(upload) {
		this.log('replace', null, upload);
		upload.setConflictMode(OC.FileUpload.CONFLICT_MODE_OVERWRITE);
		this.submitUploads([upload]);
	},
	/**
	 * handle uploading a file and letting the server decide a new name
	 * @param {object} upload
	 */
	onAutorename:function(upload) {
		this.log('autorename', null, upload);
		upload.setConflictMode(OC.FileUpload.CONFLICT_MODE_AUTORENAME);
		this.submitUploads([upload]);
	},
	_trace:false, //TODO implement log handler for JS per class?
	log:function(caption, e, data) {
		if (this._trace) {
			console.log(caption);
			console.log(data);
		}
	},
	/**
	 * checks the list of existing files prior to uploading and shows a simple dialog to choose
	 * skip all, replace all or choose which files to keep
	 *
	 * @param {array} selection of files to upload
	 * @param {object} callbacks - object with several callback methods
	 * @param {function} callbacks.onNoConflicts
	 * @param {function} callbacks.onSkipConflicts
	 * @param {function} callbacks.onReplaceConflicts
	 * @param {function} callbacks.onChooseConflicts
	 * @param {function} callbacks.onCancel
	 */
	checkExistingFiles: function (selection, callbacks) {
		var fileList = this.fileList;
		var conflicts = [];
		// only keep non-conflicting uploads
		selection.uploads = _.filter(selection.uploads, function(upload) {
			var file = upload.getFile();
			if (file.relativePath) {
				// can't check in subfolder contents
				return true;
			}
			if (!fileList) {
				// no list to check against
				return true;
			}
			var fileInfo = fileList.findFile(file.name);
			if (fileInfo) {
				conflicts.push([
					// original
					_.extend(fileInfo, {
						directory: fileInfo.directory || fileInfo.path || fileList.getCurrentDirectory()
					}),
					// replacement (File object)
					upload
				]);
				return false;
			}
			return true;
		});
		if (conflicts.length) {
			// wait for template loading
			OC.dialogs.fileexists(null, null, null, this).done(function() {
				_.each(conflicts, function(conflictData) {
					OC.dialogs.fileexists(conflictData[1], conflictData[0], conflictData[1].getFile(), this);
				});
			});
		}

		// upload non-conflicting files
		// note: when reaching the server they might still meet conflicts
		// if the folder was concurrently modified, these will get added
		// to the already visible dialog, if applicable
		callbacks.onNoConflicts(selection);
	},

	_hideProgressBar: function() {
		var self = this;
		$('#uploadprogresswrapper .stop').fadeOut();
		$('#uploadprogressbar').fadeOut(function() {
			self.$uploadEl.trigger(new $.Event('resized'));
		});
	},

	_showProgressBar: function() {
		$('#uploadprogressbar').fadeIn();
		this.$uploadEl.trigger(new $.Event('resized'));
	},

	/**
	 * Returns whether the given file is known to be a received shared file
	 *
	 * @param {Object} file file
	 * @return {bool} true if the file is a shared file
	 */
	_isReceivedSharedFile: function(file) {
		if (!window.FileList) {
			return false;
		}
		var $tr = window.FileList.findFileEl(file.name);
		if (!$tr.length) {
			return false;
		}

		return ($tr.attr('data-mounttype') === 'shared-root' && $tr.attr('data-mime') !== 'httpd/unix-directory');
	},

	/**
	 * Initialize the upload object
	 *
	 * @param {Object} $uploadEl upload element
	 * @param {Object} options
	 * @param {OCA.Files.FileList} [options.fileList] file list object
	 * @param {OC.Files.Client} [options.filesClient] files client object
	 * @param {Object} [options.dropZone] drop zone for drag and drop upload
	 */
	init: function($uploadEl, options) {
		var self = this;
		options = options || {};

		this.fileList = options.fileList;
		this.filesClient = options.filesClient || OC.Files.getClient();

		$uploadEl = $($uploadEl);
		this.$uploadEl = $uploadEl;

		if ($uploadEl.exists()) {
			$('#uploadprogresswrapper .stop').on('click', function() {
				self.cancelUploads();
			});

			this.fileUploadParam = {
				type: 'PUT',
				dropZone: options.dropZone, // restrict dropZone to content div
				autoUpload: false,
				sequentialUploads: true,
				//singleFileUploads is on by default, so the data.files array will always have length 1
				/**
				 * on first add of every selection
				 * - check all files of originalFiles array with files in dir
				 * - on conflict show dialog
				 *   - skip all -> remember as single skip action for all conflicting files
				 *   - replace all -> remember as single replace action for all conflicting files
				 *   - choose -> show choose dialog
				 *     - mark files to keep
				 *       - when only existing -> remember as single skip action
				 *       - when only new -> remember as single replace action
				 *       - when both -> remember as single autorename action
				 * - start uploading selection
				 * @param {object} e
				 * @param {object} data
				 * @returns {boolean}
				 */
				add: function(e, data) {
					self.log('add', e, data);
					var that = $(this), freeSpace;

					var upload = new OC.FileUpload(self, data);
					// can't link directly due to jQuery not liking cyclic deps on its ajax object
					data.uploadId = upload.getId();

					// we need to collect all data upload objects before
					// starting the upload so we can check their existence
					// and set individual conflict actions. Unfortunately,
					// there is only one variable that we can use to identify
					// the selection a data upload is part of, so we have to
					// collect them in data.originalFiles turning
					// singleFileUploads off is not an option because we want
					// to gracefully handle server errors like 'already exists'

					// create a container where we can store the data objects
					if ( ! data.originalFiles.selection ) {
						// initialize selection and remember number of files to upload
						data.originalFiles.selection = {
							uploads: [],
							filesToUpload: data.originalFiles.length,
							totalBytes: 0,
							biggestFileBytes: 0
						};
					}
					// TODO: move originalFiles to a separate container, maybe inside OC.Upload
					var selection = data.originalFiles.selection;

					// add uploads
					if ( selection.uploads.length < selection.filesToUpload ) {
						// remember upload
						selection.uploads.push(upload);
					}

					//examine file
					var file = upload.getFile();
					try {
						// FIXME: not so elegant... need to refactor that method to return a value
						Files.isFileNameValid(file.name);
					}
					catch (errorMessage) {
						data.textStatus = 'invalidcharacters';
						data.errorThrown = errorMessage;
					}

					if (data.targetDir) {
						upload.setTargetFolder(data.targetDir);
						delete data.targetDir;
					}

					// in case folder drag and drop is not supported file will point to a directory
					// http://stackoverflow.com/a/20448357
					if ( ! file.type && file.size % 4096 === 0 && file.size <= 102400) {
						var dirUploadFailure = false;
						try {
							var reader = new FileReader();
							reader.readAsBinaryString(file);
						} catch (NS_ERROR_FILE_ACCESS_DENIED) {
							//file is a directory
							dirUploadFailure = true;
						}

						if (dirUploadFailure) {
							data.textStatus = 'dirorzero';
							data.errorThrown = t('files',
								'Unable to upload {filename} as it is a directory or has 0 bytes',
								{filename: file.name}
							);
						}
					}

					// only count if we're not overwriting an existing shared file
					if (self._isReceivedSharedFile(file)) {
						file.isReceivedShare = true;
					} else {
						// add size
						selection.totalBytes += file.size;
						// update size of biggest file
						selection.biggestFileBytes = Math.max(selection.biggestFileBytes, file.size);
					}

					// check PHP upload limit against biggest file
					if (selection.biggestFileBytes > $('#upload_limit').val()) {
						data.textStatus = 'sizeexceedlimit';
						data.errorThrown = t('files',
							'Total file size {size1} exceeds upload limit {size2}', {
							'size1': humanFileSize(selection.biggestFileBytes),
							'size2': humanFileSize($('#upload_limit').val())
						});
					}

					// check free space
					freeSpace = $('#free_space').val();
					if (freeSpace >= 0 && selection.totalBytes > freeSpace) {
						data.textStatus = 'notenoughspace';
						data.errorThrown = t('files',
							'Not enough free space, you are uploading {size1} but only {size2} is left', {
							'size1': humanFileSize(selection.totalBytes),
							'size2': humanFileSize($('#free_space').val())
						});
					}

					// end upload for whole selection on error
					if (data.errorThrown) {
						// trigger fileupload fail handler
						var fu = that.data('blueimp-fileupload') || that.data('fileupload');
						fu._trigger('fail', e, data);
						return false; //don't upload anything
					}

					// check existing files when all is collected
					if ( selection.uploads.length >= selection.filesToUpload ) {

						//remove our selection hack:
						delete data.originalFiles.selection;

						var callbacks = {

							onNoConflicts: function (selection) {
								self.submitUploads(selection.uploads);
							},
							onSkipConflicts: function (selection) {
								//TODO mark conflicting files as toskip
							},
							onReplaceConflicts: function (selection) {
								//TODO mark conflicting files as toreplace
							},
							onChooseConflicts: function (selection) {
								//TODO mark conflicting files as chosen
							},
							onCancel: function (selection) {
								$.each(selection.uploads, function(i, upload) {
									upload.abort();
								});
							}
						};

						self.checkExistingFiles(selection, callbacks);

					}

					return true; // continue adding files
				},
				/**
				 * called after the first add, does NOT have the data param
				 * @param {object} e
				 */
				start: function(e) {
					self.log('start', e, null);
					//hide the tooltip otherwise it covers the progress bar
					$('#upload').tipsy('hide');
				},
				fail: function(e, data) {
					var upload = self.getUpload(data);
					var status = null;
					if (upload) {
						status = upload.getResponseStatus();
					}
					self.log('fail', e, upload);

					if (data.textStatus === 'abort') {
						self.showUploadCancelMessage();
					} else if (status === 412) {
						// file already exists
						self.showConflict(upload);
					} else if (status === 404) {
						// target folder does not exist any more
						OC.Notification.showTemporary(
							t('files', 'Target folder "{dir}" does not exist any more', {dir: upload.getFullPath()})
						);
						self.cancelUploads();
					} else if (status === 507) {
						// not enough space
						OC.Notification.showTemporary(
							t('files', 'Not enough free space')
						);
						self.cancelUploads();
					} else {
						// HTTP connection problem or other error
						OC.Notification.showTemporary(data.errorThrown, {timeout: 10});
					}

					if (upload) {
						upload.deleteUpload();
					}
				},
				/**
				 * called for every successful upload
				 * @param {object} e
				 * @param {object} data
				 */
				done:function(e, data) {
					var upload = self.getUpload(data);
					var that = $(this);
					self.log('done', e, upload);

					var status = upload.getResponseStatus();
					if (status < 200 || status >= 300) {
						// trigger fail handler
						var fu = that.data('blueimp-fileupload') || that.data('fileupload');
						fu._trigger('fail', e, data);
						return;
					}
				},
				/**
				 * called after last upload
				 * @param {object} e
				 * @param {object} data
				 */
				stop: function(e, data) {
					self.log('stop', e, data);
				}
			};

			// initialize jquery fileupload (blueimp)
			var fileupload = this.$uploadEl.fileupload(this.fileUploadParam);

			if (this._supportAjaxUploadWithProgress()) {
				//remaining time
				var lastUpdate = new Date().getMilliseconds();
				var lastSize = 0;
				var bufferSize = 20;
				var buffer = [];
				var bufferIndex = 0;
				var bufferTotal = 0;
				for(var i = 0; i < bufferSize;i++){
					buffer[i] = 0;
				}

				// add progress handlers
				fileupload.on('fileuploadadd', function(e, data) {
					self.log('progress handle fileuploadadd', e, data);
					self.trigger('add', e, data);
				});
				// add progress handlers
				fileupload.on('fileuploadstart', function(e, data) {
					self.log('progress handle fileuploadstart', e, data);
					$('#uploadprogresswrapper .stop').show();
					$('#uploadprogresswrapper .label').show();
					$('#uploadprogressbar').progressbar({value: 0});
					$('#uploadprogressbar .ui-progressbar-value').
						html('<em class="label inner"><span class="desktop">'
							+ t('files', 'Uploading...')
							+ '</span><span class="mobile">'
							+ t('files', '...')
							+ '</span></em>');
                    $('#uploadprogressbar').tipsy({gravity:'n', fade:true, live:true});
					self._showProgressBar();
					self.trigger('start', e, data);
				});
				fileupload.on('fileuploadprogress', function(e, data) {
					self.log('progress handle fileuploadprogress', e, data);
					//TODO progressbar in row
					self.trigger('progress', e, data);
				});
				fileupload.on('fileuploadprogressall', function(e, data) {
					self.log('progress handle fileuploadprogressall', e, data);
					var progress = (data.loaded / data.total) * 100;
					var thisUpdate = new Date().getMilliseconds();
					var diffUpdate = (thisUpdate - lastUpdate)/1000; // eg. 2s
					lastUpdate = thisUpdate;
					var diffSize = data.loaded - lastSize;
					lastSize = data.loaded;
					diffSize = diffSize / diffUpdate; // apply timing factor, eg. 1mb/2s = 0.5mb/s
					var remainingSeconds = ((data.total - data.loaded) / diffSize);
					if(remainingSeconds >= 0) {
						bufferTotal = bufferTotal - (buffer[bufferIndex]) + remainingSeconds;
						buffer[bufferIndex] = remainingSeconds; //buffer to make it smoother
						bufferIndex = (bufferIndex + 1) % bufferSize;
					}
					var smoothRemainingSeconds = (bufferTotal / bufferSize); //seconds
					var date = new Date(smoothRemainingSeconds * 1000);
					var timeStringDesktop = "";
					var timeStringMobile = "";
					if(date.getUTCHours() > 0){
						timeStringDesktop = t('files', '{hours}:{minutes}:{seconds} hour{plural_s} left' , {
							hours:date.getUTCHours(),
							minutes: ('0' + date.getUTCMinutes()).slice(-2),
							seconds: ('0' + date.getUTCSeconds()).slice(-2),
							plural_s: ( smoothRemainingSeconds === 3600  ? "": "s") // 1 hour = 1*60m*60s = 3600s
						});
						timeStringMobile = t('files', '{hours}:{minutes}h' , {
							hours:date.getUTCHours(),
							minutes: ('0' + date.getUTCMinutes()).slice(-2),
							seconds: ('0' + date.getUTCSeconds()).slice(-2)
						});
					} else if(date.getUTCMinutes() > 0){
						timeStringDesktop = t('files', '{minutes}:{seconds} minute{plural_s} left' , {
							minutes: date.getUTCMinutes(),
							seconds: ('0' + date.getUTCSeconds()).slice(-2),
							plural_s: (smoothRemainingSeconds === 60 ? "": "s") // 1 minute = 1*60s = 60s
						});
						timeStringMobile = t('files', '{minutes}:{seconds}m' , {
							minutes: date.getUTCMinutes(),
							seconds: ('0' + date.getUTCSeconds()).slice(-2)
						});
					} else if(date.getUTCSeconds() > 0){
						timeStringDesktop = t('files', '{seconds} second{plural_s} left' , {
							seconds: date.getUTCSeconds(),
							plural_s: (smoothRemainingSeconds === 1 ? "": "s") // 1 second = 1s = 1s
						});
						timeStringMobile = t('files', '{seconds}s' , {seconds: date.getUTCSeconds()});
					} else {
						timeStringDesktop = t('files', 'Any moment now...');
						timeStringMobile = t('files', 'Soon...');
					}
					$('#uploadprogressbar .label .mobile').text(timeStringMobile);
					$('#uploadprogressbar .label .desktop').text(timeStringDesktop);
					$('#uploadprogressbar').attr('original-title',
						t('files', '{loadedSize} of {totalSize} ({bitrate})' , {
							loadedSize: humanFileSize(data.loaded),
							totalSize: humanFileSize(data.total),
							bitrate: humanFileSize(data.bitrate) + '/s'
						})
					);
					$('#uploadprogressbar').progressbar('value', progress);
					self.trigger('progressall', e, data);
				});
				fileupload.on('fileuploadstop', function(e, data) {
					self.log('progress handle fileuploadstop', e, data);

					self.clear();
					self._hideProgressBar();
				});
				fileupload.on('fileuploadfail', function(e, data) {
					self.log('progress handle fileuploadfail', e, data);
					//if user pressed cancel hide upload progress bar and cancel button
					if (data.errorThrown === 'abort') {
						self._hideProgressBar();
					}
					self.trigger('fail', e, data);
				});

				fileupload.on('fileuploadchunksend', function(e, data) {
					// modify the request to adjust it to our own chunking
					var upload = self.getUpload(data);
					var range = data.contentRange.split(' ')[1];
					var chunkId = range.split('/')[0];
					data.url = OC.getRootPath() +
						'/remote.php/dav/uploads' +
						'/' + encodeURIComponent(OC.getCurrentUser().uid) +
						'/' + encodeURIComponent(upload.getId()) +
						'/' + encodeURIComponent(chunkId);
					delete data.contentRange;
					delete data.headers['Content-Range'];
				});
				fileupload.on('fileuploaddone', function(e, data) {
					var upload = self.getUpload(data);
					upload.done().then(function() {
						self.trigger('done', e, upload);
					});
				});
				fileupload.on('fileuploaddrop', function(e, data) {
					self.trigger('drop', e, data);
				});

			}
		}

		// warn user not to leave the page while upload is in progress
		$(window).on('beforeunload', function(e) {
			if (self.isProcessing()) {
				return t('files', 'File upload is in progress. Leaving the page now will cancel the upload.');
			}
		});

		//add multiply file upload attribute to all browsers except konqueror (which crashes when it's used)
		if (navigator.userAgent.search(/konqueror/i) === -1) {
			this.$uploadEl.attr('multiple', 'multiple');
		}

		return this.fileUploadParam;
	}
}, OC.Backbone.Events);


